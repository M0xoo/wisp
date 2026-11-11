# v1 → v2 coverage

Every v1 HTTP route (`docs/v1-routes.txt`), MCP tool, CLI command, setting key and telemetry event
(`docs/v1-surface.txt`) and the v2 piece that serves its intent (ADR-0031: no compat routes, the intent is
kept). `npm run check` (rule `v1-coverage`) reads this table: every v1 item has a row here or in
`docs/v1-dropped.md`, and every reference names something that exists:

- `cmd:<id>` a command in a plugin manifest; `mcp:<tool>` an MCP tool (plugins/mcp); `cli:<verb>` a `wisp`
  verb (crates/wisp); `setting:<key>` a registry setting; `kind:<section>` a resource kind (`wisp.yml`);
  `route:<path>` an HTTP route a plugin or the edge serves; `telemetry:<event>` a catalogue event that some
  plugin emits; `ui:<home>` client-only state (ADR-0006), with why.
- `todo:<what>` is work: the intent has no v2 piece yet. Each is a warning, counted in the summary, until built.

| kind | v1 | v2 |
|---|---|---|
| route | `DELETE /agents/:id/accounts/:acc` | `cmd:accounts.remove` |
| route | `DELETE /agents/:id/keys/:provider` | `cmd:accounts.keys.remove` |
| route | `DELETE /agents/:id/login` | `cmd:accounts.login.cancel` |
| route | `DELETE /cloud/keys/:id` | `cmd:grid-client.revoke` |
| route | `DELETE /cloud/signin/:id` | `cmd:grid-client.signinCancel` |
| route | `DELETE /connectors/:id` | `cmd:connectors.remove` |
| route | `DELETE /connectors/:id/signin` | `cmd:connectors.signout` |
| route | `DELETE /crew/:id` | `cmd:crew.remove` |
| route | `DELETE /internal/crew/:id` | `mcp:wisp_crew_remove` |
| route | `DELETE /later/:id` | `cmd:later.cancelPlan` |
| route | `DELETE /machines/:id` | `cmd:machines.remove` |
| route | `DELETE /machines/:id/agents/:aid/accounts/:acc` | `cmd:machines.call` |
| route | `DELETE /machines/:id/agents/:aid/keys/:provider` | `cmd:machines.call` |
| route | `DELETE /machines/:id/agents/:aid/login` | `cmd:machines.call` |
| route | `DELETE /projects/:id` | `kind:projects` |
| route | `DELETE /recipes/:key` | `cmd:workflows.remove` |
| route | `DELETE /sandbox/:id` | `cmd:grid-client.sandboxRemove` |
| route | `DELETE /sandbox/env/:key` | `todo:grid sandbox env (v1 sandbox.js)` |
| route | `DELETE /sandbox/login` | `todo:grid sandbox harness sign-in` |
| route | `DELETE /sandbox/logins/:agent` | `todo:grid sandbox harness sign-in` |
| route | `DELETE /sessions/:id` | `cmd:runtime.delete` |
| route | `DELETE /sessions/:id/btw` | `cmd:runtime.btw.drop` |
| route | `DELETE /sessions/:id/goal` | `cmd:goal.drop` |
| route | `DELETE /sessions/:id/later` | `cmd:later.cancel` |
| route | `DELETE /sessions/:id/queue` | `cmd:runtime.queue.cancel` |
| route | `DELETE /sessions/:id/run` | `cmd:terminal.close` |
| route | `DELETE /sessions/:id/share` | `cmd:share.stop` |
| route | `DELETE /sessions/:id/shell` | `cmd:terminal.close` |
| route | `DELETE /sessions/:id/term` | `cmd:terminal.close` |
| route | `DELETE /spells/:id` | `cmd:plugins.setEnabled`, `kind:plugins` |
| route | `DELETE /stuff/:id` | `cmd:stuff.remove` |
| route | `DELETE /stuff/:id/allow` | `cmd:stuff.allow` |
| route | `DELETE /stuff/:id/data` | `cmd:stuff.resetData` |
| route | `DELETE /stuff/:id/launch` | `cmd:stuff.stop` |
| route | `DELETE /stuff/:id/publish` | `cmd:stuff.unpublish` |
| route | `DELETE /teams/:id` | `kind:teams` |
| route | `DELETE /triggers/:id` | `cmd:automations.task.remove` |
| route | `DELETE /uploads/:id` | `route:/uploads/:id` |
| route | `GET /agents` | `cmd:runtime.agents` |
| route | `GET /agents/:id/accounts` | `cmd:accounts.list` |
| route | `GET /agents/:id/keys` | `cmd:accounts.keys` |
| route | `GET /agents/:id/login` | `cmd:accounts.login.status` |
| route | `GET /cloud/keys` | `cmd:grid-client.access` |
| route | `GET /cloud/signin/:id` | `cmd:grid-client.signinStatus` |
| route | `GET /computer` | `cmd:grid-client.computer` |
| route | `GET /config` | `cmd:settings.list` |
| route | `GET /connectors` | `cmd:connectors.list` |
| route | `GET /connectors/oauth/callback` | `cmd:connectors.oauthFinish` |
| route | `GET /crew` | `cmd:crew.list` |
| route | `GET /crew-kit` | `cmd:crew.kit` |
| route | `GET /crew-layout` | `cmd:crew.layout` |
| route | `GET /crew/:id` | `cmd:crew.get` |
| route | `GET /crew/stats` | `cmd:crew.stats` |
| route | `GET /events` | `route:/events` |
| route | `GET /files` | `todo:workspace files (v1 GET /files: a folder's files for @ and the picker)` |
| route | `GET /fs` | `todo:folder browser (v1 GET /fs: the folder picker's listing)` |
| route | `GET /health` | `route:/health` |
| route | `GET /internal/ask/:id` | `mcp:ask_user` |
| route | `GET /internal/available/:id` | `mcp:wisp_available` |
| route | `GET /internal/connectors/:sid` | `mcp:wisp_connectors` |
| route | `GET /internal/crew/:id` | `mcp:wisp_crew` |
| route | `GET /internal/delegate/:id` | `mcp:subagent_results` |
| route | `GET /internal/session/:id` | `mcp:wisp_session` |
| route | `GET /internal/sessions/:id` | `mcp:wisp_sessions` |
| route | `GET /internal/spell-schema/:id` | `mcp:wisp_spell_schema` |
| route | `GET /internal/spells/:id` | `mcp:wisp_spells` |
| route | `GET /internal/stats/:id` | `mcp:wisp_stats` |
| route | `GET /internal/stuff/:id` | `mcp:wisp_stuff` |
| route | `GET /internal/task/:id` | `mcp:wisp_task` |
| route | `GET /issues` | `cmd:issues.list` |
| route | `GET /later` | `cmd:later.list`, `cmd:later.plans` |
| route | `GET /load` | `cmd:machine.load` |
| route | `GET /machine` | `cmd:machine.read` |
| route | `GET /machines` | `cmd:machines.list` |
| route | `GET /machines/:id/agents/:aid/accounts` | `cmd:machines.call` |
| route | `GET /machines/:id/agents/:aid/keys` | `cmd:machines.call` |
| route | `GET /machines/:id/agents/:aid/login` | `cmd:machines.call` |
| route | `GET /machines/:id/discover` | `cmd:machines.discover` |
| route | `GET /machines/:id/fs` | `todo:folder browser on a machine (v1 GET /machines/:id/fs)` |
| route | `GET /machines/discover` | `cmd:machines.discover` |
| route | `GET /machines/reachable` | `cmd:machines.reachable` |
| route | `GET /machines/ssh-hosts` | `cmd:machines.hosts` |
| route | `GET /openapi.json` | `route:/openapi.json` |
| route | `GET /preferences` | `cmd:learn.view` |
| route | `GET /projects` | `kind:projects` |
| route | `GET /projects/:id/foreign-worktrees` | `cmd:worktrees.bringIn` |
| route | `GET /projects/discover` | `route:/projects/discover` |
| route | `GET /projects/github` | `todo:projects (GitHub repos to clone)` |
| route | `GET /projects/origin` | `todo:projects (a folder's git origin)` |
| route | `GET /recipes` | `cmd:workflows.list` |
| route | `GET /recipes/:key` | `cmd:workflows.list` |
| route | `GET /remote` | `cmd:channels.view` |
| route | `GET /remote/discord/invite` | `todo:channels discord transport (invite link)` |
| route | `GET /remote/slack/manifest` | `cmd:channels.extra` |
| route | `GET /router` | `cmd:router.view` |
| route | `GET /sandbox` | `cmd:grid-client.sandboxes` |
| route | `GET /search` | `cmd:runtime.search` |
| route | `GET /sessions` | `cmd:runtime.list` |
| route | `GET /sessions/:id` | `cmd:runtime.get` |
| route | `GET /sessions/:id/changes` | `cmd:git.changes` |
| route | `GET /sessions/:id/check-log` | `cmd:ship.check_log` |
| route | `GET /sessions/:id/file` | `todo:workspace file (v1: one file of a task's folder, for the file viewer)` |
| route | `GET /sessions/:id/files` | `todo:workspace files (v1: a task folder's files, for @ mentions)` |
| route | `GET /sessions/:id/folders` | `cmd:runtime.get` |
| route | `GET /sessions/:id/goal-runs/:run` | `todo:goal runs (v1 goal-runs.js: what one goal check said and did)` |
| route | `GET /sessions/:id/grep` | `todo:workspace grep (v1: search a task's folder)` |
| route | `GET /sessions/:id/patch` | `cmd:git.changes` |
| route | `GET /sessions/:id/presentation` | `cmd:runtime.presentation` |
| route | `GET /sessions/:id/prs` | `cmd:ship.view` |
| route | `GET /sessions/:id/run` | `cmd:terminal.get` |
| route | `GET /sessions/:id/run/log` | `cmd:terminal.get` |
| route | `GET /sessions/:id/share` | `cmd:share.peek` |
| route | `GET /sessions/:id/shell` | `route:/sessions/:id/shell`, `cmd:terminal.shell.info` |
| route | `GET /sessions/:id/ship` | `cmd:ship.details` |
| route | `GET /sessions/:id/source` | `todo:task source (v1 GET/PUT /sessions/:id/source: the folder or repo a task starts from)` |
| route | `GET /sessions/:id/takeover` | `cmd:terminal.get` |
| route | `GET /sessions/:id/term` | `route:/sessions/:id/term` |
| route | `GET /sessions/:id/unmasked` | `todo:env unmask (v1: a masked .env value, shown on request)` |
| route | `GET /sessions/:id/wait` | `mcp:wisp_wait`, `cli:wait` |
| route | `GET /sessions/:id/watch` | `mcp:wisp_watch` |
| route | `GET /sessions/:id/workspace` | `cmd:worktrees.status` |
| route | `GET /spells` | `cmd:plugins.list` |
| route | `GET /spells/:id` | `cmd:plugins.list` |
| route | `GET /spells/:id/export` | `cmd:resources.export` |
| route | `GET /status` | `route:/status` |
| route | `GET /stuff` | `cmd:stuff.list` |
| route | `GET /stuff/:id/cover` | `route:/stuff/:id/cover` |
| route | `GET /stuff/:id/file` | `route:/stuff/:id/file` |
| route | `GET /stuff/:id/grant` | `cmd:stuff.grant` |
| route | `GET /stuff/starters` | `route:/stuff/starters`, `cmd:stuff.starters` |
| route | `GET /teams` | `kind:teams` |
| route | `GET /teams/:id` | `kind:teams` |
| route | `GET /tools` | `cmd:git.tools` |
| route | `GET /triggers` | `cmd:automations.tasks`, `cmd:automations.trigger.ls` |
| route | `GET /update` | `cmd:update.view` |
| route | `GET /uploads/:id` | `route:/uploads/:id` |
| route | `GET /usage` | `cmd:runtime.usage`, `cmd:budget.view` |
| route | `GET /usage/periods` | `cmd:budget.view` |
| route | `GET /usage/tools` | `cmd:runtime.usage` |
| route | `GET /worktrees` | `cmd:worktrees.view` |
| route | `PATCH /agents/:id/accounts/:acc` | `cmd:accounts.update` |
| route | `PATCH /config` | `cmd:settings.set` |
| route | `PATCH /connectors/:id` | `cmd:connectors.update` |
| route | `PATCH /crew/:id` | `cmd:crew.update` |
| route | `PATCH /internal/crew/:id` | `mcp:wisp_crew_edit` |
| route | `PATCH /later/:id` | `cmd:later.editPlan` |
| route | `PATCH /machines/:id` | `cmd:machines.update` |
| route | `PATCH /machines/:id/agents/:aid/accounts/:acc` | `cmd:machines.call` |
| route | `PATCH /projects/:id` | `kind:projects`, `cmd:runtime.projectRun`, `cmd:runtime.projectTest` |
| route | `PATCH /recipes/:key` | `cmd:workflows.set` |
| route | `PATCH /router` | `cmd:router.set` |
| route | `PATCH /sessions/:id` | `cmd:runtime.rename`, `cmd:runtime.setState`, `cmd:runtime.archive`, `cmd:runtime.markRead`, `cmd:runtime.setMode`, `cmd:runtime.setLean` |
| route | `PATCH /sessions/:id/goal` | `cmd:goal.pause`, `cmd:goal.resume` |
| route | `PATCH /sessions/:id/later` | `cmd:later.edit` |
| route | `PATCH /sessions/:id/queue` | `cmd:runtime.queue.edit`, `cmd:runtime.queue.order` |
| route | `PATCH /spells/:id` | `cmd:plugins.setEnabled` |
| route | `PATCH /stuff/:id` | `cmd:stuff.update` |
| route | `PATCH /teams/:id` | `kind:teams` |
| route | `PATCH /triggers/:id` | `cmd:automations.task.set` |
| route | `POST /agents/:id/accounts` | `cmd:accounts.add` |
| route | `POST /agents/:id/drain/dismiss` | `cmd:budget.dismissDrain` |
| route | `POST /agents/:id/keys` | `cmd:accounts.keys.set` |
| route | `POST /agents/:id/login` | `cmd:accounts.login.start` |
| route | `POST /agents/:id/login/input` | `cmd:accounts.login.input` |
| route | `POST /agents/:id/logout` | `cmd:accounts.logout` |
| route | `POST /agents/:id/trust` | `cmd:accounts.watch.trust` |
| route | `POST /agents/:id/windows/dismiss` | `cmd:budget.dismissNotice` |
| route | `POST /agents/install` | `cmd:accounts.install` |
| route | `POST /agents/recheck` | `cmd:accounts.recheck` |
| route | `POST /automations/pause` | `cmd:machine.automations.pause` |
| route | `POST /channels/inbound` | `cmd:channels.inbound` |
| route | `POST /channels/rotate` | `cmd:channels.rotate` |
| route | `POST /channels/routed` | `cmd:channels.routed` |
| route | `POST /cloud/keys` | `cmd:grid-client.access` |
| route | `POST /cloud/signin` | `cmd:grid-client.signin` |
| route | `POST /computer` | `cmd:grid-client.computer` |
| route | `POST /connectors` | `cmd:connectors.add` |
| route | `POST /connectors/:id/signin` | `cmd:connectors.signin` |
| route | `POST /connectors/:id/test` | `cmd:connectors.test` |
| route | `POST /connectors/import` | `cmd:connectors.import` |
| route | `POST /crew` | `cmd:crew.create` |
| route | `POST /crew/:id/checkin` | `cmd:crew.checkin` |
| route | `POST /crew/:id/detach` | `cmd:crew.detach` |
| route | `POST /crew/:id/jobs` | `cmd:crew.assign` |
| route | `POST /crew/export` | `cmd:crew.export` |
| route | `POST /crew/import` | `cmd:crew.import` |
| route | `POST /feedback` | `todo:feedback (v1 services/feedback.js: send feedback from Settings)` |
| route | `POST /hooks/:token` | `route:/hooks/:id` |
| route | `POST /internal/approve` | `mcp:approve` |
| route | `POST /internal/ask` | `mcp:ask_user` |
| route | `POST /internal/connectors/:id/token` | `todo:connector token for an agent (v1 mcp-connector.js)` |
| route | `POST /internal/connectors/:sid` | `mcp:wisp_connector_add` |
| route | `POST /internal/connectors/:sid/signin` | `mcp:wisp_connector_signin` |
| route | `POST /internal/crew/:id` | `mcp:wisp_crew_add` |
| route | `POST /internal/crew/:id/kit` | `mcp:wisp_crew_kit` |
| route | `POST /internal/delegate/:id` | `mcp:delegate` |
| route | `POST /internal/later` | `mcp:resume_later` |
| route | `POST /internal/launch/:id` | `mcp:wisp_launch` |
| route | `POST /internal/prs` | `mcp:wisp_pr` |
| route | `POST /internal/spell-check/:id` | `mcp:wisp_spell_check` |
| route | `POST /internal/spell-data/:id` | `mcp:wisp_spell_data` |
| route | `POST /internal/stuff` | `mcp:wisp_save` |
| route | `POST /internal/tags` | `mcp:wisp_tag` |
| route | `POST /internal/task/:id` | `mcp:wisp_task` |
| route | `POST /internal/watch` | `mcp:wisp_watch` |
| route | `POST /later` | `cmd:later.plan` |
| route | `POST /launch/warm` | `todo:launch warm-up (v1: pre-spawn the harness as you type)` |
| route | `POST /lsp/install` | `cmd:lsp.install` |
| route | `POST /machine/fix` | `cmd:machine.fix` |
| route | `POST /machine/harness/clean` | `cmd:machine.harness.clean` |
| route | `POST /machine/stop` | `cmd:machine.stop` |
| route | `POST /machines` | `cmd:machines.add` |
| route | `POST /machines/:id/agents/:aid/accounts` | `cmd:machines.call` |
| route | `POST /machines/:id/agents/:aid/keys` | `cmd:machines.call` |
| route | `POST /machines/:id/agents/:aid/login` | `cmd:machines.call` |
| route | `POST /machines/:id/agents/:aid/login/input` | `cmd:machines.call` |
| route | `POST /machines/:id/agents/:aid/logout` | `cmd:machines.call` |
| route | `POST /machines/:id/connect` | `cmd:machines.connect` |
| route | `POST /machines/:id/disconnect` | `cmd:machines.disconnect` |
| route | `POST /machines/:id/let-in` | `cmd:machines.letIn` |
| route | `POST /machines/:id/stop` | `cmd:machines.stop` |
| route | `POST /open` | `todo:open in editor (v1 POST /open: a file or folder in the user's editor)` |
| route | `POST /projects` | `kind:projects` |
| route | `POST /projects/:id/foreign-worktrees` | `cmd:worktrees.bringIn` |
| route | `POST /projects/:id/foreign-worktrees/dismiss` | `cmd:worktrees.dismiss` |
| route | `POST /projects/checkout` | `cmd:git.clone` |
| route | `POST /recipes` | `cmd:workflows.set` |
| route | `POST /recipes/:key/run` | `cmd:workflows.run` |
| route | `POST /remote/test` | `cmd:channels.test` |
| route | `POST /router/preview` | `cmd:router.preview` |
| route | `POST /router/reset` | `cmd:router.reset` |
| route | `POST /sandbox/browser` | `todo:grid sandbox browser` |
| route | `POST /sandbox/desktop` | `todo:grid sandbox desktop` |
| route | `POST /sandbox/login` | `todo:grid sandbox harness sign-in` |
| route | `POST /sandbox/login/input` | `todo:grid sandbox harness sign-in` |
| route | `POST /sandbox/seed` | `cmd:grid-client.sandbox` |
| route | `POST /sessions` | `cmd:runtime.create` |
| route | `POST /sessions/:id/answer` | `cmd:runtime.answer` |
| route | `POST /sessions/:id/app-state` | `cmd:runtime.appState` |
| route | `POST /sessions/:id/approve` | `cmd:runtime.approval` |
| route | `POST /sessions/:id/btw` | `cmd:runtime.btw` |
| route | `POST /sessions/:id/changes/commit` | `cmd:git.commit` |
| route | `POST /sessions/:id/changes/revert` | `cmd:git.revert` |
| route | `POST /sessions/:id/changes/stage` | `cmd:git.stage` |
| route | `POST /sessions/:id/clash` | `todo:overlaps (v1 services/overlaps.js: two tasks edit the same lines)` |
| route | `POST /sessions/:id/compact` | `cmd:runtime.compact` |
| route | `POST /sessions/:id/crew` | `cmd:crew.assign` |
| route | `POST /sessions/:id/crew-reply` | `todo:crew.reply (declared in wisp-crew-api, not in the manifest nor registered)` |
| route | `POST /sessions/:id/exec` | `cmd:runtime.exec` |
| route | `POST /sessions/:id/fix-conflicts` | `cmd:ship.fix_conflicts` |
| route | `POST /sessions/:id/folders` | `todo:task folders (v1: add or remove a task's extra folders)` |
| route | `POST /sessions/:id/fork` | `cmd:runtime.fork` |
| route | `POST /sessions/:id/held` | `cmd:runtime.held` |
| route | `POST /sessions/:id/later` | `cmd:later.add` |
| route | `POST /sessions/:id/lsp` | `cmd:lsp.ask` |
| route | `POST /sessions/:id/merge` | `cmd:ship.merge` |
| route | `POST /sessions/:id/open-shell` | `cmd:terminal.shell.start` |
| route | `POST /sessions/:id/pack` | `route:/_pack` |
| route | `POST /sessions/:id/pr` | `cmd:ship.ship` |
| route | `POST /sessions/:id/relay` | `todo:move a task (v1 services/move.js + relay.js: move a task to another computer)` |
| route | `POST /sessions/:id/reply` | `cmd:runtime.followUp` |
| route | `POST /sessions/:id/reveal` | `todo:reveal a task's folder (v1: show it in Finder/Explorer)` |
| route | `POST /sessions/:id/revert` | `cmd:git.restoreTurn` |
| route | `POST /sessions/:id/review` | `cmd:review.view` |
| route | `POST /sessions/:id/rollback` | `cmd:git.restoreTurn` |
| route | `POST /sessions/:id/run` | `cmd:runtime.projectRun` |
| route | `POST /sessions/:id/share` | `cmd:share.create` |
| route | `POST /sessions/:id/shell` | `cmd:terminal.shell.start` |
| route | `POST /sessions/:id/ship` | `cmd:ship.ship` |
| route | `POST /sessions/:id/side` | `todo:side discussions (v1 /side: a task that talks over another, read-only)` |
| route | `POST /sessions/:id/stop` | `cmd:runtime.stop` |
| route | `POST /sessions/:id/takeover` | `cmd:terminal.open` |
| route | `POST /sessions/:id/term` | `cmd:terminal.input` |
| route | `POST /sessions/:id/turns/:turn/:step` | `cmd:runtime.approveBlocked` |
| route | `POST /sessions/:id/turns/:turnId/rerun` | `cmd:runtime.rerun` |
| route | `POST /sessions/:id/turns/:turnId/sign-in` | `cmd:runtime.signIn` |
| route | `POST /shares/import` | `cmd:share.import` |
| route | `POST /shares/peek` | `cmd:share.peek` |
| route | `POST /spells` | `cmd:plugins.setEnabled`, `kind:plugins` |
| route | `POST /spells/:id/data/:name` | `mcp:wisp_spell_data` |
| route | `POST /spells/check` | `mcp:wisp_spell_check` |
| route | `POST /spells/off` | `cmd:plugins.setEnabled` |
| route | `POST /spells/try-data` | `mcp:wisp_spell_data` |
| route | `POST /stuff` | `cmd:stuff.save` |
| route | `POST /stuff/:id/allow` | `cmd:stuff.allow` |
| route | `POST /stuff/:id/launch` | `cmd:stuff.launch` |
| route | `POST /stuff/:id/publish` | `cmd:stuff.publish` |
| route | `POST /stuff/:id/restore` | `cmd:stuff.restore` |
| route | `POST /stuff/:id/reveal` | `route:/stuff/:id/reveal`, `cmd:stuff.reveal` |
| route | `POST /stuff/starters/:starter` | `route:/stuff/starters/:starter`, `cmd:stuff.addStarter` |
| route | `POST /stuff/upload` | `route:/stuff/upload`, `cmd:stuff.upload` |
| route | `POST /teams` | `kind:teams` |
| route | `POST /telemetry/event` | `cmd:telemetry.track` |
| route | `POST /triggers` | `cmd:automations.task.set` |
| route | `POST /triggers/:id/run` | `cmd:automations.task.run` |
| route | `POST /update` | `cmd:update.install` |
| route | `POST /uploads` | `route:/uploads` |
| route | `POST /worktrees/clean` | `cmd:worktrees.clean` |
| route | `PUT /crew-layout` | `cmd:crew.set_layout` |
| route | `PUT /preferences` | `cmd:learn.set` |
| route | `PUT /remote` | `cmd:channels.update` |
| route | `PUT /sandbox/env` | `todo:grid sandbox env` |
| route | `PUT /sessions/:id/goal` | `cmd:goal.set` |
| route | `PUT /sessions/:id/source` | `todo:task source` |
| mcp | `approve` | `mcp:approve` |
| mcp | `ask_user` | `mcp:ask_user` |
| mcp | `delegate` | `mcp:delegate` |
| mcp | `resume_later` | `mcp:resume_later` |
| mcp | `subagent_results` | `mcp:subagent_results` |
| mcp | `wisp_agents` | `mcp:wisp_agents` |
| mcp | `wisp_available` | `mcp:wisp_available` |
| mcp | `wisp_blocks` | `mcp:wisp_blocks` |
| mcp | `wisp_connector_add` | `mcp:wisp_connector_add` |
| mcp | `wisp_connector_signin` | `mcp:wisp_connector_signin` |
| mcp | `wisp_connectors` | `mcp:wisp_connectors` |
| mcp | `wisp_crew` | `mcp:wisp_crew` |
| mcp | `wisp_crew_add` | `mcp:wisp_crew_add` |
| mcp | `wisp_crew_edit` | `mcp:wisp_crew_edit` |
| mcp | `wisp_crew_kit` | `mcp:wisp_crew_kit` |
| mcp | `wisp_crew_remove` | `mcp:wisp_crew_remove` |
| mcp | `wisp_get` | `mcp:wisp_get` |
| mcp | `wisp_launch` | `mcp:wisp_launch` |
| mcp | `wisp_list` | `mcp:wisp_list` |
| mcp | `wisp_pr` | `mcp:wisp_pr` |
| mcp | `wisp_reply` | `mcp:wisp_reply` |
| mcp | `wisp_save` | `mcp:wisp_save` |
| mcp | `wisp_session` | `mcp:wisp_session` |
| mcp | `wisp_sessions` | `mcp:wisp_sessions` |
| mcp | `wisp_spell_check` | `mcp:wisp_spell_check` |
| mcp | `wisp_spell_data` | `mcp:wisp_spell_data` |
| mcp | `wisp_spell_schema` | `mcp:wisp_spell_schema` |
| mcp | `wisp_spells` | `mcp:wisp_spells` |
| mcp | `wisp_stats` | `mcp:wisp_stats` |
| mcp | `wisp_stop` | `mcp:wisp_stop` |
| mcp | `wisp_stuff` | `mcp:wisp_stuff` |
| mcp | `wisp_tag` | `mcp:wisp_tag` |
| mcp | `wisp_task` | `mcp:wisp_task` |
| mcp | `wisp_wait` | `mcp:wisp_wait` |
| mcp | `wisp_watch` | `mcp:wisp_watch` |
| cli | `add` | `cli:add` |
| cli | `btw` | `cli:btw` |
| cli | `computer` | `todo:wisp computer (v1: this computer's grid link on/off/status)` |
| cli | `crew` | `cli:crew` |
| cli | `grid` | `cli:grid` |
| cli | `list` | `cli:list` |
| cli | `ls` | `cli:ls` |
| cli | `mcp` | `cli:mcp` |
| cli | `merge` | `cli:merge` |
| cli | `recipes` | `cli:recipes` |
| cli | `reply` | `cli:reply` |
| cli | `run` | `cli:run` |
| cli | `ship` | `cli:ship` |
| cli | `show` | `cli:show` |
| cli | `skill` | `cli:skill` |
| cli | `spell` | `cli:plugin` |
| cli | `spells` | `cli:plugins` |
| cli | `stop` | `cli:stop` |
| cli | `usage` | `cmd:runtime.usage` |
| cli | `wait` | `cli:wait` |
| cli | `grid backup` | `cli:grid` |
| cli | `grid dev` | `cli:grid` |
| cli | `grid doctor` | `cli:grid` |
| cli | `grid help` | `cli:grid` |
| cli | `grid init` | `cli:grid` |
| cli | `grid rotate-key` | `cli:grid` |
| cli | `grid serve` | `cli:grid` |
| cli | `grid users` | `cli:grid` |
| cli | `grid waitlist` | `cli:grid` |
| setting | `acceptChannels` | `setting:channels.acceptChannels` |
| setting | `accounts` | `cmd:accounts.list` |
| setting | `agent` | `kind:agents` |
| setting | `apps` | `setting:runtime.apps` |
| setting | `autoStop` | `cmd:budget.setStop` |
| setting | `automationsPausedUntil` | `cmd:machine.automations.pause` |
| setting | `batteryHold` | `setting:machine.batteryHold` |
| setting | `blocks` | `setting:runtime.blocks` |
| setting | `cloneDir` | `setting:git.cloneDir` |
| setting | `cpuCeiling` | `setting:machine.cpuCeiling` |
| setting | `drainWatch` | `setting:budget.drainWatch` |
| setting | `editor` | `kind:ui` |
| setting | `effort` | `kind:agents` |
| setting | `fixConflicts` | `setting:ship.fixConflicts` |
| setting | `followUp` | `setting:runtime.followUp` |
| setting | `goalJudges` | `kind:goal` |
| setting | `goalVote` | `kind:goal` |
| setting | `harnessAsk` | `cmd:accounts.watch.ask` |
| setting | `leanRuns` | `setting:runtime.leanRuns` |
| setting | `learn` | `setting:learn.enabled` |
| setting | `limitHold` | `todo:setting limitHold (hold a turn near the usage limit)` |
| setting | `limitWait` | `todo:setting limitWait (wait for the reset)` |
| setting | `liveLimits` | `todo:setting liveLimits` |
| setting | `maskEnvFiles` | `setting:git.maskEnvFiles` |
| setting | `maxRuns` | `setting:machine.maxRuns` |
| setting | `memoryFloor` | `setting:machine.memoryFloor` |
| setting | `mode` | `kind:agents` |
| setting | `model` | `kind:agents` |
| setting | `models` | `kind:agents` |
| setting | `notify` | `cmd:channels.notify` |
| setting | `panes` | `setting:stuff.panes` |
| setting | `projectAsk` | `setting:worktrees.projectAsk` |
| setting | `readTimes` | `ui:settings store (read times of each task, per device)` |
| setting | `review` | `setting:review.harness` |
| setting | `router` | `cmd:router.set` |
| setting | `spareCard` | `ui:settings store (the spare task card)` |
| setting | `subagentModel` | `setting:runtime.subagentModel` |
| setting | `subagents` | `todo:setting subagents` |
| setting | `teamPreset` | `kind:teams` |
| setting | `telemetry` | `cmd:telemetry.set` |
| setting | `telemetryNotice` | `ui:settings store (the one-time usage-stats notice)` |
| setting | `terminal` | `kind:ui` |
| setting | `terminalSessions` | `todo:setting terminalSessions` |
| setting | `theme` | `ui:settings store (light, dark, system)` |
| setting | `transcript` | `ui:settings store (transcript density)` |
| setting | `updateChannel` | `setting:update.updateChannel` |
| setting | `watch` | `setting:runtime.watch` |
| setting | `webhookTriggers` | `setting:automations.webhookTriggers` |
| setting | `windowNotice` | `setting:budget.windowNotice` |
| setting | `worktree` | `kind:projects` |
| setting | `worktreeCleanup` | `setting:worktrees.cleanup` |
| setting | `worktreeMax` | `setting:worktrees.max` |
| setting | `worktreeOnDone` | `setting:worktrees.onDone` |
| telemetry | `account` | `telemetry:account` |
| telemetry | `agent_launch` | `telemetry:agent_launch` |
| telemetry | `agent_login` | `telemetry:agent_login` |
| telemetry | `agent_task` | `telemetry:agent_task` |
| telemetry | `app_started` | `telemetry:app_started` |
| telemetry | `approval` | `telemetry:approval` |
| telemetry | `ask_user` | `telemetry:ask_user` |
| telemetry | `auto_override` | `telemetry:auto_override` |
| telemetry | `auto_settled` | `telemetry:auto_settled` |
| telemetry | `btw` | `telemetry:btw` |
| telemetry | `channel_event` | `telemetry:channel_event` |
| telemetry | `compact` | `telemetry:compact` |
| telemetry | `connector_tool` | `telemetry:connector_tool` |
| telemetry | `crew_imported` | `telemetry:crew_imported` |
| telemetry | `crew_shared` | `telemetry:crew_shared` |
| telemetry | `crew_tool` | `telemetry:crew_tool` |
| telemetry | `delegate` | `telemetry:delegate` |
| telemetry | `exec_action` | `telemetry:exec_action` |
| telemetry | `fork_task` | `telemetry:fork_task` |
| telemetry | `harness_install` | `telemetry:harness_install` |
| telemetry | `merge` | `telemetry:merge` |
| telemetry | `move_task` | `todo:move a task (v1 services/move.js)` |
| telemetry | `resume_later` | `telemetry:resume_later` |
| telemetry | `retro` | `telemetry:retro` |
| telemetry | `run_app` | `telemetry:run_app` |
| telemetry | `shell` | `telemetry:shell` |
| telemetry | `ship` | `telemetry:ship` |
| telemetry | `side_task` | `todo:side discussions (v1 /side, services/fork.js side())` |
| telemetry | `spell_hook` | `todo:plugins/spells install and hooks (emit spell_hook when a user plugin's hook runs)` |
| telemetry | `spell_installed` | `todo:plugins/spells install (emit spell_installed when a user plugin is installed)` |
| telemetry | `stuff_launch` | `telemetry:stuff_launch` |
| telemetry | `stuff_publish` | `telemetry:stuff_publish` |
| telemetry | `stuff_save` | `telemetry:stuff_save` |
| telemetry | `takeover` | `telemetry:takeover` |
| telemetry | `task_import` | `telemetry:task_import` |
| telemetry | `task_share` | `telemetry:task_share` |
| telemetry | `try_two_ways` | `todo:try two ways (v1 --try trial; v2's CLI says to use --compare: count it there, server side)` |
| telemetry | `turn_ended` | `telemetry:turn_ended` |
| telemetry | `turn_started` | `telemetry:turn_started` |
| telemetry | `update` | `telemetry:update` |
| telemetry | `wisp_available` | `telemetry:wisp_available` |
| telemetry | `wisp_pr` | `telemetry:wisp_pr` |
| telemetry | `wisp_session` | `telemetry:wisp_session` |
| telemetry | `wisp_sessions` | `telemetry:wisp_sessions` |
| telemetry | `wisp_stats` | `telemetry:wisp_stats` |
| telemetry | `wisp_tag` | `telemetry:wisp_tag` |
| telemetry | `wisp_watch` | `telemetry:wisp_watch` |
| telemetry | `worktrees_brought_in` | `telemetry:worktrees_brought_in` |
