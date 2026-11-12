# v1 features in v2: summary (2026-11-10)

From `docs/v1-features.md` (326 rows, merged from v1's 632 changelog entries, the plain-bullet releases 0.1–0.11,
`web/js/features/*`, keys, Settings panes, block types, MCP tools and the CLI). How each status was decided is
at the top of that file. In short: **built** means a server command and a mounted GUI or the CLI do it end to
end; **partial** is most often *the server and the CLI can do it, but no mounted GUI shows it*.

## Counts

| Area | built | partial | missing | dropped | rows |
|---|---:|---:|---:|---:|---:|
| Tasks and the list | 17 | 29 | 3 | 0 | 49 |
| Composer | 10 | 30 | 6 | 0 | 46 |
| Task page | 9 | 25 | 10 | 0 | 44 |
| Goal and judges | 4 | 3 | 0 | 0 | 7 |
| Crew | 5 | 14 | 1 | 0 | 20 |
| Automations and triggers | 4 | 11 | 0 | 2 | 17 |
| Worktrees | 4 | 3 | 0 | 0 | 7 |
| Ship, PR, review | 6 | 3 | 0 | 0 | 9 |
| My Stuff, apps, panes | 3 | 6 | 1 | 0 | 10 |
| Sharing | 1 | 2 | 1 | 0 | 4 |
| Machines, cloud, grid | 8 | 12 | 1 | 0 | 21 |
| Channels | 3 | 10 | 0 | 0 | 13 |
| Connectors and MCP | 5 | 4 | 0 | 0 | 9 |
| Agents, accounts, usage | 4 | 13 | 1 | 0 | 18 |
| Settings | 4 | 4 | 0 | 0 | 8 |
| Keyboard | 5 | 0 | 5 | 0 | 10 |
| CLI and integrations | 7 | 2 | 0 | 2 | 11 |
| Desktop app | 0 | 1 | 5 | 0 | 6 |
| Phone | 0 | 3 | 5 | 0 | 8 |
| Updates, install, telemetry | 1 | 3 | 0 | 0 | 4 |
| Look and feel | 2 | 3 | 0 | 0 | 5 |
| **Total** | **102** | **181** | **39** | **4** | **326** |

Dropped, all by ADR-0031: spells (F-auto-16, F-auto-17), the v1 JS SDK's shapes (F-cli-5) and v1's HTTP routes
(F-cli-7).

**What the numbers say.** The backend is mostly there: of the 181 partial rows, about 120 have their server
command and fail only on the GUI. The gap is the web UI. 13 plugin UI packages aren't mounted (`crew`, `stuff`,
`automations`, `connectors`, `accounts`, `machines`, `budget`, `grid-client`, `plugins`, `telemetry`, `learn`,
`issues`, `shell-composer`), and so are `shell-home`'s tips and notifications. Eight of `shell-task`'s pieces are
stubs (`TaskHead`, `Transcript`, `PlanView`, `AskCard`, `HaltCard`, `HeldCard`, `Receipt`, `WhatChanged`). Only 6
of v1's ~30 shortcuts are registered. There is no desktop app and no Android frontend yet.

## The 30 that matter most (missing or partial, by how often a user hits them)

| # | Row | Feature | Status | What's missing |
|---:|---|---|---|---|
| 1 | F-key-5…8 | Task keys: J/K, O/Enter, E, A, L, M, Delete, S, ⇧R, ⇧F, T, V, D, P, ], /, U, C | missing | register them as `ShortcutDef`s (the actions exist) |
| 2 | F-comp-15…18 | `@` files/crew/My Stuff and the `/` menu in the prompt box | missing / partial | mount `shell-composer`'s `mentions.ts`/`slash.ts`; add a file-index command |
| 3 | F-comp-1, F-comp-2 | The searchable harness · model picker with the thinking slider | partial | mount `RunnerPicker.tsx` |
| 4 | F-comp-12 | Drop or paste files on the prompt box | partial | a drop target on Home and the reply box → `stuff.upload` |
| 5 | F-page-19, 27, 28 | Side panel PR and Shell panes | partial | both show *later*; wire `ship.details` and `terminal.shell.start` |
| 6 | F-page-21, 22 | Stage, commit and revert from Changes | built | ChangesPane on the kit ChangesList |
| 7 | F-page-33 | Take over / *Open in <harness>* in a terminal inside wisp | partial | an in-page terminal and the T key; the rename is queued |
| 8 | F-crew-3, 1, 10 | Crew member thread, editor and kit | missing / partial | `crew` UI registers no view; `openCrew` renders nothing |
| 9 | F-page-12, 13 | Usage receipt on every turn (tokens, cache, % of weekly) | partial | `Receipt.tsx` is a stub |
| 10 | F-task-34 | Full transcript (V) | partial | `Transcript.tsx` is a stub |
| 11 | F-comp-39, F-auto-9 | *Ask near the limit* card (Send anyway / wait) | partial | the GUI card over the reply box |
| 12 | F-acct-9…14 | Settings → Usage and Plan budget | partial | mount the budget UI |
| 13 | F-acct-2…6 | Settings → Agents: sign in, accounts, keys, re-check, install | partial | mount the accounts UI |
| 14 | F-comp-30 | Compare runs (vs) as one task with honest totals | partial | only CLI fan-out; no grouping or GUI |
| 15 | F-auto-1, 6, 7 | Automations screen, Scheduled section, edit what's waiting | partial | mount the automations and later UIs |
| 16 | F-task-20 | ⌘K searches inside prompts and answers | partial | palette doesn't call `runtime.search` |
| 17 | F-page-14, 15 | Cache gone cold warning, Compact now | missing / partial | cold check missing; Compact has no GUI |
| 18 | F-comp-28, 29 | `/btw` and `/side` | partial / missing | `/btw` has no entry; `runtime.side` has no server command |
| 19 | F-task-14, F-comp-42, F-page-17 | Why a run stopped (crash, limit, refusal, signed out), with Sign in / Hand to … | partial | `HaltCard.tsx` is a stub |
| 20 | F-comp-25, F-comp-22 | Held after Stop; drafts and *after #12* | partial | `HeldCard` stub; UI sends `session.held`, which no manifest lists |
| 21 | F-stuff-1, 4, 7 | My Stuff page, Launch apps, panes | partial | mount the stuff UI |
| 22 | F-conn-1, 2 | Settings → Connectors | partial | the connectors manifest has 0 commands, while the UI sends 7 |
| 23 | F-chan-13, 3, 5 | Phone dialog, channels grammar, Slack/Discord/GitHub two-way | partial | the Phone dialog isn't mounted; the grammar is queued |
| 24 | F-mach-1, 6, 9 | Machines and Cloud panes; Run on another computer | partial | mount the machines and grid-client UIs |
| 25 | F-page-10, 11, 23 | Comment on an answer or a diff line, sent with the follow-up | missing | no comment store |
| 26 | F-task-31, 32 | ↑ brings back prompts; drafts survive a reload | partial | `history.ts` not mounted; Home keeps text in a local signal |
| 27 | F-page-24…26 | Edit a file in wisp, open any file, language server | missing / partial | no editor UI (`lsp` server only) |
| 28 | F-page-29, 30 | Run the task's app beside it; Pick element | partial / missing | no Run pane; no picker |
| 29 | F-desk-1 | The desktop app | missing | no `apps/desktop` (queue item 8) |
| 30 | F-phone-1…5 | The Android app (SSH, notifications, swipes, cloud sign-in) | missing | no v2 Android frontend (queue item 8) |

Next after these: F-acct-17 (memory/retro, `learn` has no commands), F-comp-35 (first-run launcher),
F-task-36 (*No output for 12 min*), F-comp-36 (Issue picker), F-share-1/3 (Share dialog, My shares),
F-page-34/35 (Babysitting mode, `/terminal`), F-mach-5 (Update to X on a machine), F-page-43 (feedback dialog).

## Questions

1. **Status of server-only features.** ADR-0022 says the CLI covers the GUI. I marked a feature *partial* when the
   server and `wisp <plugin> <verb>` can do it but the GUI can't, because every v1 scenario is a GUI one. Should
   CLI reach count as *built* for some areas (crew, automations, machines)?
2. **The phone app.** ADR-0031 says the phone and desktop apps ship v2 bundles only, so I read them as kept, and
   they're *missing* until queue item 8. Is the Android app (SSH computers, swipes, dictation, the camera,
   share-in) still in scope for the first v2 release, or does only the PWA (F-phone-6) ship first?
3. **Spells.** ADR-0031 drops them. v1's spell-made UI (floating buttons, card panels, `/spell` in follow-ups)
   has no plugin equivalent a user can *ask for* yet. Is "make me a pane" (F-stuff-7) the replacement, or should
   asking an agent to write a user plugin be its own feature?
4. **Compare.** v1 shows a compare as one task with a row per run and totals; v2's CLI starts separate tasks.
   Keep v1's single-task grouping (my default), or is separate tasks with a shared lineage the v2 intent?
5. **Babysitting mode and `/terminal`** (F-page-34, 35) were found nowhere in v2, and no ADR drops them. I kept them
   as missing.
6. **Rows I could not confirm in the code** and marked *partial* with "not verified": F-task-4, 15, 22; F-comp-34,
   46; F-wt-4, 7; F-ship-2, 7; F-chan-4, 10; F-conn-8, 9. Each needs a named test rather than a reading. Some may
   be built.
7. **The coder is changing the manifests right now** (git status shows `goal`, `stuff`, `runtime`, `machine`,
   `later` manifests modified). Statuses that depend on a command being in a manifest (F-goal-5, F-stuff-6, the
   `runtime.setMode/setAgent/forLater` rows) reflect the working tree on 2026-11-10, not the last commit.
8. **Fixed entries.** About 300 v1 Fixed entries are layout and spacing polish (button alignment, phone widths,
   one-line bars). Rather than give each one a row, F-look-1 (parity) and F-look-5 (layout) cover them, since
   `qa/parity.mjs` and `qa/layout.mjs` test exactly that. If the `v1-features` check needs one row per entry,
   they can be generated from the changelog's bold titles (`git show origin/main:CHANGELOG.md`).
