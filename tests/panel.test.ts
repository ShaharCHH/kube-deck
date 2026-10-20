import { expect, mock, test } from 'claude-code/testing'

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
  mock.clock(on, { now: 1_000_000 })
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
