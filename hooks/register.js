import { classify } from './classify.js'
import { redactOutput } from './redact.js'

// ---------------------------------------------------------------- config (edit)
// A cluster counts as prod when any of these match the kubeconfig path, the cluster
// name, or the API server URL. Unknown cluster (no kubeconfig / oc missing) = strict.
const PROD_PATTERNS = [/prod/i]
// Used only to READ the local kubeconfig (`config view --minify`), never talks to a cluster.
const KUBE_CLI = 'oc'
// Approve-all switches itself off this many minutes after it was turned on.
const APPROVE_MINUTES = 15
// Audit log: $HOME/<AUDIT_DIR>/audit.jsonl, one JSON line per cluster-changing command.
const AUDIT_DIR = '.kube-deck'

// ---------------------------------------------------------------- state
// Module variables reset on reload; the todo list is reloaded from $.store in session.start.
// approveAll is deliberately never persisted: every new session starts guarded.
let cluster = { known: false, name: '', namespace: '', isProd: true }
let approveAll = false
let approveUntil = 0
let todos = []
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
  const isProd = !known || PROD_PATTERNS.some((re) => re.test(haystack))

  cluster = { known, name, namespace, isProd }
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
    await $.process.run(['mkdir', '-p', dir], { timeoutMs: 3000 })
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
    const r = await $.process.run(['tee', '-a', dir + '/audit.jsonl'], { stdin: line + '\n', timeoutMs: 3000 })
    if (r.exitCode !== 0) throw new Error('tee exit ' + r.exitCode)
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
    ? cluster.name + (cluster.namespace ? ' / ' + cluster.namespace : '') + (cluster.isProd ? ' (PROD)' : '')
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
    // Count down approve-all and switch it off when time is up. Runs once a second but only
    // does anything while approve-all is on. (The timer stops when the module reloads.)
    $.clock.every(1000, async () => {
      try {
        if (approveAll) {
          await approveActive($)
          $.ui.invalidate('ui.render')
        }
      } catch {}
    })
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
    return {
      text:
        (cluster.known ? cluster.name : 'no cluster found') +
        ' | project: ' + (cluster.namespace || 'default') +
        ' | prod: ' + cluster.isProd +
        ' | approve-all: ' + (await approveActive($)),
    }
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
    if (!verdict.touches) return next(e)

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

    const result = await next(e)
    await refreshCluster($) // e.g. `oc project foo` just changed the namespace
    return await redactResult($, e.command, result)
  }).catch(async ($, e, next) => ({
    deny: next.called
      ? 'kube-deck failed after the command ran (' + next.error.kind + '), so its output was withheld as a precaution. Tell the user.'
      : 'The kube-deck guard failed (' + next.error.kind + '), so this command was not run. Tell the user.',
  }))

  // ---- the panel: cluster, guard, todos, recent cluster commands, as bordered cards
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const now = await $.clock.now()
    const armed = approveAll && now < approveUntil

    const spacer = () => Text({ children: [' '] })
    const card = (title, right, color, children) =>
      Box({
        flexDirection: 'column',
        borderStyle: 'round',
        borderColor: color,
        borderDimColor: !color,
        paddingX: 1,
        children: [
          Box({
            flexDirection: 'row',
            justifyContent: 'space-between',
            children: [Text({ bold: true, wrap: 'truncate-middle', children: [title] }), right ?? spacer()],
          }),
          ...children,
        ],
      })

    // ---- cluster
    const badge = !cluster.known
      ? Text({ bold: true, inverse: true, color: 'red', children: [' STRICT '] })
      : cluster.isProd
        ? Text({ bold: true, inverse: true, color: 'red', children: [' PROD '] })
        : Text({ color: 'green', children: ['non-prod'] })
    const clusterCard = card(cluster.known ? cluster.name : 'no cluster found', undefined, cluster.isProd ? 'red' : 'green', [
      Box({
        flexDirection: 'row',
        justifyContent: 'space-between',
        children: [Text({ dimColor: true, children: ['project  ' + (cluster.namespace || 'default')] }), badge],
      }),
    ])

    // ---- guard
    const guardCard = card('Guard', armed ? Text({ bold: true, color: 'yellow', children: ['ON · ' + mmss(approveUntil - now)] }) : undefined, armed ? 'yellow' : undefined, [
      Button({
        key: 'approve-all',
        label: armed ? 'Approve all (a): ON, press to stop' : 'Approve all (a): off',
        hotkey: 'a',
        dimColor: !armed,
        onPress: async () => {
          await setApprove($, !armed)
        },
      }),
      Text({
        dimColor: true,
        wrap: 'wrap',
        children: [
          armed
            ? 'Changes run WITHOUT asking, prod included, until the timer ends.'
            : cluster.isProd
              ? 'Asking before every cluster-changing command.'
              : 'Non-prod: only commands that set their own target are asked.',
        ],
      }),
      Text({ dimColor: true, wrap: 'wrap', children: ['Secrets are redacted from command output. Audit: /audit'] }),
    ])

    // ---- todos
    const doneCount = todos.filter((t) => t.done).length
    const todoCard = card('Todo' + (repoName ? ' · ' + repoName : ''), Text({ dimColor: true, children: [doneCount + '/' + todos.length] }), undefined, [
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
            onSubmit: async (value) => {
              const text = value.trim()
              if (!text) return
              draft = ''
              await mutateTodos($, (list) => [...list, { id: newId(), text, done: false }])
            },
          }),
          Button({
            key: 'add-todo',
            label: 'Add',
            onPress: async () => {
              const text = draft.trim()
              if (!text) return
              draft = ''
              await mutateTodos($, (list) => [...list, { id: newId(), text, done: false }])
            },
          }),
        ],
      }),
      ...(todos.length === 0 ? [Text({ dimColor: true, children: ['nothing yet'] })] : []),
      ...todos.map((t) =>
        Box({
          flexDirection: 'row',
          columnGap: 1,
          children: [
            // No native checkbox element: a plain button that flips between the two glyphs.
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
                  dimColor: t.done,
                  italic: t.done,
                  wrap: 'wrap',
                  children: [t.text + (t.by === 'claude' ? '  · claude' : '')],
                }),
              ],
            }),
            Button({
              key: 'del-' + t.id,
              label: 'x',
              onPress: () => mutateTodos($, (list) => list.filter((x) => x.id !== t.id)),
            }),
          ],
        }),
      ),
      ...(doneCount > 0
        ? [
            Button({
              key: 'clear-done',
              label: 'Clear done (' + doneCount + ')',
              onPress: () => mutateTodos($, (list) => list.filter((x) => !x.done)),
            }),
          ]
        : []),
    ])

    // ---- recent cluster commands: tag and time on one line, the command truncated below it
    const OUTCOME = {
      approved: ['approved', 'green'],
      refused: ['REFUSED', 'red'],
      auto: ['AUTO', 'yellow'],
      'non-prod': ['non-prod', undefined],
    }
    const activityCard = card('Cluster commands', undefined, undefined, [
      ...(activity.length === 0 ? [Text({ dimColor: true, children: ['none this session'] })] : []),
      ...activity.map((a) => {
        const [tag, color] = OUTCOME[a.outcome] ?? [a.outcome, undefined]
        return Box({
          flexDirection: 'column',
          children: [
            Box({
              flexDirection: 'row',
              columnGap: 1,
              children: [
                Text({ dimColor: true, children: [hhmm(a.at)] }),
                Text({ bold: true, color, children: [tag] }),
              ],
            }),
            Text({ dimColor: true, wrap: 'truncate-end', children: [a.cmd] }),
          ],
        })
      }),
    ])

    // Outside cluster work only the todo card shows. The cluster cards appear once a cluster
    // is detected, a cluster command has run, or approve-all is on. The guard itself never
    // depends on what is drawn: it acts on every cluster command either way.
    const showCluster = cluster.known || activity.length > 0 || armed
    return Box({
      flexDirection: 'column',
      children: showCluster ? [clusterCard, guardCard, todoCard, activityCard] : [todoCard],
    })
  })
}
