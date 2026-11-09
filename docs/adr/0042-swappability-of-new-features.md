# ADR-0042: The newer features are plugins too, each behind a point a user plugin can fill

- Status: accepted
- Date: 2026-11-09
- Source: the owner: "we're still on our rule that everything is a plugin and swappable, correct?" Yes; this records
  where each feature added since ADR-0003 sits, so none of them is wired into the kernel or the binary.

| Feature | Owning plugin | Point(s) a plugin can fill or replace | Swap example |
|---|---|---|---|
| Formulas, plan, apply, export (0026/0034) | `wisp.resources` | `resource.kind@1`; `formula.source@1` (where modules come from: path, git, grid) | a kind for your own tool; modules from an internal registry |
| Workflows (0028) | `wisp.workflows` | `workflow.step@1` (step types beyond tasks: wait, approval, webhook) | a "deploy" step |
| Task specs, rerun, fork (0027/0029) | `wisp.runtime` | `runtime.harness@1`, interceptors (`before:run`, …) | another harness |
| Repo history `.wisp/`, blame, track, Open in (0033) | `wisp.history` (new, split out of runtime) | `history.store@1` (files, git notes, LFS); `history.blame@1` (git, jj) | Jujutsu instead of git; history kept in a database |
| Adopt outside sessions (0035) | `wisp.history` | `harness.sessions@1` (one per harness) | a new CLI's sessions |
| Sharing (0027/0038) | `wisp.share` | `share.destination@1` (wisp Cloud, file, gist, git) | S3 or an internal portal |
| Grid hub, tunnels, remote machines (0041/0010) | `wisp.grid-client`, `wisp.machines` | `machines.transport@1` (ssh, grid, grid-tunnel) | Tailscale-direct, a corporate bastion |
| Telemetry (0021) | `wisp.telemetry` | `telemetry.sink@1` (PostHog is `wisp.posthog`) | your own analytics |
| Frontends (0024) | `wisp.web`, `wisp.tui`, `wisp.cli` | `web.extension`, `tui.view`, `tui.input`, `term.block`, `cli.verb` | a different TUI; extra CLI verbs |
| MCP for outside harnesses (0040) | `wisp.mcp` | tools are generated from the catalogue; `mcp.tool@1` for hand-made ones | |
| Terminal context (0023) | `wisp.termctx` | `termctx.source@1` (tmux, WezTerm, kitty, iTerm2, …) | another terminal |
| CI, git hook (0040) | `wisp.ci`, `wisp.githooks` (new) | | another CI provider |
| My Stuff, apps (0036) | `wisp.stuff`, plugin host's untrusted tier | `stuff.kind@1` | a new item type |
| Docs | none (not runtime) | | |

**The rules this keeps:**
- The kernel has no feature. The only place features are named is the plugin groups in `crates/wisp/src/groups.rs`
  (`DefaultPlugins`, `BoxPlugins`, `HeadlessPlugins`, `MinimalPlugins`).
- Each of these plugins can be switched off. Its dependents are refused with a reason, and the rest keeps working,
  with a test per plugin ("deactivate leaks nothing", plan §6.10).
- Each one can be replaced by a user plugin that provides the same point or service, at the same power (plan §6.0).
- **Check:** `tools/check` fails a host crate that isn't in a group or that registers functionality outside its
  manifest's points.

## wisp.history, split out (added 2026-11-09)

`wisp.history` owns `.wisp/` history: tracking (`history.track`, `untrack`, `save`), blame, log, the ask-mode
offers, resume requests and context injection. Its two points:
- `history.store@1` (where a tracked task's files go): `files` (the working tree, the default), `notes` (git
  notes under `refs/notes/wisp`, so the tree stays clean), `lfs` (the files, with `.gitattributes` sending
  transcripts to Git LFS). The repo picks one with `history: { transcripts: files | notes | lfs }`.
- `history.blame@1` (what knows which commit wrote a line): `git`, through wisp-proc.

`wisp.share` keeps bundles, signatures and destinations; it no longer writes into repos.

### Edge cases (each one a test, named after it)
- `history_off_leaves_share_working`: with wisp.history off, `share.preview` still answers and `history.track`
  is refused as an unknown command, saying its plugin is off.
- `a_user_store_receives_the_writes`: a plugin that provides `history.store@1` as `db` and a repo with
  `history: { transcripts: db }` gets the task's files; nothing lands in the tree.
- `notes_keep_the_tree_clean`: with `transcripts: notes` the transcript is a git note on `refs/notes/wisp` and the
  working tree has only the task file and report.
- `lfs_marks_transcripts`: with `transcripts: lfs`, `.gitattributes` routes `.wisp/history/*.zst` to LFS, once.
- `tracking_twice_rewrites_in_place`: tracking a task again leaves one task file, one report, one transcript.
- `a_folder_without_git_still_tracks`: the files store writes in a folder that isn't a repo; blame says so.
- `a_user_blame_source_answers`: a plugin providing `history.blame@1` answers `history.blame`.
