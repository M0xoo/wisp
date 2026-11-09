# ADR-0041: wisp Grid is the hub: what's shared, and the remote machines you use from the GUI or the TUI

- Status: accepted
- Date: 2026-11-09
- Source: the owner: "the grid will play the role of a hub of what's shared plus remote machines (that can have the
  TUI or GUI)."
- Brings together ADR-0010 (peers), 0038 (sharing through wisp Cloud), 0024 (frontends), 0014 (grid control plane).

## Decision

wisp Grid (grid.trywisp.dev, or self-hosted) has two jobs, and every frontend reaches both.

**1. The hub of what's shared**
- Everything shared through wisp Cloud (ADR-0038) lives there: tasks, setups and modules, crew, workflows, apps,
  plugins, My Stuff items and reports. Each has its page, its access rules, versions, and view and import counts.
- **Discover:** a public gallery of what people chose to publish (formulas, modules, crew members, workflows,
  plugins, apps), searchable and taggable, with "Use this" opening the import screen (ADR-0034). It's the
  community showcase on the site (openclaw.ai's "what people are building", for wisp).
- **Teams:** a team space on the grid holds the team's shared modules, the setups members import, and tasks shared
  with the team (`share: { with: [team@acme] }`), with roles that map to capability sets.
- **Module source:** `source: grid://acme/review-team?ref=v2` works like a git source, pinned in `.wisp/lock.yml`.

**2. Remote machines**
- **Cloud computers:** a box on the grid runs a full wisp (the Rust binary, `BoxPlugins`), as today.
- **Your own computers:** through the grid tunnel (ADR-0010), reachable from anywhere without opening ports.
- **Sandboxes:** short-lived boxes for one task.
- All of them are **peers** speaking the sync protocol, so one list merges every machine, and commands go to
  the peer that owns them.

**Every machine on the grid can be used from every frontend:**

| Frontend | How |
|---|---|
| GUI | in the browser at `<handle>.grid.trywisp.dev`, in the desktop app, and on the phone: one list across machines, as today |
| TUI | `wisp tui --on <machine>` attaches your local TUI to that peer over the sync protocol (nothing to install there). Or `wisp ssh <machine>` opens a shell on a cloud box with `wisp tui` ready, for when you want to be *on* the box |
| CLI | `wisp --on <machine> …` runs any command against that peer: `wisp ls --on studio`, `wisp "task" --on cloud` |
| SDK | `wisp.connect({ peer: 'studio' })` |
| Agents | MCP tools take a peer, so an agent in Claude Code can start a task on your cloud box (ADR-0040) |

- **Placement as code:** formulas and workflows say where things run (`on: ${machine.studio}`, `on: cloud`), and
  `wisp grid deploy -f` applies a formula to a box (ADR-0026/0034).
- **Sleeping boxes stay asleep** until something real needs them (plan §7.2.3), and the GUI and TUI show them as
  asleep, with their last-known rows.

## Consequences

- grid-client (on each wisp) and apps/grid (the hub) grow a gallery, team spaces, a `grid://` module source, and
  `wisp ssh`.
- `--on <machine>` becomes a global CLI flag, and the TUI takes a peer. Both use the Rust SyncClient.
- The site's Run section shows the TUI and the GUI on a cloud box. The Track and Declare sections show the gallery
  and team sharing.
