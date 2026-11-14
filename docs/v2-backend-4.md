# Backend round 4: issues (issues.projects, v1 #766)

## issues.projects (unblocks the launcher's Issue picker)

- wisp.runtime contributes `issues.projects@1` from its `project` resource kind (`kinds.rs` `IssueProjects`):
  a project by its name (the picker's id) with its folder here; its repo comes from the folder's origin, as before.
  Test: `kinds::issue_tests::the_issue_picker_finds_a_declared_project_by_name`.
- runtime host + `wisp-issues-api`.

## v1 #766: a signed-in connector lists its issues through its own tools

Found on the way: nobody contributed `issues.connectors@1` either, and nobody provided the `Http` the lister sends
Linear's and Jira's API calls through, so Linear and Jira never listed anything in v2.

- **`connectors.call {id, tool, args} → {result}`** (new, `plugins/connectors/host/src/call.rs`; v1 `mcpCall`): one
  tool of a remote connector, called by wisp over streamable HTTP (`initialize`, `notifications/initialized`,
  `tools/call`, the server's session id), with its headers and its OAuth token; the token never leaves wisp. A
  JSON-RPC error or a tool's `isError` comes back in the server's words; 401/403 says "needs sign-in". A connector
  wisp starts itself (stdio) isn't called yet (Linear's and Atlassian's are remote). Manifest entry added;
  `connectors/CallArgs.ts`, `CallOut.ts`. Test: `call::tests::a_servers_refusal_is_said_in_its_own_words`.
- **`issues.connectors@1`** from wisp.connectors (same file): every connector with its secrets revealed and
  `signed_in` (OAuth with a stored token). `wisp_issues_api::Connector.signed_in` is additive.
  (Two small additive lines in connectors' lib.rs; the UI coder's files are otherwise untouched.)
- **issues core `mcp.rs`** (sans-IO): `signed_in_connector`, `tool_json`, `linear_mcp_issue` (closed ones out:
  statusType completed/canceled, done/canceled states), `linear_args` (`assignee: "me"` or the workspace, the fields
  it reads, twice the limit), `jira_site` (the first site with a Jira scope), `jira_args`, `jira_list`,
  `mcp_problem` (a stale sign-in → "Linear wants you to sign in again: Settings → Connectors." with its fix).
- **issues host:** with no API key, a signed-in Linear connector lists yours, else the workspace's open ones
  (`IssueList.scope`: `mine` / `all`, additive); a signed-in Atlassian connector finds the site, then searches by
  JQL. The tools go through `connectors.call` (`Tools` seam, `ConnectorTools`); the API-key path now has an HTTP
  client (`NetHttp` over the kernel's net service). v1's new refusal wording ("add Linear in Settings → Connectors
  and sign in"). Manifest + `connectors:call`, `runtime:get`.
- Tests (v1 test/issue-signin.test.js, row for row): `tests/signin.rs` ›
  `linear_a_signed_in_connector_lists_your_open_issues_through_its_list_issues_tool`,
  `linear_none_assigned_to_you_lists_the_workspaces_open_issues_instead`,
  `linear_not_signed_in_says_to_sign_in_and_so_does_a_refusal_from_the_server`,
  `jira_a_signed_in_atlassian_connector_finds_your_site_then_searches_your_issues` (all pass). The existing
  `tests/route.rs` (7) and core `tests/issues.rs` (14) still pass.
- `cargo clippy -p wisp-issues -p wisp-issues-core -p wisp-issues-api -p wisp-connectors -p wisp-connectors-api
  -p wisp-runtime --all-targets -- -D warnings`: clean.

## For the UI coder

- The picker's **Connect Linear… / Connect Jira…** (`fix: "linear" | "jira"`) open Settings → Connectors with the
  form prefilled: Linear `https://mcp.linear.app/mcp`, Atlassian `https://mcp.atlassian.com/v1/mcp`, remote, sign-in
  on, **Add and sign in** focused (v1 web/js/connector-examples.js). The connectors examples list gets both.
- `IssueList.scope == "all"`: say they're the workspace's open issues (none are assigned to you).

## The two harness branches left (item 2)

- **worktrees/host/src/trust.rs:86** (`agent == "claude"` → Claude's trust items): `Harness::project_hooks() ->
  Option<ProjectHooks { settings, mcp }>` (additive, `wisp-runtime-api` harness point): the files in a project from
  which the CLI runs commands of its own. Claude's: `.claude/settings.json`, `.claude/settings.local.json`,
  `.mcp.json`. `trust::hook_items(dir, home, hooks)` reads them; `trust::hooks_of(ctx, agent)` asks the harness
  (`runtime.harness@1`); `pending` and `before_run` take the hooks, no harness id. Test:
  `trust::tests::a_harness_with_project_hooks_lists_them_and_one_without_lists_none` (pass).
- **budget/core/src/windows.rs:160** (dollars for Claude): `unit_words(in_usd, u)` and `drain_why(…, in_usd, …)`:
  the unit follows what was counted (a run's cost, or its tokens). Nothing calls `drain_why` yet (the drain watch
  isn't wired in v2's budget host). Test: `windows::unit_tests::drain_units_are_dollars_when_runs_reported_their_cost_else_tokens`.
- **Left, same smell (not in the brief):** `budget/core/src/work.rs:138` (Claude's cumulative cost counter) and
  `:155` (Codex's token totals): how each CLI reports its stats; they belong in each harness's parser (report a
  turn's own cost and tokens), then budget reads one shape.
- `cargo clippy -p wisp-budget-core -p wisp-budget -p wisp-worktrees -p wisp-claude -p wisp-runtime-api --all-targets -- -D warnings`: clean.
