// The session state kube-deck keeps in `$.state` (it survives a hot reload; module variables do not).
export type Picked = { AWS_PROFILE?: string; KUBECONFIG?: string }

declare module 'claude-code' {
  interface PluginState {
    'kube-deck': { picked: Picked }
  }
}
