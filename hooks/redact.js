// Pure logic, no `$`: masks Kubernetes Secret values in command output before the model reads it.
// Best-effort and regex-based: it covers Secret objects (yaml/json), commands that print a
// token, and pipelines that pull a secret apart. It does NOT cover env vars in pod specs,
// ConfigMaps, logs, `oc exec ... env`, or anything not recognisably a secret read.

export const MASK = '<redacted>'

// Commands whose whole point is to print a credential.
const TOKEN_COMMANDS = /\bwhoami\b[^|;&\n]*(\s-t\b|--show-token)|\bcreate\s+token\b|\bget-token\b|\bnew-token\b|\bsa\s+get-token\b/

// A secret read that is reshaped on the way out, so the output carries no Secret marker.
const SECRET_WORD = /\bsecrets?\b/i
const RESHAPE = /jsonpath|go-template|\btemplate\b|custom-columns|\bextract\b|\bbase64\b|\bjq\b|\byq\b|\bcut\b|\bawk\b|\bsed\b|\bgrep\b|\bcat\b|\btr\b/

const indentOf = (line) => line.match(/^\s*/)[0].length

// One sweep that masks values under data/stringData and the
// last-applied annotation, tracking only indentation.
function maskYaml(text) {
  const lines = text.split('\n')
  const out = []
  let count = 0
  let section = null // { base, keyIndent }
  for (const line of lines) {
    const blank = line.trim() === ''
    const indent = indentOf(line)

    if (section && !blank && indent <= section.base) section = null

    if (section) {
      if (blank) {
        out.push(line)
        continue
      }
      if (section.keyIndent === null) section.keyIndent = indent
      if (indent === section.keyIndent) {
        const m = /^(\s*[^\s:][^:]*:)/.exec(line)
        out.push(m ? m[1] + ' ' + MASK : ' '.repeat(indent) + MASK)
        count++
      }
      // deeper lines are the continuation of a block scalar: dropped
      continue
    }

    const block = /^(\s*)(data|stringData):\s*$/.exec(line)
    if (block) {
      out.push(line)
      section = { base: block[1].length, keyIndent: null }
      continue
    }
    const applied = /^(\s*)([^\s:]*last-applied-configuration:)/.exec(line)
    if (applied) {
      out.push(applied[1] + applied[2] + ' ' + MASK)
      section = { base: applied[1].length, keyIndent: -1 } // drops its block scalar lines
      count++
      continue
    }
    out.push(line)
  }
  return { text: out.join('\n'), count }
}

function maskJson(text) {
  let count = 0
  // "data": { "k": "v", ... }  (flat map of strings, as Secrets are)
  let out = text.replace(/("(?:data|stringData)"\s*:\s*\{)([^{}]*)(\})/g, (_all, open, body, close) => {
    const masked = body.replace(/("(?:[^"\\]|\\.)*"\s*:\s*)"(?:[^"\\]|\\.)*"/g, (_m, key) => {
      count++
      return key + '"' + MASK + '"'
    })
    return open + masked + close
  })
  // the last-applied annotation carries a copy of the data
  out = out.replace(/("[^"]*last-applied-configuration"\s*:\s*)"(?:[^"\\]|\\.)*"/g, (_m, key) => {
    count++
    return key + '"' + MASK + '"'
  })
  return { text: out, count }
}

/**
 * @returns {{ text: string, redacted: number, withheld: boolean }}
 *   `withheld` means the whole output was replaced, because it could not be masked safely.
 */
export function redactOutput(command, output) {
  const cmd = String(command ?? '')
  const text = String(output ?? '')
  if (text === '') return { text, redacted: 0, withheld: false }

  if (TOKEN_COMMANDS.test(cmd)) {
    return { text: '[kube-deck: this command prints a credential, so its output was withheld]', redacted: 1, withheld: true }
  }
  if (SECRET_WORD.test(cmd) && RESHAPE.test(cmd)) {
    return {
      text: '[kube-deck: output of a secret read that is reshaped (jsonpath/jq/base64/…) was withheld. Ask the user to run it themselves if the value is really needed]',
      redacted: 1,
      withheld: true,
    }
  }

  const isSecretYaml = /^\s*kind:\s*Secret\b/m.test(text)
  const isSecretJson = /"kind"\s*:\s*"Secret"/.test(text)
  if (!isSecretYaml && !isSecretJson) return { text, redacted: 0, withheld: false }

  let result = { text, count: 0 }
  if (isSecretYaml) result = maskYaml(result.text)
  if (isSecretJson) {
    const j = maskJson(result.text)
    result = { text: j.text, count: result.count + j.count }
  }
  if (result.count === 0) return { text, redacted: 0, withheld: false }
  return {
    text: result.text + '\n[kube-deck: ' + result.count + ' secret value(s) redacted]',
    redacted: result.count,
    withheld: false,
  }
}
