// The per-repo todo list, kept in $.store (shared by all sessions on the machine).

export let todos = []

// Todos are kept per project root: key 'todos:<root>' in $.store (shared by all sessions).
export let todoKey = 'todos'

export let repoName = ''

export let projectRoot = ''

// Names of other kube-deck store files next to ours (the host names the file by install source,
// so an inline copy and a marketplace copy each get their own list). Empty when there is only one.
export let otherStores = []

const STORE_DIR = '.claude/plugins/store'

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
  await findOtherStores($)
  $.ui.invalidate('ui.render')
}

// Best effort: if the directory cannot be listed we simply show no warning.
async function findOtherStores($) {
  try {
    const home = (await $.env.get('HOME')) ?? ''
    if (!home) return
    const r = await $.process.run(['ls', '-1', home + '/' + STORE_DIR], { timeoutMs: 3000 })
    const files = r.exitCode === 0 ? String(r.stdout).split('\n').filter((f) => /^kube-deck_.+\.json$/.test(f)) : []
    // Our own file is the one that holds the key we just read or wrote; we cannot tell which it is,
    // so the warning only says that more than one exists.
    otherStores = files.length > 1 ? files : []
  } catch {
    otherStores = []
  }
}

export const SPLIT_STORE_NOTE =
  'kube-deck is installed from more than one source, so each keeps its own todo list and this one may be incomplete. Load kube-deck from one source only.'

export async function mutateTodos($, change) {
  // read right before writing: other sessions share $.store
  const stored = await $.store.get(todoKey)
  todos = change(Array.isArray(stored) ? stored : [])
  await $.store.set(todoKey, todos)
  $.ui.invalidate('ui.render')
}

export function formatTodos() {
  const note = otherStores.length > 0 ? '\n\nWarning: ' + SPLIT_STORE_NOTE : ''
  if (todos.length === 0) return 'The todo list for this repo is empty.' + note
  return todos.map((t) => t.id + ' ' + (t.done ? '[x]' : '[ ]') + ' ' + t.text).join('\n') + note
}
