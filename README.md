# kube-deck

Claude Code mod (CLI + desktop). Needs Claude Code >= 2.1.287.

## What it does

- **Right-hand panel (`/deck`):** cards for cluster, AWS, guard, todo, done and cluster commands.
  - *Cluster:* name, project, a red `PROD` badge (green `non-prod`, `STRICT` when the cluster can't be read).
  - *AWS:* profile, region, signed-in role and whether the login works (`signed in` / `SSO EXPIRED` / `unreachable`), with a `Recheck` button. When the login is expired or unreachable a `Log in with SSO` button appears: it runs `aws sso login --profile <profile>` (opens your browser, waits up to 3 minutes for you to approve), then re-checks. `/aws-login` does the same from the prompt. Profile comes from `AWS_PROFILE`, then a `.aws-profile` file in the project root, then the only profile in `~/.aws/config`. The login is checked with `aws sts get-caller-identity` at most every 5 minutes, in the background. The account id is never shown.
  - *Dropdowns:* the AWS card has a `profile` dropdown (profiles from `~/.aws/config`) and the Cluster card a `kubeconfig` dropdown (files in `~/.kube` that read like a kubeconfig, plus the one in `KUBECONFIG`). A pick sets `AWS_PROFILE` / `KUBECONFIG` for this Claude Code process, so the commands Claude runs from then on use it. Nothing on disk changes (no `use-context`, no config edit) and a new session starts from your shell's values again. Only listed values are accepted. Switching kubeconfig re-judges prod / non-prod and switches approve-all off. The dropdown lists are re-read on every prompt and `/ctx`.
  - *Cluster login:* an `api` field and `Log in (browser)` button on the Cluster card, and `/kube-login <url>`. Runs `oc login --web --server=<url>` into its own file `~/.kube/<cluster>.kubeconfig` (so no kubeconfig has to exist, and no other file is touched), waits up to 10 minutes for you to approve in the browser, then switches to that file like the dropdown does. Empty field = log in again to the current cluster (refreshes its own file). The URL must be `https://host[:port]`. No password or token goes through the panel, so for token or password logins use a terminal. Needs an `oc` and a cluster that support `--web`. A failed login says why on the card.
  - *Guard:* `Approve all` button (hotkey `a`) with a countdown while on.
  - *Todo:* add field + `Add`, `☐`/`☑` per item, `x`, `Clear done`, `done/total` count.
  - *Cluster commands:* the last 8 cluster-changing commands with outcome.

  Outside cluster work (no cluster readable, no cluster command run, approve-all off) the Cluster card (it holds the login), the Todo card (and Done, and AWS when a profile resolves) show; Guard and Cluster commands stay hidden.

  It opens by itself, unfocused. Beside the transcript it needs a wide fullscreen terminal (>= 144 columns); otherwise it waits and `/deck` opens it above the prompt. `/deck close` closes it. Ctrl+X then Tab focuses it.
- **Guard:** Bash commands that change cluster state (`oc`, `kubectl`, `helm`, `argocd`) ask first on prod. Read-only verbs pass. Unknown verbs count as changing. Commands that set their own target (`--context`, `--kubeconfig`, `--server`, `KUBECONFIG=`) are asked even on non-prod.
- **Approve-all:** panel button, `/approve-all`, or "Run it + approve all for 15 min" in the dialog. Switches itself off after 15 minutes (`APPROVE_MINUTES`), checked on every command and by a 1s timer. Never persisted: every new session starts guarded.
- **Secret redaction:** output of cluster commands is masked before Claude reads it.
  - Secret objects (yaml and json): `data` / `stringData` values and the `last-applied-configuration` annotation become `<redacted>`.
  - Withheld whole: `oc whoami -t`, `create token`, `get-token`, and secret reads that are reshaped (`jsonpath`, `jq`, `base64`, `cat`, `grep`, ...).
  - A note `[kube-deck: N secret value(s) redacted]` is appended so Claude knows. You get a toast.
- **Audit log:** `~/.kube-deck/audit.jsonl` (dir 0700, file 0600; older world-readable files are tightened on the next write), one JSON line per cluster-changing command: time, outcome (approved / auto / non-prod / refused), cluster, project, repo, command (tokens masked). `/audit` shows the path and the last 10.
- **Todo (per repo):** each project root has its own list, kept in `$.store` (shared by all sessions on the machine). `/todo add <text>` adds from the prompt.
- **Claude adds todos on its own:** tool `mcp__kube-deck__todo` (list / add / done / update, no delete) plus a short static system-prompt section telling it to add concrete follow-ups without asking. Its items are tagged `· claude`, duplicates are skipped, you get a toast per change, you discard with `x`. It edits an item only after discussing it with you.
- **Refresh:** cluster and project are re-read on every prompt (3s timeout), at session start, on `/ctx`, and around each cluster command.
- `/ctx` prints cluster, project, guard and AWS state. The profile name is only used if it is a plain name (letters, digits, `_.@+=,-`), since it goes into a command line.

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
