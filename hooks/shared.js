// Typed-in drafts and "login wanted" flags that more than one module reads or writes.
// Plain objects, so a module can change a property (an imported name cannot be reassigned).
export const drafts = { kubeServer: '', ssoUrl: '', ssoRegion: '' }
// Set by a panel button; the 1s timer in session.start (which holds the session's `$`) does the login.
// kubeInsecure: the pending kubeLogin should skip the TLS certificate check (only ever set by a deliberate press).
export const wanted = { kubeLogin: false, kubeInsecure: false, awsLogin: false, awsSso: false }
