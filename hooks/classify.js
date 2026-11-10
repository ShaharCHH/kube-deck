// Pure logic, no `$`: decides whether a shell command touches a cluster CLI,
// whether it changes anything, and whether it overrides the target cluster inline.
// This is a reminder-grade heuristic, NOT a security boundary. Unknown verbs count as
// "changes something" so the failure mode is an extra prompt, not a silent pass.
//
// The command line is scanned like a shell would: text inside single quotes, comments and
// heredoc bodies is data, never a command ("git commit -m 'oc delete'" does not touch a cluster).
// Things that do run, even inside quotes, are looked at too: $(...), `...`, bash -c '...',
// eval, ssh host '...', a heredoc fed to bash, "echo oc delete x | bash". When the scanner is
// unsure (nesting too deep) it assumes the command changes something.

const CLIS = new Set(['oc', 'kubectl', 'helm', 'argocd'])
const PREFIXES = new Set(['sudo', 'doas', 'time', 'timeout', 'xargs', 'watch', 'nohup', 'command', 'exec', 'env', 'nice', 'ionice', 'setsid', 'stdbuf', 'caffeinate'])
// Shell words that sit in front of a command: `for x in a b; do oc delete pod $x; done`, `if ...; then oc ...`
const KEYWORDS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{'])
// find runs what follows these once per match: `find . -exec oc delete -f {} \;`
const EXEC_FLAGS = new Set(['-exec', '-execdir', '-ok', '-okdir'])
const SHELLS = new Set(['bash', 'sh', 'zsh'])
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/

// Flags that consume the next token when written as "--flag value"
const VALUE_FLAGS = new Set([
  '-n', '--namespace', '--context', '--kubeconfig', '--cluster', '--user', '--server', '-s',
  '--token', '--as', '--as-group', '--request-timeout', '--kube-context', '--kube-apiserver',
  '--kube-token', '--kube-as-user', '--kube-as-group', '--kube-ca-file', '--auth-token',
  '--argocd-context',
])

// Anything that points the command at a cluster other than the one in your KUBECONFIG (checked per word)
const RETARGET_FLAG = /^--(kubeconfig|context|server|cluster|kube-context|kube-apiserver|token)(=|$)/
const isRetarget = (t, short) => RETARGET_FLAG.test(t) || t.startsWith('KUBECONFIG=') || (short && (t === '-s' || t.startsWith('-s=')))

const DRY_RUN = /^--dry-run(=(client|server|true))?$/

const MAX_DEPTH = 3 // nesting of bash -c / eval / $(...) we look into
const CLI_WORD = /(^|[^\w.-])(oc|kubectl|helm|argocd)($|[^\w-])/
const SHELL_C = /^-[A-Za-z]*c[A-Za-z]*$/

const READ = {
  oc: {
    single: ['get', 'describe', 'logs', 'top', 'explain', 'api-resources', 'api-versions', 'version',
      'whoami', 'status', 'projects', 'events', 'diff', 'wait', 'kustomize', 'completion',
      'help', 'options'],
    pair: {
      rollout: ['status', 'history'],
      config: ['view', 'current-context', 'get-contexts', 'get-clusters', 'get-users'],
      adm: ['top', 'node-logs'],
      auth: ['can-i', 'whoami'],
    },
  },
  helm: {
    single: ['list', 'ls', 'status', 'get', 'history', 'show', 'search', 'template', 'lint', 'version', 'env', 'verify'],
    pair: { repo: ['list'], plugin: ['list'] },
  },
  argocd: {
    single: ['version'],
    pair: {
      app: ['get', 'list', 'diff', 'history', 'manifests', 'resources', 'logs', 'wait'],
      cluster: ['list', 'get'],
      proj: ['list', 'get'],
      repo: ['list', 'get'],
    },
  },
}
READ.kubectl = READ.oc

const bare = (t) => t.replace(/^["'`($]+/, '').replace(/["'`)]+$/, '')
const base = (t) => t.split('/').pop()
const texts = (tokens) => tokens.map((t) => t.t).join(' ')

// ---------------------------------------------------------------- scanner
// Cuts a command line into segments (one simple command each) of tokens { t: text without quotes,
// q: some of it was quoted }. A segment may carry heredoc bodies / a here-string, and `from`, the segment
// piped into it. `nested` are scripts that run although they sit inside quotes: "$(...)" and "`...`".
// Cut points are only the unquoted ones: ; & && | || newline ( ) and backticks.

// the text of a $( ... ) that starts at `from` and the index of its closing paren
function substitution(src, from) {
  let depth = 1
  for (let i = from; i < src.length; i++) {
    const c = src[i]
    if (c === '\\') i++
    else if (c === "'") i = src.indexOf("'", i + 1) < 0 ? src.length : src.indexOf("'", i + 1)
    else if (c === '"') { for (i++; i < src.length && src[i] !== '"'; i++) if (src[i] === '\\') i++ }
    else if (c === '(') depth++
    else if (c === ')' && --depth === 0) return [src.slice(from, i), i]
  }
  return [src.slice(from), src.length]
}

// the text of a `...` that starts at `from` and the index of its closing backtick
function backticked(src, from) {
  for (let i = from; i < src.length; i++) {
    if (src[i] === '\\') i++
    else if (src[i] === '`') return [src.slice(from, i), i]
  }
  return [src.slice(from), src.length]
}

// the commands hiding in an expanding text (a heredoc body): everything in $(...) and `...`
function substitutionsIn(text) {
  const found = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') i++
    else if (text[i] === '$' && text[i + 1] === '(') { const [s, end] = substitution(text, i + 2); found.push(s); i = end }
    else if (text[i] === '`') { const [s, end] = backticked(text, i + 1); found.push(s); i = end }
  }
  return found
}

function scan(src) {
  const segments = []
  const nested = []
  const pending = [] // heredocs whose body starts on the next line
  const fresh = (from) => ({ tokens: [], heredocs: [], here: null, hasHere: false, from })
  let seg = fresh(null)
  let tok = null
  let hereNext = false
  const endTok = () => {
    if (!tok) return
    if (hereNext) { seg.here = tok.t; seg.hasHere = true; hereNext = false } else seg.tokens.push(tok)
    tok = null
  }
  const endSeg = (piped) => {
    endTok()
    const keep = seg.tokens.length || seg.hasHere
    if (keep) segments.push(seg)
    seg = fresh(piped ? (keep ? seg : seg.from) : null)
  }
  const add = (text, quoted) => {
    tok = tok || { t: '', q: false }
    tok.t += text
    if (quoted) tok.q = true
  }

  // bodies of the heredocs opened on the line that just ended; returns the index of the last character used
  const readHeredocs = (nl) => {
    let pos = nl + 1
    for (const p of pending.splice(0)) {
      const body = []
      let found = false
      while (pos < src.length) {
        let eol = src.indexOf('\n', pos)
        if (eol < 0) eol = src.length
        const line = src.slice(pos, eol)
        pos = eol + 1
        if ((p.dash ? line.replace(/^\t+/, '') : line) === p.delim) { found = true; break }
        body.push(line)
      }
      // no terminator (e.g. the "<<" in $((1<<3))): it was not a heredoc, scan on as usual
      if (!found) return nl
      p.seg.heredocs.push({ body: body.join('\n') })
      if (p.expand) nested.push(...substitutionsIn(body.join('\n')))
    }
    return pos - 1
  }

  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (c === '\\') {
      if (src[i + 1] === '\n') i++ // line continuation
      else if (i + 1 < src.length) { add(src[i + 1], true); i++ }
    } else if (c === "'") {
      const j = src.indexOf("'", i + 1) < 0 ? src.length : src.indexOf("'", i + 1)
      add(src.slice(i + 1, j), true)
      i = j
    } else if (c === '"') {
      add('', true)
      for (i++; i < src.length && src[i] !== '"'; i++) {
        const d = src[i]
        if (d === '\\' && i + 1 < src.length) {
          const e = src[++i]
          if (e !== '\n') add('$`"\\'.includes(e) ? e : d + e, true)
        } else if (d === '$' && src[i + 1] === '(') {
          const [s, end] = substitution(src, i + 2); nested.push(s); i = end
        } else if (d === '`') {
          const [s, end] = backticked(src, i + 1); nested.push(s); i = end
        } else add(d, true)
      }
    } else if (c === '`' || c === '(' || c === ')' || c === ';') {
      endSeg(false)
    } else if (c === '\n') {
      endSeg(false)
      if (pending.length) i = readHeredocs(i)
    } else if (c === '&') {
      if (src[i + 1] === '&') { endSeg(false); i++ }
      else if (src[i + 1] === '>' || src[i - 1] === '>' || src[i - 1] === '<') add(c) // 2>&1, &>file
      else endSeg(false) // run in the background
    } else if (c === '|') {
      const piped = src[i + 1] !== '|'
      if (src[i + 1] === '|' || src[i + 1] === '&') i++
      endSeg(piped)
    } else if (c === ' ' || c === '\t' || c === '\r') {
      endTok()
    } else if (c === '#' && !tok) {
      const nl = src.indexOf('\n', i)
      i = nl < 0 ? src.length : nl - 1 // a comment runs to the end of the line
    } else if (c === '<' && src.startsWith('<<<', i)) {
      endTok(); hereNext = true; i += 2
    } else if (c === '<' && src[i + 1] === '<') {
      let j = i + 2
      const dash = src[j] === '-'
      if (dash) j++
      while (src[j] === ' ' || src[j] === '\t') j++
      let delim = ''
      let quoted = false
      for (; j < src.length && !/[\s;|&()<>]/.test(src[j]); j++) {
        if (/['"\\]/.test(src[j])) quoted = true
        else delim += src[j]
      }
      if (delim) pending.push({ seg, delim, dash, expand: !quoted })
      seg.hasHere = true
      i = j - 1
    } else {
      add(c, false)
    }
  }
  endSeg(false)
  return { segments, nested }
}

// ---------------------------------------------------------------- classifier
// `scanMode`: the text runs somewhere we only see as words (over ssh, or piped into a shell), so skip
// leading words until a CLI turns up instead of requiring it as the first word.
function analyze(command, result, depth, scanMode = false) {
  if (depth > MAX_DEPTH) {
    // too deep to follow: if a CLI is named at all, assume the worst
    if (CLI_WORD.test(command)) {
      result.touches = result.mutating = true
      result.hits.push({ cli: 'nested', verb: '(too deep)', sub: '', mutating: true })
    }
    return
  }
  const { segments, nested } = scan(String(command ?? ''))
  for (const inner of nested) analyze(inner, result, depth + 1)
  for (const seg of segments) analyzeSegment(seg, result, depth, scanMode)
}

function analyzeSegment(seg, result, depth, scanMode) {
  const tokens = seg.tokens
  let i = 0
  let sawPrefix = scanMode
  while (i < tokens.length) {
    const t = bare(tokens[i].t)
    if (ENV_ASSIGN.test(t)) { i++; continue }
    if (KEYWORDS.has(t)) { i++; continue }
    if (PREFIXES.has(t)) { sawPrefix = true; i++; continue }
    if (sawPrefix) {
      // after a prefix such as xargs/sudo, skip its options until the command shows up
      if (CLIS.has(base(t)) || SHELLS.has(base(t)) || base(t) === 'eval' || base(t) === 'ssh' || base(t) === 'find') break
      // watch "oc get pods": a quoted word holding a whole command line
      if (tokens[i].q && /\s/.test(tokens[i].t)) analyze(tokens[i].t, result, depth + 1)
      i++
      continue
    }
    break
  }
  if (i >= tokens.length) {
    // a bare KUBECONFIG=... / export KUBECONFIG=... changes what the commands after it hit
    if (tokens.some((t) => t.t.startsWith('KUBECONFIG='))) result.retarget = true
    return
  }

  const head = base(bare(tokens[i].t))
  const rest = tokens.slice(i + 1)

  // bash -c "oc delete ...", bash <<EOF ... EOF, bash <<< "...", echo "..." | bash
  if (SHELLS.has(head)) {
    const c = rest.findIndex((t) => SHELL_C.test(t.t))
    if (c > -1) analyze(rest[c + 1]?.t ?? '', result, depth + 1)
    if (seg.here !== null) analyze(seg.here, result, depth + 1)
    for (const h of seg.heredocs) analyze(h.body, result, depth + 1)
    const readsStdin = c < 0 && seg.here === null && !seg.heredocs.length && rest.every((t) => t.t.startsWith('-'))
    if (readsStdin && seg.from) analyze(texts(seg.from.tokens), result, depth + 1, true)
    return
  }

  // eval "oc delete ...": the arguments are joined into a command line
  if (head === 'eval') {
    analyze(texts(rest), result, depth + 1)
    return
  }
  // find ... -exec oc delete {} \;
  const exec = head === 'find' ? tokens.findIndex((t, k) => k > i && EXEC_FLAGS.has(t.t)) : -1
  if (exec > -1) {
    analyze(texts(tokens.slice(exec + 1)), result, depth + 1)
    return
  }
  // ssh bastion oc delete ...: what follows the host runs there (and is parsed there again)
  if (head === 'ssh') {
    analyze(texts(rest), result, depth + 1, true)
    return
  }

  if (!CLIS.has(head)) {
    if (tokens.some((t) => t.t.startsWith('KUBECONFIG='))) result.retarget = true
    return
  }
  result.touches = true
  const short = head === 'oc' || head === 'kubectl'
  if (tokens.some((t) => isRetarget(t.t, short))) result.retarget = true

  // first two positional words after the CLI = verb and sub-verb
  const positional = []
  for (let j = i + 1; j < tokens.length && positional.length < 2; j++) {
    const t = tokens[j].t
    if (t.startsWith('-')) {
      if (!t.includes('=') && VALUE_FLAGS.has(t)) j++
      continue
    }
    positional.push(bare(t))
  }
  const [verb, sub] = positional

  let mutating = true
  const rule = READ[head]
  if (!verb) mutating = false // bare "oc" prints help
  else if (head === 'oc' && verb === 'project' && !sub) mutating = false // `oc project` / `oc project -q` only print
  else if (rule?.single.includes(verb)) mutating = false
  else if (rule?.pair[verb] && sub && rule.pair[verb].includes(sub)) mutating = false
  if (mutating && tokens.some((t) => DRY_RUN.test(t.t))) mutating = false

  if (mutating) result.mutating = true
  result.hits.push({ cli: head, verb: verb ?? '', sub: sub ?? '', mutating })
}

export function classify(command) {
  const result = { touches: false, mutating: false, retarget: false, hits: [] }
  analyze(command, result, 0)
  return result
}
