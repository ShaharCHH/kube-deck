// Pure logic, no `$`: which addresses the cluster card probes (see tests/reach.test.mjs).

// host and port of a kubeconfig server URL; null if it is not one we can probe
export function apiTarget(server) {
  const m = /^https?:\/\/(\[[0-9a-fA-F:]+\]|[A-Za-z0-9][A-Za-z0-9.-]*)(?::(\d{1,5}))?(?:\/|$)/.exec(String(server ?? ''))
  if (!m) return null
  const host = m[1].replace(/^\[|\]$/g, '')
  const port = m[2] ? Number(m[2]) : String(server).startsWith('https') ? 443 : 80
  if (port < 1 || port > 65535) return null
  return { host, port, key: host + ':' + port }
}

// WATCH_PORTS entries that are usable; the rest are dropped, because the values end up on a command line
export function watchTargets(list) {
  const out = []
  for (const w of Array.isArray(list) ? list : []) {
    const name = String(w?.name ?? '').trim()
    const host = String(w?.host ?? '127.0.0.1').trim()
    const port = Number(w?.port)
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,15}$/.test(name)) continue
    if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(host)) continue
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue
    out.push({ name, host, port })
  }
  return out.slice(0, 6)
}

export const LOCAL_HOST = /^(localhost|127(\.\d{1,3}){3}|::1)$/i
