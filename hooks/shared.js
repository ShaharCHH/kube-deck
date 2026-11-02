// Typed-in drafts and "login wanted" flags that more than one module reads or writes.
// Plain objects, so a module can change a property (an imported name cannot be reassigned).
// kubeMethod: which login the cluster card shows (browser | token | password); kubeAdd: path typed in "Add kubeconfig".
export const drafts = { kubeServer: '', kubeMethod: 'browser', kubeAdd: '', ssoUrl: '', ssoRegion: '' }
// What was typed for a token or password login. The panel cannot hide typed text, so these live only in
// this object (never in $.state, $.store, the audit log or a toast) and are emptied once the login works.
export const secrets = { user: '', pass: '', token: '' }
// Set by a panel button; the 1s timer in session.start (which holds the session's `$`) does the login.
// kubeInsecure: the pending kubeLogin should skip the TLS certificate check (only ever set by a deliberate press).
export const wanted = { kubeLogin: false, kubeInsecure: false, kubeMethod: 'browser', awsLogin: false, awsSso: false }
