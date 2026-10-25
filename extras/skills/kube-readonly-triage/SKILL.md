---
name: kube-readonly-triage
description: Read-only triage of a failing workload on Kubernetes or OpenShift. Use when a pod is crashing, pending, not ready, a rollout is stuck, a service is unreachable, or the user says "why is X down" and has kubectl or oc access. Finds the cause with get/describe/logs/events only and never changes the cluster.
---

# Kubernetes / OpenShift read-only triage

Find out why a workload is unhealthy using **read-only commands only**. Work from the outside in: confirm where you are, find what is wrong, read the evidence, then report. Do not fix anything unless the user asks afterwards.

Use `oc` on OpenShift and `kubectl` elsewhere. The commands are the same unless noted.

## Rules

1. **Never run a command that changes the cluster.** No `apply`, `delete`, `patch`, `edit`, `scale`, `rollout restart`, `rollout undo`, `exec`, `cp`, `drain`, `cordon`, `label`, `annotate`, or `login`. If a fix is needed, show the command and let the user run it.
2. **Do not read secret values.** Never run `get secret -o yaml/json` or `describe secret` output into the conversation, and never `exec ... env`. Listing secret *names* is fine.
3. **Be explicit about target.** Pass `-n <namespace>` on every command. Never rely on the current default.
4. **Empty output is not "healthy".** A dead tunnel, expired login, or wrong namespace all look like "nothing found". Check step 0 first.
5. **Say "unverified" when you could not check something.**

## Step 0: confirm where you are

```
kubectl config current-context          # oc: oc whoami --show-server
kubectl auth whoami                     # oc: oc whoami   (is the login still valid?)
kubectl get ns <namespace>              # does the namespace exist and can I see it?
```

`kubectl auth whoami` needs kubectl 1.28+ and a 1.27+ API server. On older setups it fails with `unknown command` or `the server could not find the requested resource`; that is not a login problem, so skip it and rely on the `get ns` check. On OpenShift use `oc whoami`.

If any of these fail with `Unauthorized`, `Forbidden`, or a timeout, stop and tell the user to log in or fix access. Do not keep retrying. Tell the user which context and namespace you are about to look at, and if the name suggests production, say so.

## Step 1: what is not healthy

```
kubectl get pods -n <ns> -o wide
kubectl get deploy,sts,ds,job -n <ns>
kubectl get events -n <ns> --sort-by=.lastTimestamp
```

Look at the `STATUS`, `READY` and `RESTARTS` columns. Then match the status to a branch:

| Status or symptom | Go to |
| --- | --- |
| `Pending` | Step 2a |
| `ImagePullBackOff` / `ErrImagePull` | Step 2b |
| `CrashLoopBackOff` / `Error` / many restarts | Step 2c |
| `Running` but `0/1` ready | Step 2d |
| `Running` and ready, but unreachable | Step 2e |
| Rollout stuck | Step 2f |

## Step 2: read the evidence

Always start with `describe`. The `Events:` block at the bottom usually names the cause.

```
kubectl describe pod <pod> -n <ns>
```

**2a. Pending** (not scheduled). In the events, look for:
- `Insufficient cpu/memory`: the cluster is full or requests are too big. Check `kubectl top nodes`.
- `node(s) had untolerated taint` / `didn't match node selector`: scheduling rules. Compare with `kubectl get nodes --show-labels`.
- `unbound immediate PersistentVolumeClaims`: check `kubectl get pvc -n <ns>` and the StorageClass.
- On OpenShift, `unable to validate against any security context constraint`: the SCC is blocking the pod. Check `oc get pod <pod> -n <ns> -o jsonpath='{.metadata.annotations.openshift\.io/scc}'` on a working sibling pod.

**2b. Image pull errors.** In the events, read the exact image name and the error.
- `not found` / `manifest unknown`: wrong tag or name.
- `unauthorized` / `pull access denied`: missing or wrong pull secret. Check the pod's `imagePullSecrets` with `kubectl get pod <pod> -n <ns> -o jsonpath='{.spec.imagePullSecrets}'`. Do not print the secret itself.

**2c. Crashing.** The previous container's logs hold the crash reason, not the current one.
```
kubectl logs <pod> -n <ns> --previous --tail=100
kubectl logs <pod> -n <ns> -c <container> --previous --tail=100     # multi-container pods
kubectl get pod <pod> -n <ns> -o jsonpath='{.status.containerStatuses[*].lastState}'
```
- `OOMKilled` (exit 137): memory limit too low or a leak. Compare with `kubectl top pod <pod> -n <ns>` and the pod's `resources.limits`.
- `Error` with exit code 1/2: application error; the log tail says what.
- Crash right at start with config errors: check that the referenced ConfigMap and Secret *exist* with `kubectl get configmap,secret -n <ns>` (names only).
- Init container failing: use `-c <init-container-name>`; list names with `kubectl get pod <pod> -n <ns> -o jsonpath='{.spec.initContainers[*].name}'`.

**2d. Running but not ready.** The readiness probe is failing.
```
kubectl describe pod <pod> -n <ns>        # look for "Readiness probe failed: ..."
kubectl logs <pod> -n <ns> --tail=100
```
Compare the probe's path and port with what the app actually listens on.

**2e. Ready but unreachable.** Check the chain Service, endpoints, route.
```
kubectl get svc,endpoints -n <ns>
kubectl describe svc <svc> -n <ns>
oc get route -n <ns>                      # OpenShift
kubectl get ingress -n <ns>               # elsewhere
```
- Endpoints empty: the Service selector does not match the pod labels. Compare `kubectl get svc <svc> -n <ns> -o jsonpath='{.spec.selector}'` with `kubectl get pods -n <ns> --show-labels`.
- Endpoints present but traffic fails: wrong `targetPort`, or a NetworkPolicy (`kubectl get networkpolicy -n <ns>`).

**2f. Rollout stuck.**
```
kubectl rollout status deploy/<name> -n <ns> --timeout=5s
kubectl rollout history deploy/<name> -n <ns>
kubectl describe deploy <name> -n <ns>
kubectl get rs -n <ns>
```
Usually the *new* ReplicaSet's pods hit one of the failures above. Find a pod from the newest ReplicaSet and go back to the matching branch. Also check `maxUnavailable`/quota messages: `kubectl describe quota -n <ns>`.

## Step 3: report

Write the result in this shape:

```
Target:    <context> / <namespace>   (prod? yes/no/unknown)
Symptom:   <what was seen, with the status/exit code>
Cause:     <the most likely cause, and the line of evidence for it>
Confidence: confirmed | likely | unverified
Not checked: <anything you could not read, e.g. no permission, no logs>
Suggested fix (not run): <the command or manifest change for the user to apply>
```

Quote the exact event or log line that supports the cause. If two causes are possible, list both rather than picking one.

## Notes

- `kubectl get events` only keeps about an hour by default, so a quiet event list does not mean there was no problem earlier. Say so.
- `--previous` fails if the container never restarted; that is expected, use the current logs instead.
- Large clusters: add `-l app=<label>` or use `--field-selector=status.phase!=Running` to cut noise.
- This skill does not replace a guard: a skill is advice the model follows, not a barrier. For enforcement on production, use a tool that blocks changing commands before they run.
