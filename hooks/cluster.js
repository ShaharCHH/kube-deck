// The cluster on show: which one, prod or not, the kubeconfig dropdown, and the browser login.

import { approveAll, setApprove } from './approve.js'
import { KUBE_CLI, KUBE_CRED_LOGIN_MS, KUBE_LOGIN_MS, KUBE_SERVER_RE, NONPROD_PATTERNS, PROD_PATTERNS } from './config.js'
import { setPicked } from './picked.js'
import { drafts, secrets } from './shared.js'

// ---------------------------------------------------------------- state
// Module variables reset on reload; the todo list is reloaded from $.store in session.start.
// approveAll is deliberately never persisted: every new session starts guarded.
// level: strict (unreadable) | prod (matches PROD_PATTERNS) | unlisted (matches neither list) | nonprod
export let cluster = { known: false, name: '', namespace: '', server: '', isProd: true, level: 'strict' }

export let kubeconfigs = []

export let kubeconfig = ''

export let kubeLogin = { status: 'idle', last: null }

// Outcome of the last "Add kubeconfig": { ok, note }, shown on the card when it failed.
export let kubeAdd = { ok: true, note: '' }

// ---------------------------------------------------------------- helpers
// Helpers that need the engine take `$` as an argument (allowed for top-level functions).

// oc-generated cluster names look like "api-sno-sandbox5359-opentlc-com:6443"; the API host
// minus its "api." prefix reads better ("sno-sandbox5359.opentlc.com").
export function prettyName(entryName, server) {
  const host = /^https?:\/\/([^:/]+)/.exec(server ?? '')?.[1]
  if (host && /^api[.-]/.test(entryName ?? '')) return host.replace(/^api\./, '')
  return entryName
}

export async function refreshCluster($) {
  let kubeconfig = ''
  try {
    kubeconfig = (await $.env.get('KUBECONFIG')) ?? ''
  } catch {}

  let info = null
  try {
    // short timeout: this also runs on every prompt, so a hung oc must not stall typing
    const r = await $.process.run([KUBE_CLI, 'config', 'view', '--minify', '-o', 'json'], { timeoutMs: 3000 })
    if (r.exitCode === 0) info = JSON.parse(r.stdout)
  } catch {}

  const entry = info?.clusters?.[0]
  const entryName = entry?.name ?? ''
  const server = entry?.cluster?.server ?? ''
  const namespace = info?.contexts?.[0]?.context?.namespace ?? ''

  // Separate kubeconfig per cluster: the file name is the most readable label.
  const file = kubeconfig.split(':')[0].split('/').pop().replace(/\.[^.]+$/, '')
  const name = file && file !== 'config' ? file : prettyName(entryName, server)
  const known = Boolean(info && name)
  const haystack = [kubeconfig, name, entryName, server].join(' ')
  // non-prod is trusted only by name: file name, cluster name, API host (never the folder)
  const host = /^https?:\/\/([^:/]+)/.exec(server)?.[1] ?? ''
  const nameHaystack = [kubeconfig.split(':')[0].split('/').pop(), name, entryName, host].join(' ')
  const level = !known
    ? 'strict'
    : PROD_PATTERNS.some((re) => re.test(haystack))
      ? 'prod'
      : NONPROD_PATTERNS.some((re) => re.test(nameHaystack))
        ? 'nonprod'
        : 'unlisted'

  cluster = { known, name, namespace, server, isProd: level !== 'nonprod', level }
  $.ui.invalidate('ui.render')
}

// How the cluster is called in prompts and replies.
export function levelLabel() {
  return cluster.level === 'nonprod' ? 'non-prod' : cluster.level === 'unlisted' ? 'not marked non-prod, treated as prod' : cluster.level === 'prod' ? 'PROD' : 'unknown, treated as prod'
}

// ---- the dropdowns: switch AWS profile / kubeconfig for this session
// `$.env.set` changes the variable for this process and everything it starts later, which
// includes the shell commands Claude runs. Nothing on disk changes (no `oc config use-context`,
// no edit to ~/.aws/config), so closing the session puts everything back.
export async function discoverKubeconfigs($) {
  let home = ''
  let current = ''
  try {
    home = (await $.env.get('HOME')) ?? ''
    current = ((await $.env.get('KUBECONFIG')) ?? '').split(':')[0]
  } catch {}
  const found = []
  if (home) {
    try {
      for (const f of await $.fs.list(home + '/.kube')) {
        if (f.kind === 'dir' || found.length >= 30) continue
        // only files that read like a kubeconfig (~/.kube also holds caches and other tools' files)
        try {
          if (/^\s*(apiVersion|clusters|contexts):/m.test(String(await $.fs.read(home + '/.kube/' + f.name)).slice(0, 4000))) {
            found.push(home + '/.kube/' + f.name)
          }
        } catch {}
      }
    } catch {}
  }
  if (current && !found.includes(current)) found.unshift(current)
  kubeconfig = current
  kubeconfigs = found.sort()
}

export async function switchKubeconfig($, path) {
  if (!kubeconfigs.includes(path) || path === kubeconfig) return
  const r = await $.env.set('KUBECONFIG', path)
  if (r?.deny) return $.ui.toast('Could not switch kubeconfig: ' + r.deny)
  // an approve-all given for the old cluster must not carry over to the new one
  const wasArmed = approveAll
  if (wasArmed) await setApprove($, false)
  await setPicked($, 'KUBECONFIG', path)
  kubeconfig = path
  await refreshCluster($) // re-judges prod / non-prod for the new file
  $.ui.toast('Kubeconfig is now ' + path.split('/').pop() + (wasArmed ? '; approve-all switched off' : ''))
}

// Logs in to a cluster into a kubeconfig file of its own, so no kubeconfig has to exist first and no
// other file is touched. `method` is 'web' (browser, nothing secret typed), 'token' or 'password'
// (taken from `secrets`; the panel cannot hide typed text, and `oc` only takes them as arguments,
// so they are visible in the process list for the seconds the login runs).
// `insecure` adds --insecure-skip-tls-verify for a cluster whose certificate is not trusted: the token then goes to whoever answers at that address, so it is never the default;
// the panel offers it only after a login failed with a certificate error. Logging in again to the cluster already in use refreshes that same file.
export async function loginKube($, typed, insecure = false, method = 'web') {
  // "api.x.example.com:6443" works too: https:// is added when no scheme was typed
  let url = String(typed || drafts.kubeServer || cluster.server || '').trim().replace(/\/+$/, '')
  if (url && !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(url)) url = 'https://' + url
  if (!KUBE_SERVER_RE.test(url)) {
    // on the card, not only a toast: a toast is easy to miss
    kubeLogin = { status: 'idle', last: { ok: false, secs: null, note: 'Not a usable cluster URL. Type it like api.mycluster.example.com:6443 (https only).' } }
    $.ui.invalidate('ui.render')
    return $.ui.toast('Not a usable cluster URL (use https://host:port)')
  }
  let home = ''
  try {
    home = (await $.env.get('HOME')) ?? ''
  } catch {}
  if (!home) return $.ui.toast('Cannot log in: HOME is not set')
  const typedSecrets = method === 'token' ? [secrets.token] : method === 'password' ? [secrets.user, secrets.pass] : []
  // a leading '-' would be read as a flag; whitespace never belongs in a token or user name
  if (typedSecrets.some((v) => !v || /\s/.test(v) || v.startsWith('-'))) {
    kubeLogin = { status: 'idle', last: { ok: false, secs: null, note: method === 'token' ? 'Type the token first (no spaces).' : 'Type the user name and the password first (no spaces).' } }
    $.ui.invalidate('ui.render')
    return $.ui.toast('Missing ' + (method === 'token' ? 'token' : 'user name or password'))
  }
  const host = /^https:\/\/([^:/]+)/.exec(url)[1].replace(/^api\./, '').replace(/[^A-Za-z0-9]+/g, '-')
  const reuse = kubeconfig && url === cluster.server
  const file = reuse ? kubeconfig : home + '/.kube/' + host + '.kubeconfig'
  kubeLogin = { status: 'logging', last: null }
  $.ui.invalidate('ui.render')
  const started = await $.clock.now()
  let ok = false
  let note = ''
  let badCert = false
  try {
    // '=' forms, so a value can never be taken for a flag
    const how = method === 'token' ? ['--token=' + secrets.token] : method === 'password' ? ['--username=' + secrets.user, '--password=' + secrets.pass] : ['--web']
    const r = await $.process.run([KUBE_CLI, 'login', ...how, '--server=' + url, ...(insecure ? ['--insecure-skip-tls-verify'] : [])], {
      timeoutMs: method === 'web' ? KUBE_LOGIN_MS : KUBE_CRED_LOGIN_MS,
      env: { KUBECONFIG: file },
    })
    ok = r.exitCode === 0
    if (!ok) {
      badCert = /x509|certificate/i.test(String(r.stderr || '') + String(r.stdout || ''))
      const line = String(r.stderr || r.stdout || '').split('\n').map((l) => l.trim()).find(Boolean) ?? ''
      note = 'exit ' + r.exitCode + (line ? ': ' + scrub(line, typedSecrets).replace(/https?:\/\/\S+/g, '<url>').slice(0, 120) : '')
    }
  } catch (err) {
    note = scrub(String((err && err.message) || err || 'failed'), typedSecrets).replace(/https?:\/\/\S+/g, '<url>').slice(0, 120)
  }
  const secs = Math.round(((await $.clock.now()) - started) / 1000)
  kubeLogin = { status: 'idle', last: { ok, secs, note, badCert, insecure } }
  if (ok) {
    drafts.kubeServer = ''
    clearSecrets() // kept after a failure so "Log in anyway" or a retry needs no retyping
    await discoverKubeconfigs($)
    if (file === kubeconfig) await refreshCluster($)
    else await switchKubeconfig($, file) // also re-judges prod and switches approve-all off
    $.ui.toast('Logged in to ' + host + (insecure ? ' (certificate NOT verified)' : ''))
  } else {
    $.ui.toast('Cluster login did not finish after ' + secs + 's (' + (note || 'no detail') + ')')
  }
  $.ui.invalidate('ui.render')
}

// Replaces every typed secret in a message that is about to be shown.
function scrub(text, values) {
  let out = text
  for (const v of values) if (v) out = out.split(v).join('***')
  return out
}

export function clearSecrets() {
  secrets.user = ''
  secrets.pass = ''
  secrets.token = ''
}

// Adds a kubeconfig file you already have: checks it reads like one, copies it into ~/.kube with
// mode 600 (a kubeconfig can hold tokens and keys) and switches to it. The original is left alone,
// and an existing file in ~/.kube is never overwritten.
export async function addKubeconfig($, typed) {
  let home = ''
  try {
    home = (await $.env.get('HOME')) ?? ''
  } catch {}
  if (!home) return $.ui.toast('Cannot add a kubeconfig: HOME is not set')
  const say = (note) => {
    kubeAdd = { ok: false, note }
    $.ui.invalidate('ui.render')
    $.ui.toast(note)
  }
  const raw = String(typed || drafts.kubeAdd || '').trim().replace(/^['"]|['"]$/g, '')
  if (!raw) return say('Type the path of a kubeconfig file.')
  const src = raw === '~' ? home : raw.startsWith('~/') ? home + raw.slice(1) : raw
  if (!src.startsWith('/')) return say('Use a full path (/… or ~/…).')
  let head = ''
  try {
    head = String(await $.fs.read(src)).slice(0, 4000)
  } catch {
    return say('Cannot read ' + src.split('/').pop() + '.')
  }
  if (!/^\s*(apiVersion|clusters|contexts):/m.test(head)) return say(src.split('/').pop() + ' does not read like a kubeconfig.')
  const name = src.split('/').pop()
  const dest = src.startsWith(home + '/.kube/') && !src.slice((home + '/.kube/').length).includes('/') ? src : home + '/.kube/' + name
  if (dest !== src) {
    if (await $.fs.exists(dest)) return say(name + ' already exists in ~/.kube. Rename your file first.')
    const r = await $.process.run(['install', '-m', '600', src, dest], { timeoutMs: 5000 })
    if (r.exitCode !== 0) return say('Could not copy it into ~/.kube.')
  }
  kubeAdd = { ok: true, note: '' }
  drafts.kubeAdd = ''
  await discoverKubeconfigs($)
  await switchKubeconfig($, dest)
  $.ui.invalidate('ui.render')
}

// The panel's Log in button replaces this; an imported name cannot be reassigned from outside.
export function setKubeLogin(value) {
  kubeLogin = value
}
