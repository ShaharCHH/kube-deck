// node tests/redact.test.mjs
import { redactOutput, MASK } from '../hooks/redact.js'

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

console.log(failed ? failed + ' failed' : 'redact: all passed')
process.exit(failed ? 1 : 0)
