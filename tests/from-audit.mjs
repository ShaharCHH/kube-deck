// Turns the guard's "Not a cluster command" answers into classifier test cases.
//   node tests/from-audit.mjs [path/to/audit.jsonl]      (default: ~/.kube-deck/audit.jsonl)
// Prints one line per distinct command, ready to paste into tests/classify.test.mjs, and says
// whether the CURRENT classifier still flags it. Lines that already pass are fixed: paste them as
// regression tests. Lines marked STILL FLAGGED are the parser bugs to fix next.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { classify } from '../hooks/classify.js'

const file = process.argv[2] ?? homedir() + '/.kube-deck/audit.jsonl'
let text
try {
  text = readFileSync(file, 'utf8')
} catch (err) {
  console.error('cannot read ' + file + ': ' + err.message)
  process.exit(1)
}

const seen = new Set()
let still = 0
for (const line of text.split('\n')) {
  let entry
  try { entry = JSON.parse(line) } catch { continue }
  if (entry.outcome !== 'false-positive' || seen.has(entry.command)) continue
  seen.add(entry.command)
  const r = classify(entry.command)
  const flagged = r.touches && r.mutating
  if (flagged) still++
  console.log(
    '  [' + JSON.stringify(entry.command) + ', false, false, false],' +
      (flagged ? '  // STILL FLAGGED, matched: ' + (entry.matched ?? []).join(', ') : ''),
  )
}
console.error(seen.size + ' false positive(s), ' + still + ' still flagged by the current classifier')
