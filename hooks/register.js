import { atom, update } from 'claude-code'
import { classify } from './classify.js'
import { redactOutput } from './redact.js'

// What was picked in the panel (AWS_PROFILE, KUBECONFIG), kept in $.state: a hot reload resets
// module variables but not this, and the process environment keeps the pick after a reload while
// Claude's shell never had it.
const PICKED_REF = { plugin: 'kube-deck', key: 'picked' }
const pickedAtom = atom(PICKED_REF, {})

// ---------------------------------------------------------------- config (edit)
// A cluster counts as prod when any of these match the kubeconfig path, the cluster
// name, or the API server URL. Unknown cluster (no kubeconfig / oc missing) = strict.
const PROD_PATTERNS = [/prod/i]
// ...and ONLY a cluster that matches one of these is trusted as non-prod. Matched against the
// kubeconfig FILE name, the cluster name and the API host (not the folder, so a home directory
// called "devops" marks nothing). A name that matches neither list is "unlisted" and is treated
// as prod, so a prod cluster nobody named "prod" still gets asked. PROD_PATTERNS wins over this.
// A letter on either side breaks a match, so "devops" is not "dev"; digits and - _ . do not.
const NONPROD_PATTERNS = [
  /(^|[^a-z])(sandbox|dev|test|staging|stage|qa|lab|demo|local|minikube|kind|crc|docker-desktop|rancher-desktop)([^a-z]|$)/i,
]
// Used only to READ the local kubeconfig (`config view --minify`), never talks to a cluster.
const KUBE_CLI = 'oc'
// Used to check the AWS login (`sts get-caller-identity`, read-only). Run at most every 5 minutes.
const AWS_CLI = 'aws'
const AWS_CHECK_MS = 5 * 60000
// How long `aws sso login` may wait for you to approve in the browser (10 minutes is the most
// $.process.run allows). Killing it earlier leaves the browser's redirect with nothing to connect to.
const AWS_LOGIN_MS = 10 * 60000
// How long `oc login --web` may wait for you to approve in the browser (same cap as above).
const KUBE_LOGIN_MS = 10 * 60000
// API URL typed in the panel: https, a host name, optional port. It ends up in a command line.
const KUBE_SERVER_RE = /^https:\/\/[A-Za-z0-9][A-Za-z0-9.-]*(:\d{1,5})?$/
// SSO start URL and region typed in the panel; both end up in ~/.aws/config and on a command line.
const AWS_SSO_URL_RE = /^https:\/\/[A-Za-z0-9][A-Za-z0-9.-]*(\/[A-Za-z0-9_.\/-]*)?$/
// The Identity Center issuer URL is also accepted as a start URL; its id is exactly 16 hex digits,
// so extra text stuck on the end (a region typed into the wrong field) is caught.
const AWS_SSO_ISSUER_RE = /^https:\/\/identitycenter\.amazonaws\.com\/ssoins-[0-9a-f]{16}$/
const AWS_REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/
const AWS_PROFILE_RE = /^[A-Za-z0-9_][A-Za-z0-9_.@+=,-]*$/
// Approve-all switches itself off this many minutes after it was turned on.
const APPROVE_MINUTES = 15
// Audit log: $HOME/<AUDIT_DIR>/audit.jsonl, one JSON line per cluster-changing command.
const AUDIT_DIR = '.kube-deck'

// Panel colors. Theme keys, not hex: they follow the person's light/dark theme. Change a
// value here to restyle the whole panel (any theme key, or a color string).
const THEME = {
  brand: 'claude', // title, todo card
  accent: 'suggestion', // guard card, primary actions
  ok: 'success', // non-prod, approved, all done
  warn: 'warning', // approve-all ON
  danger: 'error', // PROD, refused, delete
  muted: 'subtle', // secondary text, borders
  text: 'text',
  onColor: 'inverseText', // text drawn on a filled chip or hovered button
}

// ---------------------------------------------------------------- state
// Module variables reset on reload; the todo list is reloaded from $.store in session.start.
// approveAll is deliberately never persisted: every new session starts guarded.
// level: strict (unreadable) | prod (matches PROD_PATTERNS) | unlisted (matches neither list) | nonprod
let cluster = { known: false, name: '', namespace: '', server: '', isProd: true, level: 'strict' }
let approveAll = false
let approveUntil = 0
let todos = []
// AWS profile (resolved like the old session bar did) and whether its login still works.
// status: none (no profile) | unknown | checking | logging | ok | expired | error
// lastLogin: how the last Log in attempt ended ({ ok, secs, note }), kept so a failure explains itself.
let aws = { profile: '', region: '', role: '', status: 'none', checkedAt: 0, lastLogin: null }
// What the dropdowns offer: profile names from ~/.aws/config, kubeconfig files from ~/.kube.
// `kubeconfig` is the file in use (first KUBECONFIG entry), so the dropdown can show it.
let awsProfiles = []
let kubeconfigs = []
let kubeconfig = ''
// Cluster login: the API URL typed in the panel, how the last attempt ended, and the flag the
// Log in button sets for the 1s timer (same pattern as the AWS login below).
// kubeLogin.status: idle | logging
let kubeServerDraft = ''
let kubeLogin = { status: 'idle', last: null }
let kubeLoginWanted = false
// Where the AWS profile on show came from: env (AWS_PROFILE, which Claude's shell has too, unless
// it was set by a pick), file (.aws-profile) or only (the one profile in ~/.aws/config). The last
// two are not in Claude's shell, so the guard exports them.
let awsSource = 'env'
// Set by the Log in button; the 1s timer (which holds the session's `$`) does the actual login.
let awsLoginWanted = false
// Adding a profile from an SSO start URL: what was typed, the state of that flow, and the
// account/role pairs found after the browser login (account ids stay in memory, never drawn).
// status: idle | logging
let ssoUrlDraft = ''
let ssoRegionDraft = ''
let awsSso = { status: 'idle', choices: [], session: '', region: '', last: null }
let awsSsoWanted = false
// Todos are kept per project root: key 'todos:<root>' in $.store (shared by all sessions).
let todoKey = 'todos'
let repoName = ''
let projectRoot = ''
// Last few cluster-changing commands the guard saw, newest first (this session only).
let activity = []
// Text typed in the panel's add field, kept so a redraw doesn't wipe a half-typed task.
let draft = ''
// The right-hand panel. Beside the transcript in a wide fullscreen terminal (a pane the mod
// opens by itself needs >= 144 columns); /deck opens it above the prompt otherwise.
const PANE = 'deck'
const PANE_COLUMNS = 46
// The tool Claude can call: mcp__<plugin name>__<tool name>
const TODO_TOOL = 'mcp__kube-deck__todo'
const APPROVE_LABEL = 'Run it + approve all for ' + APPROVE_MINUTES + ' min'

const newId = () => Math.random().toString(36).slice(2, 8)

// ---------------------------------------------------------------- helpers
// Helpers that need the engine take `$` as an argument (allowed for top-level functions).

// oc-generated cluster names look like "api-sno-sandbox5359-opentlc-com:6443"; the API host
// minus its "api." prefix reads better ("sno-sandbox5359.opentlc.com").
function prettyName(entryName, server) {
  const host = /^https?:\/\/([^:/]+)/.exec(server ?? '')?.[1]
  if (host && /^api[.-]/.test(entryName ?? '')) return host.replace(/^api\./, '')
  return entryName
}

async function refreshCluster($) {
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
function levelLabel() {
  return cluster.level === 'nonprod' ? 'non-prod' : cluster.level === 'unlisted' ? 'not marked non-prod, treated as prod' : cluster.level === 'prod' ? 'PROD' : 'unknown, treated as prod'
}

// ---- aws
// Claude Code's environment is frozen at launch, so the profile is found in order, first hit
// wins: AWS_PROFILE, a one-line `.aws-profile` file in the project root, or the only
// `[profile X]` in ~/.aws/config.
function parseAwsConfig(text) {
  const sections = {}
  let cur = null
  for (const raw of String(text).split('\n')) {
    const line = raw.trim()
    const head = /^\[(.+)\]$/.exec(line)
    if (head) {
      cur = sections[head[1].trim()] = {}
      continue
    }
    const kv = /^([^=#;\s][^=]*?)\s*=\s*(.*)$/.exec(line)
    if (cur && kv) cur[kv[1]] = kv[2]
  }
  return sections
}

async function resolveAws($) {
  let home = ''
  let profile = ''
  let source = 'env'
  try {
    home = (await $.env.get('HOME')) ?? ''
    profile = ((await $.env.get('AWS_PROFILE')) ?? '').trim()
  } catch {}
  if (!profile && projectRoot) {
    try {
      profile = String(await $.fs.read(projectRoot + '/.aws-profile')).split('\n')[0].trim()
      source = 'file'
    } catch {}
  }
  let sections = {}
  try {
    if (home) sections = parseAwsConfig(await $.fs.read(home + '/.aws/config'))
  } catch {}
  awsProfiles = Object.keys(sections)
    .map((n) => (n === 'default' ? n : n.startsWith('profile ') ? n.slice('profile '.length).trim() : ''))
    .filter((n) => AWS_PROFILE_RE.test(n))
  if (!profile) {
    const names = Object.keys(sections).filter((n) => n.startsWith('profile '))
    if (names.length === 1) {
      profile = names[0].slice('profile '.length).trim()
      source = 'only'
    }
  }
  // the name ends up in a command line: only plain profile-name characters, never an option
  if (!AWS_PROFILE_RE.test(profile)) profile = ''
  awsSource = profile ? source : 'env'
  const section = sections[profile === 'default' ? 'default' : 'profile ' + profile]
  if (profile !== aws.profile) {
    // a different profile: forget what we knew and check again soon
    aws = { profile, region: '', role: '', status: profile ? 'unknown' : 'none', checkedAt: 0, lastLogin: null }
  }
  aws.region = section?.region ?? ''
  $.ui.invalidate('ui.render')
}

// Is the login for the profile still good? A real call, not a guess from the token file, so
// "unreachable" (network, CLI failure) is kept apart from "expired" and never read as healthy.
async function checkAws($, force) {
  if (!aws.profile || aws.status === 'checking' || aws.status === 'logging') return
  const now = await $.clock.now()
  if (!force && aws.checkedAt && now - aws.checkedAt < AWS_CHECK_MS) return
  const profile = aws.profile
  aws.status = 'checking'
  $.ui.invalidate('ui.render')
  let status = 'error'
  let role = ''
  try {
    const r = await $.process.run([AWS_CLI, 'sts', 'get-caller-identity', '--profile', profile, '--output', 'json'], {
      timeoutMs: 10000,
    })
    if (r.exitCode === 0) {
      status = 'ok'
      try {
        // keep only the role or user name, never the account id inside the ARN
        role = /:(?:assumed-role|user|role)\/([^/]+)/.exec(JSON.parse(r.stdout).Arn ?? '')?.[1] ?? ''
      } catch {}
    } else if (/expired|sso|token|login/i.test(String(r.stderr ?? ''))) {
      status = 'expired'
    }
  } catch {}
  if (aws.profile !== profile) return // switched while we waited; the new profile gets its own check
  aws.status = status
  aws.role = role
  aws.checkedAt = await $.clock.now()
  $.ui.invalidate('ui.render')
}

// Runs `aws sso login` (opens the browser, waits for you to approve), then checks the result.
// Started by the Log in button; this is the one place the panel runs a login for you.
async function loginAws($) {
  const profile = aws.profile
  if (!profile) return
  aws.status = 'logging'
  $.ui.invalidate('ui.render')
  const started = await $.clock.now()
  let ok = false
  let note = ''
  try {
    const r = await $.process.run([AWS_CLI, 'sso', 'login', '--profile', profile], { timeoutMs: AWS_LOGIN_MS })
    ok = r.exitCode === 0
    if (!ok) {
      // first line of what the CLI said, with any URL (it can carry a one-time code) dropped
      const line = String(r.stderr || r.stdout || '').split('\n').map((l) => l.trim()).find(Boolean) ?? ''
      note = 'exit ' + r.exitCode + (line ? ': ' + line.replace(/https?:\/\/\S+/g, '<url>').slice(0, 120) : '')
    }
  } catch (err) {
    // rejects when it cannot start, or was still running at the timeout
    note = String((err && err.message) || err || 'failed').replace(/https?:\/\/\S+/g, '<url>').slice(0, 120)
  }
  const secs = Math.round(((await $.clock.now()) - started) / 1000)
  aws.lastLogin = { ok, secs, note }
  $.ui.toast(ok ? 'AWS login finished' : 'AWS login did not finish after ' + secs + 's (' + (note || 'no detail') + ')')
  aws.status = 'unknown'
  await checkAws($, true) // ask AWS, rather than trust the exit code
}

// ---- add an AWS profile from an SSO start URL
// aws configure sso is interactive, so the panel does its steps itself: add an [sso-session]
// block to ~/.aws/config, `aws sso login --sso-session` (browser), list the accounts and roles
// the fresh token can use, and write the one profile you pick. It only ever appends to
// ~/.aws/config (a copy of the original is kept once, as config.bak-kube-deck).
async function appendAwsConfig($, home, block) {
  const path = home + '/.aws/config'
  let text = ''
  try {
    text = String(await $.fs.read(path))
  } catch {}
  if (text && !(await $.fs.exists(path + '.bak-kube-deck'))) await $.fs.write(path + '.bak-kube-deck', text)
  await $.fs.write(path, text + (text && !text.endsWith('\n') ? '\n' : '') + (text ? '\n' : '') + block)
}

// The newest unexpired SSO token for this start URL, from the CLI's own cache.
async function findSsoToken($, home, startUrl) {
  const norm = (u) => String(u ?? '').replace(/[#/]+$/, '')
  const now = await $.clock.now()
  let best = null
  try {
    for (const f of await $.fs.list(home + '/.aws/sso/cache')) {
      if (!f.name.endsWith('.json')) continue
      try {
        const j = JSON.parse(String(await $.fs.read(home + '/.aws/sso/cache/' + f.name)))
        if (j.accessToken && norm(j.startUrl) === norm(startUrl) && Date.parse(j.expiresAt) > now) {
          if (!best || Date.parse(j.expiresAt) > Date.parse(best.expiresAt)) best = j
        }
      } catch {}
    }
  } catch {}
  return best?.accessToken ?? ''
}

// Accounts and roles the token can use. The token goes on the command line for the length of
// these calls (the CLI offers no other way); other processes of yours could see it until they end.
async function listSsoChoices($, token, region) {
  const call = async (argv) => {
    const r = await $.process.run([AWS_CLI, ...argv, '--access-token', token, '--region', region, '--output', 'json'], { timeoutMs: 20000 })
    if (r.exitCode !== 0) throw new Error('exit ' + r.exitCode)
    return JSON.parse(r.stdout)
  }
  const choices = []
  for (const a of ((await call(['sso', 'list-accounts'])).accountList ?? []).slice(0, 40)) {
    if (!/^\d{12}$/.test(a.accountId ?? '')) continue
    for (const r of (await call(['sso', 'list-account-roles', '--account-id', a.accountId])).roleList ?? []) {
      if (AWS_PROFILE_RE.test(r.roleName ?? '')) choices.push({ accountId: a.accountId, accountName: String(a.accountName ?? a.accountId), roleName: r.roleName })
    }
  }
  return choices
}

async function loginAwsSso($, typedUrl, typedRegion) {
  let url = String(typedUrl || ssoUrlDraft || '').trim()
  if (url && !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(url)) url = 'https://' + url
  const region = String(typedRegion || ssoRegionDraft || '').trim()
  const bad = !AWS_SSO_URL_RE.test(url) || (url.startsWith('https://identitycenter.amazonaws.com/') && !AWS_SSO_ISSUER_RE.test(url))
    ? 'Not a usable SSO start URL. Use mycompany.awsapps.com/start, or the issuer URL identitycenter.amazonaws.com/ssoins-<16 hex digits> (nothing after it).'
    : !AWS_REGION_RE.test(region)
      ? 'Type the SSO region, like us-east-1 (where Identity Center lives).'
      : ''
  if (bad) {
    awsSso = { ...awsSso, status: 'idle', last: { ok: false, secs: null, note: bad } }
    $.ui.invalidate('ui.render')
    return $.ui.toast(bad)
  }
  let home = ''
  try {
    home = (await $.env.get('HOME')) ?? ''
  } catch {}
  if (!home) return $.ui.toast('Cannot add a profile: HOME is not set')

  const session = 'kube-deck-' + url.slice('https://'.length).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)
  awsSso = { status: 'logging', choices: [], session, region, last: null }
  $.ui.invalidate('ui.render')
  const started = await $.clock.now()
  let note = ''
  let choices = []
  try {
    let text = ''
    try {
      text = String(await $.fs.read(home + '/.aws/config'))
    } catch {}
    const existing = parseAwsConfig(text)['sso-session ' + session]
    if (existing && String(existing.sso_start_url ?? '').replace(/[#/]+$/, '') !== url.replace(/[#/]+$/, '')) {
      throw new Error('~/.aws/config already has [sso-session ' + session + '] with a different sso_start_url; fix or remove that block')
    }
    if (!existing) {
      await appendAwsConfig($, home, '[sso-session ' + session + ']\nsso_start_url = ' + url + '\nsso_region = ' + region + '\nsso_registration_scopes = sso:account:access\n')
    }
    const r = await $.process.run([AWS_CLI, 'sso', 'login', '--sso-session', session], { timeoutMs: AWS_LOGIN_MS })
    if (r.exitCode !== 0) {
      // the AWS CLI often puts the reason on the line after "An error occurred (...):", so keep two lines
      const lines = String(r.stderr || r.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2).join(' ')
      note = 'exit ' + r.exitCode + (lines ? ': ' + lines.replace(/https?:\/\/\S+/g, '<url>').replace(/^aws: \[ERROR\]: /, '').slice(0, 220) : '')
    } else {
      const token = await findSsoToken($, home, url)
      if (!token) note = 'logged in, but no SSO token was found in ~/.aws/sso/cache'
      else choices = await listSsoChoices($, token, region)
      if (!note && choices.length === 0) note = 'logged in, but no accounts or roles are available to you'
    }
  } catch (err) {
    note = String((err && err.message) || err || 'failed').replace(/https?:\/\/\S+/g, '<url>').slice(0, 220)
  }
  const secs = Math.round(((await $.clock.now()) - started) / 1000)
  awsSso = { status: 'idle', choices, session, region, last: note ? { ok: false, secs, note } : { ok: true, secs, note: '' } }
  if (!note) {
    ssoUrlDraft = ''
    $.ui.toast('Signed in. Pick the account and role to add as a profile.')
  } else {
    $.ui.toast('AWS SSO login did not finish after ' + secs + 's (' + note + ')')
  }
  $.ui.invalidate('ui.render')
}

// Writes the profile for a picked account/role (unless it exists) and switches to it.
async function addSsoProfile($, index) {
  const c = awsSso.choices[Number(index)]
  if (!c) return
  let home = ''
  try {
    home = (await $.env.get('HOME')) ?? ''
  } catch {}
  if (!home) return
  const name = (c.accountName + '-' + c.roleName).replace(/[^A-Za-z0-9_.@+=,-]+/g, '-').replace(/^[^A-Za-z0-9_]+/, '')
  if (!AWS_PROFILE_RE.test(name)) return $.ui.toast('Cannot make a profile name from that account')
  await resolveAws($)
  if (!awsProfiles.includes(name)) {
    await appendAwsConfig($, home, '[profile ' + name + ']\nsso_session = ' + awsSso.session + '\nsso_account_id = ' + c.accountId + '\nsso_role_name = ' + c.roleName + '\nregion = ' + awsSso.region + '\n')
    await resolveAws($)
  }
  awsSso = { ...awsSso, choices: [] }
  await switchAws($, name)
  $.ui.toast('Profile ' + name + ' added to ~/.aws/config and selected')
}

// ---- the dropdowns: switch AWS profile / kubeconfig for this session
// `$.env.set` changes the variable for this process and everything it starts later, which
// includes the shell commands Claude runs. Nothing on disk changes (no `oc config use-context`,
// no edit to ~/.aws/config), so closing the session puts everything back.
async function discoverKubeconfigs($) {
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

// `export NAME='value'; ` for each picked variable. Values are quoted, so a path with a space
// or a quote in it stays one word.
function exportPrefix(vars) {
  return Object.entries(vars)
    .map(([k, v]) => 'export ' + k + "='" + String(v).replace(/'/g, "'\\''") + "'; ")
    .join('')
}

async function getPicked($) {
  try {
    return (await $.state.get(PICKED_REF)).value ?? {}
  } catch {
    return {}
  }
}

// What Claude's shell must be given so it matches the panel: everything picked, plus the AWS
// profile on show when it did not come from AWS_PROFILE (.aws-profile, or the only profile).
async function shellExports($) {
  return { ...(aws.profile && awsSource !== 'env' ? { AWS_PROFILE: aws.profile } : {}), ...(await getPicked($)) }
}

// Only values the dropdown offered are accepted, never free text.
async function switchAws($, name) {
  // "already selected" only counts once it has been exported: a profile the panel shows because
  // it is the only one in ~/.aws/config is not set in Claude's shell until it is picked.
  if (!awsProfiles.includes(name) || (name === aws.profile && (await getPicked($)).AWS_PROFILE === name)) return
  const r = await $.env.set('AWS_PROFILE', name)
  if (r?.deny) return $.ui.toast('Could not switch AWS profile: ' + r.deny)
  await update($, pickedAtom, (p) => ({ ...p, AWS_PROFILE: name }))
  await resolveAws($) // reads the new AWS_PROFILE and resets what we knew about the old one
  $.ui.toast('AWS profile is now ' + name + ' (commands Claude runs from now on)')
  checkAws($, true).catch(() => {})
}

async function switchKubeconfig($, path) {
  if (!kubeconfigs.includes(path) || path === kubeconfig) return
  const r = await $.env.set('KUBECONFIG', path)
  if (r?.deny) return $.ui.toast('Could not switch kubeconfig: ' + r.deny)
  // an approve-all given for the old cluster must not carry over to the new one
  const wasArmed = approveAll
  if (wasArmed) await setApprove($, false)
  await update($, pickedAtom, (p) => ({ ...p, KUBECONFIG: path }))
  kubeconfig = path
  await refreshCluster($) // re-judges prod / non-prod for the new file
  $.ui.toast('Kubeconfig is now ' + path.split('/').pop() + (wasArmed ? '; approve-all switched off' : ''))
}

// Logs in to a cluster through the browser (`oc login --web`) into a kubeconfig file of its own,
// so no kubeconfig has to exist first and no other file is touched. No password or token passes
// through the panel. Logging in again to the cluster already in use refreshes that same file.
async function loginKube($, typed) {
  // "api.x.example.com:6443" works too: https:// is added when no scheme was typed
  let url = String(typed || kubeServerDraft || cluster.server || '').trim().replace(/\/+$/, '')
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
  const host = /^https:\/\/([^:/]+)/.exec(url)[1].replace(/^api\./, '').replace(/[^A-Za-z0-9]+/g, '-')
  const reuse = kubeconfig && url === cluster.server
  const file = reuse ? kubeconfig : home + '/.kube/' + host + '.kubeconfig'
  kubeLogin = { status: 'logging', last: null }
  $.ui.invalidate('ui.render')
  const started = await $.clock.now()
  let ok = false
  let note = ''
  try {
    const r = await $.process.run([KUBE_CLI, 'login', '--web', '--server=' + url], {
      timeoutMs: KUBE_LOGIN_MS,
      env: { KUBECONFIG: file },
    })
    ok = r.exitCode === 0
    if (!ok) {
      const line = String(r.stderr || r.stdout || '').split('\n').map((l) => l.trim()).find(Boolean) ?? ''
      note = 'exit ' + r.exitCode + (line ? ': ' + line.replace(/https?:\/\/\S+/g, '<url>').slice(0, 120) : '')
    }
  } catch (err) {
    note = String((err && err.message) || err || 'failed').replace(/https?:\/\/\S+/g, '<url>').slice(0, 120)
  }
  const secs = Math.round(((await $.clock.now()) - started) / 1000)
  kubeLogin = { status: 'idle', last: { ok, secs, note } }
  if (ok) {
    kubeServerDraft = ''
    await discoverKubeconfigs($)
    if (file === kubeconfig) await refreshCluster($)
    else await switchKubeconfig($, file) // also re-judges prod and switches approve-all off
    $.ui.toast('Logged in to ' + host)
  } else {
    $.ui.toast('Cluster login did not finish after ' + secs + 's (' + (note || 'no detail') + ')')
  }
  $.ui.invalidate('ui.render')
}

// ---- approve-all with an expiry
async function setApprove($, on) {
  approveAll = on
  approveUntil = on ? (await $.clock.now()) + APPROVE_MINUTES * 60000 : 0
  $.ui.invalidate('ui.render')
}

// True while approve-all is on and not expired. Checked on every guarded command, so it holds
// even if the timer below never fired.
async function approveActive($) {
  if (!approveAll) return false
  if ((await $.clock.now()) < approveUntil) return true
  approveAll = false
  approveUntil = 0
  $.ui.toast('kube-deck: approve-all expired, asking again')
  $.ui.invalidate('ui.render')
  return false
}

function mmss(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0')
}

// ---- todos
// Point the todo list at the current project root and load it. Called at session start,
// on every prompt (the root can move with /cd or a worktree) and before the model's tool runs.
async function loadTodos($) {
  let root = ''
  try {
    root = await $.session.root()
  } catch {}
  projectRoot = root
  todoKey = root ? 'todos:' + root : 'todos'
  repoName = root.split('/').filter(Boolean).pop() ?? ''
  const stored = await $.store.get(todoKey)
  todos = Array.isArray(stored) ? stored : []
  $.ui.invalidate('ui.render')
}

async function mutateTodos($, change) {
  // read right before writing: other sessions share $.store
  const stored = await $.store.get(todoKey)
  todos = change(Array.isArray(stored) ? stored : [])
  await $.store.set(todoKey, todos)
  $.ui.invalidate('ui.render')
}

function formatTodos() {
  if (todos.length === 0) return 'The todo list for this repo is empty.'
  return todos.map((t) => t.id + ' ' + (t.done ? '[x]' : '[ ]') + ' ' + t.text).join('\n')
}

// ---- activity feed and audit log
function maskCommand(command) {
  return command
    .replace(/(--(?:token|password|client-secret)(?:=|\s+))\S+/gi, '$1***')
    .replace(/(sha256~)\S+/g, '$1***')
}

function record(at, command, outcome) {
  const cmd = maskCommand(command).replace(/\s+/g, ' ').trim()
  activity = [
    { at, cluster: cluster.name || '?', isProd: cluster.isProd, cmd: cmd.length > 160 ? cmd.slice(0, 160) + '…' : cmd, outcome },
    ...activity,
  ].slice(0, 8)
}

function hhmm(ms) {
  try {
    const d = new Date(ms)
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
  } catch {
    return ''
  }
}

function isoTime(ms) {
  try {
    return new Date(ms).toISOString()
  } catch {
    return String(ms)
  }
}

// Append one JSON line with `tee -a` (O_APPEND: safe with several sessions writing at once;
// $.fs.write would replace the whole file). Best effort, but a failure is never silent.
async function audit($, at, command, outcome, retarget) {
  try {
    const home = (await $.env.get('HOME')) ?? ''
    if (!home) throw new Error('no HOME')
    const dir = home + '/' + AUDIT_DIR
    // The log holds full command lines: keep it private to this user (dir 0700, file 0600).
    await $.process.run(['mkdir', '-p', dir], { timeoutMs: 3000 })
    await $.process.run(['chmod', '700', dir], { timeoutMs: 3000 })
    const line = JSON.stringify({
      ts: isoTime(at),
      outcome,
      cluster: cluster.name || null,
      prod: cluster.isProd,
      project: cluster.namespace || null,
      repo: projectRoot || null,
      retargeted: retarget || undefined,
      command: maskCommand(command),
    })
    // umask 077 so a new file is born 0600; chmod below also fixes a file made by an older version.
    const file = dir + '/audit.jsonl'
    const r = await $.process.run(['sh', '-c', 'umask 077; exec tee -a "$1" >/dev/null', 'sh', file], { stdin: line + '\n', timeoutMs: 3000 })
    if (r.exitCode !== 0) throw new Error('tee exit ' + r.exitCode)
    await $.process.run(['chmod', '600', file], { timeoutMs: 3000 })
  } catch {
    $.ui.toast('kube-deck: audit log write FAILED for a cluster command')
  }
}

// ---- output redaction
// Applied to the output of cluster commands before the model reads it.
async function redactResult($, command, result) {
  if (!result || result.deny) return result

  if (result.isError) {
    // An errored call's output arrives as one text; if it holds secrets, withhold it whole.
    const e = redactOutput(command, String(result.text ?? ''))
    if (e.redacted > 0 || e.withheld) {
      $.ui.toast('kube-deck withheld a command error that contained secret values')
      return { deny: 'kube-deck withheld this output because it contained secret values.' }
    }
    return result
  }

  const out = result.result
  if (!out || typeof out !== 'object' || typeof out.stdout !== 'string') return result
  const o = redactOutput(command, out.stdout)
  const er = redactOutput(command, typeof out.stderr === 'string' ? out.stderr : '')
  if (o.redacted === 0 && er.redacted === 0) return result

  $.ui.toast(
    o.withheld || er.withheld
      ? 'kube-deck withheld a command output that prints credentials'
      : 'kube-deck redacted ' + (o.redacted + er.redacted) + ' secret value(s) from a command output',
  )
  // A fresh object (no `text`/`ref` of core's) so the model is given the redacted result.
  return {
    result: { ...out, stdout: o.text, stderr: er.text },
    ...(result.context ? { context: result.context } : {}),
  }
}

function describeVerdict(verdict, command) {
  const where = cluster.known
    ? cluster.name + (cluster.namespace ? ' / ' + cluster.namespace : '') + (cluster.isProd ? ' (' + levelLabel() + ')' : '')
    : 'unknown cluster'
  const why = verdict.retarget
    ? 'This command sets its own cluster/context, so the panel may not show where it lands.'
    : 'It changes cluster state.'
  const shown = command.length > 300 ? command.slice(0, 300) + '…' : command
  return 'Run on ' + where + '? ' + why + '\n' + shown
}

// ---------------------------------------------------------------- module
export function register(on) {
  // One session.start hook per module (a second one without a matcher fails to load).
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'todo',
      description: 'Open the todo list, or "/todo add <text>"',
      immediate: true,
    })
    await $.command.register({
      name: 'deck',
      description: 'Open the kube-deck panel (cluster, guard, todos); "/deck close" closes it',
      immediate: true,
    })
    await $.command.register({
      name: 'approve-all',
      description: 'Toggle approve-all (switches itself off after ' + APPROVE_MINUTES + ' minutes)',
      immediate: true,
    })
    await $.command.register({
      name: 'ctx',
      description: 'Re-read the kubeconfig and show cluster, project and guard state',
      immediate: true,
    })
    await $.command.register({
      name: 'aws-login',
      description: 'Run aws sso login for the panel\'s AWS profile (opens the browser)',
      immediate: true,
    })
    await $.command.register({
      name: 'aws-sso-login',
      description: 'Add an AWS profile from an SSO start URL: /aws-sso-login mycompany.awsapps.com/start us-east-1 (browser login, then pick account/role in the panel)',
      immediate: true,
    })
    await $.command.register({
      name: 'kube-login',
      description: 'Log in to a cluster in the browser: /kube-login https://api.mycluster.example.com:6443 (no URL = the current cluster)',
      immediate: true,
    })
    await $.command.register({
      name: 'audit',
      description: 'Show the audit log path and its last 10 entries',
      immediate: true,
    })
    // The tool Claude uses to read and update this repo's todo list. No delete:
    // removing items stays with you. isDeferred:false keeps its schema in the prompt so
    // "add that to my todo" works without a ToolSearch hop (costs a few tokens per request).
    await $.tool.register({
      name: 'todo',
      description:
        "The user's todo list for this repository, shown in their side panel. Add items " +
        'proactively for concrete follow-ups that come up while you work; the user discards ' +
        'the ones they do not want. Actions: list; add (needs text); done (needs id); ' +
        'update (needs id and text, only after the user agreed to the change).',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'add', 'done', 'update'] },
          text: { type: 'string', description: 'One short, actionable line, for add and update' },
          id: { type: 'string', description: 'The item id, for done and update' },
        },
        required: ['action'],
      },
      isDeferred: false,
    })
    await loadTodos($)
    await refreshCluster($)
    await resolveAws($)
    await discoverKubeconfigs($)
    // Count down approve-all and switch it off when time is up. Runs once a second but only
    // does anything while approve-all is on. (The timer stops when the module reloads.)
    $.clock.every(1000, async () => {
      try {
        if (approveAll) {
          await approveActive($)
          $.ui.invalidate('ui.render')
        }
        if (kubeLoginWanted) {
          kubeLoginWanted = false
          await loginKube($)
        }
        if (awsSsoWanted) {
          awsSsoWanted = false
          await loginAwsSso($)
        }
        if (awsLoginWanted) {
          awsLoginWanted = false
          await loginAws($)
        }
      } catch {}
    })
    // The AWS login check runs in the background so it never delays a prompt: once soon after
    // start, then whenever the last check is older than AWS_CHECK_MS.
    $.clock.after(1000, () => checkAws($, false).catch(() => {}))
    $.clock.every(30000, () => checkAws($, false).catch(() => {}))
    // Open the panel unfocused. In a narrow terminal it waits (isPlaced false); /deck opens it.
    try {
      await $.ui.open({ id: PANE, title: 'kube-deck', columns: PANE_COLUMNS })
    } catch {}
    return next(e)
  })

  // Per prompt: the project root can move (/cd, worktrees) and the namespace or login may
  // have changed in another terminal, so re-read both. Never blocks the prompt on a failure.
  on('prompt.submit', async ($, e, next) => {
    try {
      await loadTodos($)
      await refreshCluster($)
      await resolveAws($)
      await discoverKubeconfigs($)
    } catch {}
    return next(e)
  })

  // ---- the model's side of the todo list
  on('tool.call', { tool: TODO_TOOL }, async ($, e) => {
    await loadTodos($) // another session may have changed the list
    if (e.action === 'list') return { result: formatTodos() }

    if (e.action === 'add') {
      const text = String(e.text ?? '').trim()
      if (!text) return { deny: 'add needs a non-empty "text".' }
      // skip duplicates, so proactive adding can't pile up the same item
      const dup = todos.find((t) => !t.done && t.text.trim().toLowerCase() === text.toLowerCase())
      if (dup) return { result: 'Already on the list as ' + dup.id + ': ' + dup.text }
      const item = { id: newId(), text, done: false, by: 'claude' }
      await mutateTodos($, (list) => [...list, item])
      $.ui.toast('Claude added a todo: ' + text)
      return { result: 'Added ' + item.id + ': ' + text }
    }

    if (e.action === 'update') {
      const text = String(e.text ?? '').trim()
      const item = todos.find((t) => t.id === e.id)
      if (!item || !text) return { deny: 'update needs an existing "id" (see action "list") and non-empty "text".' }
      await mutateTodos($, (list) => list.map((t) => (t.id === item.id ? { ...t, text } : t)))
      $.ui.toast('Claude updated a todo: ' + text)
      return { result: 'Updated ' + item.id + ': ' + text }
    }

    if (e.action === 'done') {
      const item = todos.find((t) => t.id === e.id)
      if (!item) return { deny: 'No todo with id "' + e.id + '". Call the tool with action "list" to see the ids.' }
      await mutateTodos($, (list) => list.map((t) => (t.id === item.id ? { ...t, done: true } : t)))
      $.ui.toast('Claude ticked off: ' + item.text)
      return { result: 'Marked done: ' + item.text }
    }

    return { deny: 'action must be one of: list, add, done, update.' }
  })

  // A static nudge so Claude actually uses the todo tool. The text never changes between
  // requests, so it does not break the prompt cache.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    return {
      sections: [
        ...composed.sections,
        {
          id: 'kube-deck:todo',
          scope: 'session',
          text:
            "The user keeps a todo list for this repo, shown in their side panel. Whenever a concrete " +
            'follow-up comes up while you work (something left undone, a problem you noticed but were ' +
            'not asked to fix, a check to do later), add it with the todo tool without asking: one ' +
            'short, actionable line each, no more than a few per turn, nothing vague. The user ' +
            'discards items they do not want. Change an existing item only after discussing it with ' +
            'the user. Tick items off when you finish them.',
        },
      ],
    }
  })

  // ---- commands
  on('command.run', { command: 'todo' }, async ($, e) => {
    const args = String(e.args ?? '').trim()
    await loadTodos($)
    if (args.startsWith('add')) {
      const text = args.slice(3).trim()
      if (!text) return { text: 'usage: /todo add <text>' }
      await mutateTodos($, (list) => [...list, { id: newId(), text, done: false }])
      return { text: 'added: ' + text }
    }
    await $.ui.open({ id: PANE, title: 'kube-deck', columns: PANE_COLUMNS, focus: true, closeOnEscape: true })
    return {}
  })

  on('command.run', { command: 'deck' }, async ($, e) => {
    if (String(e.args ?? '').trim() === 'close') {
      await $.ui.close({ id: PANE })
      return {}
    }
    await refreshCluster($)
    await loadTodos($)
    await $.ui.open({ id: PANE, title: 'kube-deck', columns: PANE_COLUMNS, focus: true, closeOnEscape: true })
    return {}
  })

  on('command.run', { command: 'approve-all' }, async ($) => {
    const turnOn = !(await approveActive($))
    await setApprove($, turnOn)
    return {
      text: turnOn
        ? 'approve-all is ON for ' + APPROVE_MINUTES + ' min: cluster-changing commands run without asking, prod included'
        : 'approve-all is off',
    }
  })

  on('command.run', { command: 'ctx' }, async ($) => {
    await refreshCluster($)
    await resolveAws($)
    await discoverKubeconfigs($)
    return {
      text:
        (cluster.known ? cluster.name : 'no cluster found') +
        ' | project: ' + (cluster.namespace || 'default') +
        ' | prod: ' + cluster.isProd + ' (' + levelLabel() + ')' +
        ' | approve-all: ' + (await approveActive($)) +
        ' | aws: ' + (aws.profile ? aws.profile + ' (' + aws.status + ')' : 'no profile'),
    }
  })

  on('command.run', { command: 'aws-login' }, async ($) => {
    await resolveAws($)
    if (!aws.profile) return { text: 'no AWS profile found (set AWS_PROFILE, or put one in .aws-profile)' }
    await loginAws($)
    return { text: 'aws: ' + aws.profile + ' (' + aws.status + ')' }
  })

  on('command.run', { command: 'aws-sso-login' }, async ($, e) => {
    const [url, region] = String(e.args ?? '').trim().split(/\s+/)
    await loginAwsSso($, url, region)
    return {
      text: awsSso.last?.ok
        ? awsSso.choices.length + ' account/role(s) found: pick one in the AWS card'
        : 'AWS SSO login: ' + (awsSso.last?.note || 'nothing happened'),
    }
  })

  on('command.run', { command: 'kube-login' }, async ($, e) => {
    await loginKube($, String(e.args ?? '').trim())
    await refreshCluster($)
    return { text: (cluster.known ? cluster.name + ' (' + levelLabel() + ')' : 'no cluster found') + (kubeLogin.last && !kubeLogin.last.ok ? ' | last login failed: ' + kubeLogin.last.note : '') }
  })

  on('command.run', { command: 'audit' }, async ($) => {
    let path = AUDIT_DIR + '/audit.jsonl'
    try {
      path = ((await $.env.get('HOME')) ?? '') + '/' + path
      const raw = await $.fs.read(path)
      const lines = String(raw).split('\n').filter(Boolean).slice(-10)
      const rows = lines.map((l) => {
        try {
          const a = JSON.parse(l)
          return (a.ts ?? '').slice(0, 19).replace('T', ' ') + '  ' + String(a.outcome).padEnd(8) + ' ' + (a.cluster ?? '?') + '  ' + a.command
        } catch {
          return l
        }
      })
      return { text: path + '\n' + (rows.length ? rows.join('\n') : '(empty)') }
    } catch {
      return { text: path + '\n(no entries yet, or the file is unreadable)' }
    }
  })

  // ---- the guard: ask on prod, redact secrets from the output, write the audit log
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const verdict = classify(e.command)
    // what the shell actually runs: the picked AWS profile / kubeconfig first, then the command.
    // The checks below look at the original command, so they are not fooled by the prefix.
    const prefix = exportPrefix(await shellExports($))
    const go = (ev) => next(prefix ? { ...ev, command: prefix + ev.command } : ev)
    if (!verdict.touches) return go(e)

    // the kubeconfig or the project may have changed since the last call
    await refreshCluster($)

    const at = await $.clock.now()
    const auto = await approveActive($)
    const wouldAsk = verdict.mutating && (cluster.isProd || verdict.retarget)
    const needsApproval = wouldAsk && !auto
    if (needsApproval) {
      let answer = 'Refuse' // a dismissed question must refuse
      try {
        answer = await $.ui.ask(describeVerdict(verdict, e.command), ['Run it', APPROVE_LABEL, 'Refuse'])
      } catch {}
      if (answer === APPROVE_LABEL) {
        await setApprove($, true)
      } else if (answer !== 'Run it') {
        record(at, e.command, 'refused')
        await audit($, at, e.command, 'refused', verdict.retarget)
        $.ui.invalidate('ui.render')
        return { deny: 'The user declined this cluster command. Do not retry it; ask what they want instead.' }
      }
    }
    if (verdict.mutating) {
      const outcome = needsApproval ? 'approved' : wouldAsk ? 'auto' : 'non-prod'
      record(at, e.command, outcome)
      await audit($, at, e.command, outcome, verdict.retarget)
      $.ui.invalidate('ui.render')
    }

    const result = await go(e)
    await refreshCluster($) // e.g. `oc project foo` just changed the namespace
    return await redactResult($, e.command, result)
  }).catch(async ($, e, next) => ({
    deny: next.called
      ? 'kube-deck failed after the command ran (' + next.error.kind + '), so its output was withheld as a precaution. Tell the user.'
      : 'The kube-deck guard failed (' + next.error.kind + '), so this command was not run. Tell the user.',
  }))

  // ---- the panel: cluster, guard, todos, recent cluster commands, as bordered cards.
  // Colors are theme keys (THEME, top of file), so the panel follows light/dark mode.
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const { Box, Text, Button, Input, Select } = $.ui.resolve(e)
    const now = await $.clock.now()
    const armed = approveAll && now < approveUntil

    const spacer = () => Text({ children: [' '] })
    // a filled label: " PROD ", " ON 14:32 "
    const chip = (label, bg) =>
      Text({ bold: true, color: THEME.onColor, backgroundColor: bg, children: [' ' + label + ' '] })
    // "label  value" pair, label muted
    const field = (label, value, valueColor) =>
      Box({
        flexDirection: 'row',
        columnGap: 1,
        children: [
          Text({ color: THEME.muted, children: [label.padEnd(8)] }),
          Box({ flexGrow: 1, children: [Text({ color: valueColor, wrap: 'truncate-end', children: [value] })] }),
        ],
      })
    // A card: coloured border, a header row (title left, status right), then groups of rows
    // separated by a blank line so the card breathes.
    const card = (title, right, color, groups) =>
      Box({
        flexDirection: 'column',
        borderStyle: 'round',
        borderColor: color ?? THEME.muted,
        paddingX: 1,
        rowGap: 1,
        children: [
          Box({
            flexDirection: 'row',
            justifyContent: 'space-between',
            children: [
              Text({ bold: true, color: color ?? THEME.text, wrap: 'truncate-middle', children: [title] }),
              right ?? spacer(),
            ],
          }),
          ...groups.map((g) => Box({ flexDirection: 'column', children: g })),
        ],
      })

    // ---- cluster
    const startKubeLogin = () => {
      if (kubeLogin.status === 'logging' || kubeLoginWanted) return
      kubeLoginWanted = true
      kubeLogin = { status: 'logging', last: null }
      $.ui.invalidate('ui.render')
    }
    const level = cluster.level === 'nonprod' ? THEME.ok : cluster.level === 'unlisted' ? THEME.warn : THEME.danger
    const badge =
      cluster.level === 'strict'
        ? chip('STRICT', THEME.danger)
        : cluster.level === 'prod'
          ? chip('PROD', THEME.danger)
          : cluster.level === 'unlisted'
            ? chip('UNLISTED', THEME.warn)
            : chip('non-prod', THEME.ok)
    const clusterCard = card(cluster.known ? cluster.name : 'no cluster found', badge, level, [
      [field('project', cluster.namespace || 'default', THEME.text)],
      ...(kubeconfigs.length > 0
        ? [
            [
              Select({
                key: 'kubeconfig-select',
                label: 'kubeconfig',
                options: kubeconfigs.map((f) => ({ value: f, label: f.split('/').pop() })),
                value: kubeconfig || undefined,
                onSelect: (value) => switchKubeconfig($, value),
              }),
            ],
          ]
        : []),
      [
        Box({
          flexDirection: 'row',
          columnGap: 1,
          children: [
            Input({
              key: 'kube-server',
              label: 'api',
              placeholder: cluster.server ? 'API URL (empty = this cluster)' : 'api.mycluster.example.com:6443',
              value: kubeServerDraft,
              submitLabel: 'log in',
              onInput: (value) => {
                kubeServerDraft = value
              },
              onSubmit: () => startKubeLogin(),
            }),
          ],
        }),
        Button({
          key: 'kube-login',
          label: kubeLogin.status === 'logging' ? '…  Approve in your browser' : '▶  Log in (browser)',
          variant: 'primary',
          hover: { scope: 'hv-kube-login', color: THEME.onColor, backgroundColor: THEME.accent },
          onPress: () => startKubeLogin(),
        }),
      ],
      ...(kubeLogin.last && !kubeLogin.last.ok && kubeLogin.status !== 'logging'
        ? [[Text({ color: THEME.warn, wrap: 'wrap', children: [kubeLogin.last.secs == null ? kubeLogin.last.note : 'Last login attempt ended after ' + kubeLogin.last.secs + 's: ' + (kubeLogin.last.note || 'no detail')] })]]
        : []),
    ])

    // ---- aws: profile, region, signed-in role, and whether the login still works
    const AWS_BADGE = {
      ok: chip('signed in', THEME.ok),
      expired: chip('SSO EXPIRED', THEME.danger),
      error: chip('unreachable', THEME.warn),
      checking: Text({ color: THEME.muted, children: ['… checking'] }),
      logging: Text({ color: THEME.accent, children: ['… logging in'] }),
      unknown: Text({ color: THEME.muted, children: ['… not checked'] }),
      none: Text({ color: THEME.muted, children: ['no profile'] }),
    }
    const startAwsSso = () => {
      if (awsSso.status === 'logging' || awsSsoWanted) return
      awsSsoWanted = true
      awsSso = { ...awsSso, status: 'logging', choices: [], last: null }
      $.ui.invalidate('ui.render')
    }
    const awsColor = aws.status === 'logging' ? THEME.accent : aws.status === 'ok' ? THEME.ok : aws.status === 'expired' ? THEME.danger : aws.status === 'error' ? THEME.warn : THEME.muted
    const awsCard = card('AWS', AWS_BADGE[aws.status], awsColor, [
      [
        field('profile', aws.profile || '(none)', aws.profile ? THEME.text : THEME.muted),
        ...(aws.region ? [field('region', aws.region, THEME.text)] : []),
        ...(aws.role ? [field('role', aws.role, THEME.text)] : []),
        ...(aws.checkedAt ? [field('checked', hhmm(aws.checkedAt), THEME.muted)] : []),
      ],
      ...(awsProfiles.length > 1
        ? [
            [
              Select({
                key: 'aws-profile-select',
                label: 'profile',
                options: awsProfiles.map((n) => ({ value: n })),
                value: aws.profile,
                onSelect: (value) => switchAws($, value),
              }),
            ],
          ]
        : []),
      ...(aws.status === 'expired'
        ? [[Text({ color: THEME.danger, wrap: 'wrap', children: ['Press Log in, or run in a terminal: aws sso login --profile ' + aws.profile] })]]
        : aws.status === 'error'
          ? [[Text({ color: THEME.warn, wrap: 'wrap', children: ['Could not reach AWS (network, or the CLI failed). Login state is unknown.'] })]]
          : []),
      ...(aws.lastLogin && !aws.lastLogin.ok && aws.status !== 'ok' && aws.status !== 'logging'
        ? [[Text({ color: THEME.warn, wrap: 'wrap', children: ['Last login attempt ended after ' + aws.lastLogin.secs + 's: ' + (aws.lastLogin.note || 'no detail')] })]]
        : []),
      ...(aws.status === 'expired' || aws.status === 'error' || aws.status === 'logging'
        ? [
            [
              Button({
                key: 'aws-login',
                label: aws.status === 'logging' ? '…  Approve in your browser' : '▶  Log in with SSO',
                variant: 'primary',
                hover: { scope: 'hv-aws-login', color: THEME.onColor, backgroundColor: THEME.accent },
                onPress: () => {
                  if (aws.status === 'logging' || awsLoginWanted) return
                  awsLoginWanted = true
                  aws.status = 'logging'
                  $.ui.invalidate('ui.render')
                },
              }),
            ],
          ]
        : []),
      [
        Input({
          key: 'aws-sso-url',
          label: 'sso',
          placeholder: 'mycompany.awsapps.com/start',
          value: ssoUrlDraft,
          submitLabel: 'next',
          onInput: (value) => {
            ssoUrlDraft = value
          },
          onSubmit: () => {},
        }),
        Input({
          key: 'aws-sso-region',
          label: 'region',
          placeholder: 'SSO region, like us-east-1',
          value: ssoRegionDraft,
          submitLabel: 'log in',
          onInput: (value) => {
            ssoRegionDraft = value
          },
          onSubmit: () => startAwsSso(),
        }),
        Button({
          key: 'aws-sso-login',
          label: awsSso.status === 'logging' ? '…  Approve in your browser' : '▶  Add profile via SSO',
          variant: 'primary',
          hover: { scope: 'hv-aws-sso', color: THEME.onColor, backgroundColor: THEME.accent },
          onPress: () => startAwsSso(),
        }),
      ],
      ...(awsSso.choices.length > 0
        ? [
            [
              Select({
                key: 'aws-sso-pick',
                label: 'account',
                options: awsSso.choices.map((c, i) => ({ value: String(i), label: c.accountName + ' · ' + c.roleName })),
                onSelect: (value) => addSsoProfile($, value),
              }),
            ],
          ]
        : []),
      ...(awsSso.last && !awsSso.last.ok && awsSso.status !== 'logging'
        ? [[Text({ color: THEME.warn, wrap: 'wrap', children: [awsSso.last.secs == null ? awsSso.last.note : 'SSO login ended after ' + awsSso.last.secs + 's: ' + awsSso.last.note] })]]
        : []),
      ...(aws.profile
        ? [
            [
              Button({
                key: 'aws-recheck',
                label: '↻  Recheck',
                variant: 'secondary',
                hover: { scope: 'hv-aws', color: THEME.onColor, backgroundColor: THEME.accent },
                onPress: () => checkAws($, true),
              }),
            ],
          ]
        : []),
    ])

    // ---- guard
    const guardCard = card(
      'Guard',
      armed ? chip('ON · ' + mmss(approveUntil - now), THEME.warn) : Text({ color: THEME.ok, children: ['● guarding'] }),
      armed ? THEME.warn : THEME.accent,
      [
        [
          Button({
            key: 'approve-all',
            label: armed ? '■  ON · press to stop  (a)' : '▶  Approve all  (a)',
            hotkey: 'a',
            variant: armed ? 'primary' : 'secondary',
            hover: { scope: 'hv-approve', color: THEME.onColor, backgroundColor: armed ? THEME.warn : THEME.accent },
            onPress: async () => {
              await setApprove($, !armed)
            },
          }),
        ],
        [
          Text({
            color: armed ? THEME.warn : THEME.muted,
            wrap: 'wrap',
            children: [
              armed
                ? 'Changes run WITHOUT asking, prod included, until the timer ends.'
                : cluster.level === 'unlisted'
                  ? 'Name not in NONPROD_PATTERNS, so treated as prod: asking before every cluster-changing command.'
                  : cluster.isProd
                  ? 'Asking before every cluster-changing command.'
                  : 'Non-prod: only commands that set their own target are asked.',
            ],
          }),
          Text({ color: THEME.muted, wrap: 'wrap', children: ['Secrets are redacted from output. Log: /audit'] }),
        ],
      ],
    )

    // ---- todos: open tasks in the Todo card, finished ones in the Done card
    const open = todos.filter((t) => !t.done)
    const finished = todos.filter((t) => t.done)
    const doneCount = finished.length
    const bar = todos.length === 0 ? '' : '▰'.repeat(doneCount) + '▱'.repeat(open.length) + ' '
    const addTodo = async (value) => {
      const text = String(value ?? '').trim()
      if (!text) return
      draft = ''
      await mutateTodos($, (list) => [...list, { id: newId(), text, done: false }])
    }
    // A thin line between two tasks
    const divider = (id) =>
      Text({ key: 'sep-' + id, color: THEME.muted, dimColor: true, wrap: 'truncate', children: ['─'.repeat(PANE_COLUMNS)] })
    // One task row. No native checkbox element: a plain button that flips between two glyphs.
    const taskRow = (t) =>
      Box({
        flexDirection: 'column',
        children: [
          Box({
            flexDirection: 'row',
            columnGap: 1,
            children: [
              Button({
                key: 'done-' + t.id,
                label: t.done ? '☑' : '☐',
                plain: true,
                onPress: () =>
                  mutateTodos($, (list) => list.map((x) => (x.id === t.id ? { ...x, done: !x.done } : x))),
              }),
              Box({
                flexGrow: 1,
                children: [
                  Text({
                    color: t.done ? THEME.muted : THEME.text,
                    strikethrough: t.done,
                    wrap: 'wrap',
                    children: [t.text],
                  }),
                ],
              }),
              Button({
                key: 'del-' + t.id,
                label: '✕',
                plain: true,
                hover: { scope: 'hv-del-' + t.id, color: THEME.danger },
                onPress: () => mutateTodos($, (list) => list.filter((x) => x.id !== t.id)),
              }),
            ],
          }),
          ...(t.by === 'claude'
            ? [Box({ paddingLeft: 3, children: [Text({ color: THEME.brand, dimColor: true, children: ['✦ added by Claude'] })] })]
            : []),
        ],
      })
    // rows with a divider between each pair
    const withDividers = (list) => list.flatMap((t, i) => (i === 0 ? [taskRow(t)] : [divider(t.id), taskRow(t)]))

    const todoCard = card(
      'Todo' + (repoName ? ' · ' + repoName : ''),
      Text({ color: doneCount === todos.length && todos.length > 0 ? THEME.ok : THEME.muted, children: [bar + doneCount + '/' + todos.length] }),
      THEME.brand,
      [
        [
          Box({
            flexDirection: 'row',
            columnGap: 1,
            children: [
              Input({
                key: 'new-todo',
                label: 'new',
                placeholder: 'type a task, Enter',
                value: draft,
                submitLabel: 'add',
                onInput: (value) => {
                  draft = value
                },
                onSubmit: addTodo,
              }),
              Button({
                key: 'add-todo',
                label: '+ Add',
                variant: 'primary',
                hover: { scope: 'hv-add', color: THEME.onColor, backgroundColor: THEME.brand },
                onPress: () => addTodo(draft),
              }),
            ],
          }),
        ],
        open.length === 0
          ? [
              Text({
                color: THEME.muted,
                italic: true,
                children: [doneCount > 0 ? 'All caught up.' : 'Nothing yet. Add a task above, or ask Claude to.'],
              }),
            ]
          : withDividers(open),
      ],
    )

    // The Done card holds finished tasks and the Clear button. It only shows when there is something in it.
    const doneCard =
      doneCount === 0
        ? null
        : card(
            'Done',
            Text({ color: THEME.ok, children: [doneCount + ' finished'] }),
            THEME.ok,
            [
              withDividers(finished),
              [
                Button({
                  key: 'clear-done',
                  label: 'Clear done (' + doneCount + ')',
                  variant: 'secondary',
                  hover: { scope: 'hv-clear', color: THEME.onColor, backgroundColor: THEME.danger },
                  onPress: () => mutateTodos($, (list) => list.filter((x) => !x.done)),
                }),
              ],
            ],
          )

    // ---- recent cluster commands: one line each, time + outcome chip + the command
    const OUTCOME = {
      approved: ['approved', THEME.ok],
      refused: ['REFUSED', THEME.danger],
      auto: ['AUTO', THEME.warn],
      'non-prod': ['non-prod', THEME.muted],
    }
    const activityCard = card('Cluster commands', undefined, THEME.muted, [
      activity.length === 0
        ? [Text({ color: THEME.muted, italic: true, children: ['None this session.'] })]
        : activity.map((a) => {
            const [tag, bg] = OUTCOME[a.outcome] ?? [a.outcome, THEME.muted]
            return Box({
              flexDirection: 'row',
              columnGap: 1,
              children: [
                Text({ color: THEME.muted, children: [hhmm(a.at)] }),
                chip(tag, bg),
                Box({ flexGrow: 1, children: [Text({ color: THEME.muted, wrap: 'truncate-end', children: [a.cmd] })] }),
              ],
            })
          }),
    ])

    const footer = Text({ color: THEME.muted, children: ['/deck close  ·  ctrl+x tab focuses'] })

    // The cluster card (it holds the login), the AWS card (it holds the SSO setup) and the todo
    // card always show. The guard and command cards appear once a cluster is detected, a
    // cluster command has run, or approve-all is on. The guard itself never depends on what is
    // drawn: it acts on every cluster command either way.
    const showCluster = cluster.known || activity.length > 0 || armed || kubeconfigs.length > 0 || kubeLogin.status === 'logging'
    return Box({
      flexDirection: 'column',
      gap: 1,
      children: [
        Text({ bold: true, color: THEME.brand, children: ['◆ kube-deck'] }),
        clusterCard, // always: it holds the cluster login
        awsCard, // always: it holds the SSO profile setup
        ...(showCluster ? [guardCard] : []),
        todoCard,
        ...(doneCard ? [doneCard] : []),
        ...(showCluster ? [activityCard] : []),
        footer,
      ],
    })
  })
}
