// Pure logic, no `$`: decides whether a shell command touches a cluster CLI,
// whether it changes anything, and whether it overrides the target cluster inline.
// This is a reminder-grade heuristic, NOT a security boundary. Unknown verbs count as
// "changes something" so the failure mode is an extra prompt, not a silent pass.

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

// Anything that points the command at a cluster other than the one in your KUBECONFIG
const RETARGET = /(^|\s)(--(kubeconfig|context|server|cluster|kube-context|kube-apiserver|token)([=\s]|$)|KUBECONFIG=)/
const RETARGET_SHORT = /\s-s[\s=]/ // oc/kubectl only

const DRY_RUN = /--dry-run(=(client|server|true))?(\s|$)/

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

// Also splits at `(`, `)` and backticks, so a command inside $(...) or `...` is looked at too.
// Quotes are not understood: a separator inside quotes only ever adds a harmless extra piece.
function splitSegments(command) {
  return String(command ?? '').split(/&&|\|\||;|\||\n|\(|\)|`/)
}

function analyzeSegment(segment, result, depth) {
  const tokens = segment.trim().split(/\s+/).filter(Boolean)
  let i = 0
  let sawPrefix = false
  while (i < tokens.length) {
    const t = bare(tokens[i])
    if (ENV_ASSIGN.test(t)) { i++; continue }
    if (KEYWORDS.has(t)) { i++; continue }
    if (PREFIXES.has(t)) { sawPrefix = true; i++; continue }
    // after a prefix such as xargs/sudo, skip its options until the CLI shows up
    if (sawPrefix && !CLIS.has(base(t))) { i++; continue }
    break
  }
  if (i >= tokens.length) return

  const head = base(bare(tokens[i]))

  // bash -c "oc delete ..." : look inside the quoted string
  if (SHELLS.has(head) && depth < 2 && /^-[a-z]*c$/.test(tokens[i + 1] ?? '')) {
    const inner = tokens.slice(i + 2).join(' ').replace(/^["']|["']$/g, '')
    for (const seg of splitSegments(inner)) analyzeSegment(seg, result, depth + 1)
    return
  }

  // eval "oc delete ...": the argument is a command line
  if (head === 'eval' && depth < 2) {
    const inner = tokens.slice(i + 1).join(' ').replace(/^["']|["']$/g, '')
    for (const seg of splitSegments(inner)) analyzeSegment(seg, result, depth + 1)
    return
  }
  // find ... -exec oc delete {} \;
  const exec = head === 'find' ? tokens.findIndex((t, k) => k > i && EXEC_FLAGS.has(t)) : -1
  if (exec > -1 && depth < 2) {
    analyzeSegment(tokens.slice(exec + 1).join(' '), result, depth + 1)
    return
  }
  // ssh bastion oc delete ...: what follows the host runs there; look from the first CLI word on
  if (head === 'ssh' && depth < 2) {
    const at = tokens.findIndex((t, k) => k > i && CLIS.has(base(bare(t))))
    if (at > -1) analyzeSegment(tokens.slice(at).join(' '), result, depth + 1)
    return
  }

  if (!CLIS.has(head)) return
  result.touches = true
  if (RETARGET.test(segment) || ((head === 'oc' || head === 'kubectl') && RETARGET_SHORT.test(segment))) {
    result.retarget = true
  }

  // first two positional tokens after the CLI = verb and sub-verb
  const positional = []
  for (let j = i + 1; j < tokens.length && positional.length < 2; j++) {
    const t = tokens[j]
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
  if (mutating && DRY_RUN.test(segment)) mutating = false

  if (mutating) result.mutating = true
  result.hits.push({ cli: head, verb: verb ?? '', sub: sub ?? '', mutating })
}

export function classify(command) {
  const result = { touches: false, mutating: false, retarget: false, hits: [] }
  for (const seg of splitSegments(command)) analyzeSegment(seg, result, 0)
  return result
}
