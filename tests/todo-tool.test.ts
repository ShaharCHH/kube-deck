import { expect, test } from 'claude-code/testing'

test('the todo tool adds and lists per-repo items', async ($, on) => {
  const db: Record<string, unknown> = {}
  on('session.root', () => ({ value: '/work/my-repo' }))
  on('store.get', (_$, e) => ({ value: db[(e as any).key] }))
  on('store.set', (_$, e) => { db[(e as any).key] = (e as any).value; return { value: undefined } })

  const added = await $.tool.call({ tool: 'mcp__kube-deck__todo', action: 'add', text: 'drain worker-3' } as any)
  expect(String((added as any).result)).toContain('drain worker-3')

  const listed = await $.tool.call({ tool: 'mcp__kube-deck__todo', action: 'list' } as any)
  expect(String((listed as any).result)).toContain('[ ] drain worker-3')
  expect(Object.keys(db)).toEqual(['todos:/work/my-repo'])

  const dup = await $.tool.call({ tool: 'mcp__kube-deck__todo', action: 'add', text: 'Drain worker-3' } as any)
  expect(String((dup as any).result)).toContain('Already on the list')

  const id = String((added as any).result).split(' ')[1].replace(':', '')
  const upd = await $.tool.call({ tool: 'mcp__kube-deck__todo', action: 'update', id, text: 'drain worker-4' } as any)
  expect(String((upd as any).result)).toContain('drain worker-4')
})
