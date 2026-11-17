import { atom, update } from 'claude-code'

// What was picked in the panel (AWS_PROFILE, KUBECONFIG), kept in $.state: a hot reload resets
// module variables but not this, and the process environment keeps the pick after a reload while
// Claude's shell never had it.
// Not exported: the engine's scan lists what a module reads and writes only while the reference
// stays in this file, used in place.
const PICKED_REF = { plugin: 'kube-deck', key: 'picked' }

const pickedAtom = atom(PICKED_REF, {})

// `export NAME='value'` for one picked variable. Values are quoted, so a path with a space
// or a quote in it stays one word.
const exportOf = ([k, v]) => 'export ' + k + "='" + String(v).replace(/'/g, "'\\''") + "'"

// `export NAME='value'; ` for each picked variable, to put in front of a command.
export function exportPrefix(vars) {
  return Object.entries(vars)
    .map((kv) => exportOf(kv) + '; ')
    .join('')
}

// Claude Code applies ~/.kube-deck/env/<session id>.env to every Bash command, through the line
// hooks/env-file.sh adds to $CLAUDE_ENV_FILE when the session starts. Keeping the picks there
// means the command is never rewritten: a command a hook changes after auto mode reviewed it
// gets no verdict (issue #24).
// Returns false when that file is not there (the hook did not run, e.g. an older Claude Code),
// and the guard falls back to the prefix.
export async function syncEnvFile($, vars) {
  try {
    const home = (await $.env.get('HOME')) ?? ''
    const id = await $.session.id()
    if (!home || !/^[A-Za-z0-9-]+$/.test(id)) return false
    const path = home + '/.kube-deck/env/' + id + '.env'
    if (!(await $.fs.exists(path))) return false
    await $.fs.write(path, Object.entries(vars).map((kv) => exportOf(kv) + '\n').join(''))
    return true
  } catch {
    return false
  }
}

// Remember a pick. `update` has to sit in the file that makes the atom (the engine's scan lists
// what a module reads and writes from it), so the other modules call this.
export async function setPicked($, name, value) {
  await update($, pickedAtom, (p) => ({ ...p, [name]: value }))
}

export async function getPicked($) {
  try {
    return (await $.state.get(PICKED_REF)).value ?? {}
  } catch {
    return {}
  }
}
