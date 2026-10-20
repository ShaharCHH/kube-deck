import { atom, update } from 'claude-code'

// What was picked in the panel (AWS_PROFILE, KUBECONFIG), kept in $.state: a hot reload resets
// module variables but not this, and the process environment keeps the pick after a reload while
// Claude's shell never had it.
// Not exported: the engine's scan lists what a module reads and writes only while the reference
// stays in this file, used in place.
const PICKED_REF = { plugin: 'kube-deck', key: 'picked' }

const pickedAtom = atom(PICKED_REF, {})

// `export NAME='value'; ` for each picked variable. Values are quoted, so a path with a space
// or a quote in it stays one word.
export function exportPrefix(vars) {
  return Object.entries(vars)
    .map(([k, v]) => 'export ' + k + "='" + String(v).replace(/'/g, "'\\''") + "'; ")
    .join('')
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
