// Settings and constants. Everything you may want to edit before trusting the guard is in this file.

// ---------------------------------------------------------------- config (edit)
// A cluster counts as prod when any of these match the kubeconfig path, the cluster
// name, or the API server URL. Unknown cluster (no kubeconfig / oc missing) = strict.
export const PROD_PATTERNS = [/prod/i]

// ...and ONLY a cluster that matches one of these is trusted as non-prod. Matched against the
// kubeconfig FILE name, the cluster name and the API host (not the folder, so a home directory
// called "devops" marks nothing). A name that matches neither list is "unlisted" and is treated
// as prod, so a prod cluster nobody named "prod" still gets asked. PROD_PATTERNS wins over this.
// A letter on either side breaks a match, so "devops" is not "dev"; digits and - _ . do not.
export const NONPROD_PATTERNS = [
  /(^|[^a-z])(sandbox|dev|test|staging|stage|qa|lab|demo|local|minikube|kind|crc|docker-desktop|rancher-desktop)([^a-z]|$)/i,
]

// Used only to READ the local kubeconfig (`config view --minify`), never talks to a cluster.
export const KUBE_CLI = 'oc'

// Used to check the AWS login (`sts get-caller-identity`, read-only). Run at most every 5 minutes.
export const AWS_CLI = 'aws'

export const AWS_CHECK_MS = 5 * 60000

// How long `aws sso login` may wait for you to approve in the browser (10 minutes is the most
// $.process.run allows). Killing it earlier leaves the browser's redirect with nothing to connect to.
export const AWS_LOGIN_MS = 10 * 60000

// How long `oc login --web` may wait for you to approve in the browser (same cap as above).
export const KUBE_LOGIN_MS = 10 * 60000

// How long a token or password login may take: no browser step, so a hung server should fail fast.
export const KUBE_CRED_LOGIN_MS = 60000

// API URL typed in the panel: https, a host name, optional port. It ends up in a command line.
export const KUBE_SERVER_RE = /^https:\/\/[A-Za-z0-9][A-Za-z0-9.-]*(:\d{1,5})?$/

// SSO start URL and region typed in the panel; both end up in ~/.aws/config and on a command line.
export const AWS_SSO_URL_RE = /^https:\/\/[A-Za-z0-9][A-Za-z0-9.-]*(\/[A-Za-z0-9_.\/-]*)?$/

// The Identity Center issuer URL is also accepted as a start URL; its id is exactly 16 hex digits,
// so extra text stuck on the end (a region typed into the wrong field) is caught.
export const AWS_SSO_ISSUER_RE = /^https:\/\/identitycenter\.amazonaws\.com\/ssoins-[0-9a-f]{16}$/

export const AWS_REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/

export const AWS_PROFILE_RE = /^[A-Za-z0-9_][A-Za-z0-9_.@+=,-]*$/

// Approve-all switches itself off this many minutes after it was turned on.
export const APPROVE_MINUTES = 15

// Audit log: $HOME/<AUDIT_DIR>/audit.jsonl, one JSON line per cluster-changing command.
export const AUDIT_DIR = '.kube-deck'

// Panel colors. Theme keys, not hex: they follow the person's light/dark theme. Change a
// value here to restyle the whole panel (any theme key, or a color string).
export const THEME = {
  brand: 'claude', // title, todo card
  accent: 'suggestion', // guard card, primary actions
  ok: 'success', // non-prod, approved, all done
  warn: 'warning', // approve-all ON
  danger: 'error', // PROD, refused, delete
  muted: 'subtle', // secondary text, borders
  text: 'text',
  onColor: 'inverseText', // text drawn on a filled chip or hovered button
}

// The right-hand panel. Beside the transcript in a wide fullscreen terminal (a pane the mod
// opens by itself needs >= 144 columns); /deck opens it above the prompt otherwise.
export const PANE = 'deck'

export const PANE_COLUMNS = 46

// The tool Claude can call: mcp__<plugin name>__<tool name>
export const TODO_TOOL = 'mcp__kube-deck__todo'

export const APPROVE_LABEL = 'Run it + approve all for ' + APPROVE_MINUTES + ' min'

export const newId = () => Math.random().toString(36).slice(2, 8)
