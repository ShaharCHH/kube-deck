// node tests/redact.test.mjs
import { redactOutput, maskCommand, MASK } from '../hooks/redact.js'

let failed = 0
const check = (name, cond, extra) => { if (!cond) { failed++; console.log('FAIL', name, extra ?? '') } }

const yaml = `apiVersion: v1
data:
  password: c3VwZXJzZWNyZXQ=
  user: YWRtaW4=
kind: Secret
metadata:
  annotations:
    kubectl.kubernetes.io/last-applied-configuration: |
      {"apiVersion":"v1","data":{"password":"c3VwZXJzZWNyZXQ="},"kind":"Secret"}
  name: demo
  namespace: default
type: Opaque
`
let r = redactOutput('oc get secret demo -o yaml', yaml)
check('yaml masks values', !r.text.includes('c3VwZXJzZWNyZXQ') && !r.text.includes('YWRtaW4'), r.text)
check('yaml keeps keys', r.text.includes('password: ' + MASK) && r.text.includes('user: ' + MASK))
check('yaml keeps metadata', r.text.includes('name: demo') && r.text.includes('type: Opaque'))
check('yaml masks last-applied', !r.text.includes('"apiVersion":"v1","data"'), r.text)
check('yaml counted', r.redacted === 3, String(r.redacted))

const json = JSON.stringify({ apiVersion: 'v1', kind: 'Secret', data: { password: 'c3VwZXI=', user: 'YWRtaW4=' }, metadata: { name: 'demo', annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{"data":{"password":"c3VwZXI="}}' } } }, null, 2)
r = redactOutput('oc get secret demo -o json', json)
check('json masks values', !r.text.includes('c3VwZXI') && !r.text.includes('YWRtaW4'), r.text)
check('json stays parseable', (() => { try { JSON.parse(r.text.split('\n[kube-deck')[0]); return true } catch { return false } })(), r.text)

const list = `apiVersion: v1
items:
- apiVersion: v1
  data:
    token: dG9rZW4=
  kind: Secret
  metadata:
    name: a
- apiVersion: v1
  data:
    k: dg==
  kind: Secret
  metadata:
    name: b
kind: List
`
r = redactOutput('oc get secrets -o yaml', list)
check('list masks every item', !r.text.includes('dG9rZW4') && !r.text.includes('dg=='), r.text)

check('table output untouched', redactOutput('oc get secret', 'NAME   TYPE   DATA   AGE\ndemo   Opaque 2      3d').redacted === 0)
check('configmap untouched', redactOutput('oc get cm x -o yaml', 'apiVersion: v1\ndata:\n  a: b\nkind: ConfigMap\n').redacted === 0)
check('jsonpath withheld', redactOutput("oc get secret demo -o jsonpath='{.data.password}'", 'c3VwZXI=').withheld)
check('base64 pipeline withheld', redactOutput('oc get secret demo -o json | jq -r .data.p | base64 -d', 'hunter2').withheld)
check('whoami -t withheld', redactOutput('oc whoami -t', 'sha256~abc').withheld)
check('whoami plain ok', !redactOutput('oc whoami', 'kube:admin').withheld)
check('create token withheld', redactOutput('oc create token default', 'eyJ...').withheld)
check('empty ok', redactOutput('oc get secret', '').redacted === 0)

// ---- command lines (audit log and the recent-commands card)
// [command, secret that must be gone, text that must stay]
const masked = [
  ['oc login -u admin -p hunter2 https://api.x.example.com:6443', 'hunter2', 'oc login -u admin'],
  ['oc login --token=sha256~abcDEF123 --server=https://api.x.example.com:6443', 'abcDEF123', '--server=https://api.x.example.com:6443'],
  ['oc login --password "my pass word" -u admin', 'my pass', '-u admin'],
  ['oc create secret generic db --from-literal=password=hunter2 --from-literal=user=bob', 'hunter2', '--from-literal=user='],
  ["oc create secret generic db --from-literal=password='two words'", 'two words', 'oc create secret generic db'],
  ['oc create secret docker-registry r --docker-username=u --docker-password=s3cret --docker-server=quay.io', 's3cret', '--docker-username=u'],
  ['helm upgrade x y --set db.password=hunter2 --set replicas=3', 'hunter2', '--set replicas=3'],
  ['helm upgrade x y --set-string auth.apiKey=abc123 -n ns', 'abc123', '-n ns'],
  ['AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG oc get pods', 'wJalrXUtnFEMI', 'oc get pods'],
  ['AWS_SESSION_TOKEN=FwoGZXIvYXdz aws s3 ls', 'FwoGZXIvYXdz', 'aws s3 ls'],
  ['cd /x && GITHUB_TOKEN=' + 'gh' + 'p_abcdefghijklmnopqrstuvwxyz0123 git push', 'gh' + 'p_abcdefghijkl', 'git push'],
  ['curl -H "Authorization: Bearer abc.def.ghi" https://api.x.example.com/v1', 'abc.def.ghi', 'https://api.x.example.com/v1'],
  ['git clone https://bob:hunter2@git.example.com/r.git', 'hunter2', 'git.example.com/r.git'],
  // fake credentials are assembled here so that no real-looking key sits in the file for scanners to flag
  ['echo ' + 'AK' + 'IA' + 'IOSFODNN7EXAMPLE', 'AK' + 'IA' + 'IOSFODNN7EXAMPLE', 'echo'],
  ['echo eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc_def-123', 'eyJhbGciOiJIUzI1NiJ9', 'echo'],
  ['oc get pods --token sha256~zzz999 -n foo', 'zzz999', '-n foo'],
]
for (const [cmd, secret, kept] of masked) {
  const out = maskCommand(cmd)
  check('mask hides ' + secret, !out.includes(secret), out)
  check('mask keeps ' + kept, out.includes(kept), out)
}
// things that look similar but are not secrets stay readable
for (const cmd of [
  'oc get secret db -o yaml',
  'oc logs -p mypod',
  'oc get pods -n prod --context=prod',
  'KUBECONFIG=/home/x/.kube/a.kubeconfig oc get nodes',
  'oc delete pod x --grace-period=0',
  'helm upgrade x y --set replicas=3',
]) {
  check('mask leaves alone: ' + cmd, maskCommand(cmd) === cmd, maskCommand(cmd))
}
check('mask is idempotent', maskCommand(maskCommand('oc login -p hunter2 --token=abc')) === maskCommand('oc login -p hunter2 --token=abc'))

console.log(failed ? failed + ' failed' : 'redact: all passed')
process.exit(failed ? 1 : 0)
