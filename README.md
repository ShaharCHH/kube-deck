# kube-deck

Claude Code mod (CLI + desktop). Needs Claude Code >= 2.1.287.

## What it does

- **Right-hand panel (`/deck`):** four cards.
  - *Cluster:* name, project, a red `PROD` badge (green `non-prod`, `STRICT` when the cluster can't be read).
  - *Guard:* `Approve all` button (hotkey `a`) with a countdown while on.
  - *Todo:* add field + `Add`, `☐`/`☑` per item, `x`, `Clear done`, `done/total` count.
  - *Cluster commands:* the last 8 cluster-changing commands with outcome.

  Outside cluster work (no cluster readable, no cluster command run, approve-all off) only the Todo card shows, so the panel stays quiet in non-infra sessions.

  It opens by itself, unfocused. Beside the transcript it needs a wide fullscreen terminal (>= 144 columns); otherwise it waits and `/deck` opens it above the prompt. `/deck close` closes it. Ctrl+X then Tab focuses it.
- **Guard:** Bash commands that change cluster state (`oc`, `kubectl`, `helm`, `argocd`) ask first on prod. Read-only verbs pass. Unknown verbs count as changing. Commands that set their own target (`--context`, `--kubeconfig`, `--server`, `KUBECONFIG=`) are asked even on non-prod.
- **Approve-all:** panel button, `/approve-all`, or "Run it + approve all for 15 min" in the dialog. Switches itself off after 15 minutes (`APPROVE_MINUTES`), checked on every command and by a 1s timer. Never persisted: every new session starts guarded.
- **Secret redaction:** output of cluster commands is masked before Claude reads it.
  - Secret objects (yaml and json): `data` / `stringData` values and the `last-applied-configuration` annotation become `<redacted>`.
  - Withheld whole: `oc whoami -t`, `create token`, `get-token`, and secret reads that are reshaped (`jsonpath`, `jq`, `base64`, `cat`, `grep`, ...).
  - A note `[kube-deck: N secret value(s) redacted]` is appended so Claude knows. You get a toast.
- **Audit log:** `~/.kube-deck/audit.jsonl`, one JSON line per cluster-changing command: time, outcome (approved / auto / non-prod / refused), cluster, project, repo, command (tokens masked). `/audit` shows the path and the last 10.
- **Todo (per repo):** each project root has its own list, kept in `$.store` (shared by all sessions on the machine). `/todo add <text>` adds from the prompt.
- **Claude adds todos on its own:** tool `mcp__kube-deck__todo` (list / add / done / update, no delete) plus a short static system-prompt section telling it to add concrete follow-ups without asking. Its items are tagged `· claude`, duplicates are skipped, you get a toast per change, you discard with `x`. It edits an item only after discussing it with you.
- **Refresh:** cluster and project are re-read on every prompt (3s timeout), at session start, on `/ctx`, and around each cluster command.
- `/ctx` prints cluster, project and guard state.

## Run

    claude plugin validate ./kube-deck
    node kube-deck/tests/classify.test.mjs
    node kube-deck/tests/redact.test.mjs
    (cd kube-deck && claude plugin test)
    claude --plugin-dir ./kube-deck        # uses your exported KUBECONFIG

## Edit before trusting

All at the top of `hooks/register.js`:

- `PROD_PATTERNS` (default: `/prod/i` against kubeconfig path, cluster name, API URL).
- `APPROVE_MINUTES`, `AUDIT_DIR`.
- Unknown cluster = strict (treated as prod).

## Limits

- The classifier and the redaction are regex-based reminders, not security boundaries. Obfuscated shell, scripts that call `oc` internally, and `oc` inside other tools are not seen.
- Redaction does not cover: env values in pod specs, ConfigMaps, logs, `oc exec ... env`, `cat` of a kubeconfig, anything that isn't recognisably a secret read.
- Redaction covers Bash cluster commands only, not other tools.
- The audit log is best effort: a failed write shows a toast, it does not block the command.
- Claude Code's own permission prompt still runs after this one. Allow rules for read-only commands avoid double prompts.
- Mods are unsandboxed. Read the code before installing, and `claude plugin validate` after every edit.
