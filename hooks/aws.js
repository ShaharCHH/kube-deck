// The AWS profile on show: its login state, the profile dropdown, and adding a profile from an SSO URL.

import { AWS_CHECK_MS, AWS_CLI, AWS_LOGIN_MS, AWS_PROFILE_RE, AWS_REGION_RE, AWS_SSO_ISSUER_RE, AWS_SSO_URL_RE } from './config.js'
import { getPicked, setPicked } from './picked.js'
import { drafts } from './shared.js'
import { projectRoot } from './todos.js'

// AWS profile (resolved like the old session bar did) and whether its login still works.
// status: none (no profile) | unknown | checking | logging | ok | expired | error
// lastLogin: how the last Log in attempt ended ({ ok, secs, note }), kept so a failure explains itself.
export let aws = { profile: '', region: '', role: '', status: 'none', checkedAt: 0, lastLogin: null }

// What the dropdowns offer: profile names from ~/.aws/config, kubeconfig files from ~/.kube.
// `kubeconfig` is the file in use (first KUBECONFIG entry), so the dropdown can show it.
export let awsProfiles = []

// Where the AWS profile on show came from: env (AWS_PROFILE, which Claude's shell has too, unless
// it was set by a pick), file (.aws-profile) or only (the one profile in ~/.aws/config). The last
// two are not in Claude's shell, so the guard exports them.
export let awsSource = 'env'

export let awsSso = { status: 'idle', choices: [], session: '', region: '', last: null }

// ---- aws
// Claude Code's environment is frozen at launch, so the profile is found in order, first hit
// wins: AWS_PROFILE, a one-line `.aws-profile` file in the project root, or the only
// `[profile X]` in ~/.aws/config.
export function parseAwsConfig(text) {
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

export async function resolveAws($) {
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
export async function checkAws($, force) {
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
export async function loginAws($) {
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
  if (aws.profile !== profile) {
    // switched to another profile while the browser login was open: the result belongs to the old
    // one, so say so in a toast and leave the profile on show alone
    $.ui.toast(
      ok
        ? 'AWS login finished for ' + profile + ' (no longer the profile on show)'
        : 'AWS login for ' + profile + ' did not finish after ' + secs + 's (' + (note || 'no detail') + ')',
    )
    return
  }
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
export async function appendAwsConfig($, home, block) {
  const path = home + '/.aws/config'
  let text = ''
  try {
    text = String(await $.fs.read(path))
  } catch {}
  if (text && !(await $.fs.exists(path + '.bak-kube-deck'))) await $.fs.write(path + '.bak-kube-deck', text)
  await $.fs.write(path, text + (text && !text.endsWith('\n') ? '\n' : '') + (text ? '\n' : '') + block)
}

// The newest unexpired SSO token for this start URL, from the CLI's own cache.
export async function findSsoToken($, home, startUrl) {
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
export async function listSsoChoices($, token, region) {
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

export async function loginAwsSso($, typedUrl, typedRegion) {
  let url = String(typedUrl || drafts.ssoUrl || '').trim()
  if (url && !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(url)) url = 'https://' + url
  const region = String(typedRegion || drafts.ssoRegion || '').trim()
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
    drafts.ssoUrl = ''
    $.ui.toast('Signed in. Pick the account and role to add as a profile.')
  } else {
    $.ui.toast('AWS SSO login did not finish after ' + secs + 's (' + note + ')')
  }
  $.ui.invalidate('ui.render')
}

// Writes the profile for a picked account/role (unless it exists) and switches to it.
export async function addSsoProfile($, index) {
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

// Only values the dropdown offered are accepted, never free text.
export async function switchAws($, name) {
  // "already selected" only counts once it has been exported: a profile the panel shows because
  // it is the only one in ~/.aws/config is not set in Claude's shell until it is picked.
  if (!awsProfiles.includes(name) || (name === aws.profile && (await getPicked($)).AWS_PROFILE === name)) return
  const r = await $.env.set('AWS_PROFILE', name)
  if (r?.deny) return $.ui.toast('Could not switch AWS profile: ' + r.deny)
  await setPicked($, 'AWS_PROFILE', name)
  await resolveAws($) // reads the new AWS_PROFILE and resets what we knew about the old one
  $.ui.toast('AWS profile is now ' + name + ' (commands Claude runs from now on)')
  checkAws($, true).catch(() => {})
}

// The panel's Add profile button replaces this; an imported name cannot be reassigned from outside.
export function setAwsSso(value) {
  awsSso = value
}
