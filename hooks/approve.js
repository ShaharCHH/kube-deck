// approve-all with an expiry. Never persisted: every new session starts guarded.

import { APPROVE_MINUTES } from './config.js'

export let approveAll = false

export let approveUntil = 0

// ---- approve-all with an expiry
export async function setApprove($, on) {
  approveAll = on
  approveUntil = on ? (await $.clock.now()) + APPROVE_MINUTES * 60000 : 0
  $.ui.invalidate('ui.render')
}

// True while approve-all is on and not expired. Checked on every guarded command, so it holds
// even if the timer below never fired.
export async function approveActive($) {
  if (!approveAll) return false
  if ((await $.clock.now()) < approveUntil) return true
  approveAll = false
  approveUntil = 0
  $.ui.toast('kube-deck: approve-all expired, asking again')
  $.ui.invalidate('ui.render')
  return false
}

export function mmss(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0')
}
