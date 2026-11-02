// Whether the active cluster's API (and any WATCH_PORTS) answers: a plain TCP connect, nothing is sent.
// Mostly useful behind a local port-forward or tunnel, which can end quietly while the kubeconfig keeps
// pointing at 127.0.0.1; for a cluster you reach directly it just reads "reachable".

import { cluster } from './cluster.js'
import { WATCH_PORTS } from './config.js'
import { LOCAL_HOST, apiTarget, watchTargets } from './targets.js'

// api: { key: "host:port" it was measured for, up, hint } | null; watched: [{ name, host, port, up }]
export let reach = { api: null, watched: [] }

// ---------------------------------------------------------------- probes
// true / false, or null when nc itself could not run (so a missing nc is never shown as "down")
async function probe($, host, port) {
  try {
    const r = await $.process.run(['nc', '-z', '-w', '2', host, String(port)], { timeoutMs: 4000 })
    if (r.exitCode === 0) return true
    if (r.exitCode === 127 || /not found|no such file/i.test(String(r.stderr || ''))) return null
    return false
  } catch {
    return null
  }
}

// Does this name resolve to this machine? Asked of the system resolver like any program would, so /etc/hosts
// and per-domain resolvers count. macOS only; anywhere else it answers false and no hint is shown.
async function resolvesToLocalhost($, host) {
  if (LOCAL_HOST.test(host)) return true
  try {
    const r = await $.process.run(['dscacheutil', '-q', 'host', '-a', 'name', host], { timeoutMs: 3000 })
    return r.exitCode === 0 && /^ip_address: 127\.0\.0\.1$/m.test(String(r.stdout || ''))
  } catch {
    return false
  }
}

export async function checkReach($) {
  const before = JSON.stringify(reach)
  const next = { api: null, watched: [] }
  const target = cluster.known ? apiTarget(cluster.server) : null
  if (target) {
    const up = await probe($, target.host, target.port)
    if (up !== null) next.api = { key: target.key, up, hint: !up && (await resolvesToLocalhost($, target.host)) }
  }
  for (const w of watchTargets(WATCH_PORTS)) {
    const up = await probe($, w.host, w.port)
    if (up !== null) next.watched.push({ ...w, up })
  }
  reach = next
  if (JSON.stringify(reach) !== before) $.ui.invalidate('ui.render')
}
