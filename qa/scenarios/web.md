# Web (browser mode) scenarios

wisp served by `node bin/wisp.js --no-open` and used in Chrome. Every scenario runs against a QA
wisp: its own `WISP_HOME`, port and temp git repo, with wisp's fake agents on PATH
(`qa/lib.mjs` → `startWisp()`), so nothing of yours is touched and no account is needed.

**Run:** `node qa/web.mjs` (screenshots and `web.json` land in `qa/out/`).
Tags: **Automated** = `qa/web.mjs` checks it · **Suite** = covered by `npm test` · **Manual** = by hand.

Every page check also fails on an uncaught page error or a `console.error`.

---

### WEB-01 · Server boots and answers
- **Steps:** start wisp; `GET /api/health`, `GET /api/status`, `GET /api/config`, `GET /openapi.json`.
- **Expected:** all 200; health has `version` = `package.json`'s; status has `live`, `clients`.
- **Automated**

### WEB-02 · First paint: split view home
- **Preconditions:** window 1440×900, fresh home.
- **Steps:** open `/`.
- **Expected:** sidebar with *New task*, *Needs you* listing *Welcome to wisp*; the home shows
  *What should wisp do next?*, the launcher (prompt box, *This computer*, permission mode, harness)
  and *Tips*; *Machines* and *Automations* side by side under *New task*; the foot says *wisp Grid · Not
  connected · Sign in* (a click opens Machines' sign-in), then *Get the app* and *Settings* (icons). No console errors.
- **Automated**

### WEB-03 · Welcome tour renders every block
- **Steps:** open *Welcome to wisp*.
- **Expected:** the presentation renders (hero, diff, tests, stats, …) with no block falling back
  to raw JSON, and no console errors.
- **Automated**

### WEB-04 · Launch a task from the launcher
- **Preconditions:** a project added (`POST /api/projects`).
- **Steps:** pick the project in the launcher, type a prompt, press ↵.
- **Expected:** the prompt box clears at once; a card appears in the sidebar immediately
  (optimistic), runs (live status), then finishes with its presentation (hero, `1 file +1 −1`).
  The task's details column shows the harness, project and `wisp/…` branch.
- **Automated**

### WEB-05 · Live updates without reload
- **Steps:** with the page open, launch a task through the API (`POST /api/sessions`).
- **Expected:** its card appears and finishes in the open page with no reload (SSE).
- **Automated**

### WEB-06 · Follow up
- **Steps:** on a finished task, type a follow-up in its composer and send.
- **Expected:** the box clears at once, a second turn runs and renders below the first.
- **Automated**

### WEB-07 · Agent asks a question (`ask_user`)
- **Steps:** launch with a prompt containing `ASK`; answer in the card.
- **Expected:** the card goes to *Needs you* with the question and options; answering sends the
  answer to the running agent, which finishes.
- **Automated**

### WEB-08 · Approve in Edits mode
- **Steps:** launch with `APPROVE` in Edits mode.
- **Expected:** an approval card with *Allow / Always / Deny*; *Allow* lets the run finish.
- **Automated** (API answer, UI shows the approval)

### WEB-09 · Stop a running task
- **Steps:** launch a task that hangs (`FAKE_HANG`-style long run), press Stop.
- **Expected:** the run stops, the card says it was stopped, no agent process is left.
- **Suite** (`test/e2e.test.js`), **Automated** (API stop of a long run)

### WEB-10 · Mark done, archive, delete
- **Steps:** `E` on an open task; then archive; then delete through the API.
- **Expected:** it moves to *Done*, then out of the list into *Archived*; delete removes it and its
  worktree.
- **Automated**

### WEB-11 · Transcript and diff viewer
- **Steps:** on a finished task press `V` (Transcript); click `1 file +1 −1`.
- **Expected:** the timeline shows the agent's steps; the diff viewer shows `math.js` with the edit.
- **Automated**

### WEB-12 · Command palette
- **Steps:** `⌘K` / `Ctrl+K`, type part of a task title, ↵.
- **Expected:** the palette lists the task under sessions and opens it; `Esc` closes.
- **Automated**

### WEB-13 · Feed view ↔ split view
- **Steps:** press `\`; press `\` again.
- **Expected:** the one-column feed with the same cards, then split view again. The choice is kept
  after a reload.
- **Automated**

### WEB-14 · Keyboard: J / K / N / Esc
- **Steps:** with 2+ tasks, `J` and `K`; `N`; `Esc`.
- **Expected:** J/K open the next/previous task; N focuses the prompt; Esc goes back home.
- **Automated**

### WEB-15 · Settings: every pane opens
- **Steps:** open Settings, click each pane (General, Notifications, Agents, Auto, Machines,
  Cloud, Memory, Automations, Spells, Usage, Privacy).
- **Expected:** each shows its lede and content, no errors. Agents lists the fake harnesses.
- **Automated**

### WEB-16 · Theme: light and dark
- **Steps:** switch theme (Settings → General or the system preference).
- **Expected:** both themes render with readable text; screenshots of home and an open task.
- **Automated** (Chrome `prefers-color-scheme`)

### WEB-17 · Narrow windows fall back to the feed
- **Steps:** resize to 860×900 (under `SPLIT_MIN_WIDTH`).
- **Expected:** the feed layout, no horizontal scroll.
- **Automated**

### WEB-18 · Phone width (mobile browser)
- **Steps:** 390×844 touch viewport; open home, launch a task, open it.
- **Expected:** no horizontal overflow; launcher usable; long URLs in prompts wrap.
- **Automated**

### WEB-19 · Spells: install, see, turn off
- **Steps:** install the *Tool stats* example spell enabled (`POST /api/spells`); reload; click its
  top-bar button; turn it off.
- **Expected:** the *Tools* button appears and opens its dialog with stats; off removes it.
- **Automated**

### WEB-20 · Recipes
- **Steps:** save a recipe with a `{param}` (`POST /api/recipes`); see it in the launcher's
  *Recipes* row; run it with `wisp run`.
- **Expected:** the chip appears; the run launches a task with the param filled.
- **Automated** (API + UI chip)

### WEB-21 · Compare two harnesses
- **Steps:** launch with `compare: ['codex']`.
- **Expected:** two sessions in one group, each on its own branch; the compare row shows both.
- **Automated** (API), **Suite**

### WEB-22 · `/btw` side question
- **Steps:** on a task, follow up with `/btw did you update the docs?`.
- **Expected:** an answer appears without interrupting or adding a turn to the main run.
- **Automated** (API), **Suite** (`test/btw.test.js`)

### WEB-23 · Machines, Automations, Get the app dialogs
- **Steps:** click *Machines* and *Automations* under *New task*, and *Get the app* in the foot.
- **Expected:** each opens its panel/dialog and closes with Esc.
- **Automated**

### WEB-24 · Usage
- **Steps:** after some tasks, `GET /api/usage`, Settings → Usage.
- **Expected:** counts include the tasks run; the pane renders numbers, not `NaN`.
- **Automated**

### WEB-25 · CLI against the running server
- **Steps:** `WISP_PORT=… wisp "add a test" --wait --json -C <repo>`; `wisp ls --json`;
  `wisp show <id>`; `wisp --version`.
- **Expected:** exit 0, JSON with the presentation, the task listed; version matches.
- **Automated**

### WEB-26 · MCP server
- **Steps:** `wisp mcp`, send `initialize` and `tools/list` on stdin.
- **Expected:** tools include `wisp_launch`, `wisp_wait`, `wisp_reply`.
- **Automated**

### WEB-27 · Reload keeps state; service worker cache
- **Steps:** reload with tasks present.
- **Expected:** the last data paints first (cache), then updates; nothing replays its entry
  animation; open task stays open.
- **Automated** (reload keeps the open task)

### WEB-28 · Ship it / Merge
- **Steps:** a task in a repo with a GitHub remote → *Ship it*, then *Merge* after CI.
- **Expected:** commit, push and PR opened; card follows checks; Merge squash-merges and syncs
  local main.
- **Suite** (`test/ship.test.js`, fake `gh`) · **Manual** against a real repo

### WEB-29 · Take over in a terminal
- **Steps:** *Take over* (`T`) on a finished Claude task.
- **Expected:** the in-app terminal resumes `claude --resume <id>` in the worktree.
- **Suite** (`test/terminal.test.js`, `test/pty.test.js`) · **Manual** with a real CLI

### WEB-30 · Real harnesses
- **Steps:** `npm run test:real` with signed-in CLIs.
- **Expected:** each installed harness completes a turn and renders a presentation.
- **Manual**

### WEB-31 · Docs site
- **Steps:** `node scripts/site.mjs`; open `docs/index.html` at 1440 and 390 wide.
- **Expected:** builds without error; no horizontal overflow, no console errors.
- **Automated** (build + render), **Suite** (`test/site.test.js`)
