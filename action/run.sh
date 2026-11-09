#!/usr/bin/env bash
# The action's one step (action.yml): run it, write the report to the job summary and the pull request, and say how
# it ended. Inputs come as WISP_* variables; the harness's own keys (ANTHROPIC_API_KEY, OPENAI_API_KEY, …) pass
# through the job's env as they are.
set -euo pipefail

args=()
[ -n "${WISP_AGENT:-}" ] && args+=(--agent "$WISP_AGENT")
[ -n "${WISP_MODEL:-}" ] && args+=(--model "$WISP_MODEL")
[ -n "${WISP_MODE:-}" ] && args+=(--mode "$WISP_MODE")
cd "${WISP_PROJECT:-.}"

# the task's id: from `wisp attach <id>` (a formula, a declared task) or the launch's JSON (a prompt)
attach_id() { grep -o 'wisp attach [^ ]*' | tail -1 | awk '{print $3}'; }
if [ -n "${WISP_FORMULA:-}" ]; then
  id=$(wisp run -f "$WISP_FORMULA" ${args[@]+"${args[@]}"} | attach_id)
elif [ -n "${WISP_TASK_NAME:-}" ]; then
  id=$(wisp run "$WISP_TASK_NAME" ${args[@]+"${args[@]}"} | attach_id)
elif [ -n "${WISP_PROMPT:-}" ]; then
  id=$(wisp ${args[@]+"${args[@]}"} --json -- "$WISP_PROMPT" | jq -r 'if type == "array" then .[0].id else .id end // empty')
else
  echo "::error::wisp: give it a prompt, a task or a formula"
  exit 2
fi
if [ -z "$id" ]; then
  echo "::error::wisp started nothing"
  exit 1
fi
wisp wait "$id" > /dev/null || true
state=$(wisp show "$id" --json | jq -r '.state // "unknown"')
report=$(wisp show "$id" || true)

{
  echo "task=$id"
  echo "state=$state"
} >> "${GITHUB_OUTPUT:-/dev/null}"
{
  echo "### wisp: $state"
  echo
  echo '```'
  printf '%s\n' "$report"
  echo '```'
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"

pr=$(jq -r '.pull_request.number // empty' "${GITHUB_EVENT_PATH:-/dev/null}" 2>/dev/null || true)
if [ "${WISP_COMMENT:-true}" = "true" ] && [ -n "$pr" ]; then
  body=$(mktemp)
  {
    echo "**wisp** ran \`$id\` ($state)"
    echo
    printf '%s\n' "$report"
  } > "$body"
  gh pr comment "$pr" --body-file "$body" || echo "::warning::wisp: couldn't comment on #$pr"
fi

if [ "${WISP_FAIL_ON:-failed}" = "failed" ] && [ "$state" = "error" ]; then
  echo "::error::wisp: the task failed ($id)"
  exit 1
fi
