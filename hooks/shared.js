// Typed-in drafts and "login wanted" flags that more than one module reads or writes.
// Plain objects, so a module can change a property (an imported name cannot be reassigned).
export const drafts = { kubeServer: '', ssoUrl: '', ssoRegion: '' }
// Set by a panel button; the 1s timer in session.start (which holds the session's `$`) does the login.
export const wanted = { kubeLogin: false, awsLogin: false, awsSso: false }
