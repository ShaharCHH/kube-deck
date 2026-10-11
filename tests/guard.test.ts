import { expect, mock, test } from 'claude-code/testing'

const KUBECONFIG_JSON = JSON.stringify({
  clusters: [{ name: 'api-x', cluster: { server: 'https://api.x.example.com:6443' } }],
  contexts: [{ context: { namespace: 'payments' } }],
})
const SECRET_YAML = 'apiVersion: v1\ndata:\n  password: c3VwZXJzZWNyZXQ=\nkind: Secret\nmetadata:\n  name: demo\n'

// Sets up the world beneath the plugin and returns what the plugin did to it.
function world(on: any, opts: { kubeconfig: string; answer?: string }) {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  mock.store(on)
  mock.env(on, { KUBECONFIG: opts.kubeconfig, HOME: '/home/t' })
  const seen = { asks: [] as string[], ran: [] as string[], audit: [] as any[], modes: [] as string[] }
  on('session.root', () => ({ value: '/work/my-repo' }))
  on('process.run', (_$: any, e: any) => {
    const argv: string[] = e.argv
    if (argv[0] === 'oc') return { value: { exitCode: 0, stdout: KUBECONFIG_JSON, stderr: '' } }
    if (argv[0] === 'chmod') seen.modes.push(argv[1] + ' ' + argv[2])
    if (argv[0] === 'sh' && /umask 077/.test(argv[2] ?? '') && /tee -a/.test(argv[2])) seen.audit.push(JSON.parse(String(e.init?.stdin).trim()))
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  // $.ui.ask is a tool.call of AskUserQuestion: answer it as the person would
  on('tool.call', { tool: 'AskUserQuestion' } as any, (_$: any, e: any) => {
    const q = e.questions[0].question
    seen.asks.push(q)
    return { result: { questions: e.questions, answers: { [q]: opts.answer ?? 'Run it' } } }
  })
  // the engine's own Bash: records the command and prints a secret for `get secret`
  on('tool.call', { tool: 'Bash' } as any, (_$: any, e: any) => {
    seen.ran.push(e.command)
    const stdout = /get secret/.test(e.command) ? SECRET_YAML : 'ok'
    return { result: { stdout, stderr: '', interrupted: false } }
  })
  return { clock, seen }
}

test('prod: a refused change is denied and audited, a read passes', async ($, on) => {
  const { seen } = world(on, { kubeconfig: '/k/prod-east.kubeconfig', answer: 'Refuse' })
  const denied: any = await $.tool.call({ tool: 'Bash', command: 'oc delete pod x' } as any)
  expect(String(denied.deny)).toContain('declined')
  expect(seen.ran).toEqual([])
  expect(seen.audit.at(-1).outcome).toBe('refused')
  expect(seen.audit.at(-1).prod).toBe(true)
  // audit log holds full command lines: private dir and file
  expect(seen.modes).toContain('700 /home/t/.kube-deck')
  expect(seen.modes).toContain('600 /home/t/.kube-deck/audit.jsonl')

  const read: any = await $.tool.call({ tool: 'Bash', command: 'oc get pods' } as any)
  expect(read.deny).toBeUndefined()
  expect(seen.asks.length).toBe(1)
})

test('prod: an approved change runs and is audited', async ($, on) => {
  const { seen } = world(on, { kubeconfig: '/k/prod-east.kubeconfig', answer: 'Run it' })
  await $.tool.call({ tool: 'Bash', command: 'oc scale deploy/x --replicas=0' } as any)
  expect(seen.ran).toEqual(['oc scale deploy/x --replicas=0'])
  expect(seen.audit.at(-1).outcome).toBe('approved')
})

test('non-prod: changes run without a question', async ($, on) => {
  const { seen } = world(on, { kubeconfig: '/k/sandbox.kubeconfig' })
  await $.tool.call({ tool: 'Bash', command: 'oc delete pod x' } as any)
  expect(seen.asks.length).toBe(0)
  expect(seen.audit.at(-1).outcome).toBe('non-prod')
})

test('approve-all skips the question, then expires after 15 minutes', async ($, on) => {
  const { clock, seen } = world(on, { kubeconfig: '/k/prod-east.kubeconfig', answer: 'Run it' })
  await $.command.run({ command: 'approve-all', args: '' })
  await $.tool.call({ tool: 'Bash', command: 'oc delete pod a' } as any)
  expect(seen.asks.length).toBe(0)
  expect(seen.audit.at(-1).outcome).toBe('auto')

  await clock.advance(16 * 60 * 1000)
  await $.tool.call({ tool: 'Bash', command: 'oc delete pod b' } as any)
  expect(seen.asks.length).toBe(1)
  expect(seen.audit.at(-1).outcome).toBe('approved')
})

test('secret values never reach the model', async ($, on) => {
  world(on, { kubeconfig: '/k/sandbox.kubeconfig' })
  const r: any = await $.tool.call({ tool: 'Bash', command: 'oc get secret demo -o yaml' } as any)
  expect(JSON.stringify(r)).not.toContain('c3VwZXJzZWNyZXQ')
  expect(String(r.result.stdout)).toContain('<redacted>')
})
