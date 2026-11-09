# wisp positioning

The one source of facts for marketing copy. Every claim points to its source. Updated 2026-11-04.

## One-liner and category
wisp runs Claude Code, Codex, Cursor and four more harnesses in parallel, on any of your computers, and hands back a report instead of a transcript. People search for: *run Claude Code and Codex in parallel*, *coding agent manager*, *kanban for coding agents*.

## What it does (present wisp as a whole)
| Pillar | Proof |
|---|---|
| Crew | Long-lived members with schedules and memory (README, Crew) |
| Machines and Cloud | Tasks on other computers join one list; wisp Cloud boxes (README, Machines, wisp Cloud) |
| Compare | Same task on two harnesses, keep the winner (site `#compare`) |
| Delegate | A lead hands work to other harnesses (README, Delegate) |
| Spells | wisp changes itself at runtime (README, Spells) |
| The report | Diff, tests, next steps instead of a transcript (README, Why wisp?) |
| Agent board and panes | One board across every harness, account, machine and crew member; Allowance board; panes (`server/starters/`, README) |
| Ship it | Commit, push, PR, Merge from the task (README) |

## Audience and jobs
Engineers running several coding agents who juggle terminals, worktrees and long transcripts, often with a second account or another computer.

- **Push:** long transcripts, losing track of who is waiting, plans emptying with no explanation.
- **Pull:** one place for everything, reports, work that continues with the lid shut.
- **Habit:** tmux plus worktrees by hand.
- **Anxiety:** cost, trust in Full auto, setup.

## Rivals (checked 2026-11-04; stars from `gh api repos/<repo>`)
Compare only with projects of about 1k stars or more.

| Rival | Stars | Falls short | wisp falls short |
|---|---|---|---|
| Claude Code mods | 154.5k | A pane lives in a Claude Code session; Claude Code only | Mods reach the terminal, Desktop and VS Code; made from a prompt too |
| Codex | 133.2k | UI plugin runtime landed in 0.166.0, no user panes yet (report below) | Vendor's own app and reach |
| Cursor | closed | Canvases are agent-made, not user-pinned | Canvases are shareable by link from cloud agents |
| opencode | 224.6k | Plugin slots in the TUI only | Much larger audience |
| Vibe Kanban | 28.6k | bloop shut down (announced 2026-04-10), remote services removed, community-maintained | Crosses 10+ agents; built-in browser preview |
| Cline Kanban | 1.4k | Started in one repo with `npx kanban` | Dependency chains between cards; 7 agents |
| tmux plus worktrees | n/a | No shared view | Nothing to install |

Do not say *only wisp* about cross-harness boards: Vibe Kanban and Cline Kanban cross harnesses. Say that **no vendor's native pane** does, and that wisp's board reads wisp's task list, so it covers whatever wisp runs. Evidence: `~/.wisp/crew/1e0f1342e828/reports/2026-11-03-panes.md`.

## Proof (real numbers only)
- Stars: 9 on 2026-11-04 (`gh repo view WispAgents/wisp --json stargazerCount`). npm latest 0.57.0.
- 7 harnesses, 0 runtime dependencies, MIT (`package.json`, README badges).

## Claims the code limits
- Allowance board: accounts on the computer running that wisp (`GET /agents` is local; usage stays per machine). Claude Code and Codex report windows; the rest say they don't.
- Allowance board periods (#613): each window lists recent periods with Outside wisp, Used and what 1% cost (dollars on Claude Code, millions of tokens on Codex; ≈ when from running totals). Outside wisp can read low, never high. Periods before this version show a dash for Outside wisp and Used.
- The weekly reading (`shrinkOf`, 2 full weekly periods per side) is a diagnostic, not proof. Never state a result: the first reading is 2 Dec 2026. Say only that it stays silent until it has enough, and that it doesn't tell you a plan changed.
- Panes don't open in the Android app over its SSH tunnel; through wisp Cloud they do (`web/js/features/panes.js`).
- iPhone Home Screen is Grid-only, alerts by ntfy: never call it a native app.
- Review by another harness: promise *another company's model* only when picked by name.

## Words
Use: task, harness, crew, crew member, job, spell, report, pane, Machines (desktop), Computers (phone), *Ship it*, *Needs you*. Avoid: session, bots, plugin, *AI-powered*, *please upvote*. Full list: `design/copy.md`.

## Voice
A helpful colleague: plain, concrete, one punchy line per page.

## Headlines tried
| Date | Line | Where | Status |
|---|---|---|---|
| before Oct 2026 | Send coding agents off. Read what they did. | README line 7 | Turned down as too narrow; still live on README |
| before Oct 2026 | All your coding agents. One place, any machine. | site, og tags | Replaced by PR #310; still in og:title |
| live | Your new way to build. | site h1 | Live |
| 2026-11-04 | wisp grows with you | guide, README, launch notes | Working line (owner) |
| 2026-11-04 | Lead with *make a pane* | n/a | Turned down: Claude Code mods already do it, Codex and Cursor are close |

## Learnings
| Date | Tried | Evidence | Status |
|---|---|---|---|
| 2026-10-31 | X Ads campaign 42894424 | €28.63, 295 clicks, 1 Grid sign-up, 0 installs | Paused |
