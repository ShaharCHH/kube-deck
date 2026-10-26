# Changelog

All notable changes to kube-deck. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **Add a kubeconfig by path** in the cluster card: checked, copied into `~/.kube` with mode 600, selected.
- **Token and user + password cluster logins** next to the browser one (`log in with` picker). Typed values live only in memory, are replaced by `***` in error messages and are emptied after a successful login. The panel cannot hide typed text; see the README.

## [0.1.0] - 2026-10-20

First public release.

### Added
- **Guard.** Cluster-changing `oc` / `kubectl` / `helm` / `argocd` commands ask first on prod. Reads pass; unknown verbs count as changes; commands that set their own target (`--context`, `--kubeconfig`, `--server`, `KUBECONFIG=`) are asked even on non-prod. It looks inside loops and `if`s, `$(…)` and backticks, `find -exec`, `eval`, `bash -c`, `ssh host oc …` and wrappers such as `sudo`, `timeout` and `xargs`. `oc login`, `oc logout` and `oc project <name>` count as changes.
- **Non-prod by name only.** A cluster is trusted as non-prod only if its kubeconfig file name, cluster name or API host matches `NONPROD_PATTERNS`; anything else is `UNLISTED` and asked like prod. `PROD_PATTERNS` always wins.
- **Approve-all** (button, `/approve-all`, or from the dialog) that switches itself off after 15 minutes and is never persisted.
- **Secret redaction** of cluster command output (Secret `data` / `stringData`, `last-applied-configuration`, token commands, reshaped secret reads).
- **Audit log** at `~/.kube-deck/audit.jsonl` (private files), with secrets typed into commands masked in the log and the panel: flags such as `--token` / `--password`, `oc login -p`, `--from-literal`, `helm --set …password=`, credential-looking `NAME=value` assignments, bearer headers, URL credentials and common token formats.
- **Side panel** (`/deck`) with cluster, AWS, guard, to-do, done and recent-commands cards.
- **Switching.** `profile` and `kubeconfig` dropdowns. A pick reaches the commands Claude runs, is kept across a plugin reload, and switching kubeconfig re-judges prod and switches approve-all off.
- **Logins.** Browser login to a cluster (`oc login --web`, `/kube-login`) into its own kubeconfig file; AWS SSO login from the panel (`/aws-login`); adding an AWS profile from an SSO start URL with an account / role picker (`/aws-sso-login`).
- **To-do list** per repo, which Claude can add to on its own through the `mcp__kube-deck__todo` tool.
- MIT license, a marketplace file for `/plugin install kube-deck --marketplace ShaharCHH/kube-deck`, and tests for the classifier, the redaction and the engine hooks.

[Unreleased]: https://github.com/ShaharCHH/kube-deck/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ShaharCHH/kube-deck/releases/tag/v0.1.0
