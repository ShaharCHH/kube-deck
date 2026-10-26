# kube-deck

[![tests](https://github.com/ShaharCHH/kube-deck/actions/workflows/test.yml/badge.svg)](https://github.com/ShaharCHH/kube-deck/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**A safety net and control panel for working on Kubernetes / OpenShift and AWS with Claude Code.**

kube-deck is a [Claude Code](https://claude.com/claude-code) mod (works in the terminal and the desktop app). It sits between Claude and your clusters: it asks before Claude changes anything on prod, hides secrets from what Claude reads, keeps an audit log, and gives you a side panel to see and switch which AWS profile and cluster you are on, log in to either from the panel, and keep a to-do list.

> Needs Claude Code 2.1.287 or later (developed and tested on 2.1.304).

```
┌─ ◆ kube-deck ─────────────────────────────────────┐
│ ╭────────────────────────────────────────────────╮│
│ │ my-sandbox-cluster                   non-prod  ││
│ │ project   payments                             ││
│ │ kubeconfig: my-sandbox-cluster.kubeconfig ▾    ││
│ │ api: api.other.example.com:6443  [▶ Log in]    ││
│ ╰────────────────────────────────────────────────╯│
│ ╭────────────────────────────────────────────────╮│
│ │ AWS                                signed in   ││
│ │ profile  Workload-Admin    region  eu-west-1   ││
│ │ profile: Workload-Admin ▾                      ││
│ │ sso: mycompany.awsapps.com/start  [▶ Add]      ││
│ ╰────────────────────────────────────────────────╯│
│ ╭────────────────────────────────────────────────╮│
│ │ Guard                            ● guarding    ││
│ │ [ ▶ Approve all (a) ]                          ││
│ ╰────────────────────────────────────────────────╯│
│ ╭────────────────────────────────────────────────╮│
│ │ Todo · my-repo                    ▰▰▱ 2/3      ││
│ ╰────────────────────────────────────────────────╯│
└───────────────────────────────────────────────────┘
```

## Contents

- [Install](#install)
- [What you get](#what-you-get)
- [Commands](#commands)
- [The panel](#the-panel)
- [The guard](#the-guard)
- [Secret redaction](#secret-redaction)
- [Audit log](#audit-log)
- [Configuration](#configuration)
- [Limits](#limits)
- [Development](#development)
- [License](#license)

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install kube-deck --marketplace ShaharCHH/kube-deck
```

From a shell:

```
claude plugin install kube-deck --marketplace ShaharCHH/kube-deck
```

To try it from a clone without installing:

```
git clone https://github.com/ShaharCHH/kube-deck
claude --plugin-dir ./kube-deck
```

Mods are not sandboxed. Read the code before you install it, and run `claude plugin validate` after every edit.

## What you get

| | |
| --- | --- |
| **Guard** | Cluster-changing `oc` / `kubectl` / `helm` / `argocd` commands ask first on prod. Reads pass. Unknown verbs count as changes. |
| **Secret redaction** | Secret values are masked in command output before Claude reads it. |
| **Audit log** | Every cluster-changing command is logged (private file, tokens masked). |
| **Side panel** | Cluster, AWS, guard, to-do and recent commands in one pane. |
| **Switching** | Dropdowns to change AWS profile and kubeconfig; Claude's commands follow your pick. |
| **Logins** | Browser login to a cluster (`oc login --web`) and to AWS SSO, creating the kubeconfig or profile for you. |
| **To-do list** | Per repo; Claude can add follow-ups itself. |

## Commands

| Command | What it does |
| --- | --- |
| `/deck` | Open the panel (`/deck close` closes it). |
| `/ctx` | Re-read the kubeconfig and print cluster, project, guard and AWS state. |
| `/approve-all` | Toggle approve-all; it switches itself off after 15 minutes. |
| `/kube-login <api-url>` | Log in to a cluster in the browser. No URL = log in again to the current cluster. |
| `/aws-login` | Run `aws sso login` for the panel's AWS profile. |
| `/aws-sso-login <start-url> <sso-region>` | Add an AWS profile from an SSO start URL. |
| `/todo add <text>` | Add a to-do for this repo. |
| `/audit` | Show the audit log path and its last 10 entries. |

## The panel

The panel opens by itself, unfocused. Beside the transcript it needs a wide fullscreen terminal (144 columns or more); otherwise it waits, and `/deck` opens it above the prompt. `Ctrl+X` then `Tab` focuses it.

### Cluster card

- Cluster name, project (namespace) and a badge: red `PROD`, green `non-prod`, amber `UNLISTED` (the name matches neither list, so it is treated as prod), or `STRICT` (the cluster can't be read).
- **`kubeconfig` dropdown:** the files in `~/.kube` that read like a kubeconfig, plus the one in `KUBECONFIG`.
- **`api` row:** `reachable` or red `UNREACHABLE`, from a plain TCP connect (`nc -z`) to the host and port in the kubeconfig's `server`, every 10 seconds. Nothing is sent, but it does touch the cluster's address, unlike the rest of the card, which only reads the file. Nothing to set. It is most useful behind a local port-forward or tunnel (an SSM session, `oc port-forward`, an SSH forward), which can end quietly while the kubeconfig keeps pointing at `127.0.0.1`: when the address is unreachable and resolves to this machine (asked of the system resolver, so `/etc/hosts` counts; macOS only), the card says the tunnel may have ended. It proves the port is open, not that the cluster works. No `nc` means no row, never a false alarm. Start tunnels yourself; kube-deck does not.
- **`WATCH_PORTS`:** optional extra rows for other addresses, for example a console behind a second forward: `export const WATCH_PORTS = [{ name: 'console', port: 443 }]` in `hooks/config.js` (`host` defaults to `127.0.0.1`). Each shows `up` or red `DOWN`. Empty by default.
- **Cluster login:** type the API URL (`api.mycluster.example.com:6443`, `https://` is added for you) and press `Log in (browser)`. It runs `oc login --web --server=<url>` into its own file, `~/.kube/<cluster>.kubeconfig`, so no kubeconfig has to exist and no other file is touched. It waits up to 10 minutes for you to approve in the browser, then switches to that file. No password or token passes through the panel; for token or password logins use a terminal. Needs an `oc` and a cluster that support `--web`. A failed login says why on the card.

### AWS card

- Profile, region, signed-in role and whether the login still works (`signed in` / `SSO EXPIRED` / `unreachable`), checked with `aws sts get-caller-identity` at most every 5 minutes in the background. The account id is never shown.
- **`Log in with SSO`** appears when the login is expired or unreachable: it runs `aws sso login --profile <profile>` (up to 10 minutes) and re-checks.
- **`profile` dropdown:** the profiles in `~/.aws/config`.
- **Add a profile from an SSO URL:** type the SSO start URL (`mycompany.awsapps.com/start`, or the Identity Center issuer URL `identitycenter.amazonaws.com/ssoins-<16 hex digits>`) and the SSO region, then press `Add profile via SSO`.
  1. It appends an `[sso-session kube-deck-<name>]` block to `~/.aws/config`. A copy of the original is kept once as `~/.aws/config.bak-kube-deck`; existing sections are never edited.
  2. It runs `aws sso login --sso-session` (browser, up to 10 minutes).
  3. It lists the accounts and roles your new token can use in an `account` dropdown (at most 40 accounts).
  4. Picking one appends a `[profile <account>-<role>]` block (region = the SSO region; edit the file for another) and switches to it. Account ids go into the config file, where AWS keeps them, but are never drawn in the panel.
  
  To list accounts it reads the short-lived token from `~/.aws/sso/cache` and passes it on the command line to `aws sso list-accounts` and `list-account-roles` for a few seconds, where other processes of yours could see it.

### How switching reaches Claude

A pick sets `AWS_PROFILE` / `KUBECONFIG` for the Claude Code process, but that alone does **not** reach the shell Claude's Bash tool runs (checked). So the guard puts `export AWS_PROFILE='…'; export KUBECONFIG='…'; ` in front of each Bash command Claude runs from then on.

- Only what you picked is exported, plus an AWS profile the panel shows because it came from a `.aws-profile` file in the project root, or because it is the only profile in `~/.aws/config`. A profile that came from `AWS_PROFILE` itself needs nothing.
- Picks are kept in session state, so a plugin reload does not lose them. A new session starts from your shell's values again.
- Nothing on disk changes for a switch (no `use-context`, no config edit). Only listed values are accepted, never free text.
- The guard still judges the command Claude wrote, not the prefix. A command you run yourself with `!` is not prefixed.
- Claude Code's own permission prompt sees the prefixed command, so an allow rule like `Bash(oc get:*)` may stop matching after a pick.
- Switching kubeconfig re-judges prod / non-prod and switches approve-all off.

### Guard, to-do and commands cards

- **Guard:** the `Approve all` button (hotkey `a`) with a countdown while it is on.
- **Todo / Done:** an add field, `☐` / `☑` per item, `x` to delete, `Clear done`, and a `done/total` count.
- **Cluster commands:** the last 8 cluster-changing commands with their outcome.

Outside cluster work (no cluster readable, no cluster command run, approve-all off) the Cluster, AWS and Todo cards show; Guard and Cluster commands stay hidden.

## The guard

Bash commands that change cluster state (`oc`, `kubectl`, `helm`, `argocd`) ask first on prod. Read-only verbs pass.

- **Unknown verbs count as changes**, so a miss costs an extra prompt rather than a silent pass. `oc login`, `oc logout` and `oc project <name>` count too, because they change what later commands hit.
- **It looks inside** loops and `if`s (`for x in a b; do oc delete pod $x; done`), `$(…)` and backticks, `find -exec`, `eval`, `bash -c`, `ssh host oc …`, and wrappers such as `sudo`, `timeout` and `xargs`.
- **Commands that set their own target** (`--context`, `--kubeconfig`, `--server`, `KUBECONFIG=`) are asked even on non-prod.
- **What counts as prod:** a cluster is non-prod only if its kubeconfig *file name*, cluster name or API host matches `NONPROD_PATTERNS`. A `PROD_PATTERNS` match always means prod. Anything else is `UNLISTED` and asked like prod, so a prod cluster nobody named "prod" is still guarded. An unreadable cluster is treated as prod.
- **Approve-all:** the panel button, `/approve-all`, or "Run it + approve all for 15 min" in the dialog. It switches itself off after 15 minutes, checked on every command and by a 1-second timer, and is never persisted: every new session starts guarded.

## Secret redaction

Output of cluster commands is masked before Claude reads it.

- **Secret objects** (YAML and JSON): `data` / `stringData` values and the `last-applied-configuration` annotation become `<redacted>`.
- **Withheld whole:** `oc whoami -t`, `create token`, `get-token`, and secret reads that are reshaped (`jsonpath`, `jq`, `base64`, `cat`, `grep`, …).
- A note `[kube-deck: N secret value(s) redacted]` is appended so Claude knows, and you get a toast.

## Audit log

`~/.kube-deck/audit.jsonl` (directory `0700`, file `0600`; older world-readable files are tightened on the next write). One JSON line per cluster-changing command: time, outcome (`approved` / `auto` / `non-prod` / `refused`), cluster, project, repo, and the command with secrets masked. `/audit` shows the path and the last 10 entries.

The same masking applies to the recent-commands card. Only the logged or shown copy is masked; the command runs as written, and the approval dialog shows it as it is. It covers:

- any `--flag` whose name holds `token`, `password`, `secret` or `key` (`--token`, `--docker-password`, `--client-secret`, …)
- `oc login -p …`, `--from-literal=key=value`, and `helm --set …password=value`
- `NAME=value` assignments for credential-looking names (`AWS_SECRET_ACCESS_KEY=…`, `GITHUB_TOKEN=…`)
- `Authorization` / `Bearer` / `Basic` values and `user:password@` in URLs
- AWS, GitHub, Slack and JWT token formats, and `sha256~…` OpenShift tokens

It is regex-based and knows these usual shapes. A secret in a positional argument, a here-doc or a file the command reads is not caught.

## To-do list

Each project root has its own list, kept in `$.store` (shared by all sessions on the machine).

Claude can add to it on its own: the tool `mcp__kube-deck__todo` (list / add / done / update, no delete) plus a short system-prompt section telling it to add concrete follow-ups without asking. Its items are tagged `· claude`, duplicates are skipped, you get a toast per change, and you discard with `x`. It edits an item only after discussing it with you.

## Configuration

Everything is in `hooks/config.js`:

| Setting | Default | Meaning |
| --- | --- | --- |
| `PROD_PATTERNS` | `/prod/i` | Matched against the kubeconfig path, cluster name and API URL. A match always means prod. |
| `NONPROD_PATTERNS` | sandbox, dev, test, staging, stage, qa, lab, demo, local, minikube, kind, crc, docker-desktop, rancher-desktop | Matched against the kubeconfig *file name*, cluster name and API host (never the folder, so a home directory called `devops` marks nothing). A letter next to the word breaks the match: `devops` is not `dev`, `sandbox1234` is `sandbox`. **Add your own environment names here.** |
| `APPROVE_MINUTES` | `15` | How long approve-all stays on. |
| `AUDIT_DIR` | `.kube-deck` | Folder under `$HOME` for the audit log. |
| `WATCH_PORTS` | `[]` | Extra `{ name, port, host? }` addresses shown as `up` / `DOWN` rows on the cluster card. |

## Limits

- The classifier and the redaction are regex-based reminders, **not security boundaries**. Obfuscated shell, aliases, scripts that call `oc` internally, and `oc` inside other tools are not seen.
- Redaction does not cover env values in pod specs, ConfigMaps, logs, `oc exec … env`, `cat` of a kubeconfig, or anything that isn't recognisably a secret read. It covers Bash cluster commands only, not other tools.
- The audit log is best effort: a failed write shows a toast and does not block the command.
- Claude Code's own permission prompt still runs after kube-deck's. Allow rules for read-only commands avoid double prompts.
- The profile name is only used if it is a plain name (letters, digits, `_.@+=,-`), since it goes into a command line.

## Development

```
claude plugin validate .          # manifest, hooks and state contract
node tests/classify.test.mjs      # the command classifier
node tests/redact.test.mjs        # secret redaction
claude plugin test                # engine tests (guard, panel, to-do)
claude --plugin-dir .             # run it; saving a file hot-reloads
```

GitHub Actions runs the plain-Node checks on every push and pull request (modules parse, manifests are valid JSON, classifier, redaction). `claude plugin validate` and `claude plugin test` need the Claude Code CLI, so run those locally before you open a PR. Changes are listed in [CHANGELOG.md](CHANGELOG.md).

| File | Role |
| --- | --- |
| `hooks/register.js` | The wiring only: session start, prompts, slash commands, timers, the to-do tool. |
| `hooks/config.js` | The settings you may edit (prod / non-prod patterns, timeouts, colours). |
| `hooks/guard.js` | The Bash guard: asks on prod, redacts output, writes the audit log. |
| `hooks/panel.js` | Draws the panel. |
| `hooks/cluster.js` | Cluster state, the kubeconfig dropdown and the browser cluster login. |
| `hooks/reach.js`, `targets.js` | Whether the cluster's API and `WATCH_PORTS` answer (a TCP connect), and the pure address parsing it uses. |
| `hooks/aws.js` | AWS profile state, login, the profile dropdown and adding a profile from an SSO URL. |
| `hooks/audit.js` | The recent-commands feed, the audit log, output redaction and the approval question. |
| `hooks/approve.js`, `todos.js`, `picked.js`, `shared.js` | Approve-all, the to-do list, what was picked in the panel (kept in session state), and state shared by the panel and the logins. |
| `hooks/classify.js` | Pure: decides whether a command touches a cluster, changes it, or sets its own target. |
| `hooks/redact.js` | Pure: masks Secret data in output and secrets in command lines. |
| `types/index.d.ts` | The `$.state` contract (what was picked in the panel). |
| `tests/` | Plain-node tests for the pure modules, engine tests for the rest. |

## License

[MIT](LICENSE) © 2026 Shahar Cohen Hadad. Use it, change it and share it freely; keep the copyright notice. It comes with no warranty, so test the guard on a non-prod cluster before you rely on it.
