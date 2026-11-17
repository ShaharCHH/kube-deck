#!/bin/bash
# SessionStart hook: points Claude's Bash tool at this session's kube-deck env file
# (~/.kube-deck/env/<session_id>.env), so a pick in the panel reaches the shell without the
# guard rewriting the command (issue #24: a rewritten command gets no auto-mode verdict).
# Claude Code applies what this writes to $CLAUDE_ENV_FILE to every later Bash command.
set -euo pipefail

input=$(cat)
# session_id is a UUID; the character class also keeps it from naming another path
sid=$(printf '%s' "$input" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([A-Za-z0-9-]*\)".*/\1/p' | head -n 1)
if [ -z "$sid" ]; then
  echo "kube-deck: no session_id in the SessionStart input" >&2
  exit 1
fi
# an older Claude Code without CLAUDE_ENV_FILE: nothing to point at
if [ -z "${CLAUDE_ENV_FILE:-}" ]; then
  exit 0
fi

umask 077 # the file holds a kubeconfig path and a profile name: private
dir="$HOME/.kube-deck/env"
mkdir -p "$dir"
f="$dir/$sid.env"
[ -e "$f" ] || : >"$f"

line=$(printf 'if [ -r %q ]; then . %q; fi' "$f" "$f")
# resume and compact start the same session again: add the line once
if ! grep -qxF "$line" "$CLAUDE_ENV_FILE" 2>/dev/null; then
  printf '%s\n' "$line" >>"$CLAUDE_ENV_FILE"
fi
