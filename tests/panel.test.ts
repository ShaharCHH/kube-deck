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

test('without a cluster: only the todo card draws', async ($, on) => {
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
