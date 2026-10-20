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
  // separators inside quotes: the split ignores quotes, but the result must stay safe
  ['oc get cm x -o jsonpath="{.a};{.b}"', true, false, false],
  ['oc delete pod "a;b"', true, true, false],
  ['oc label pod x "k=a|b"', true, true, false],
  ['oc get pods | grep "x|y"', true, false, false],
  // commands that are not the first word of their piece
  ['for p in a b; do oc delete pod $p; done', true, true, false],
  ['for p in a b; do oc get pod $p; done', true, false, false],
  ['if true; then oc delete pod x; fi', true, true, false],
  ['while true; do oc get pods; sleep 1; done', true, false, false],
  ['echo $(oc delete pod x)', true, true, false],
  ['echo `oc delete pod x`', true, true, false],
  ['(oc delete pod x)', true, true, false],
  ['x=$(oc get pods -o name | head -1) && oc delete $x', true, true, false],
  ['find . -name x -exec oc delete -f {} \\;', true, true, false],
  ['find . -name x -exec oc get -f {} \\;', true, false, false],
  ['eval "oc delete pod x"', true, true, false],
  ['ssh bastion oc delete pod x', true, true, false],
  ['ssh bastion "oc delete pod x"', true, true, false],
  ['ssh bastion oc get pods', true, false, false],
  ['ssh bastion uptime', false, false, false],
  ['timeout 30 oc delete pod x', true, true, false],
  ['caffeinate -i helm upgrade x y', true, true, false],
  // jsonpath / selectors with parentheses stay reads
  ["oc get pods -o jsonpath='{.items[?(@.x)].name}'", true, false, false],
  ["oc get pods -l 'app in (a,b)'", true, false, false],
  // login, logout and switching project change what later commands hit
  ['oc login -u admin -p pw https://other.example.com:6443', true, true, false],
  ['oc logout', true, true, false],
  ['oc project other-ns', true, true, false],
  ['oc whoami', true, false, false],
  // known false positive: oc text inside a quoted echo is read as a command (an extra prompt)
  ['echo "a; oc delete pod x"', true, true, false],
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
