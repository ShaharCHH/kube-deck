import { approveActive, approveAll, setApprove } from './approve.js'
import { aws, awsSso, checkAws, loginAws, loginAwsSso, resolveAws } from './aws.js'
import { cluster, discoverKubeconfigs, kubeLogin, levelLabel, loginKube, loginKubeOidc, refreshCluster } from './cluster.js'
import { APPROVE_MINUTES, AUDIT_DIR, PANE, PANE_COLUMNS, TODO_TOOL, newId } from './config.js'
import { registerGuard } from './guard.js'
import { registerPanel } from './panel.js'
import { wanted } from './shared.js'
import { formatTodos, loadTodos, mutateTodos, todos } from './todos.js'

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
      description: 'Log in to a cluster in the browser: /kube-login https://api.mycluster.example.com:6443 (no URL = the current cluster; add --insecure for a certificate you do not trust)',
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
        if (wanted.kubeLogin) {
          wanted.kubeLogin = false
          const insecure = wanted.kubeInsecure
          wanted.kubeInsecure = false
          const method = wanted.kubeMethod
          wanted.kubeMethod = 'browser'
          if (method === 'oidc') await loginKubeOidc($, '', insecure)
          else await loginKube($, '', insecure, method === 'token' || method === 'password' ? method : 'web')
        }
        if (wanted.awsSso) {
          wanted.awsSso = false
          await loginAwsSso($)
        }
        if (wanted.awsLogin) {
          wanted.awsLogin = false
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
    // "--insecure" anywhere in the args skips the certificate check for this login only
    const args = String(e.args ?? '').trim()
    const insecure = /(^|\s)--insecure(\s|$)/.test(args)
    await loginKube($, args.replace(/(^|\s)--insecure(?=\s|$)/g, ' ').trim(), insecure)
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

  registerGuard(on)

  registerPanel(on)
}
