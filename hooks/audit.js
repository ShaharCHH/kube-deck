// The recent-commands feed, the audit log, output redaction and the approval question.

import { maskCommand, redactOutput } from './redact.js'
import { cluster, levelLabel } from './cluster.js'
import { AUDIT_DIR } from './config.js'
import { projectRoot } from './todos.js'

// Last few cluster-changing commands the guard saw, newest first (this session only).
export let activity = []

// ---- activity feed and audit log
export function record(at, command, outcome) {
  const cmd = maskCommand(command).replace(/\s+/g, ' ').trim()
  activity = [
    { at, cluster: cluster.name || '?', isProd: cluster.isProd, cmd: cmd.length > 160 ? cmd.slice(0, 160) + '…' : cmd, outcome },
    ...activity,
  ].slice(0, 8)
}

export function hhmm(ms) {
  try {
    const d = new Date(ms)
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
  } catch {
    return ''
  }
}

export function isoTime(ms) {
  try {
    return new Date(ms).toISOString()
  } catch {
    return String(ms)
  }
}

// Append one JSON line with `tee -a` (O_APPEND: safe with several sessions writing at once;
// $.fs.write would replace the whole file). Best effort, but a failure is never silent.
export async function audit($, at, command, outcome, retarget) {
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
export async function redactResult($, command, result) {
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

export function describeVerdict(verdict, command) {
  const where = cluster.known
    ? cluster.name + (cluster.namespace ? ' / ' + cluster.namespace : '') + (cluster.isProd ? ' (' + levelLabel() + ')' : '')
    : 'unknown cluster'
  const why = verdict.retarget
    ? 'This command sets its own cluster/context, so the panel may not show where it lands.'
    : 'It changes cluster state.'
  const shown = command.length > 300 ? command.slice(0, 300) + '…' : command
  return 'Run on ' + where + '? ' + why + '\n' + shown
}
