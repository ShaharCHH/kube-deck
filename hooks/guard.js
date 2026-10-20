import { classify } from './classify.js'
import { approveActive, setApprove } from './approve.js'
import { audit, describeVerdict, record, redactResult } from './audit.js'
import { aws, awsSource } from './aws.js'
import { cluster, refreshCluster } from './cluster.js'
import { APPROVE_LABEL } from './config.js'
import { exportPrefix, getPicked } from './picked.js'

// What Claude's shell must be given so it matches the panel: everything picked, plus the AWS
// profile on show when it did not come from AWS_PROFILE (.aws-profile, or the only profile).
export async function shellExports($) {
  return { ...(aws.profile && awsSource !== 'env' ? { AWS_PROFILE: aws.profile } : {}), ...(await getPicked($)) }
}

export function registerGuard(on) {
  // ---- the guard: ask on prod, redact secrets from the output, write the audit log
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const verdict = classify(e.command)
    // what the shell actually runs: the picked AWS profile / kubeconfig first, then the command.
    // The checks below look at the original command, so they are not fooled by the prefix.
    const prefix = exportPrefix(await shellExports($))
    const go = (ev) => next(prefix ? { ...ev, command: prefix + ev.command } : ev)
    if (!verdict.touches) return go(e)

    // the kubeconfig or the project may have changed since the last call
    await refreshCluster($)

    const at = await $.clock.now()
    const auto = await approveActive($)
    const wouldAsk = verdict.mutating && (cluster.isProd || verdict.retarget)
    const needsApproval = wouldAsk && !auto
    if (needsApproval) {
      let answer = 'Refuse' // a dismissed question must refuse
      try {
        answer = await $.ui.ask(describeVerdict(verdict, e.command), ['Run it', APPROVE_LABEL, 'Refuse'])
      } catch {}
      if (answer === APPROVE_LABEL) {
        await setApprove($, true)
      } else if (answer !== 'Run it') {
        record(at, e.command, 'refused')
        await audit($, at, e.command, 'refused', verdict.retarget)
        $.ui.invalidate('ui.render')
        return { deny: 'The user declined this cluster command. Do not retry it; ask what they want instead.' }
      }
    }
    if (verdict.mutating) {
      const outcome = needsApproval ? 'approved' : wouldAsk ? 'auto' : 'non-prod'
      record(at, e.command, outcome)
      await audit($, at, e.command, outcome, verdict.retarget)
      $.ui.invalidate('ui.render')
    }

    const result = await go(e)
    await refreshCluster($) // e.g. `oc project foo` just changed the namespace
    return await redactResult($, e.command, result)
  }).catch(async ($, e, next) => ({
    deny: next.called
      ? 'kube-deck failed after the command ran (' + next.error.kind + '), so its output was withheld as a precaution. Tell the user.'
      : 'The kube-deck guard failed (' + next.error.kind + '), so this command was not run. Tell the user.',
  }))
}
