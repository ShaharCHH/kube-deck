// node tests/reach.test.mjs
import { apiTarget, watchTargets } from '../hooks/targets.js'

let failed = 0
const check = (name, cond, extra) => { if (!cond) { failed++; console.log('FAIL', name, extra ?? '') } }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// the address to probe comes from the kubeconfig's server URL
check('host and port', eq(apiTarget('https://api.sno.example.com:6443'), { host: 'api.sno.example.com', port: 6443, key: 'api.sno.example.com:6443' }))
check('default https port', apiTarget('https://k8s.example.com')?.port === 443)
check('default http port', apiTarget('http://127.0.0.1')?.port === 80)
check('path is ignored', apiTarget('https://k8s.example.com:8443/api')?.key === 'k8s.example.com:8443')
check('ipv6 literal', apiTarget('https://[::1]:6443')?.host === '::1')
check('port out of range', apiTarget('https://x.example.com:70000') === null)
check('not a URL', apiTarget('') === null && apiTarget(undefined) === null && apiTarget('not a url') === null)
check('no shell characters get through', apiTarget('https://x.example.com;rm -rf ~:6443') === null)

// WATCH_PORTS: bad entries are dropped, good ones get a default host
check('default host', eq(watchTargets([{ name: 'console', port: 443 }]), [{ name: 'console', host: '127.0.0.1', port: 443 }]))
check('explicit host', watchTargets([{ name: 'db', host: 'localhost', port: 5432 }])[0]?.host === 'localhost')
check('bad port dropped', watchTargets([{ name: 'a', port: 0 }, { name: 'b', port: 65536 }, { name: 'c', port: '80x' }, { name: 'd', port: 1.5 }]).length === 0)
check('bad name dropped', watchTargets([{ name: '', port: 80 }, { name: '-x', port: 80 }, { name: 'a;b', port: 80 }]).length === 0)
check('bad host dropped', watchTargets([{ name: 'a', host: 'x y', port: 80 }, { name: 'b', host: '-oProxy', port: 80 }]).length === 0)
check('not a list', watchTargets(undefined).length === 0 && watchTargets('x').length === 0 && watchTargets([null, 5]).length === 0)
check('at most six', watchTargets(Array.from({ length: 9 }, (_, i) => ({ name: 'n' + i, port: 1000 + i }))).length === 6)

if (failed) {
  console.log(failed + ' failed')
  process.exit(1)
}
console.log('reach: all passed')
