// Plain-node unit test for the classifier:  node tests/classify.test.mjs
import { classify } from '../hooks/classify.js'

const cases = [
  // [command, touches, mutating, retarget]
  ['oc get pods -n foo', true, false, false],
  ['oc -n foo delete pod x', true, true, false],
  ['oc get po | xargs -I {} oc delete pod {}', true, true, false],
  ['KUBECONFIG=/x oc get nodes', true, false, true],
  ['oc get pods --context=prod', true, false, true],
  ['oc delete pod x --kubeconfig /tmp/other', true, true, true],
  ['bash -c "oc adm drain node1"', true, true, false],
  ['oc adm top nodes', true, false, false],
  ['oc adm cordon n1', true, true, false],
  ['grep oc notes.txt', false, false, false],
  ['kubectl rollout status deploy/x', true, false, false],
  ['kubectl rollout restart deploy/x', true, true, false],
  ['helm upgrade x y', true, true, false],
  ['helm list -A', true, false, false],
  ['helm install x y --dry-run', true, false, false],
  ['argocd app sync x', true, true, false],
  ['argocd app get x', true, false, false],
  ['oc apply -f x.yaml --dry-run=server', true, false, false],
  ['oc apply -f x.yaml', true, true, false],
  ['echo hi', false, false, false],
  ['sudo -u root oc delete node x', true, true, false],
  ['oc project -q', true, false, false],
  ['oc exec pod -- ls', true, true, false],
  ['ls | wc -l', false, false, false],
  ['watch oc get pods', true, false, false],
  ['cd /tmp && oc scale deploy/x --replicas=0', true, true, false],
  ['oc get pods -n foo --server=https://other:6443', true, false, true],
]

let failed = 0
for (const [cmd, touches, mutating, retarget] of cases) {
  const r = classify(cmd)
  const ok = r.touches === touches && r.mutating === mutating && r.retarget === retarget
  if (!ok) {
    failed++
    console.log('FAIL', JSON.stringify(cmd), 'got', { t: r.touches, m: r.mutating, r: r.retarget }, 'want', { touches, mutating, retarget })
  }
}
console.log(failed ? failed + ' failed' : 'all ' + cases.length + ' passed')
process.exit(failed ? 1 : 0)
