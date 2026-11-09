# v2 grid round: grid-client, the hub, wisp Cloud sharing (2026-11-09)

What this round built, by concern, and what's left. The edge cases are in ADR-0010, 0035, 0038 and 0041
("Edge cases (added 2026-11-09)"), one named test each.

## Leftovers from the last round

- **Agent rename in place:** `CrudKind.renames(cmd)`, plus `runtime.profile.rename`, a single write.
  Test: `an_agent_rename_is_one_write` in `serve_folder.rs`.
- **Session readers** for cursor, opencode, grok and antigravity (`plugins/<h>/host/src/sessions.rs`).
  - The fixtures were recorded by running each installed CLI on "Reply with OK." in `/tmp/wisp-samples/run`. They are not copies of the user's own sessions.
  - The user's injected skill and MCP lists were cut out of grok's fixture.
  - opencode and antigravity are read with read-only SQLite on the blocking pool.
  - copilot isn't installed here, so it stays listed as not built.

## grid-client (`plugins/grid-client/{api,core,host}`)

- **Sign in** (`signin.rs`): the RFC 8628 device flow.
  - A `slow_down` answer adds 5 s to the poll interval.
  - The token goes to secrets (`grid-client/token`), never to a row.
  - The cloud box is added as a `grid` machine (follow, never woken).
  - The account's other computers are added as `grid-tunnel` machines.
- **Transports** (`transport.rs`): `grid` and `grid-tunnel`.
  - Requests carry the bearer token. A watch is passive (`x-wisp-passive: 1`).
  - `probe` reads `/_grid/state`. `direct` gives a channel that wakes the box. `stop_remote` posts `/_grid/stop`.
- **This computer** (`computer.rs`): `wisp computer on|off|status`.
  - It dials out with `Upgrade: wisp-tunnel`, then serves HTTP/2 on the upgraded connection.
  - Each request is forwarded to this wisp's loopback, made to look local (`core::local_headers`, mark compared in constant time).
  - It redials after 1/2/5/15/30 s and stops on 401/404.
  - Previews pass only while `grid-client.previews` is on.
  - On a box (`WISP_BOX`) it refuses to run. The kernel's `box` set also denies `grid-client:computer`.
- **wisp Cloud** (`cloud.rs`):
  - the `wisp-cloud` destination for `share.destination@1`;
  - my shares, access, revoke;
  - `fetch`, which checks the ed25519 signature;
  - `imported` and `updates` (update available).

## Share (ADR-0038)

- `share.destination@1`, plus `share.send` and `share.destinations` in wisp.share.
- A task's link carries the preview's scrubbed, signed bundle. The bundle id is stable, so an unchanged task keeps its version.
- CLI:
  - `wisp share <task|kind.name> --to cloud`, with `--access anyone|people:…|teams:…|password`, `--expires 7d` and `--publish`;
  - `wisp shares [--updates] [--revoke id]`;
  - `wisp open <link>`, which shows a setup's plan and applies it with `--yes` (a task goes to the existing open choices);
  - `grid://` module sources in `wisp init`, pinned by version in `lock.yml`.

## Reach (ADR-0041)

- `--on <machine>` is a global flag. The client routes each command through `machines.route` with the same idempotency key, says which machine answers, and lists the machines when the name is unknown.
- `machines.route` to an asleep box that wakes on request now sends the command straight there, which wakes it, then connects the link.
- **Bug fixed in machines:** probe, direct channels and stop never carried the peer's secret, so every grid request from those paths was unauthenticated. `PeerIo::quiet_with` and a secret cache fix it.
- Every generated MCP tool takes `peer` (routed through `machines.route`).
- `wisp grid deploy -f <file> [--on <box>]` is `apply` on the cloud box.

## The hub (`apps/grid`)

- `accounts.rs`: device codes, devices, sessions, computers, and dev sign-in (`auth.dev`).
- `shares.rs`: versions, signer pinning, access, expiry, revoke, counts, gallery.
- `teams.rs`: roles. Migration 12 (appended) adds the share columns, `share_versions`, `teams` and `team_members`.
- `tunnels.rs`: the reverse HTTP/2 tunnel. A new tunnel for the same computer wins; cookies a computer sets are dropped (a preview's own are kept, host-only).
- `hostd.rs`: the process driver. A box is `wisp serve` in box and trusted-proxy mode, started on a real request and stopped when idle (`/api/status`), with one start per box.
- `edge.rs`: one server for every address.
  - **Grid's own address (`<domain>`):** the device API, `/activate`, the shares API, `/s/<id>`, `/gallery`, teams.
  - **Cloud boxes (`<handle>.<domain>`):** the box behind the edge. A passive request to a stopped box answers 503.
  - **Computers and their pages:** reached through the tunnel. Each check names its reach in `trust`.
- `pages/hub.rs`: a page for each share kind, plus locked, gone and gallery pages, every value escaped.
- `wisp-grid dev` (`cli.rs`).

## Not built

- **Grid sign-in providers.** GitHub and Google OAuth (v1 `auth/providers.js`) aren't ported; the grid signs in with `auth.dev` only. `wisp-grid serve` says so.
- **Other grid parts not ported:** the container driver (boxd), sandboxes as peers, sites, inbox, mail, route, and the v1 grid tests for those parts.
- **`wisp ssh <machine>`:** needs a grid ssh gateway.
- **`wisp tui --on`:** there is no `wisp tui` in v2 yet.
- **SDK `peer`:** there's no TypeScript SDK package for it yet.
- **Team spaces in the UI:** teams are reachable through the grid's JSON API only; there's no page and no CLI.
- **Share pages:** they use the grid's own server-rendered CSS, not the app's kit.
- **Kinds without a page view:** apps, plugins and My Stuff are stored and shown as JSON; they have no page of their own.
