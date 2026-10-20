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
