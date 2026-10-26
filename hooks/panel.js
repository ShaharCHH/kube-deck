import { approveAll, approveUntil, mmss, setApprove } from './approve.js'
import { activity, hhmm } from './audit.js'
import { addSsoProfile, aws, awsProfiles, awsSso, checkAws, setAwsSso, switchAws } from './aws.js'
import { addKubeconfig, clearSecrets, cluster, kubeAdd, kubeLogin, kubeconfig, kubeconfigs, setKubeLogin, switchKubeconfig } from './cluster.js'
import { PANE, PANE_COLUMNS, THEME, newId } from './config.js'
import { drafts, secrets, wanted } from './shared.js'
import { mutateTodos, repoName, todos } from './todos.js'

// Text typed in the panel's add field, kept so a redraw doesn't wipe a half-typed task.
let draft = ''

export function registerPanel(on) {
  // ---- the panel: cluster, guard, todos, recent cluster commands, as bordered cards.
  // Colors are theme keys (THEME, in config.js), so the panel follows light/dark mode.
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
    const startKubeLogin = (insecure = false) => {
      if (kubeLogin.status === 'logging' || wanted.kubeLogin) return
      wanted.kubeLogin = true
      wanted.kubeInsecure = insecure
      wanted.kubeMethod = drafts.kubeMethod === 'token' ? 'token' : drafts.kubeMethod === 'password' ? 'password' : 'web'
      setKubeLogin({ status: 'logging', last: null })
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
      // add a kubeconfig you already have (a path, not its contents: those can hold tokens)
      [
        Input({
          key: 'kube-add',
          label: 'add file',
          placeholder: '~/Downloads/my.kubeconfig',
          value: drafts.kubeAdd,
          submitLabel: 'add',
          onInput: (value) => {
            drafts.kubeAdd = value
          },
          onSubmit: (value) => addKubeconfig($, value),
        }),
      ],
      ...(!kubeAdd.ok && kubeAdd.note ? [[Text({ color: THEME.warn, wrap: 'wrap', children: [kubeAdd.note] })]] : []),
      // log in to a cluster: browser (SSO), token or user + password
      [
        Select({
          key: 'kube-method',
          label: 'log in with',
          options: [
            { value: 'browser', label: 'Browser (SSO)' },
            { value: 'token', label: 'Token' },
            { value: 'password', label: 'User + password' },
          ],
          value: drafts.kubeMethod,
          onSelect: (value) => {
            drafts.kubeMethod = value
            clearSecrets() // nothing typed for one method is kept when you switch to another
            $.ui.invalidate('ui.render')
          },
        }),
        Input({
          key: 'kube-server',
          label: 'api',
          placeholder: cluster.server ? 'API URL (empty = this cluster)' : 'api.mycluster.example.com:6443',
          value: drafts.kubeServer,
          submitLabel: drafts.kubeMethod === 'browser' ? 'log in' : 'next',
          onInput: (value) => {
            drafts.kubeServer = value
          },
          onSubmit: () => (drafts.kubeMethod === 'browser' ? startKubeLogin(false) : undefined),
        }),
        // The panel cannot hide typed text: what is typed here shows on screen and stays in the
        // terminal's scrollback. It is kept only in memory and emptied once the login works.
        ...(drafts.kubeMethod === 'token'
          ? [
              Input({
                key: 'kube-token',
                label: 'token',
                placeholder: 'sha256~… (shown as you type)',
                value: secrets.token,
                submitLabel: 'log in',
                onInput: (value) => {
                  secrets.token = value.trim()
                },
                onSubmit: () => startKubeLogin(false),
              }),
            ]
          : drafts.kubeMethod === 'password'
            ? [
                Input({
                  key: 'kube-user',
                  label: 'user',
                  placeholder: 'user name',
                  value: secrets.user,
                  submitLabel: 'next',
                  onInput: (value) => {
                    secrets.user = value.trim()
                  },
                  onSubmit: () => undefined,
                }),
                Input({
                  key: 'kube-pass',
                  label: 'password',
                  placeholder: '(shown as you type)',
                  value: secrets.pass,
                  submitLabel: 'log in',
                  onInput: (value) => {
                    secrets.pass = value.trim()
                  },
                  onSubmit: () => startKubeLogin(false),
                }),
              ]
            : []),
        Button({
          key: 'kube-login',
          label:
            kubeLogin.status === 'logging'
              ? drafts.kubeMethod === 'browser'
                ? '…  Approve in your browser'
                : '…  Logging in'
              : drafts.kubeMethod === 'browser'
                ? '▶  Log in (browser)'
                : '▶  Log in',
          variant: 'primary',
          hover: { scope: 'hv-kube-login', color: THEME.onColor, backgroundColor: THEME.accent },
          onPress: () => startKubeLogin(false),
        }),
      ],
      ...(kubeLogin.last && !kubeLogin.last.ok && kubeLogin.status !== 'logging'
        ? [[Text({ color: THEME.warn, wrap: 'wrap', children: [kubeLogin.last.secs == null ? kubeLogin.last.note : 'Last login attempt ended after ' + kubeLogin.last.secs + 's: ' + (kubeLogin.last.note || 'no detail')] })]]
        : []),
      // Offered only after a certificate failure, as its own button: skipping the check lets anyone
      // who answers at that address collect the login, so it is never on the default path.
      ...(kubeLogin.last && !kubeLogin.last.ok && kubeLogin.last.badCert && !kubeLogin.last.insecure && kubeLogin.status !== 'logging'
        ? [
            [
              Text({ color: THEME.warn, wrap: 'wrap', children: ['The cluster certificate is not trusted. Only continue if you know this cluster.'] }),
              Button({
                key: 'kube-login-insecure',
                label: '⚠  Log in anyway (skip certificate check)',
                variant: 'primary',
                hover: { scope: 'hv-kube-login-insecure', color: THEME.onColor, backgroundColor: THEME.danger },
                onPress: () => startKubeLogin(true),
              }),
            ],
          ]
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
      if (awsSso.status === 'logging' || wanted.awsSso) return
      wanted.awsSso = true
      setAwsSso({ ...awsSso, status: 'logging', choices: [], last: null })
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
                  if (aws.status === 'logging' || wanted.awsLogin) return
                  wanted.awsLogin = true
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
          value: drafts.ssoUrl,
          submitLabel: 'next',
          onInput: (value) => {
            drafts.ssoUrl = value
          },
          onSubmit: () => {},
        }),
        Input({
          key: 'aws-sso-region',
          label: 'region',
          placeholder: 'SSO region, like us-east-1',
          value: drafts.ssoRegion,
          submitLabel: 'log in',
          onInput: (value) => {
            drafts.ssoRegion = value
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
