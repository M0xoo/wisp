#!/bin/sh
# PreToolUse hook (Bash): coders code and test their own work; the outer loop (full suites, e2e, UI gates) runs in
# PR CI and in the one batched verification pass at the end (owner, 2026-11-09; docs/v2-team-brief.md).
# Allowed: cargo check/clippy/build, `cargo test -p <crate> [...]`, `npx vitest run <file>`.
# Refused: workspace-wide cargo test/nextest, npm test, npm run verify, monoflow verify, qa/*.mjs gates.
# The batched pass sets WISP_OUTER_LOOP=1 in front of the command.
cmd=$(cat | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).tool_input.command||"")}catch{}})')
case "$cmd" in *WISP_OUTER_LOOP=1*) exit 0 ;; esac
# a script the command runs counts as the command (sh x.sh, bash x.sh, . x.sh, ./x.sh, /path/x.sh)
for f in $( { echo "$cmd" | grep -Eo '(sh|bash|zsh|source|exec|\.)[[:space:]"'"'"',]+[^[:space:]"'"'"';&|()]+\.(sh|bash)' | grep -Eo '[^[:space:]"'"'"',]+\.(sh|bash)$';
              echo "$cmd" | grep -Eo '(^|[;&|][[:space:]]*)[./~][^[:space:]"'"'"';&|()]*\.(sh|bash)' | grep -Eo '[./~][^[:space:]]*$'; } | sort -u); do
  case "$f" in *no-suites.sh) continue ;; esac
  [ -f "$f" ] && cmd="$cmd
$(cat "$f")"
done
deny() { echo "Refused: $1. Coders code: test only the crate or file you changed (cargo test -p <crate> --test <file> <name>). Full suites, e2e and UI gates run in PR CI (docs/v2-team-brief.md)." >&2; exit 2; }
echo "$cmd" | grep -Eq '(^|[;&|[:space:]])cargo[[:space:]]+(test|nextest)' && ! echo "$cmd" | grep -Eq '(^|[[:space:]])(-p|--package)([[:space:]=])' && deny "a workspace-wide cargo test"
echo "$cmd" | grep -Eq '(^|[;&|[:space:]])cargo[[:space:]]+(test|nextest).*--workspace' && deny "cargo test --workspace"
echo "$cmd" | grep -Eq '(^|[;&|[:space:]])npm[[:space:]]+(test|t|run[[:space:]]+(test|verify))([[:space:]]|$)' && deny "the npm test suite"
echo "$cmd" | grep -Eq 'monoflow[^;&|]*[[:space:]]verify' && deny "monoflow verify (the outer loop)"
echo "$cmd" | grep -Eq 'qa/(parity|layout|feedback)\.mjs' && deny "a UI gate run (qa/*.mjs)"
exit 0
