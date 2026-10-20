// Pure logic, no `$`: masks Kubernetes Secret values in command output before the model reads it.
// Best-effort and regex-based: it covers Secret objects (yaml/json), commands that print a
// token, and pipelines that pull a secret apart. It does NOT cover env vars in pod specs,
// ConfigMaps, logs, `oc exec ... env`, or anything not recognisably a secret read.

export const MASK = '<redacted>'

// ---- command lines
// A command line shown on screen (the recent-commands card) or written to the audit log must not
// carry the secrets typed into it. This only changes the copy that is shown or logged; the command
// itself runs as written. Best effort, like everything here: it knows the usual shapes below.
const VALUE = String.raw`(?:"[^"]*"|'[^']*'|\S+)` // one argument, quoted or not
const CRED_WORD = String.raw`(?:token|password|passwd|secret|api-?key|access-?key|private-?key|credentials?)`
const SECRET_FLAG = new RegExp(String.raw`(--[a-z0-9-]*${CRED_WORD}[a-z0-9-]*(?:=|\s+))${VALUE}`, 'gi')
const SECRET_ENV = new RegExp(String.raw`((?:^|[\s;&|(])[A-Za-z0-9_]*${CRED_WORD.replace(/-\?/g, '_?')}[A-Za-z0-9_]*=)${VALUE}`, 'gi')
const LOGIN_P = new RegExp(String.raw`(\s-p(?:=|\s+))${VALUE}`, 'g')
const FROM_LITERAL = new RegExp(String.raw`(--from-literal(?:=|\s+)['"]?[^=\s'"]+=)${VALUE}`, 'g')
const HELM_SET = new RegExp(String.raw`(--set(?:-string|-literal)?(?:=|\s+)['"]?[^=\s'"]*${CRED_WORD}[^=\s'"]*=)${VALUE}`, 'gi')
const AUTH_HEADER = /((?:Authorization:\s*)?\b(?:Bearer|Basic)\s+)[^\s"']+/gi
const URL_PASSWORD = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(@)/gi
// credentials that look like themselves wherever they appear
const TOKEN_FORMATS = [
  [/(sha256~)\S+/g, '$1***'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '***'],
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*/g, '***'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '***'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '***'],
]

export function maskCommand(command) {
  let s = String(command ?? '')
  s = s.replace(SECRET_FLAG, '$1***') // --token x, --password=x, --docker-password x, --client-secret x
  s = s.replace(FROM_LITERAL, '$1***') // oc create secret generic x --from-literal=key=value
  s = s.replace(HELM_SET, '$1***') // helm --set db.password=value
  s = s.replace(SECRET_ENV, '$1***') // AWS_SECRET_ACCESS_KEY=x oc ..., GITHUB_TOKEN=x
  if (/\blogin\b/.test(s)) s = s.replace(LOGIN_P, '$1***') // oc login -u u -p password
  s = s.replace(AUTH_HEADER, '$1***') // curl -H "Authorization: Bearer x"
  s = s.replace(URL_PASSWORD, '$1***$2') // https://user:password@host
  for (const [re, to] of TOKEN_FORMATS) s = s.replace(re, to)
  return s
}

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
