---
name: add-command
description: Use when adding or changing something a user, agent, channel or peer can make wisp do (a command, an HTTP route or an MCP tool) in wisp v2.
---

# Add a command

1. Declare it in the owner plugin's `api/` (id `owner.verb`, typed args and result) and in its manifest's
   `contributes.commands`.
2. Implement it in `host/` with `ctx.command({ id, parse, run })`. `parse` validates `unknown` input and
   throws `invalid` with a field path. `run` writes only through `store.tx` (one transaction, the change
   feed records it) and returns plain JSON.
3. **Permissions are default deny.** Name the command in every capability set that should reach it
   (`packages/kernel/src/capabilities.ts`): `user:full`, `agent:session`, `agent:capped` (a task a channel
   started below Full auto), `apikey`, `box`. `npm run check` fails if no set names it.
4. It must be able to refuse: if another plugin may want to veto it, run an interceptor hook
   (`before:<verb>`) before writing, and document the hook in `api/`.
5. Client side: `defineCommand({ id, optimistic })`, where `optimistic` is the patch it applies at once, or
   `'none'` with a reason. The UI rolls back with a toast on `reject`.
6. An HTTP route or MCP tool is a thin adapter over the command. Add the route to OpenAPI (the check fails
   without it) and MCP tools to the agent-protocol goldens.
7. Tests: the decider/handler (no mocks), the permission refusal, idempotency (same mid twice runs once).
   Then `.agents/bin/monoflow verify --affected`.
