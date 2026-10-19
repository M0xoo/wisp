# Changelog

All notable changes to `wisp-agents` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Mention another task in a prompt.** Right-click a task (or open its ⋯ menu) and pick **Copy task ID**, then paste the ID into the launcher, a follow-up box or the Rerun dialog. It shows as a chip with the task's title, like pasting an issue link in Linear, and stays a chip in the sent prompt, where clicking it opens that task. Backspace removes the whole chip and Cmd+Z brings it back. Pasting several IDs at once makes a chip for each. The agent gets the title and ID, and two new read-only tools sit next to `ask_user`: `wisp_session` reads a task (its title, state, harness, folder and branch, every request made in it, and a turn's report as markdown) and `wisp_sessions` lists your other tasks (filter by `query`, `state`, `project`, `archived`). Cursor and Antigravity runs can't take injected tools, so for them wisp puts each mentioned task's latest report in the prompt instead. Prompts store a mention as `@[Title](wisp:<id>)`, so API and CLI callers can write one too. Task titles show `@Title`. The bridge routes (`GET /api/internal/sessions/:id`, `GET /api/internal/session/:id?of=<id>`) only take the per-run token.
- **Agents can answer questions about your wisp usage.** Every task now gets a read-only `wisp_stats` tool next to `ask_user`. Ask a task "which tools do my tasks use?" or "what did Codex cost me this week?" and the agent gets a table of tool calls by kind (shell, read, edit, search, web, subagents, other MCP tools, questions), by harness, by project and by day. It also gets turns, cost, tokens and success rate, taken from the same numbers as Settings → Usage. Agents can narrow it with `days` (1–365, default 30), `agent` (a harness id) and `project` (a name or id, or `current` for the task's own project). Before, an agent had no tool for this and would either say it had no access or dig through `~/.wisp/sessions` by hand. Kinds are wisp's categories, not each harness's own tool names. The bridge route (`GET /api/internal/stats/:id`) only takes the per-run token, like `ask_user`. Cursor and Antigravity runs can't take injected MCP tools, so they don't get it.

### Changed

- **Mark done and the PR row are where you look.** An opened task now has Mark done (or Reopen) in its top bar, next to Ship it, so you can close it out without scrolling to the composer. The PR row (checks, GitHub, Merge) moved from the top of the card to right above the composer, so after reading the result it's in view without scrolling back up.
- **Full auto is the default mode.** New launches, API and CLI calls without a mode, scheduled and CI triggers, and recipes run with no permission prompts; tasks in git repos still get their own worktree and a checkpoint before every turn. If your saved launcher mode was Edits (the old default), wisp switches it to Full auto once; a Plan pick, or anything you choose afterwards, sticks. Issue triggers still start in Plan. The mode button now shows just an icon for Full auto and spells out Plan and Edits.

## [0.16.0] - 2026-10-19

### Added

- **Switch harness or model in a follow-up.** The follow-up box has a harness button, a small logo next to the mode button. It opens the same harness · model · thinking picker as the launcher. Pick another model and the follow-up resumes the same conversation on it. Pick another harness, say Codex on a task Claude Code started, and Codex starts its own conversation in the same folder. wisp hands it the turns it hasn't seen: each request, the report it got back and the files that were edited. Long histories keep the newest turns, up to about 24k characters. Each harness keeps its own conversation, so switching back to Claude Code resumes its session and only tells it what happened while it was away. Each turn's badge shows the harness that ran it. A queued follow-up keeps its own pick, so the run already going is not affected. On a session that Auto routed, switching counts as a miss for Auto's pick. API: `POST /api/sessions/:id/reply {"text","agent","model","effort"}`; CLI: `wisp reply <id> "…" --agent codex --model …`; MCP: `wisp_reply` takes `agent`, `model` and `effort`.
- **No harness yet? Install opencode in one click.** When wisp finds no coding-agent CLI on this computer, the launcher shows one line, *No coding agent here yet*, with an **Install opencode** button. opencode's free models need no account, so a new user can go from `npx wisp-agents` to a running task in a few seconds. wisp installs it with npm into its own folder (`~/.wisp/tools`), so it needs no sudo and leaves your shell profile alone, and finds it there. Pressing Enter with no harness shakes that line and keeps your prompt; before, the launch failed with *Auto found no installed harness*. Settings → Agents has the same **Install** button on the opencode row. API: `POST /api/agents/install {"id":"opencode"}`.
- wisp also finds opencode in `~/.opencode/bin`, where its official install script puts it, when that folder isn't on PATH (common for the desktop app).

- **wisp Cloud preview page** (`cloud.html`, linked from the site's nav and footer, and from a "Let it run while you sleep" section on the home page, between *Also in the box* and the install steps). It introduces a hosted wisp: managed remote machines, persistent queues that keep running while your laptop sleeps, and team dashboards. The local CLI stays free. You can try each part on the page: close the laptop and watch the cloud runs keep going, add machines, drag through one night of the queue, and filter a team dashboard by person. Signups for the waitlist go to PostHog.
- **One-line install: `curl -fsSL https://mokh.xyz/install.sh | bash`.** The script (`docs/install.sh`, served by the site) checks for macOS or Linux, Node.js 20+ and npm, runs `npm install -g wisp-agents` (set `WISP_VERSION` to pin a release), and confirms that `wisp` is on your PATH. It prints a PATH fix when the npm bin folder isn't in it, and a link to npm's permissions guide when the global install is refused. The site and the README show it next to `npx wisp-agents`.
- **Homebrew:** `brew install m0xoo/tap/wisp-agents`, from the new [M0xoo/homebrew-tap](https://github.com/M0xoo/homebrew-tap) repo (formula source in `packaging/homebrew/wisp-agents.rb`). It installs the CLI and browser mode; the formula removes the optional Electron package, which would otherwise download its ~300 MB binary into the Homebrew keg on first run.
- **Install tabs on the site.** The hero command and step 2 of the install section both have tabs (npx, npm, curl, brew), like opencode's install block. Picking a tab in one switches the other, the copy button copies the command shown, and the note under it changes with the tab. Arrow keys, Home and End move between tabs. Type a task into the hero launcher and every tab hands back a command that installs wisp and starts that task (`brew install m0xoo/tap/wisp-agents && wisp "…"`). A command too long for the bar stays on one line and ends in …, and a long typed task no longer makes the page scroll sideways on phones.

### Changed

- **The website moved to [mokh.xyz](https://mokh.xyz/).** Canonical, Open Graph and structured-data URLs, `sitemap.xml`, `robots.txt`, `llms.txt` and the npm `homepage` now use the new domain. The old `m0xoo.github.io/wisp/` address redirects there.
- **New website.** The site opens on a working copy of the launcher: it types three tasks and sends them off, and their rows move from Working to Asking (answer it right there) to Done. Type your own task and press ↵ to get the `npx wisp-agents "…"` command that runs it for real. Further down it shows the real app instead of animated mock-ups. A scroll-driven "morning with wisp" walks through five real screens with a ticking clock: three tasks launched, a mid-run question with its desktop notification, a report, Ship it, and the merged PR. A Transcript / wisp report switch shows the same run both ways. Also new: a Compare section, a take-over table with each harness's resume command, and a terminal that replays real `wisp` CLI output. Screenshots follow your light or dark theme, and on phones the story becomes a simple timeline.

### Fixed

- **Claude in Chrome now works in Claude Code tasks.** Claude Code only turns the Chrome extension on by itself in interactive sessions; wisp runs it with `-p`, so its `mcp__claude-in-chrome__*` tools were missing. wisp now passes `--chrome` when you have Claude in Chrome enabled by default (`/chrome` in Claude Code, `claudeInChromeDefaultEnabled` in `~/.claude.json`). Set `WISP_CLAUDE_CHROME=1` or `0` to force it on or off.
- An opencode task on a rate-limited model (often a free one) no longer sits at "Starting up" forever. opencode retries without printing anything, so wisp now reads its error log. If the rate limit hasn't cleared after 60s, wisp stops the task and says what to do: try again later, pick another model, or run `opencode auth login`.
- wisp no longer crashes when the `claude` CLI quits before reading its prompt (a bad flag, an auth error, a crash on start). The task now ends with Claude's error message. Before, the unread prompt raised an unhandled `EPIPE` that took the whole server down.
- `config.json` (projects, recipes, triggers, machines, settings) is now written atomically. Before, a crash or power loss mid-write could leave a cut-off file, which loaded as the defaults and was then saved over. Auto's learned state and the learned preferences are written the same way.
- Idle API connections stay open longer than clients keep them, so a request sent on a connection the server was just closing no longer fails with `ECONNRESET`.
- Refused requests (bad input, not found) no longer print a stack trace in the terminal running wisp.
- **Run** / **Re-run** on a terminal, tests or actions block now shows the new output. Before, the command ran but the block kept its old output and an error toast said it failed.
- **Escape** closes the menu or popover that is open, wherever focus is, and nothing else. Before, it could collapse the card behind a context menu and leave the menu open.
- Settings switches, project edits, and deleting a recipe, trigger or subagent preset now show the server's error when it refuses the change, and leave things as they were. Before, nothing happened on screen; deleting a preset even said "Deleted".
- Expanding cards no longer leaves a hidden file picker behind each time, and the launcher no longer adds another listener on every redraw.
- `openapi.json` now documents subagent presets (`/teams`) and `GET /uploads/{id}`.

### Internal

- The server is split by area: `server/index.js` only wires things together. Routes live in `server/routes/` behind a small route table (`server/http/`), and shared logic lives in `server/services/` (launch, Ship it, Auto, uploads, phone, feedback). Helpers that were copied across files now come from `server/util.js`, and git always runs through one helper that honours `WISP_GIT_BIN`. Adapters are checked against their contract at startup, and `claude.js` uses the same spawn plumbing as the other harnesses. `test/routes.test.js` keeps the route table and `openapi.json` in sync. The HTTP API, CLI, SDK exports and the `~/.wisp` files are unchanged.
- The web UI's 5,300-line `app.js` is now about 40 modules under `web/js/` (`core/`, `ui/`, `features/`), and `app.css` is 15 stylesheets that, concatenated in link order, are byte-for-byte the old file. A small event bus replaces the hooks that live updates used to reach open dialogs through, and one popover helper replaces about ten copies of open, outside-click and close code. No build step was added.

## [0.15.0] - 2026-10-18

### Changed

- **Calmer turn bar.** The bar under each turn now fits on one line: the read / edited / ran / searched counts open the activity log themselves (no separate **Activity** link), and **Restore to before this turn** and **Agent notes** are icon buttons next to 👍 / 👎 that stay faint until you hover the turn. After a restore, **Re-apply** shows as text so the rolled-back state stays visible.

### Fixed

- Rating a turn with 👍 / 👎 no longer re-renders the whole card and replays its entrance animation. Every refetch re-inserted the turn nodes, which restarts their CSS animations; unchanged turns are now left in place.

## [0.14.0] - 2026-10-18

### Added

- **Auto: wisp picks the harness and model for you, and it's now the default.** Choose **Auto** in the harness picker (existing setups are switched to it once) and set a goal in the model slot: **Balanced**, **Cheap** or **Best**. For each task, Auto estimates how likely each harness · model you have installed is to do that kind of task (bug, UI, docs, tests…) well. It starts from a wisp-bench pilot that ships with wisp, then learns from your own outcomes: merged or closed PRs, 👍 / 👎, rollbacks, follow-ups and how the run ended. It weighs that against cost and time, and now and then tries an alternative so the estimates stay honest. Hover a card's harness logo to see why Auto picked it. **Settings → Auto** sets the goal, whether new models get tried, and which harnesses Auto may use; **Open** shows what it learned. A harness or model that shows up later (a new CLI, a new version) gets a few tasks that aren't marked important before Auto relies on it, and a new version starts from its family's record. Auto works for compare runs (a different pick each), for subagents (a team member set to Auto is picked on its first task), on machines (picked here from what the machine has, and that machine's outcomes feed the same router), and from the CLI, recipes, triggers and Telegram. Everything it learns stays in `~/.wisp/router.json`. API: `agent: "auto"` on launch, `GET`/`PATCH /api/router`, `POST /api/router/reset`.

### Fixed

- **Claude Code tasks that say "I'll report once it has finished" now do.** When Claude ends its turn with background work still running (a test run, a build, a background subagent), the task stays in **Working** and shows **Waiting on background task: …**. When the work finishes, Claude's follow-up report becomes the task's answer. Before, wisp stopped Claude 3 seconds after its first reply, which also killed the background work, and the task ended on that "I'll report…" line. **Stop** and follow-ups still work while it waits, and it waits at most an hour. A reply that is already a full answer, for example one that leaves a dev server running, still ends the task right away. All harnesses are now also told to wait for their background work before finishing.

- **Follow-ups no longer end on "The agent finished without a message."** When a Claude Code run left background commands behind, the next follow-up ended right away with an empty answer, and the agent was cut off before it started on your message, so you had to send it again. wisp now waits for the answer to your follow-up.

## [0.13.0] - 2026-10-18

### Added

- **Start tasks from Telegram.** In **Phone → Telegram**, switch on **Start tasks from Telegram**, then send your bot `/new fix the flaky login test`. The task runs in your default project (the last used, or the one you pick in that section) with the launcher's harness, model and mode. `/new @api add rate limiting` picks a project by name, and `/projects` lists them. The bot replies **▶ Started**, and replying to that message sends a follow-up. Its card shows **Telegram** as where it came from. It's off by default, only the linked chat can start tasks, and a `/new` sent while wisp was offline is not run later. API: `PUT /api/remote` with `telegram.allowStart` and `telegram.project`.

- **Feedback for the wisp team.** Each finished turn has a small 👍 / 👎 at the end of its trail. It stays faint until you hover the turn. Click again to take the rating back. 👎 opens one optional line for what went wrong (↵ sends, Esc skips). You can also type `/feedback <note>` in the launcher or any follow-up box, or use `⌘K` → **Send feedback…** for a short dialog. Bare `/feedback` opens the dialog too. It thanks you right away; offline, the feedback is kept and sent later. It goes to PostHog with the harness, model and status of the run, never your prompt, output or code. It's sent even with usage stats off, and `WISP_FEEDBACK=0` turns it off. API: `POST /api/feedback`.

### Changed

- **Switch modes in a follow-up.** Each task's follow-up box now has the same mode button as the launcher (Plan, Edits, Full auto; Shift+Tab cycles). Start in Plan, read the plan, then pick **Edits** and say "go ahead": that follow-up and the ones after it run in the new mode. Any mode can switch to any other. The pick only takes effect when you send, and the follow-up shows the new mode next to its model. A follow-up queued while the agent works keeps its own mode, so the run already going isn't affected. A task started in Plan has no worktree, so edits after switching land in the project folder. API: `mode` on `POST /api/sessions/{id}/reply`; CLI: `wisp reply <id> "…" --mode edits`; MCP: `mode` on `wisp_reply`.

- **Compare more than two harnesses.** Clicking **vs** in the launcher adds a second harness as before, and a **+** at the end of the pill now adds a third and a fourth (four side by side, the server's limit). Each one sits behind its own **vs**: hover it for **×** to drop just that harness. A new one starts on a harness that isn't in the pill yet. With three or four, the pill shows logos only (hover a logo for harness, model and thinking level), and the mode and Subagents labels fold to icons so the bar stays on one line.

### Fixed

- Changing a Telegram setting through the API without a `token` no longer clears the bot token and unlinks the chat. After a settings change, Telegram no longer re-delivers messages wisp already handled.

- Following up on a task now keeps it on screen as it moves to **Working**, and again when it lands back in **Needs you**. On a long card, the previous answer folding away used to pull the whole card off the top of the screen, so you lost the task you had just replied to. The composer now holds still and the new exchange appears where you were typing.

## [0.12.0] - 2026-10-18

### Added

- **Settings → Agents → Re-check** looks for harnesses and models again, on this computer and on every online machine. Install a CLI, sign in or add a provider (say a new opencode provider), come back to wisp and click it: the list, the model counts and the launcher's harness picker update without restarting wisp, and a toast says what changed ("opencode +12 models", "Codex found"). Each harness now shows how many models it has, and one that isn't installed says to install its CLI and sign in. Before, wisp kept the first detection until it restarted. API: `POST /api/agents/recheck`, or `GET /api/agents?fresh=1` for this computer only.

### Changed

- The calm feed (nothing needs you) looks tidier. **Nothing needs you** gets a green dot and lines up with the **Done** and **Archived** headings, and folded groups now sit close together instead of a full section gap apart. Folded headings highlight on hover so they read as buttons.

### Fixed

- In **Settings → Machines**, the add/edit machine form lays out properly again: labels sit left above their fields, and the **SSH host** and **Name** inputs are full height instead of squashed and centred. The Settings row style was leaking into it.

## [0.11.0] - 2026-10-18

### Added

- Machines shows **Update to X** next to the version when a connected machine runs an older wisp than this computer. One click restarts wisp there as this version (you're asked first if agents are working on it). Before, reconnecting kept the old wisp running, and you had to find **Restart wisp there** in the ⋯ menu. Machines with a custom start command don't show it, because that command decides the version. Machines carry it as `outdated: "<version>"`.

### Changed

- The app responds right away instead of waiting for the server. A new task clears the prompt box and shows up in **Working** as a "Starting up" card while wisp makes its worktree. A follow-up or an answer clears the composer and moves the card to **Working** with your message as the live turn. **Mark done**, **Reopen**, **Archive**, **Delete**, **Stop**, **Rerun**, recipe runs and **Keep this** in Compare also act immediately. If the server refuses, the change is undone, your text and attachments come back, and an error toast says why.
- The web app uses the same icon as the site and the desktop app (the glowing orb on a dark tile) for its browser tab, home-screen shortcut and notifications.
- The launcher's **Run on** button sits right after the attach button, so the bar reads attachments, where it runs, then mode, harness, subagents and worktree.

### Fixed

- The launcher's harness picker now lists the harnesses installed on the places picked under **Run on**, not the ones on this computer. Any picked place that has a harness makes it pickable (a union), with its models taken from a place that has it; a harness missing on some of them says **Not on <machine>**, and launching names the place it's missing on. Before, running only on a machine still offered Claude when only this computer had it, and hid a harness only the machine had. Changing the places (or a machine coming online) moves the pick to an installed harness if the current one isn't there. Machines now report each harness's models, thinking levels and whether it can lead subagents.

## [0.10.0] - 2026-10-18

### Added

- Machines finds hosts for you. **Found on this computer** lists the hosts this computer already reaches: `Host` entries in `~/.ssh/config`, your Tailscale peers (`tailscale status --json`, with an online dot; phones and tablets are skipped) and hosts in `~/.ssh/known_hosts` (code hosts such as github.com, hashed entries and non-default ports are skipped). Hosts you've already added aren't listed. Click one to fill in the form, then press Connect. The SSH host field suggests the same hosts. API: `GET /api/machines/discover`.

### Changed

- Ship it only shows when there is something to ship. It used to sit on every finished worktree task, even one that changed nothing or whose work was already on its PR. Now it appears (on the card bar, next to the composer, in the right-click menu, in ⌘K and on `S`) only if the worktree has uncommitted changes or commits its PR doesn't have yet. **Push to PR #N** shows only when there are new changes to push. wisp checks the worktree when a turn ends, after Ship it, a revert, a rollback or an action command, and at startup. Summaries carry it as `toShip: { dirty, ahead, unpushed }`.

### Fixed

- Updating from the top-bar Update button now restarts wisp on the port it was running on. Before, a wisp started with `--port` came back on 4477 and the open tab said "wisp did not come back".

## [0.9.0] - 2026-10-18

### Added

- Machines: run agents on your other computers (a dev box, a GPU server, a cloud VM) over SSH. **Machines** in the top bar (also Settings → *Machines*, ⌘K) takes an SSH host (suggested from `~/.ssh/config`) and connects: wisp signs in with your keys, finds Node.js there, starts `npx -y wisp-agents@<this version>` detached (or reuses the wisp already running), and opens an `ssh -L` tunnel back. Each step shows live, and a failure says what to run (`ssh-copy-id`, install Node, restart an older wisp). Then pick projects on the machine (its git repos are listed, folders autocomplete). The launcher's **Run on** button (next to the harness) picks where a prompt goes: this computer, a machine, or several at once. Each place gets its own row of project chips, and one Enter launches on all of them in parallel, as one task card with a row per machine (its own project, badge and status) and a single "ready on 3 machines" toast. A machine picked while disconnected connects. Each run executes the agent on its machine, with worktrees, diffs, rollback, `ask_user`, subagents, compare and Ship it working as usual. Its sessions join your feed with a machine badge, answer questions from your phone like any other, open in VS Code / Cursor / Windsurf over Remote - SSH, and **Take over** opens `ssh -t` in your terminal. Nothing new listens on the network: wisp over there stays on its own loopback, keeps running (agents too) when this computer sleeps, and wisp reconnects when it wakes. API: `/api/machines`, `machine` and `groupId` (to group runs launched in several places) on `POST /sessions`, `machine` on `/projects`; remote sessions are `<id>@<machine>` everywhere (CLI, SDK, MCP).
- Grok Build harness (`grok`, `--agent grok`). wisp runs `grok --output-format streaming-messages-json` headless. It lists the models from `grok models` with each model's thinking levels (Low to X-High), maps Plan / Edits / Full auto to grok's permission modes, and resumes follow-ups with `--resume`. Grok can lead a team of subagents, and it asks you questions through wisp's `ask_user`. The tool reaches grok through a throwaway `--agent` definition that keeps grok's stock prompt. Diffs come from `search_replace` and `write`. Cost shows in Usage when grok reports it.

### Changed

- The launcher's Recipes row no longer has a Manage link. Recipes are still one click away from the Automations button in the top bar.
- Every text field, textarea, select and checkbox now shares one look from a small form kit in `web/css/app.css` (`.input`, `.textarea`, `.field`, `.check`, plus `.mono` / `.sm` / `.lg`): the same border, radius, height, placeholder colour, hover and focus ring across Settings, Phone, Automations, Ship it, Run recipe, Projects, the model picker search, the Subagents editor and question cards. Checkboxes use the accent colour.

### Fixed

- A lead with subagents now uses them instead of its harness's built-in subagents. Claude Code leads run with `Task`, `Agent` and `Workflow` disallowed, opencode leads with `permission.task: "deny"`, and every lead is told to use `delegate` in place of its own subagent tool. Without a team, nothing changes.
- The selects in the recipe and trigger forms and in the Ship it / Run dialogs had lost their dropdown chevron.
- Settings and Phone text fields, and every select, showed no focus state.

## [0.8.0] - 2026-10-17

### Added

- Subagents: give the lead agent a team on other harnesses, e.g. a Claude Code run that hands tests to Codex and research to opencode. The launcher's **Subagents** button opens an editor: up to 6 members, each with its own harness, model and thinking level, a name, a **Use for** note ("image and UI work", "research") that tells the lead when to pick it, and a **×N** copies stepper: `Codex ×3` gives the lead three identical Codex agents (`codex#1`…`codex#3`, 12 agents in all). Several tasks sent to `codex` in one call go to free copies and run side by side; naming a copy continues its conversation. **Save as preset** stores the team; **Presets** loads or deletes one. The lead gets a `delegate` tool on wisp's injected MCP server (Claude Code, Codex, opencode; Cursor and Antigravity can be subagents but not leads). Tasks in one call run in parallel in the lead's folder, and delegating to the same member again resumes its conversation. Feed cards show the lead's logo with its subagents' logos stacked behind it (they fan out on hover and pulse while working). A running card lists each subagent's live status, and a finished turn shows one report card per delegated task that opens into that subagent's own presentation. Subagent edits count as the lead's, so they appear in its files, diffs, rollback and Ship it. API: `subagents` / `preset` on `POST /sessions`, `/teams` for presets, `PATCH /sessions/:id { subagents }`; `wisp_launch` takes them too.
- Actionable presentation blocks: a new `actions` block (`items: [{label, command, detail, confirm} | {label, reply}]`) renders 1-click command buttons that run in the session's project folder (`POST /api/sessions/:id/exec`), show live exit code, duration and output inline, and offer a **Send failure to agent** follow-up button when a command fails. `terminal` and `tests` blocks with a `command` now have a **Run / Re-run** button, and `diff` and `files` blocks have a per-file **Revert / Re-apply** button (`POST /api/sessions/:id/revert`).
- Session checkpoints & one-click rollback: before each turn starts, wisp snapshots the git working tree (`git stash create || git rev-parse --verify HEAD`, pinned at `refs/wisp/checkpoints/<session>/<turn>`) along with pre-turn untracked files and per-file before snapshots. Each turn's trail bar, session menu, and command palette include **Restore to before this turn** (and **Re-apply turn** / Undo) via `POST /api/sessions/:id/rollback`.
- Worktree per task: in a git repo, each launch runs in its own git worktree on a `wisp/<task>-<id>` branch made from `origin/main` (freshly fetched), under `~/.wisp/worktrees/`. Parallel agents never edit the same checkout, and the agent is told where it is. On by default; toggle **Worktree / In place** in the launcher, Settings → *Worktree per task*, `--no-worktree` on the CLI or `worktree: false` in the API. Plan mode and folders that aren't repos run in place. Archiving removes a clean worktree (the branch stays, a follow-up brings it back); deleting the session removes it, and its branch unless it has commits.
- Ship it (`S`, the card's **Ship it** button, or `wisp ship <id>`): commits the worktree with a conventional message drafted from the presentation, pushes the branch and opens a PR with `gh pr create` (optionally as a draft). The card then shows the PR: CI checks, review state and merges, polled every minute; it comes back to *Needs you* when checks finish, a review lands, or it merges. **Merge** (`wisp merge <id>`) marks a draft ready, squash-merges with `--match-head-commit`, fast-forwards your local base branch and removes the worktree.
- Compare: the **vs** button in the launcher (or `--compare codex,opencode:model` on the CLI, `compare: [...]` in the API) runs the same task on a second harness, each in its own worktree. **Compare** opens the runs side by side: time, cost, files and lines changed, tests, questions, and each presentation. **Keep this** archives the others and deletes their worktrees.
- Recipes: saved prompts where `{name}` becomes a field to fill in, e.g. `Prepare release {version}…`. Create them from ⌘K → *Recipes* or *Save as recipe…* on any card; run them from ⌘K → *Run: …*, or `wisp run release 0.8.0` / `wisp recipes`. A recipe can pin a project, harness, model and mode.
- Triggers start sessions without you, while wisp is open: a cron **schedule** (local time), **CI failed** (a GitHub Actions run fails; polled with `gh run list`), or **issue labelled** (polled with `gh issue list`). Each runs a prompt or a recipe, with the run's or issue's details filled in. The first check only records what already exists. Issue triggers default to Plan mode, since issue text is untrusted. ⌘K → *Triggers*.
- Usage view (⌘K → *Usage*, Settings → *Usage*): spend per day, and spend, turns, success rate, questions and average time by project and by harness · model, over 7, 30 or 90 days. Harnesses that don't report cost are counted but not priced. `wisp usage`, `GET /api/usage`.
- Phone (Settings → *Phone*): questions and finished tasks go to [ntfy](https://ntfy.sh) and/or a Telegram bot. Tap an option to answer; on Telegram, reply to a message to answer in your own words or follow up, and tap *Mark done*. wisp polls both, so nothing has to reach your machine. ntfy answers are HMAC-signed; Telegram is linked to one chat with a one-time code.
- API: `POST /sessions` takes `worktree` and `compare`; new `/sessions/:id/ship`, `/pr`, `/merge`, `/recipes`, `/triggers`, `/remote`, `/usage` (all in `GET /api/openapi.json`). SDK: `ship`, `merge`, `recipes`, `saveRecipe`, `runRecipe`, `triggers`, `usage`. Summaries carry `branch`, `pr`, `groupId` and `origin`.
- A `graph` presentation block for explaining merges and conflicts: a PR card with the branches as coloured lanes (newest commit first), the merge target on top (conflicts / ready / merged), branch tags on each tip, and the base commits that conflict highlighted and numbered. Under it: each conflict with file, `ours` vs `theirs` and how it was resolved (hover one to light up the commit it came from), checks as chips, and an optional action button (e.g. **Resolve conflicts**) that replies to the agent. Plain-markdown rendering for the CLI, MCP and chat apps too.
- Back to top from the keyboard: `U` (or `Home`) scrolls the feed to the top. The back-to-top button that appears once you scroll shows the `U` key next to its arrow, and the shortcut is listed under `?`.

### Changed

- The bar under an open task's title only says how the run was set up: the mode when it's Plan or Full auto, the branch, and what launched it. Agent, model and path, which the card header already shows, moved into its tooltip. Compare stays in the task header and Done next to the composer; Take over is an icon. **Ship it** now also sits next to *Mark done* under the composer, so you can ship right after reading the result.
- Memory, Automations, Usage and Phone open inside Settings when you reach them from there: they take the main area next to the sidebar, with a **Back** button (or Esc) that returns to the section you came from. Only the X closes Settings. From the top bar or ⌘K they still open on their own.
- Settings is a sidebar and a pane instead of one long list: **General** (editor, terminal, worktree per task), **Notifications** (desktop, phone), **Agents** (each harness with version or error; a red dot in the sidebar when one is missing), **Memory**, **Automations** (recipes and triggers, each with **Manage**), **Usage** (last 7 days at a glance) and **Privacy**. It reopens on the last section; ↑/↓ move between sections. Phones get the sections as a scrolling tab strip.
- Recipes and triggers are out in the open instead of only behind Settings and ⌘K: an **Automations** button in the top bar (badge = triggers on, tooltip = what fires next), and a **Recipes** row under the launcher with one-click chips for the picked project's recipes (and those tied to none), **Save as recipe** for whatever is in the box, and **Manage**. Each recipe in Automations has a **Schedule** button that starts a schedule trigger running it.
- The launcher stays reachable while you scroll: once it passes under the top bar it docks there as a one-line bar (project chip + draft). Click it, or press `⌘L` / `N`, and the full launcher opens in place over the feed, without scrolling you back to the top. `Esc` or clicking away folds it again. Cards selected with `J` / `K` or opened scroll into view below it.
- The launcher's **vs** (compare) control is part of the harness pill instead of a separate button. Turned on, the second harness joins the same pill (`Claude Code ⌄ vs opencode ⌄`); hover **vs** for × to stop comparing. The bar no longer wraps onto a second line: on narrow widths model names, then labels, fold away and the logos stay.
- A compare launch is one task in the feed instead of a card per harness: the prompt on top, a row per run (harness, model, live status; each expands in place), and **Compare** for the side-by-side view. The task sits in *Needs you* while any run asks, *Working* while any runs, and *Done* once all are; ✓ marks every finished run done. Compare runs keep the prompt as their title. **Keep this** turns the kept run back into an ordinary card. See [docs/feed.md](docs/feed.md#compare-tasks).

### Fixed

- Clicking a recipe no longer runs it straight away when it has no fields to fill in. Its dialog now always stays open until you press **Run** (the button has focus, so Enter works too).
- `flow` blocks that don't fit across the card wrap onto rows that alternate direction (left to right, then right to left), joined by a short line, instead of squeezing every step into a narrow column. Loop-back lines go around the cards instead of crossing them. Phone width still stacks the steps.
- The launcher no longer flashes its focus ring when you open the harness pickers or switch between them (e.g. opencode, then Claude Code in a compare). The ring stays on while a picker or the mode menu is open; the rerun dialog behaves the same way.
- Launching a compare no longer freezes wisp for a few seconds. The runs share one `git fetch` and their worktrees are checked out in parallel. A fresh worktree's first checkpoint is its base commit, so it no longer runs blocking `git` calls that stalled the server and the live feed. With fake harnesses, a 2-way launch went from 1.5 s to 0.7 s and a 3-way launch from 2.3 s to 0.9 s. The send button shows a spinner while the launch sets up. If one worktree fails, the ones already created are removed.
- Scrolling in the feed stays put. When a card changes section in the background (a task finishes, asks or is removed), the card you're reading no longer jumps; one whose edge just peeks onto the screen no longer drags the view with it. Mark done, Archive and Delete put the next card where the old one was and focus it, so E / A / j triage continues from the same spot. j / k show the header of tall cards, switching project filters returns to the top of the feed, and a task launched from the box scrolls into view when its card lands off-screen. The rules are written down in [docs/feed.md](docs/feed.md).

## [0.7.0] - 2026-10-17

### Added

- Update button next to Search when a newer `wisp-agents` is on npm (checked at start, then once a day while wisp stays open — survives sleep, and the UI re-asks on focus). One click runs `npm install -g wisp-agents@latest` (or relaunches through `npx …@latest`) and restarts wisp; it asks first if agents are running. Git checkouts just get the `git pull` hint. Opt out with `WISP_UPDATE_CHECK=0`.
- Rerun a task: right-click a card → **Rerun…** (or `⇧R`, or ⌘K → Rerun). A dialog opens with the original prompt (editable), attachments and mode, plus the harness / model / thinking-level picker. You can pick a different setup without changing the launcher's defaults. Rerunning starts a new session in the same folder and keeps the original.
- Learning from sessions: after a session goes quiet (90 s, or right away when marked done or archived), a background retro (same harness, read-only, no tools; Haiku on Claude Code) records your preferences and the agent's lessons (a mistake and the way that worked), globally and per project. Later turns get them in their system prompt. Stored in `~/.wisp/preferences.json`; API `GET/PUT /api/preferences`. See [Learning](README.md#learning).
- Memory view (Settings → *Memory* → Open, or ⌘K → Memory): a tab per scope with preferences and lessons, the session that taught each item, a token estimate, and inline edit / add / forget. The *Retros* tab is a timeline of every retro run (last 30), including *nothing new* and failures with the reason, plus a live entry while one runs. Switching Memory off stops both learning and applying.

### Fixed

- The card you were reading stays in view after collapsing a section, and the open card is followed when it moves to another section.

## [0.6.0] - 2026-10-17

### Added

- Antigravity CLI adapter (`agy --input-format stream-json --output-format stream-json`). Plan → `--mode plan`, Edits → `--mode accept-edits`, Full auto → `--dangerously-skip-permissions`; models from `agy models`, `--effort low|medium|high`, follow-ups via `--conversation`. Like Cursor it has no flag to inject MCP servers, so Antigravity agents ask with a `question` block. Override the binary with `WISP_ANTIGRAVITY_BIN`.
- Integrations: wisp can now be driven by other agents, editors and scripts. Reference: [docs/integrations.md](docs/integrations.md).
- `wisp mcp`: a stdio MCP server with `wisp_launch`, `wisp_wait`, `wisp_get`, `wisp_reply`, `wisp_list`, `wisp_stop` and `wisp_agents`, so Claude Code, Codex, opencode, Cursor or Claude Desktop can hand tasks to wisp and read the results.
- Agent skill (`skills/wisp/SKILL.md`), installed with `wisp skill install [--agent claude|codex|opencode|all] [--project]`.
- Scripting CLI: `wisp ls`, `show`, `wait`, `reply`, `stop`, plus `--json`, `--wait`, `--cwd`, `--model` and `--effort` on launches. Use `wisp -- …` for a task whose first word is a command name.
- JS SDK: `import { WispClient } from 'wisp-agents'`. It connects to the running wisp (or starts a headless one) and covers launch, wait, reply, presentation, uploads and the event stream. `wisp-agents/render`, `/protocol` and `/server` are exported too.
- HTTP API: `GET /api/health`, `GET /api/openapi.json` (OpenAPI 3.1), `GET /api/sessions/:id/wait` (long-poll until it finishes or asks), `GET /api/sessions/:id/presentation` (blocks + markdown, `?format=markdown`), and `state`/`agent`/`project`/`cwd`/`archived`/`limit` filters on `GET /api/sessions`.
- `~/.wisp/server.json` advertises the running server's URL, port and pid.
- Webhooks (`PATCH /api/config {"webhooks": [...]}`): POST `session.finished` / `session.waiting` with the presentation as markdown.

### Fixed

- Clicking a harness in the harness · model picker (or Enter on it) switches to it with the model and thinking level shown, instead of only previewing its models.
- Antigravity models are listed with newer `agy` builds that print tab-separated `agy models` output.
- A harness CLI installed while wisp is running is detected without restarting wisp.

## [0.5.0] - 2026-10-17

### Added

- Anonymous usage stats and error reports via [PostHog](https://posthog.com): which agents, models and modes are used, run outcomes and timings, and errors (agent failures, server errors, crashes) with paths scrubbed. Never sends prompts, output, paths or project names. Turn it off in Settings → *Anonymous usage stats*, or with `WISP_TELEMETRY=0` / `DO_NOT_TRACK=1`; always off when `CI` is set. See the Telemetry section of the README.

## [0.4.0] - 2026-10-17

### Added

- Thinking level in the harness · model picker: Default / Low / Medium / High / X-High / Max under the model list, remembered per harness and shown on the launcher button. Claude Code gets `--effort`, Codex `-c model_reasoning_effort=…`, opencode `--variant` (levels read per model from `opencode models --verbose`). Cursor bakes effort into its model ids, so it has no separate selector.
- Take over in [cmux](https://cmux.dev): opens a new cmux workspace in the project running the resume command. Auto-detected when wisp is started from a cmux terminal.

## [0.3.0] - 2026-10-17

### Added

- Codex (`codex exec --json`), opencode (`opencode run --format json`) and Cursor CLI (`cursor-agent -p`) adapters, next to Claude Code. Pick the harness and model together in the launcher, or pass `--agent` on the CLI.
- One harness · model picker in the launcher: harnesses (with logos) on the left, that harness's models on the right, searchable and grouped by provider for opencode. The model is remembered per harness. opencode and Cursor model lists are read from the CLIs themselves.
- `ask_user` works in Codex and opencode (injected MCP server). Cursor has no flag to inject one, so Cursor agents ask with a `question` block instead.
- Diffs for harnesses that only report "file changed" are taken against the file as it was when the turn started (`git stash create`), or the agent's own before/after content when available.
- Windows: harness CLIs installed through npm (`.cmd` shims) and PowerShell-only installs now start. npm shims run as `node <script>`, so arguments reach the CLI unchanged. Stopping a run ends the whole process tree (`taskkill /T`).
- Take over on Windows (Windows Terminal, PowerShell, Command Prompt) and on more Linux terminals (GNOME Terminal, Konsole, Xfce Terminal, Alacritty, xterm). The settings list only shows terminals for your OS.
- Test suite (`npm test`) and CI on Linux, macOS, and Windows, plus `npm run test:real` to smoke-test the real CLIs.
- Images an agent shows are copied into `~/.wisp/shots/<session>/` when the turn finishes, so screenshots saved to `/tmp` survive reboots. Existing sessions are backfilled on startup if their files still exist. Deleting a session deletes its copies.
- Command palette (`⌘K` / `Ctrl+K`, or the Search button in the top bar): fuzzy search across sessions (title, project, summary, agent), project filters, global actions, and actions on the focused session.
- Archive tasks: right-click a task (or press `A`) to archive it. Archived tasks move to a collapsed *Archived* section and keep their state; a new question or turn brings them back.
- Right-click menus on tasks (open, rename, mark done, archive, delete), project chips (remove) and queued follow-ups (cancel).
- `⌘L` / `Ctrl+L` focuses the launcher from anywhere. `M` renames the focused item. Menus show key hints.
- Queued follow-ups are listed above the composer and can be cancelled from an × button, with confirmation.
- Task cards and requests show the harness logo, with a "harness · model" tooltip.

### Fixed

- Image blocks pointing outside the project (e.g. `/tmp/shot.png`) no longer render broken.
- Replying to a finished agent no longer gets queued behind a CLI that keeps running after its result. A run now ends on exit, 3s after its result, or when a follow-up arrives.
- Removing a project or deleting a session no longer fails silently (body-less `DELETE`s now send a JSON content type).
- The notifications setting is a real on/off switch.
- Finished cards fold up unless you are looking at them.
- Shortcut labels read `⌘L` on macOS and `Ctrl+L` elsewhere, and modifier shortcuts work on non-Latin keyboard layouts.

### Changed

- A follow-up sent while an agent is working now goes out right away: wisp interrupts the run and resumes the session with your message. To get the old behaviour back (wait until the run finishes), turn on the **Queue** toggle next to the send button. It shows while the agent is working, and wisp remembers the choice.
- The Plan / Edits / Full auto control is now one compact button with a menu. It shows a label only for a non-default mode; `Shift+Tab` in the prompt cycles modes.
- The top bar no longer shows harness status; Settings lists each harness with its version.
- Slimmer scrollbars that don't shift the layout.

## [0.2.2] - 2026-10-16

### Fixed

- Desktop app: sending a message no longer opens an extra wisp icon in the Dock. The `ask_user` helper now runs the Electron binary as plain Node (`ELECTRON_RUN_AS_NODE=1`) instead of starting a second app.

## [0.2.1] - 2026-10-16

### Added

- Desktop app: native right-click menu with spelling suggestions, Copy Link, undo/redo, cut/copy/paste and select all. Inspect Element appears only in dev mode.

### Fixed

- macOS: the Dock shows "wisp" with the wisp icon instead of "Electron". The app now launches from a renamed clone of `Electron.app`, cached per Electron version under `~/Library/Caches/wisp`.

## [0.2.0] - 2026-10-16

### Added

- `npx wisp-agents` opens the desktop app. Electron is now an optional dependency that is fetched on first launch. The CLI starts the app detached and falls back to the browser when Electron isn't available.
- `--browser` flag to keep the browser-only behaviour.

### Fixed

- Parsing of the `wisp` fence is more robust: malformed blocks are salvaged instead of dropped, and the raw turn text is kept.

## [0.1.0] - 2026-10-16

### Added

- First public release on npm as `wisp-agents`, with `wisp` and `wisp-agents` bins and a `--version` / `-v` flag.
- Launch Claude Code agents in the background and read the presentation they hand back: diffs, tests, commits, flows and questions.
- Session queue with follow-ups, answers to agent questions, terminal takeover and mark-as-done.
- Older turns are folded, with a floating collapse-all button and back-to-top.

[Unreleased]: https://github.com/M0xoo/wisp/compare/v0.16.0...HEAD
[0.16.0]: https://github.com/M0xoo/wisp/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/M0xoo/wisp/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/M0xoo/wisp/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/M0xoo/wisp/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/M0xoo/wisp/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/M0xoo/wisp/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/M0xoo/wisp/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/M0xoo/wisp/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/M0xoo/wisp/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/M0xoo/wisp/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/M0xoo/wisp/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/M0xoo/wisp/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/M0xoo/wisp/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/M0xoo/wisp/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/M0xoo/wisp/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/M0xoo/wisp/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/M0xoo/wisp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/M0xoo/wisp/releases/tag/v0.1.0
