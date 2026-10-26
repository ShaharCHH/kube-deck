import { expect, mock, test as baseTest } from 'claude-code/testing'

// Every test answers $.ui.toast, so a failing test's output is not buried in "no implementation
// for ui.toast" lines.
const test: typeof baseTest = ((name: string, body: any) =>
  baseTest(name, ($: any, on: any) => {
    on('ui.toast', () => ({ value: undefined }))
    return body($, on)
  })) as any

const KUBECONFIG_JSON = JSON.stringify({
  clusters: [{ name: 'api-x', cluster: { server: 'https://api.x.example.com:6443' } }],
  contexts: [{ context: { namespace: 'payments' } }],
})

function setup(on: any, ocWorks: boolean) {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  mock.env(on, { KUBECONFIG: ocWorks ? '/k/sandbox.kubeconfig' : '', HOME: '/home/t' })
  on('session.root', () => ({ value: '/work/my-repo' }))
  on('process.run', (_$: any, e: any) =>
    e.argv[0] === 'oc' && ocWorks
      ? { value: { exitCode: 0, stdout: KUBECONFIG_JSON, stderr: '' } }
      : { value: { exitCode: 1, stdout: '', stderr: 'oc: not found' } },
  )
}

const mount = ($: any, surface: 'terminal' | 'desktop') =>
  $.ui.mount({
    plugin: 'kube-deck',
    surface,
    component: 'Pane',
    requestId: 'deck',
    props: { title: 'kube-deck', isFocused: true, bodyColumns: 44, placement: 'dock' } as any,
  } as any)

test('with a cluster: all cards draw on terminal and desktop, and the controls work', async ($, on) => {
  setup(on, true)
  await $.command.run({ command: 'ctx', args: '' }) // reads the kubeconfig

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mount($, surface)

    // approve-all is a real button and flips its label
    expect(await ui.find({ key: 'approve-all' })).toBeDefined()
    await ui.press({ key: 'approve-all' })
    expect(JSON.stringify(await ui.find({ key: 'approve-all' }))).toContain('ON')
    await ui.press({ key: 'approve-all' })

    // add a todo, tick it, clear it
    await ui.input({ key: 'new-todo', text: 'drain worker-3' })
    expect(await ui.find({ type: 'Text', text: /drain worker-3/ })).toBeDefined()
    const box = await ui.find({ type: 'Button', text: /☐/ })
    expect(box).toBeDefined()
    await ui.press({ key: (box as any).key })
    expect(await ui.find({ type: 'Button', text: /☑/ })).toBeDefined()
    await ui.press({ key: 'clear-done' })
    expect(await ui.find({ type: 'Text', text: /drain worker-3/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('without a cluster: the todo and cluster-login cards draw, not the guard', async ($, on) => {
  setup(on, false)
  await $.command.run({ command: 'ctx', args: '' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mount($, surface)
    expect(await ui.find({ key: 'new-todo' })).toBeDefined()
    expect(await ui.find({ key: 'approve-all' })).toBeUndefined()
    await ui.unmount()
  }
})

test('finished tasks move to the Done card, which holds Clear done; open tasks are divided', async ($, on) => {
  setup(on, false)
  await $.command.run({ command: 'ctx', args: '' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mount($, surface)
    await ui.input({ key: 'new-todo', text: 'first' })
    await ui.input({ key: 'new-todo', text: 'second' })

    // nothing finished yet: no Done card, no Clear button; two open tasks have a divider between
    expect(await ui.find({ key: 'clear-done' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^─+$/ })).toBeDefined()

    // tick one: Clear done appears, and it is the only task left in Todo
    const box = (await ui.find({ type: 'Button', text: /☐/ })) as any
    await ui.press({ key: box.key })
    expect(await ui.find({ key: 'clear-done' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Done$/ })).toBeDefined()

    await ui.press({ key: 'clear-done' })
    expect(await ui.find({ key: 'clear-done' })).toBeUndefined()
    // clean up the remaining task so the next surface starts empty
    const rest = (await ui.find({ type: 'Button', text: /✕/ })) as any
    await ui.press({ key: rest.key })
    await ui.unmount()
  }
})

// The AWS card: profile from AWS_PROFILE, login state from `sts get-caller-identity`.
function awsWorld(on: any, sts: { exitCode: number; stdout: string; stderr: string } | 'throw', profile = 'dev') {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  mock.env(on, { AWS_PROFILE: profile, KUBECONFIG: '', HOME: '/home/t' })
  on('session.root', () => ({ value: '/work/my-repo' }))
  on('fs.read', (_$: any, e: any) =>
    String(e.path).endsWith('/.aws/config') ? { value: '[profile dev]\nregion = eu-west-1\n' } : { value: '' },
  )
  on('process.run', (_$: any, e: any) => {
    if (e.argv[0] === 'aws') return sts === 'throw' ? { error: { kind: 'failed' } } : { value: sts }
    return { value: { exitCode: 1, stdout: '', stderr: 'oc: not found' } }
  })
}

test('AWS card: signed in shows profile, region and role, never the account id', async ($, on) => {
  awsWorld(on, {
    exitCode: 0,
    stdout: JSON.stringify({ Account: '123456789012', Arn: 'arn:aws:sts::123456789012:assumed-role/AdminRole/me' }),
    stderr: '',
  })
  await $.command.run({ command: 'ctx', args: '' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mount($, surface)
    await ui.press({ key: 'aws-recheck' })
    const tree = JSON.stringify(await ui.find({ type: 'Text', text: /signed in/ }))
    expect(tree).toContain('signed in')
    expect(await ui.find({ type: 'Text', text: /eu-west-1/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /AdminRole/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /123456789012/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('AWS card: an expired login says so and shows the fix; a dead CLI is "unreachable", not healthy', async ($, on) => {
  awsWorld(on, { exitCode: 255, stdout: '', stderr: 'Error loading SSO Token: Token has expired and refresh failed' })
  await $.command.run({ command: 'ctx', args: '' })
  const ui = await mount($, 'terminal')
  await ui.press({ key: 'aws-recheck' })
  expect(await ui.find({ type: 'Text', text: /SSO EXPIRED/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /aws sso login --profile dev/ })).toBeDefined()
  await ui.unmount()
})

test('AWS card: a CLI that fails for another reason reads as unreachable', async ($, on) => {
  awsWorld(on, { exitCode: 1, stdout: '', stderr: 'Could not connect to the endpoint URL' })
  await $.command.run({ command: 'ctx', args: '' })
  const ui = await mount($, 'terminal')
  await ui.press({ key: 'aws-recheck' })
  expect(await ui.find({ type: 'Text', text: /unreachable/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /signed in/ })).toBeUndefined()
  await ui.unmount()
})

test('AWS card: Log in shows while expired; /aws-login runs `aws sso login` for the profile, then re-checks', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  mock.env(on, { AWS_PROFILE: 'dev', KUBECONFIG: '', HOME: '/home/t' })
  on('session.root', () => ({ value: '/work/my-repo' }))
  on('fs.read', () => ({ value: '' }))
  const ran: string[][] = []
  let loggedIn = false
  on('process.run', (_$: any, e: any) => {
    if (e.argv[0] !== 'aws') return { value: { exitCode: 1, stdout: '', stderr: '' } }
    ran.push(e.argv)
    if (e.argv[1] === 'sso') {
      loggedIn = true
      return { value: { exitCode: 0, stdout: '', stderr: '' } }
    }
    return loggedIn
      ? { value: { exitCode: 0, stdout: JSON.stringify({ Arn: 'arn:aws:iam::1:user/me' }), stderr: '' } }
      : { value: { exitCode: 255, stdout: '', stderr: 'Token has expired and refresh failed' } }
  })
  await $.command.run({ command: 'ctx', args: '' })
  const ui = await mount($, 'terminal')

  expect(await ui.find({ key: 'aws-login' })).toBeUndefined() // nothing to fix yet
  await ui.press({ key: 'aws-recheck' })
  expect(await ui.find({ type: 'Text', text: /SSO EXPIRED/ })).toBeDefined()

  // pressing queues the login (the plugin's timer runs it) and the button says what to do
  await ui.press({ key: 'aws-login' })
  expect(await ui.find({ type: 'Button', text: /Approve in your browser/ })).toBeDefined()
  expect(ran.some((a) => a[1] === 'sso')).toBe(false) // not run by the press itself

  // the typed command runs the same login directly
  await $.command.run({ command: 'aws-login', args: '' })
  expect(ran.some((a) => a.join(' ') === 'aws sso login --profile dev')).toBe(true)
  expect(await ui.find({ type: 'Text', text: /signed in/ })).toBeDefined()
  expect(await ui.find({ key: 'aws-login' })).toBeUndefined()
  await ui.unmount()
})

test('AWS card: a profile name that looks like an option is ignored', async ($, on) => {
  awsWorld(on, { exitCode: 0, stdout: '{}', stderr: '' }, '--endpoint-url=http://evil')
  await $.command.run({ command: 'ctx', args: '' })
  const ui = await mount($, 'terminal')
  expect(await ui.find({ key: 'aws-recheck' })).toBeUndefined()
  await ui.unmount()
})

test('AWS card: a login that ends early says how and why, and drops URLs from the message', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  mock.env(on, { AWS_PROFILE: 'dev', KUBECONFIG: '', HOME: '/home/t' })
  on('session.root', () => ({ value: '/work/my-repo' }))
  on('fs.read', () => ({ value: '' }))
  on('process.run', (_$: any, e: any) => {
    if (e.argv[0] !== 'aws') return { value: { exitCode: 1, stdout: '', stderr: '' } }
    return e.argv[1] === 'sso'
      ? { value: { exitCode: 1, stdout: '', stderr: 'Open https://device.example/?code=SECRET to sign in' } }
      : { value: { exitCode: 255, stdout: '', stderr: 'Token has expired and refresh failed' } }
  })
  await $.command.run({ command: 'ctx', args: '' })
  await $.command.run({ command: 'aws-login', args: '' })
  const ui = await mount($, 'terminal')
  const note = JSON.stringify(await ui.find({ type: 'Text', text: /Last login attempt ended/ }))
  expect(note).toContain('exit 1')
  expect(note).toContain('<url>')
  expect(note).not.toContain('SECRET')
  expect(await ui.find({ key: 'aws-login' })).toBeDefined() // still expired: the button stays
  await ui.unmount()
})

// A fake environment that remembers `$.env.set`, so a switch can be seen taking effect.
function switchWorld(on: any, env: Record<string, string>) {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('env.get', (_$: any, e: any) => ({ value: env[e.name] }))
  on('env.set', (_$: any, e: any) => {
    if (e.value === undefined) delete env[e.name]
    else env[e.name] = e.value
    return { value: {} }
  })
  on('session.root', () => ({ value: '/work/my-repo' }))
  const kc = 'apiVersion: v1\nclusters: []\n'
  on('fs.list', (_$: any, e: any) => ({
    value: String(e.path).endsWith('/.kube')
      ? [
          { name: 'sandbox.kubeconfig', kind: 'file' },
          { name: 'prod-eu.kubeconfig', kind: 'file' },
          { name: 'cache', kind: 'dir' },
          { name: 'kuberc', kind: 'file' },
        ]
      : [],
  }))
  on('fs.read', (_$: any, e: any) => ({
    value: String(e.path).endsWith('/.aws/config')
      ? '[default]\nregion = us-east-1\n[profile dev]\nregion = eu-west-1\n[profile prod]\nregion = eu-west-1\n'
      : String(e.path).endsWith('kuberc')
        ? 'not a kubeconfig'
        : kc,
  }))
  on('process.run', (_$: any, e: any) =>
    e.argv[0] === 'aws'
      ? { value: { exitCode: 0, stdout: JSON.stringify({ Arn: 'arn:aws:iam::1:user/' + e.argv[3] }), stderr: '' } }
      : { value: { exitCode: 1, stdout: '', stderr: 'oc: not found' } },
  )
}

test('the cluster badge tells prod, non-prod and unlisted apart', async ($, on) => {
  const env: Record<string, string> = { KUBECONFIG: '/k/finance-east.kubeconfig', HOME: '/home/t', AWS_PROFILE: '' }
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('env.get', (_$: any, e: any) => ({ value: env[e.name] }))
  on('session.root', () => ({ value: '/work/my-repo' }))
  on('fs.list', () => ({ value: [] }))
  on('fs.read', () => {
    throw new Error('ENOENT')
  })
  on('process.run', (_$: any, e: any) =>
    e.argv[0] === 'oc'
      ? { value: { exitCode: 0, stdout: KUBECONFIG_JSON, stderr: '' } }
      : { value: { exitCode: 1, stdout: '', stderr: '' } },
  )
  const badge = async (kubeconfig: string) => {
    env.KUBECONFIG = kubeconfig
    await $.command.run({ command: 'ctx', args: '' })
    const ui = await mount($, 'terminal')
    const text = JSON.stringify(await ui.find({ type: 'Text', text: /PROD|UNLISTED|non-prod|STRICT/ }))
    await ui.unmount()
    return text
  }
  expect(await badge('/k/finance-east.kubeconfig')).toContain('UNLISTED')
  expect(await badge('/k/prod-east.kubeconfig')).toContain('PROD')
  expect(await badge('/k/sandbox-1.kubeconfig')).toContain('non-prod')
})

// The panel shows a profile from .aws-profile or the only one in ~/.aws/config, which Claude's
// shell does not have: the guard must export it, or the card says "signed in" for a profile the
// commands never use. A profile from AWS_PROFILE itself needs nothing.
function profileSourceWorld(on: any, env: Record<string, string>, files: Record<string, string>) {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('env.get', (_$: any, e: any) => ({ value: env[e.name] }))
  on('session.root', () => ({ value: '/work/my-repo' }))
  on('fs.read', (_$: any, e: any) => {
    if (!(e.path in files)) throw new Error('ENOENT')
    return { value: files[e.path] }
  })
  on('fs.list', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }))
  const ran: string[] = []
  on('tool.call', { tool: 'Bash' } as any, (_$: any, e: any) => {
    ran.push(e.command)
    return { result: { stdout: 'ok', stderr: '', interrupted: false } }
  })
  return ran
}

test('a profile read from .aws-profile or the only profile is exported to the shell; one from AWS_PROFILE is not', async ($, on) => {
  const ran = profileSourceWorld(
    on,
    { AWS_PROFILE: '', KUBECONFIG: '', HOME: '/home/t' },
    { '/work/my-repo/.aws-profile': 'dev\n', '/home/t/.aws/config': '[profile dev]\nregion = x\n[profile prod]\nregion = y\n' },
  )
  await $.command.run({ command: 'todo', args: 'add x' }) // loads the project root, as session start does
  await $.command.run({ command: 'ctx', args: '' })
  await $.tool.call({ tool: 'Bash', command: 'aws sts get-caller-identity' } as any)
  expect(ran.at(-1)).toBe("export AWS_PROFILE='dev'; aws sts get-caller-identity")
})

test('the only profile in ~/.aws/config is exported to the shell too', async ($, on) => {
  const ran = profileSourceWorld(on, { AWS_PROFILE: '', KUBECONFIG: '', HOME: '/home/t' }, { '/home/t/.aws/config': '[profile solo]\nregion = x\n' })
  await $.command.run({ command: 'ctx', args: '' })
  await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
  expect(ran.at(-1)).toBe("export AWS_PROFILE='solo'; ls")
})

test('a profile that comes from AWS_PROFILE itself is left alone', async ($, on) => {
  const ran = profileSourceWorld(on, { AWS_PROFILE: 'dev', KUBECONFIG: '', HOME: '/home/t' }, { '/home/t/.aws/config': '[profile dev]\nregion = x\n[profile prod]\nregion = y\n' })
  await $.command.run({ command: 'ctx', args: '' })
  await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
  expect(ran.at(-1)).toBe('ls')
})

test('AWS login: switching profile while the browser login is open does not put its result on the new profile', async ($, on) => {
  const env: Record<string, string> = { AWS_PROFILE: 'dev', KUBECONFIG: '', HOME: '/home/t' }
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('env.get', (_$: any, e: any) => ({ value: env[e.name] }))
  on('env.set', (_$: any, e: any) => {
    env[e.name] = e.value
    return { value: {} }
  })
  on('session.root', () => ({ value: '/work/my-repo' }))
  on('fs.list', () => ({ value: [] }))
  on('fs.read', () => ({ value: '[profile dev]\nregion = x\n[profile prod]\nregion = y\n' }))
  let ui: any
  on('process.run', async (_$: any, e: any) => {
    if (e.argv[0] !== 'aws') return { value: { exitCode: 1, stdout: '', stderr: '' } }
    if (e.argv[1] === 'sso') {
      await ui.select({ key: 'aws-profile-select', value: 'prod' }) // the person picks another profile mid-login
      return { value: { exitCode: 1, stdout: '', stderr: 'Error: browser window closed' } }
    }
    return { value: { exitCode: 255, stdout: '', stderr: 'Token has expired and refresh failed' } }
  })
  await $.command.run({ command: 'ctx', args: '' })
  ui = await mount($, 'terminal')
  await $.command.run({ command: 'aws-login', args: '' }) // dev's login, ends after the switch
  expect(env.AWS_PROFILE).toBe('prod')
  // the failed login was dev's: prod must not show it
  expect(await ui.find({ type: 'Text', text: /Last login attempt ended/ })).toBeUndefined()
  await ui.unmount()
})

test('AWS dropdown: lists the profiles, and a pick sets AWS_PROFILE and re-checks', async ($, on) => {
  const env: Record<string, string> = { AWS_PROFILE: 'dev', KUBECONFIG: '', HOME: '/home/t' }
  switchWorld(on, env)
  await $.command.run({ command: 'ctx', args: '' })
  const ui = await mount($, 'terminal')

  const sel = JSON.stringify(await ui.find({ key: 'aws-profile-select' }))
  for (const name of ['default', 'dev', 'prod']) expect(sel).toContain(name)

  await ui.select({ key: 'aws-profile-select', value: 'prod' })
  expect(env.AWS_PROFILE).toBe('prod')
  expect(await ui.find({ type: 'Text', text: /prod/ })).toBeDefined()

  // a value the dropdown never offered is ignored
  await ui.select({ key: 'aws-profile-select', value: '--endpoint-url=http://evil' })
  expect(env.AWS_PROFILE).toBe('prod')
  await ui.unmount()
})

test('kubeconfig dropdown: lists kubeconfig files only; a pick sets KUBECONFIG, re-judges prod, drops approve-all', async ($, on) => {
  const env: Record<string, string> = { AWS_PROFILE: 'dev', KUBECONFIG: '/home/t/.kube/sandbox.kubeconfig', HOME: '/home/t' }
  switchWorld(on, env)
  await $.command.run({ command: 'ctx', args: '' })
  const ui = await mount($, 'terminal')

  const sel = JSON.stringify(await ui.find({ key: 'kubeconfig-select' }))
  expect(sel).toContain('sandbox.kubeconfig')
  expect(sel).toContain('prod-eu.kubeconfig')
  expect(sel).not.toContain('kuberc') // not a kubeconfig
  expect(sel).not.toContain('cache') // a directory

  await ui.press({ key: 'approve-all' })
  expect(JSON.stringify(await ui.find({ key: 'approve-all' }))).toContain('ON')

  await ui.select({ key: 'kubeconfig-select', value: '/home/t/.kube/prod-eu.kubeconfig' })
  expect(env.KUBECONFIG).toBe('/home/t/.kube/prod-eu.kubeconfig')
  expect(JSON.stringify(await ui.find({ key: 'approve-all' }))).not.toContain('ON') // switched off by the move

  await ui.select({ key: 'kubeconfig-select', value: '/etc/passwd' })
  expect(env.KUBECONFIG).toBe('/home/t/.kube/prod-eu.kubeconfig')
  await ui.unmount()
})

function kubeLoginWorld(on: any, env: Record<string, string>, loginResult: { exitCode: number; stderr: string }) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('env.get', (_$: any, e: any) => ({ value: env[e.name] }))
  on('env.set', (_$: any, e: any) => {
    env[e.name] = e.value
    return { value: {} }
  })
  on('session.root', () => ({ value: '/work/my-repo' }))
  let created = false
  on('fs.list', () => ({ value: created ? [{ name: 'sno-x-example-com.kubeconfig', kind: 'file' }] : [] }))
  on('fs.read', () => ({ value: 'apiVersion: v1\nclusters: []\n' }))
  const ran: any[] = []
  on('process.run', (_$: any, e: any) => {
    if (e.argv[0] === 'oc' && e.argv[1] === 'login') {
      ran.push(e)
      created = loginResult.exitCode === 0
      return { value: { exitCode: loginResult.exitCode, stdout: '', stderr: loginResult.stderr } }
    }
    return { value: { exitCode: 1, stdout: '', stderr: 'no cluster' } }
  })
  ;(ran as any).clock = clock
  return ran
}

test('cluster login: runs oc login --web into a file of its own, then switches to it', async ($, on) => {
  const env: Record<string, string> = { KUBECONFIG: '', HOME: '/home/t', AWS_PROFILE: '' }
  const ran = kubeLoginWorld(on, env, { exitCode: 0, stderr: '' })
  await $.command.run({ command: 'kube-login', args: 'https://api.sno.x.example.com:6443' })

  expect(ran.length).toBe(1)
  expect(ran[0].argv).toEqual(['oc', 'login', '--web', '--server=https://api.sno.x.example.com:6443'])
  expect(ran[0].init.env.KUBECONFIG).toBe('/home/t/.kube/sno-x-example-com.kubeconfig') // its own file
  expect(env.KUBECONFIG).toBe('/home/t/.kube/sno-x-example-com.kubeconfig') // and the session now uses it
})

test('cluster login: a host:port typed without https:// gets it added', async ($, on) => {
  const env: Record<string, string> = { KUBECONFIG: '', HOME: '/home/t', AWS_PROFILE: '' }
  const ran = kubeLoginWorld(on, env, { exitCode: 0, stderr: '' })
  await $.command.run({ command: 'kube-login', args: 'api.sno.x.example.com:6443' })
  expect(ran[0].argv[3]).toBe('--server=https://api.sno.x.example.com:6443')
})

// The panel and the logins live in different files and share the typed text and the "login wanted"
// flags through objects: this walks that path.
test('panel: typed URLs reach the logins, and the login buttons queue them', async ($, on) => {
  const env: Record<string, string> = { KUBECONFIG: '', HOME: '/home/t', AWS_PROFILE: '' }
  const ran = kubeLoginWorld(on, env, { exitCode: 0, stderr: '' })
  await $.command.run({ command: 'ctx', args: '' })
  const ui = await mount($, 'terminal')

  await ui.input({ key: 'kube-server', text: 'api.sno.x.example.com:6443', kind: 'change' } as any)
  await ui.press({ key: 'kube-login' })
  expect(JSON.stringify(await ui.find({ key: 'kube-login' }))).toContain('Approve in your browser')
  expect(ran.length).toBe(0) // queued: the 1s timer runs it, not the press
  await $.command.run({ command: 'kube-login', args: '' }) // no URL typed here: it uses the panel's field
  expect(ran[0].argv).toContain('--server=https://api.sno.x.example.com:6443')

  await ui.input({ key: 'aws-sso-url', text: 'mycompany.awsapps.com/start', kind: 'change' } as any)
  await ui.input({ key: 'aws-sso-region', text: 'us-east-1', kind: 'change' } as any)
  await ui.press({ key: 'aws-sso-login' })
  expect(JSON.stringify(await ui.find({ key: 'aws-sso-login' }))).toContain('Approve in your browser')
  await ui.unmount()
})

test('cluster login: a URL that is not a plain https host runs nothing', async ($, on) => {
  const env: Record<string, string> = { KUBECONFIG: '', HOME: '/home/t', AWS_PROFILE: '' }
  const ran = kubeLoginWorld(on, env, { exitCode: 0, stderr: '' })
  for (const bad of ['--token=abc', 'http://api.x.example.com:6443', 'https://x.example.com; rm -rf ~', 'https://x/../y']) {
    await $.command.run({ command: 'kube-login', args: bad })
  }
  expect(ran.length).toBe(0)
  expect(env.KUBECONFIG).toBe('')
  const ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /Not a usable cluster URL/ })).toBeDefined() // shown on the card
  await ui.unmount()
})

test('cluster login: a failed login says why, drops URLs, and does not switch', async ($, on) => {
  const env: Record<string, string> = { KUBECONFIG: '/k/old.kubeconfig', HOME: '/home/t', AWS_PROFILE: '' }
  kubeLoginWorld(on, env, { exitCode: 1, stderr: 'Open https://oauth.example/?code=SECRET to sign in' })
  await $.command.run({ command: 'kube-login', args: 'https://api.sno.x.example.com:6443' })
  const ui = await mount($, 'terminal')
  const note = JSON.stringify(await ui.find({ type: 'Text', text: /Last login attempt ended/ }))
  expect(note).toContain('<url>')
  expect(note).not.toContain('SECRET')
  expect(env.KUBECONFIG).toBe('/k/old.kubeconfig')
  expect(await ui.find({ key: 'kube-login' })).toBeDefined()
  await ui.unmount()
})

test('after a pick, Claude\'s Bash commands carry the picked AWS profile and kubeconfig', async ($, on) => {
  const env: Record<string, string> = { AWS_PROFILE: 'dev', KUBECONFIG: '/home/t/.kube/sandbox.kubeconfig', HOME: '/home/t' }
  switchWorld(on, env)
  const ran: string[] = []
  on('tool.call', { tool: 'Bash' } as any, (_$: any, e: any) => {
    ran.push(e.command)
    return { result: { stdout: 'ok', stderr: '', interrupted: false } }
  })
  await $.command.run({ command: 'ctx', args: '' })

  // nothing picked yet: commands pass through untouched
  await $.tool.call({ tool: 'Bash', command: 'aws sts get-caller-identity' } as any)
  expect(ran.at(-1)).toBe('aws sts get-caller-identity')

  const ui = await mount($, 'terminal')
  await ui.select({ key: 'aws-profile-select', value: 'prod' })
  await $.tool.call({ tool: 'Bash', command: 'aws sts get-caller-identity' } as any)
  expect(ran.at(-1)).toBe("export AWS_PROFILE='prod'; aws sts get-caller-identity")

  await ui.select({ key: 'kubeconfig-select', value: '/home/t/.kube/prod-eu.kubeconfig' })
  await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
  expect(ran.at(-1)).toBe("export AWS_PROFILE='prod'; export KUBECONFIG='/home/t/.kube/prod-eu.kubeconfig'; ls")
  await ui.unmount()
})

// A fake ~/.aws: files in a map, and an aws CLI that logs in (writes a token to the cache),
// lists accounts and roles, and records every call.
function ssoWorld(on: any, opts: { writeToken?: boolean } = {}) {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const env: Record<string, string> = { HOME: '/home/t', AWS_PROFILE: '', KUBECONFIG: '' }
  const files: Record<string, string> = { '/home/t/.aws/config': '[default]\nregion = us-east-1\n' }
  const aws: string[][] = []
  on('env.get', (_$: any, e: any) => ({ value: env[e.name] }))
  on('env.set', (_$: any, e: any) => {
    env[e.name] = e.value
    return { value: {} }
  })
  on('session.root', () => ({ value: '/work/my-repo' }))
  on('fs.read', (_$: any, e: any) => {
    if (!(e.path in files)) throw new Error('ENOENT')
    return { value: files[e.path] }
  })
  on('fs.write', (_$: any, e: any) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('fs.exists', (_$: any, e: any) => ({ value: e.path in files }))
  on('fs.list', (_$: any, e: any) => ({
    value: Object.keys(files)
      .filter((f) => f.startsWith(e.path + '/'))
      .map((f) => ({ name: f.slice(e.path.length + 1), kind: 'file' })),
  }))
  on('process.run', (_$: any, e: any) => {
    if (e.argv[0] !== 'aws') return { value: { exitCode: 1, stdout: '', stderr: 'no cluster' } }
    aws.push(e.argv)
    if (e.argv[1] === 'sso' && e.argv[2] === 'login') {
      if (opts.writeToken !== false) {
        files['/home/t/.aws/sso/cache/abc.json'] = JSON.stringify({
          startUrl: 'https://mycompany.awsapps.com/start', accessToken: 'TOKEN123', expiresAt: '2099-01-01T00:00:00Z',
        })
      }
      return { value: { exitCode: 0, stdout: '', stderr: '' } }
    }
    if (e.argv[2] === 'list-accounts') {
      return { value: { exitCode: 0, stdout: JSON.stringify({ accountList: [{ accountId: '111122223333', accountName: 'Workload' }] }), stderr: '' } }
    }
    if (e.argv[2] === 'list-account-roles') {
      return { value: { exitCode: 0, stdout: JSON.stringify({ roleList: [{ roleName: 'Admin' }] }), stderr: '' } }
    }
    return { value: { exitCode: 0, stdout: JSON.stringify({ Arn: 'arn:aws:sts::1:assumed-role/Admin/me' }), stderr: '' } }
  })
  return { env, files, aws }
}

test('AWS SSO: a start URL and region log in, list accounts, and the picked one becomes a profile', async ($, on) => {
  const { env, files, aws } = ssoWorld(on)
  await $.command.run({ command: 'aws-sso-login', args: 'mycompany.awsapps.com/start us-east-1' })

  const cfg = files['/home/t/.aws/config']
  expect(cfg).toContain('[default]') // what was there is kept
  expect(cfg).toContain('[sso-session kube-deck-mycompany-awsapps-com-start]')
  expect(cfg).toContain('sso_start_url = https://mycompany.awsapps.com/start')
  expect(files['/home/t/.aws/config.bak-kube-deck']).toBe('[default]\nregion = us-east-1\n') // one-time copy
  expect(aws.some((a) => a.join(' ') === 'aws sso login --sso-session kube-deck-mycompany-awsapps-com-start')).toBe(true)
  const listed = aws.find((a) => a[2] === 'list-accounts')!
  expect(listed).toContain('TOKEN123')

  const ui = await mount($, 'terminal')
  const pick = JSON.stringify(await ui.find({ key: 'aws-sso-pick' }))
  expect(pick).toContain('Workload · Admin')
  expect(JSON.stringify(await ui.find({ key: 'aws-sso-pick' }))).not.toContain('111122223333') // account id never drawn

  await ui.select({ key: 'aws-sso-pick', value: '0' })
  const after = files['/home/t/.aws/config']
  expect(after).toContain('[profile Workload-Admin]')
  expect(after).toContain('sso_session = kube-deck-mycompany-awsapps-com-start')
  expect(after).toContain('sso_account_id = 111122223333')
  expect(after).toContain('sso_role_name = Admin')
  expect(env.AWS_PROFILE).toBe('Workload-Admin') // and the session now uses it
  expect(await ui.find({ key: 'aws-sso-pick' })).toBeUndefined()
  expect(JSON.stringify(await ui.find({ type: 'Text', text: /Workload-Admin/ }))).not.toContain('111122223333')
  await ui.unmount()
})

test('AWS SSO: a URL or region that is not plain writes nothing and runs nothing', async ($, on) => {
  const { files, aws } = ssoWorld(on)
  for (const args of ['--endpoint-url=x us-east-1', 'http://x.awsapps.com/start us-east-1', 'x.awsapps.com/start; rm us-east-1', 'x.awsapps.com/start nowhere']) {
    await $.command.run({ command: 'aws-sso-login', args })
  }
  expect(aws.length).toBe(0)
  expect(files['/home/t/.aws/config']).toBe('[default]\nregion = us-east-1\n')
  const ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /Type the SSO region|Not a usable SSO start URL/ })).toBeDefined()
  await ui.unmount()
})

test('AWS SSO: the issuer URL works; text stuck on its end (a region) is refused; a clashing session is not reused', async ($, on) => {
  const { files, aws } = ssoWorld(on)
  // the issuer URL with the region glued on, as it happened once
  await $.command.run({ command: 'aws-sso-login', args: 'https://identitycenter.amazonaws.com/ssoins-0123456789abcdefil-central-1 il-central-1' })
  expect(aws.length).toBe(0)
  expect(files['/home/t/.aws/config']).toBe('[default]\nregion = us-east-1\n')

  // a session of that name already there with another URL: refused, nothing run
  const good = 'https://identitycenter.amazonaws.com/ssoins-0123456789abcdef'
  files['/home/t/.aws/config'] += '[sso-session kube-deck-identitycenter-amazonaws-com-ssoins-0123456789abcdef]\nsso_start_url = https://other.example.com/start\n'
  await $.command.run({ command: 'aws-sso-login', args: good + ' il-central-1' })
  expect(aws.length).toBe(0)
  const ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /different sso_start_url/ })).toBeDefined()
  await ui.unmount()
})

test('AWS SSO: the issuer URL is accepted and logs in under its own session name', async ($, on) => {
  const { files, aws } = ssoWorld(on)
  files['/home/t/.aws/sso/cache/zzz.json'] = JSON.stringify({
    startUrl: 'https://identitycenter.amazonaws.com/ssoins-0123456789abcdef', accessToken: 'TOKEN9', expiresAt: '2099-01-01T00:00:00Z',
  })
  await $.command.run({ command: 'aws-sso-login', args: 'https://identitycenter.amazonaws.com/ssoins-0123456789abcdef il-central-1' })
  expect(aws.some((a) => a.join(' ') === 'aws sso login --sso-session kube-deck-identitycenter-amazonaws-com-ssoins-0123456789abcdef')).toBe(true)
  expect(files['/home/t/.aws/config']).toContain('sso_start_url = https://identitycenter.amazonaws.com/ssoins-0123456789abcdef\n')
})

test('AWS SSO: a login that leaves no token says so and adds no profile', async ($, on) => {
  const { files, aws } = ssoWorld(on, { writeToken: false })
  await $.command.run({ command: 'aws-sso-login', args: 'mycompany.awsapps.com/start us-east-1' })
  expect(aws.some((a) => a[2] === 'list-accounts')).toBe(false)
  expect(files['/home/t/.aws/config']).not.toContain('[profile')
  const ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /no SSO token was found/ })).toBeDefined()
  await ui.unmount()
})

// Token and password logins: typed in the panel, run by the plugin's 1s timer (started by session.start).
async function startSession($: any, on: any) {
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }))
  on('tool.register', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.session.start({ cwd: '/work/my-repo', surface: 'terminal', isInteractive: true })
}

test('token login: the token reaches oc as --token=, the field empties on success, the token is gone from the field', async ($, on) => {
  const env: Record<string, string> = { KUBECONFIG: '', HOME: '/home/t', AWS_PROFILE: '' }
  const ran: any = kubeLoginWorld(on, env, { exitCode: 0, stderr: '' })
  await startSession($, on)
  const ui = await mount($, 'terminal')

  await ui.select({ key: 'kube-method', value: 'token' })
  await ui.input({ key: 'kube-server', text: 'api.sno.x.example.com:6443', kind: 'change' } as any)
  await ui.input({ key: 'kube-token', text: 'sha256~TOPSECRET', kind: 'change' } as any)
  await ui.press({ key: 'kube-login' })
  await ran.clock.advance(1500)

  expect(ran.length).toBe(1)
  expect(ran[0].argv).toEqual(['oc', 'login', '--token=sha256~TOPSECRET', '--server=https://api.sno.x.example.com:6443'])
  expect(ran[0].init.env.KUBECONFIG).toBe('/home/t/.kube/sno-x-example-com.kubeconfig')
  expect(env.KUBECONFIG).toBe('/home/t/.kube/sno-x-example-com.kubeconfig')
  expect(JSON.stringify(await ui.find({ key: 'kube-token' }))).not.toContain('TOPSECRET') // emptied after success
  await ui.unmount()
})

test('password login: user and password go as --username= / --password=; an error message never echoes them', async ($, on) => {
  const env: Record<string, string> = { KUBECONFIG: '/k/old.kubeconfig', HOME: '/home/t', AWS_PROFILE: '' }
  const ran: any = kubeLoginWorld(on, env, { exitCode: 1, stderr: 'Login failed for alice with hunter22 (401)' })
  await startSession($, on)
  const ui = await mount($, 'terminal')

  await ui.select({ key: 'kube-method', value: 'password' })
  await ui.input({ key: 'kube-server', text: 'api.sno.x.example.com:6443', kind: 'change' } as any)
  await ui.input({ key: 'kube-user', text: 'alice', kind: 'change' } as any)
  await ui.input({ key: 'kube-pass', text: 'hunter22', kind: 'change' } as any)
  await ui.press({ key: 'kube-login' })
  await ran.clock.advance(1500)

  expect(ran[0].argv).toEqual(['oc', 'login', '--username=alice', '--password=hunter22', '--server=https://api.sno.x.example.com:6443'])
  const note = JSON.stringify(await ui.find({ type: 'Text', text: /Last login attempt ended/ }))
  expect(note).toContain('***')
  expect(note).not.toContain('hunter22')
  expect(env.KUBECONFIG).toBe('/k/old.kubeconfig') // a failed login switches nothing
  await ui.unmount()
})

test('token login: an empty token or one that looks like a flag runs nothing; switching method drops what was typed', async ($, on) => {
  const env: Record<string, string> = { KUBECONFIG: '', HOME: '/home/t', AWS_PROFILE: '' }
  const ran: any = kubeLoginWorld(on, env, { exitCode: 0, stderr: '' })
  await startSession($, on)
  const ui = await mount($, 'terminal')

  await ui.select({ key: 'kube-method', value: 'token' })
  await ui.input({ key: 'kube-server', text: 'api.sno.x.example.com:6443', kind: 'change' } as any)
  await ui.press({ key: 'kube-login' }) // no token typed
  await ran.clock.advance(1500)
  await ui.input({ key: 'kube-token', text: '--insecure-skip-tls-verify', kind: 'change' } as any)
  await ui.press({ key: 'kube-login' })
  await ran.clock.advance(1500)
  expect(ran.length).toBe(0)

  await ui.select({ key: 'kube-method', value: 'password' })
  await ui.select({ key: 'kube-method', value: 'token' })
  expect(JSON.stringify(await ui.find({ key: 'kube-token' }))).not.toContain('insecure')
  await ui.unmount()
})

// Add kubeconfig by path
function addWorld(on: any, files: Record<string, string>, existing: string[] = []) {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const env: Record<string, string> = { KUBECONFIG: '', HOME: '/home/t', AWS_PROFILE: '' }
  on('env.get', (_$: any, e: any) => ({ value: env[e.name] }))
  on('env.set', (_$: any, e: any) => {
    env[e.name] = e.value
    return { value: {} }
  })
  on('session.root', () => ({ value: '/work/my-repo' }))
  const copied: string[][] = []
  on('fs.read', (_$: any, e: any) => {
    if (e.path in files) return { value: files[e.path] }
    if (copied.length && e.path === '/home/t/.kube/team.kubeconfig') return { value: 'apiVersion: v1\nclusters: []\n' } // the copy
    throw new Error('ENOENT')
  })
  on('fs.exists', (_$: any, e: any) => ({ value: existing.includes(e.path) }))
  on('fs.list', () => ({ value: copied.length ? [{ name: 'team.kubeconfig', kind: 'file' }] : [] }))
  on('process.run', (_$: any, e: any) => {
    if (e.argv[0] === 'install') {
      copied.push(e.argv)
      return { value: { exitCode: 0, stdout: '', stderr: '' } }
    }
    return { value: { exitCode: 1, stdout: '', stderr: 'no cluster' } }
  })
  return { env, copied }
}

test('add kubeconfig: a file by path is copied into ~/.kube with mode 600 and selected', async ($, on) => {
  const { env, copied } = addWorld(on, { '/home/t/Downloads/team.kubeconfig': 'apiVersion: v1\nclusters: []\n' })
  await $.command.run({ command: 'ctx', args: '' })
  const ui = await mount($, 'terminal')
  await ui.input({ key: 'kube-add', text: '~/Downloads/team.kubeconfig', kind: 'submit' } as any)
  expect(copied).toEqual([['install', '-m', '600', '/home/t/Downloads/team.kubeconfig', '/home/t/.kube/team.kubeconfig']])
  expect(env.KUBECONFIG).toBe('/home/t/.kube/team.kubeconfig')
  await ui.unmount()
})

test('add kubeconfig: a file that is not a kubeconfig, a missing file, a relative path and an existing name copy nothing', async ($, on) => {
  const { env, copied } = addWorld(
    on,
    { '/home/t/a.txt': 'hello', '/home/t/team.kubeconfig': 'apiVersion: v1\n' },
    ['/home/t/.kube/team.kubeconfig'],
  )
  await $.command.run({ command: 'ctx', args: '' })
  const ui = await mount($, 'terminal')
  for (const bad of ['~/a.txt', '~/nope.kubeconfig', 'team.kubeconfig', '~/team.kubeconfig']) {
    await ui.input({ key: 'kube-add', text: bad, kind: 'submit' } as any)
  }
  expect(copied.length).toBe(0)
  expect(env.KUBECONFIG).toBe('')
  expect(await ui.find({ type: 'Text', text: /already exists in ~\/\.kube/ })).toBeDefined()
  await ui.unmount()
})

// SSO for plain Kubernetes: kubectl writes an exec-plugin kubeconfig, `auth whoami` triggers the browser sign-in.
function oidcWorld(on: any, env: Record<string, string>, opts: { pluginInstalled?: boolean; whoami?: { exitCode: number; stderr: string } } = {}) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('env.get', (_$: any, e: any) => ({ value: env[e.name] }))
  on('env.set', (_$: any, e: any) => {
    env[e.name] = e.value
    return { value: {} }
  })
  on('session.root', () => ({ value: '/work/my-repo' }))
  let written = false
  on('fs.list', () => ({ value: written ? [{ name: 'k8s-x-example-com.kubeconfig', kind: 'file' }] : [] }))
  on('fs.read', () => ({ value: 'apiVersion: v1\nclusters: []\n' }))
  const ran: any[] = []
  on('process.run', (_$: any, e: any) => {
    if (e.argv[0] !== 'kubectl') return { value: { exitCode: 1, stdout: '', stderr: 'no cluster' } }
    ran.push(e)
    if (e.argv[1] === 'oidc-login') {
      return { value: { exitCode: opts.pluginInstalled === false ? 1 : 0, stdout: '', stderr: 'unknown command' } }
    }
    if (e.argv[2] === 'set-cluster') written = true
    if (e.argv[1] === 'auth') return { value: { exitCode: opts.whoami?.exitCode ?? 0, stdout: '', stderr: opts.whoami?.stderr ?? '' } }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  return Object.assign(ran, { clock })
}

async function fillOidc(ui: any, issuer: string, client: string) {
  await ui.select({ key: 'kube-method', value: 'oidc' })
  await ui.input({ key: 'kube-server', text: 'api.k8s.x.example.com:6443', kind: 'change' } as any)
  await ui.input({ key: 'kube-oidc-issuer', text: issuer, kind: 'change' } as any)
  await ui.input({ key: 'kube-oidc-client', text: client, kind: 'change' } as any)
  await ui.press({ key: 'kube-login' })
}

test('SSO login: writes an oidc-login exec kubeconfig in a file of its own, signs in, then switches to it', async ($, on) => {
  const env: Record<string, string> = { KUBECONFIG: '', HOME: '/home/t', AWS_PROFILE: '' }
  const ran: any = oidcWorld(on, env)
  await startSession($, on)
  const ui = await mount($, 'terminal')
  await fillOidc(ui, 'https://login.example.com/realms/prod/', 'kubernetes')
  await ran.clock.advance(1500)

  const file = '/home/t/.kube/k8s-x-example-com.kubeconfig'
  expect(ran.every((e: any) => e.init.env.KUBECONFIG === file)).toBe(true) // never touches another file
  const cmds = ran.map((e: any) => e.argv.slice(1, 3).join(' '))
  expect(cmds).toEqual(['oidc-login --version', 'config set-cluster', 'config set-credentials', 'config set-context', 'config use-context', 'auth whoami'])
  expect(ran[1].argv).toContain('--server=https://api.k8s.x.example.com:6443')
  expect(ran[1].argv).toContain('--insecure-skip-tls-verify=false')
  expect(ran[2].argv).toContain('--exec-arg=--oidc-issuer-url=https://login.example.com/realms/prod') // trailing / dropped
  expect(ran[2].argv).toContain('--exec-arg=--oidc-client-id=kubernetes')
  expect(ran[2].argv).toContain('--exec-command=kubectl')
  expect(env.KUBECONFIG).toBe(file)
  await ui.unmount()
})

test('SSO login: without the oidc-login plugin it says how to install it and writes nothing', async ($, on) => {
  const env: Record<string, string> = { KUBECONFIG: '/k/old.kubeconfig', HOME: '/home/t', AWS_PROFILE: '' }
  const ran: any = oidcWorld(on, env, { pluginInstalled: false })
  await startSession($, on)
  const ui = await mount($, 'terminal')
  await fillOidc(ui, 'https://login.example.com', 'kubernetes')
  await ran.clock.advance(1500)

  expect(ran.length).toBe(1) // only the version check
  expect(JSON.stringify(await ui.find({ type: 'Text', text: /kubectl oidc-login is not installed/ }))).toContain('krew')
  expect(env.KUBECONFIG).toBe('/k/old.kubeconfig')
  await ui.unmount()
})

test('SSO login: a failed sign-in switches nothing; an untrusted certificate offers "anyway", which sets the flag', async ($, on) => {
  const env: Record<string, string> = { KUBECONFIG: '/k/old.kubeconfig', HOME: '/home/t', AWS_PROFILE: '' }
  const ran: any = oidcWorld(on, env, { whoami: { exitCode: 1, stderr: 'tls: failed to verify certificate: x509: unknown authority' } })
  await startSession($, on)
  const ui = await mount($, 'terminal')
  await fillOidc(ui, 'https://login.example.com', 'kubernetes')
  await ran.clock.advance(1500)
  expect(env.KUBECONFIG).toBe('/k/old.kubeconfig')
  expect(await ui.find({ key: 'kube-login-insecure' })).toBeDefined()

  await ui.press({ key: 'kube-login-insecure' })
  await ran.clock.advance(1500)
  const clusters = ran.filter((e: any) => e.argv[2] === 'set-cluster')
  expect(clusters.at(-1).argv).toContain('--insecure-skip-tls-verify=true')
  await ui.unmount()
})

test('SSO login: an issuer or client id that is not plain text runs nothing', async ($, on) => {
  const env: Record<string, string> = { KUBECONFIG: '', HOME: '/home/t', AWS_PROFILE: '' }
  const ran: any = oidcWorld(on, env)
  await startSession($, on)
  const ui = await mount($, 'terminal')
  await fillOidc(ui, 'http://login.example.com', 'kubernetes') // not https
  await ran.clock.advance(1500)
  await fillOidc(ui, 'https://login.example.com; rm -rf ~', 'kubernetes')
  await ran.clock.advance(1500)
  await fillOidc(ui, 'https://login.example.com', '--x')
  await ran.clock.advance(1500)
  expect(ran.length).toBe(0)
  expect(env.KUBECONFIG).toBe('')
  await ui.unmount()
})
