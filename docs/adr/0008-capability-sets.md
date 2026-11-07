# ADR-0008: Permissions: capability sets replace capped.js

- Status: accepted
- Date: 2026-11-07
- Source: wisp v2 rewrite plan, draft 9

## Context

v1 kept what a channel-started task could do as a hand-written list in `capped.js`, plus comments in `grid/route.js`, `grid/inbox.js` and `server/http/trust.js`.

## Decision

- A permission is `ns:action{scope}` (`proc:spawn{bin:claude}`, `runtime:start`). A plugin's commands are permissions too.
- A **capability set** binds permissions to a context: `user:full`, `agent:session`, `agent:capped` (v1's `capped.js`, now data), `crew:<name>`, `box`, `apikey`, `preview`, `pane:<id>`, and each plugin's manifest permissions.
- **Default deny.** `tools/check` fails if a command or MCP tool is named by no set.
- A box never gets a token for a laptop (plan §7.2.4).

## Consequences

This is not a sandbox: a harness CLI wisp spawns keeps full access to the filesystem and the network, as in v1. Only the grid isolates it, with gVisor.
