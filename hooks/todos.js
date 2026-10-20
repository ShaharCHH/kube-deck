// The per-repo todo list, kept in $.store (shared by all sessions on the machine).

export let todos = []

// Todos are kept per project root: key 'todos:<root>' in $.store (shared by all sessions).
export let todoKey = 'todos'

export let repoName = ''

export let projectRoot = ''

// ---- todos
// Point the todo list at the current project root and load it. Called at session start,
// on every prompt (the root can move with /cd or a worktree) and before the model's tool runs.
export async function loadTodos($) {
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

export async function mutateTodos($, change) {
  // read right before writing: other sessions share $.store
  const stored = await $.store.get(todoKey)
  todos = change(Array.isArray(stored) ? stored : [])
  await $.store.set(todoKey, todos)
  $.ui.invalidate('ui.render')
}

export function formatTodos() {
  if (todos.length === 0) return 'The todo list for this repo is empty.'
  return todos.map((t) => t.id + ' ' + (t.done ? '[x]' : '[ ]') + ' ' + t.text).join('\n')
}
