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
- **Steps:** open `/`, look at the launcher, then press **More options**.
- **Expected:** sidebar with *New task*, *Needs you* listing *Welcome to wisp*; the home shows
  *What should wisp do next?*, the launcher as on a first run (prompt box, permission mode, harness, **More options**, Send;
  no place, compare, team, goal, worktree or later), and **More options** opens the rest for good (the place as a laptop
  icon titled *Runs on this computer…*; *More options* goes)
  and *Tips*; the sidebar's head ends with a round avatar (a greyed cloud, signed out) whose menu
  says *wisp Grid · Not connected · Sign in* (a click opens Machines' sign-in), then *Machines*,
  *Automations*, *Get the app* and *Settings*. No foot under the list. No console errors.
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
  At 1000px (side by side) with the project picked, the harness pill keeps its name (`Auto`, not `A…`):
  Worktree folds to its branch icon first.
- **Automated**

### WEB-04b · Auto shows its pick before you send
- **Preconditions:** Auto is the harness in the launcher; at least two harnesses installed.
- **Steps:** type a prompt; change it (`fix the crash` → `restyle the button`); click the pick next
  to Auto; choose another option in the popover; send.
- **Expected:** the pick (logo + *Model · Level*) shows within a moment and updates as you type,
  without the launcher changing width or flashing empty. The popover says why, lists what else Auto
  weighed and may suggest one. Choosing an option switches the launcher to it; the task runs on
  exactly that, and Settings → Auto counts one more correction. Sent on Auto without choosing,
  the task runs on what the preview showed (`route.pinned`).
- **Suite** (`test/router.test.js`), **Manual** (the popover)

### WEB-04c · Start a task from an issue
- **Preconditions:** a project whose origin is on GitHub with open issues (fake `gh`: `issues` in its state file), and one without a GitHub remote.
- **Steps:** at 1440px pick the project in New task and click **Issue** at the end of the project row (on a first run open *More options*). Type a word of a title, then three letters of one not in the 50 newest; pick one. With a draft in the box, pick another and press **Undo**. Pick the project with no remote, then No folder; sign gh out and open it again. ⌘K → *Start from an issue…* from an open task. Add a Linear connector with `LINEAR_API_KEY`, open it again and pick *Linear issues assigned to you*. At 390px (dark) and in the phone app do the same with taps.
- **Expected:** the picker opens at once over rows in their real shapes (two lines each), then *#12 Title* with label pills, the assignee and how long ago; typing filters at once and the server's matches follow below. Picking fills the prompt with *Fix #12: Title*, the link and the issue's text, caret at the end; a replaced draft comes back with Undo. No remote: *… has no GitHub remote*; No folder: *Pick a project*; signed out: *Sign in to GitHub* with a button that opens Settings → Agents at the GitHub row. Without a Linear key the list ends with *Connect Linear…* (Settings → Connectors). Issue sits at the end of the project row (projects fold into +N before it wraps), its label folds to its icon on a narrow screen, and in the app it's an icon in the bar after Delegate; rows and buttons are 44px in the app. Light and dark.
- **Suite** (`test/issues.test.js`, `test/spells.test.js`), **Manual** (UI)

### WEB-05 · Live updates without reload
- **Steps:** with the page open, launch a task through the API (`POST /api/sessions`).
- **Expected:** its card appears and finishes in the open page with no reload (SSE).
- **Automated**

### WEB-06 · Follow up
- **Steps:** on a finished task, type a follow-up in its composer and send.
- **Expected:** the box clears at once, a second turn runs and renders below the first.
- **Automated**

### WEB-06b · Rename keeps the task open
- **Steps:** open a task; click its title in the header, type a new name, **Enter**. Click it again, type, **Escape**. Do the same with **M** on a row in the list.
- **Expected:** Enter saves the name and Escape puts the old one back; the task stays open both times (no close, no Back to home or the list).
- **Automated** (`node qa/web.mjs`)

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
- **Expected:** it moves to *Done* and the main pane shows New task (no other task opens; the phone app goes back to the list); then out
  of the list into *Archived*; delete removes it and its worktree.
- **Automated**

### WEB-11 · Transcript and diff viewer
- **Steps:** on a finished task press `V` (Transcript); click `1 file +1 −1`.
- **Expected:** the timeline shows the agent's steps; the diff viewer shows `math.js` with the edit.
- **Automated**

### WEB-12 · Command palette
- **Steps:** `⌘K` / `Ctrl+K`, type part of a task title, ↵.
- **Expected:** the palette lists the task under sessions and opens it; `Esc` closes.
- **Topics:** after a task's agent called `wisp_tag` (its activity says *Tagging the task*), type one of its tags:
  the task shows with that tag marked, and *Topics* lists `#tag · N tasks`; ↵ on it turns the query into `#tag `,
  which keeps only tasks with that tag. A title word with `#tag` (`#auth login`) narrows further.
- **Automated**

### WEB-13 · Split view is the only layout
- **Steps:** press `\`; reload; open Settings → General.
- **Expected:** split view throughout (the feed is gone); no *Layout* row in Settings.
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

### WEB-17 · Narrow windows stack
- **Steps:** resize to 860×600 (under `SPLIT_MIN_WIDTH`); scroll the list a little; open a task;
  click its Back; click **New task**; `Esc` twice.
- **Expected:** the list fills the window, no horizontal scroll. The task opens as a page of its
  own (Back, the title, the task), its details column one fact a row (state, harness, project),
  none cut off at the right edge; at 860×390 (a phone in landscape) it has the bar over the task
  instead, every action on screen; Back returns to the list where it was scrolled. New task opens
  home as a page with the prompt focused; Esc goes back to the list.
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
- **Expected:** two sessions in one group, each on its own branch; the compare row shows both. Compare opens with a `.cmp-table` (the same rows always: Time, Cost, Tokens, Cache, Agent steps, Plan, Files, Tests, Asked; totals over all of a run's turns, `—` for what's unknown) and, under it, `.cmp-note`: the plan total when runs overlap on one account (their cells marked ≈) and a sentence against run A that never says which is better. With Compare open, a run finishing or a share landing repaints in place: cells, pill and Keep this change without a node being re-inserted, the report swaps in once, and the dialog keeps its scroll.
- **Automated** (API), **Suite**

### WEB-22 · `/btw` side question
- **Steps:** on a task, follow up with `/btw did you update the docs?`.
- **Expected:** an answer appears without interrupting or adding a turn to the main run.
- **Automated** (API), **Suite** (`test/btw.test.js`)

### WEB-22c · `/side` side discussion
- **Steps:** on a finished worktree task, follow up with `/side why that approach?`; again from More, right-click and ⌘K (*Side discussion…* puts `/side ` in the box). Send a bare `/side`. In the side discussion, follow up once more, then follow up on the main task and ask the side discussion about it. Check its / menu, More, right-click and ⌘K. Click its *Side discussion of …* line; on the main task, click *N side discussions*. Repeat at 390px (stacked) and in dark.
- **Expected:** the box clears at once, a row with the *Side* pill appears and opens; the main task counts it. A bare `/side` shows the hint and sends nothing. The side discussion has no mode, team, computer or goal buttons, no Rerun, Take over or Ship it, and no `/side` or `/goal` in its / menu; its answers know what the main task did since. The line and chip go back and forth; with a long main task title the line still shows the start of it as a link, cut with `…`, and Tab draws its whole ring.
- **Suite** (`test/side.test.js`), **Manual** (the page)

### WEB-22d · A side discussion changes the work
- **Steps:** on a task with uncommitted changes, `/side` and ask it to edit a file the main task hasn't touched, then another line of a file it changed, then a line it changed; on the card use *Keep main's version*, then again *Apply and tell main task*, once with the main task idle and once while it runs. Change the main task's lines while a card waits, then Apply. Ask it to run a command, and to run `git reset --hard`. Start a second `/side` on the same task and have it edit a line the first one changed: the card names that side discussion, not the main task, and Apply tells the main task nothing. Repeat at 390px, in the phone app's page and in dark. Start one on Codex.
- **Expected:** the first edit shows nothing, the second a warning row naming the file and the main task. The clash shows a card in the side discussion only, with its change and main's lines (once: when the diff's red is those lines, its label names them and there's no second box); the main task never pauses. Its answers are in view above the reply box at 390px and in the phone app, and *what to do instead* is typed in the reply box, the card has no box of its own. Keep writes nothing and the agent says what to tell the main task. Apply writes it and the main task gets the message, as a follow-up or in its queue. A card that moved doesn't write: it redraws with *The main task moved* and a toast. A plain command runs with no card; `git reset --hard` shows the card. Buttons are 44px in the app. Codex's side discussion says it only reads.
- **Suite** (`test/side.test.js`), **Manual** (the page)

### WEB-22b · Feedback and bug reports
- **Steps:** on home, click *Hit a bug, or wish wisp did something? Tell us* at the foot; switch the dialog to
  *Something broke*. Then type `/bug the list jumps` in the prompt box and press Enter.
- **Expected:** the dialog opens on *Idea or thought* with 👍 / 👎; *Something broke* hides the thumbs without
  the dialog changing height and keeps *Send* disabled until there's text. `/bug …` clears the box and thanks
  you at once; `/bug` alone opens the dialog on *Something broke*. The home line shows on phones too.
- **Manual** (page), **Suite** (`test/feedback.test.js`, `test/btw.test.js`)

### WEB-23 · Machines, Automations, Get the app dialogs
- **Steps:** open the avatar's menu and click *Machines*; again for *Automations* and *Get the app*.
- **Expected:** the menu closes and each opens its panel/dialog, which closes with Esc.
- **Automated**

### WEB-23b · Webhook triggers (webhook, Slack, Linear)
- **Steps:** at 1440px open Settings → Automations → Triggers → **New trigger**, pick *When a webhook is called*, a project, prompt `Deploy {{body.service}}`, **Create trigger**. Click **Turn on** in the notice (or Settings → Automations → *Webhook triggers*), **Copy** the URL, `curl -X POST -H 'content-type: application/json' -d '{"service":"api"}' <url>` twice. **Regenerate**, curl the old URL. Pick *When someone mentions wisp in Slack* and *When a Linear issue is created* and look at their fields. At 390px (dark) open the same editor.
- **Expected:** a new hook stays open on its URL (`…/api/hooks/<token>`) with Copy and Regenerate; off, a notice says the URL answers 404 and how to turn it on. The first curl answers 202 and a task starts in Plan mode with *Deploy api*; the second answers 429; *Last calls* shows *Started · Open the task* and *Skipped · At most one task every 30 s*, live. After Regenerate the old URL is 404. Slack asks for the signing secret, channel ID and an optional keyword, Linear for the signing secret and an optional label; each lists its placeholders and where the URL goes. A saved secret is never shown again (*Saved: type to replace it*). Light and dark, 390px wraps without spilling.
- **Manual** (UI), **Suite** (`test/hooks.test.js`, `test/grid.test.js`, `test/spells.test.js`)

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
- **Comments waiting:** add two comments, don't send them → Ship it and Merge each show *2 comments not sent yet: they go with your next follow-up*. The buttons still work, Merge isn't red for it (a failing or running check still is), and the comments stay over the reply box after the ship and the merge.
- **Suite** (`test/ship.test.js`, fake `gh`) · **Manual** against a real repo
- **Two tasks, same files:** two open tasks in one repo edit the same lines → both cards show an
  amber *Clash* pill (icon only on a phone), the open card's warning names the other task and the
  file with **Open**, and Ship it / Merge repeat it. The same file at different lines says *Overlap*
  and "merge cleanly". Merging or archiving one clears the other's warning.
  **Suite** (`test/overlaps.test.js`) · **Manual** in the page

### WEB-29 · Take over in a terminal
- **Steps:** *Take over* (`T`) on a finished Claude task; open another task, then the first again.
- **Expected:** the in-app terminal resumes `claude --resume <id>` in the worktree. Another task (or home) puts it away; back on the first task it shows again, with the same screen.
- **Suite** (`test/terminal.test.js`, `test/pty.test.js`) · **Manual** with a real CLI
- **No wisp block:** the resumed agent is told (`--append-system-prompt`) to answer in plain text, so its replies in the terminal carry no ```` ```wisp ```` JSON.

### WEB-43 · Babysitting mode (Terminals) and wisp blocks
- **Steps:** Settings → General → *Babysitting mode (Terminals)* on; send a Claude task. Type a follow-up in wisp's box. Hide the list (`[`), open the side panel, drag the list's edge, resize the window quickly across 900px and 700px. `/exit`, press a letter (`a`), open another task, then the first again. Repeat with Codex, opencode, Cursor, Grok and Antigravity. With Babysitting mode off, send `/terminal fix the login bug` (and a bare `/terminal`). Then *wisp blocks* off and send a task with Babysitting mode off.
- **Expected:** on sending, the task opens at once (no wait on the prompt page), on a *Starting up…* terminal screen with the title without `/terminal`, then on the agent's own CLI once it's up; a launch the server refuses goes back to New task with the prompt and a toast. The CLI is its content: full width in the task's body under its header (no panel, head, End or details column), following every window resize (`claude --session-id <uuid> … -- "<prompt>"`), already answering the prompt. The CLI starts at the size it's shown at (its first screen isn't redrawn from 100×30), and after each resize the page's columns and rows equal the terminal's (no text cut short or running past the right edge, also on a phone); the header's buttons stay at the pane's right edge; a full-screen TUI's own background (opencode, Grok) reaches the box's edges with no frame; its row says *In terminal* and its one turn is the prompt with *In the terminal*. The follow-up is typed into the terminal (the box empties, no Working card). After `/exit` the keys stay in the terminal (the task moving to Needs you doesn't take them): the letter resumes it, it never runs wisp's shortcut (`a` archive). Opening the task again after `/exit` resumes the same conversation. `/terminal …` with the setting off does the same for that task (its turn is the prompt without `/terminal`); a bare `/terminal` says what to type. `/terminal …` with a *Done when* goal, a team, compare runs, or `@Ada` (first or later in the prompt) still opens one terminal task, the extras dropped: no goal, no delegates, no crew job. Schedules, crew jobs and spells whose prompt says `/terminal` still run in wisp. With wisp blocks off the answer is plain markdown, with no *answered in plain text instead* note. Both rows say which spell set them when one does. Light and dark, split view and 390px.
- **Suite** (`test/pty.test.js`, `test/app.test.js`, `test/protocol.test.js`) · **Manual** with a real CLI

### WEB-30 · Real harnesses
- **Steps:** `npm run test:real` with signed-in CLIs.
- **Expected:** each installed harness completes a turn and renders a presentation.
- **Manual**

### WEB-31 · Docs site
- **Steps:** `node scripts/site.mjs`; open `docs/index.html` at 1440 and 390 wide.
- **Expected:** builds without error; no horizontal overflow, no console errors.
- **Automated** (build + render), **Suite** (`test/site.test.js`)

### WEB-32 · Crew: add, open, answer, delegate, follow up
- **Steps:** in the *Crew* section click **+**, pick the *CI watcher* template, open the spirit maker (click the face), change the eyes, roll once, add a delegate, **Add to crew**. Click the member: its thread opens in the main pane (in place in the feed). Send `ASK …` from the box; answer its question in the thread; **Open job**, then Esc twice. In another task's follow-up type `@`, pick the member, ask something with `CREWFOLLOW`; **Reply to …** under its answer. Edit the member: *Checks in* → **Custom…**, type `every blue moon`, **Save**; then `8am every weekday`, **Save**. Add a schedule trigger with **Send to** the member, *When* `every monday`, and run it. Under *Skills and instructions*, **Add** → *Skill*, paste a SKILL.md, **Add**; **Add** → *From this computer…*, pick one; turn one off with its switch; drop an AGENTS.md on the section. **Add** → *Generate with …*, send `CREWKIT make yourself the best UI engineer`; under the job, click a proposed file, untick another, **Add**.
- **Expected:** a schedule is typed in words and read back under the box (*= Weekdays at 8:00*); one it can't read turns the hint red and Save stays in the box; the member and the trigger show their schedule in words, never as cron. The row appears at once, above *Working*; a job you send it, a check-in or a trigger's job is a task in *Working* / *Needs you* / *Done* with the member's face (a follow-up moves it back to *Working*); a job for another task (delegated, `@` answer, checking on a task) shows only under the member, where a finished one stays (read or not) until it's marked done or archived, or newer jobs push it past three. The job shows *Starting up* at once, then *Asking you* with the question, choices and a box (and an amber dot on the face); the answer carries it on. Open job opens the task with the member as a crumb; Esc goes back to the thread at that job, then home. No toast while the thread is on screen. The `@` answer lands under the message, the member's own follow-up reaches the task's agent with the thread moved along and the member in the task's delegates (its card shows their face in the team), and Reply continues the same job. A pasted SKILL.md fills in the name and When; added files show at once with their switch, a refused one comes back with a toast. The generated files show under the job with *Replaces yours* where the name is taken; the count on Add follows the boxes; after Add the job says *Added to their kit: …* and only the ticked files are in the kit. Light and dark, split view, feed and 390px.
- **Manual** (UI), **Suite** (`test/crew.test.js`, `test/web-pure.test.js`, `test/spells.test.js`, `test/machines.test.js`)

### WEB-32f · Crew: Org (who hands work to whom)
- **Steps:** with six members (one paused, one handing work to an agent on another harness), click **Org** on the *Crew* heading. Select a member; **+** on another card; **✓** on it again; × on an agent row in the column; **Add a delegate…** → another member, then *An agent on any harness…*. Esc. Drag from a card's handle onto an unconnected member. Select one, **Open thread**, Esc (twice: the box, then the thread). Reload. At 390px, tap **Org**, select, tap **+**, Back.
- **Expected:** the chart shows leads on top and their delegates below, joined by arrows, with *Not connected* members under a dashed line and other harnesses as logos on cards. Selecting a member doesn't move the chart: its arrows light up, unrelated cards dim, and the line above says what + and ✓ do. Each change shows at once, and the arrow, the card's tick and the column agree. Esc first ends the picking, then closes the page. A drag draws a dashed line, and the card it would link highlights. Back from the thread lands on the chart with that member selected; a reload keeps Org open. At 390px, two cards fit per row, nothing spills past the edge, and the column sits under the chart. Light and dark, split view and 390px.
- **Manual** (UI), **Suite** (`test/spells.test.js`)

### WEB-32g · Crew: arranging Org by hand
- **Steps:** with five members (two leads), open **Org** and drag an unconnected member next to a lead; drag a delegate to the far right edge. Click a card (no drag). Focus a card, ←, Shift+↓. Reload; open Org in another browser. At 390px, swipe over a card that isn't selected; tap one, drag it. **Reset layout**, then Undo in the toast.
- **Expected:** only the dragged card moves (the rest stay put on the first drag too), arrows follow it live, a card can't leave the chart's sides, and a click still selects. The keys move the card and it's saved shortly after. After the reload and in the other browser the cards sit in the same spots. At 390px a swipe scrolls; a selected card follows the finger. Reset puts everyone back in tiers and hides the button; Undo brings the arrangement back. Light and dark, split view and 390px.
- **Manual** (UI), **Suite** (`test/crew.test.js`, `test/spells.test.js`)

### WEB-32c · Crew: share, import, and members from a spell
- **Steps:** open a member with a kit, a notebook and a crew delegate; ⋯ → **Share…**. Tick *Notebook* with a token in it, untick it; tick *Who they delegate to*; **Copy**; **Create a gist** (confirm). In **+**, **Import…**, paste the copied JSON, **Review**; rename one, untick one, pick a project; **Add**. Drop a `.crew.json` on the window. Install a spell with `crew` and turn it on; open its member, **Resume**; update the spell with a new brief; **Resume** again; **Edit…**, **Make it mine**. Turn the spell off and on; remove it (keep, then remove for another).
- **Expected:** the notes say what stays here; a token blocks Copy, Download and the gist with the line it's on; the gist is secret and the dialog shows its `gist:` link. The review names clashes (*Scout 2*), a harness not installed (Auto), a left-out delegate, and asks for a project for a CI watcher; Add shows the rows at once, paused. The spell's member says *New from a spell: review to start*, the review shows what it does and its project; after the update it's paused (*Paused: their spell changed*) and the review shows old and new. The editor locks what the spell sets until Make it mine. Off, the member leaves the list; on, it's back with its notebook. Phone: Share has only Copy and Create a gist. Light and dark, split view, feed and 390px.
- **Manual** (UI), **Suite** (`test/crew-share.test.js`, `test/secret-scan.test.js`, `test/spells.test.js`)

### WEB-32e · Crew: who comes first
- **Steps:** with four members (one paused), send three jobs to the third-joined, one to the fourth; reload. Send a job to the last; while it runs, hover the section, then move away. Type `@` in a follow-up.
- **Expected:** the one working is on top, then the one you sent three jobs, then one job, then the rest by when they joined, the paused one last; the folded faces and the `@` picker follow that order. Rows don't move while the pointer is in the section; they settle once it leaves. Light and dark, split view and 390px.
- **Manual** (UI)

### WEB-32d · Crew: track record (usage and limits)
- **Steps:** with Claude's plan windows known (Settings → Usage shows them), a member on a 30-minute schedule that mostly comes back quiet and one you hand big jobs, right-click the first in the *Crew* section → **Track record…**. Hover and tap a day; switch 7 / 30 / 90 days; click the suggestion's link. Open it again, click a biggest job. Pick **Whole crew** in the title, then a member's row. Open *Crew track record* from ⌘K and Settings → Usage. Open a member on another machine, a member using Codex, and a new member.
- **Expected:** the About column has no stats. The member's view leads with its plan windows (*Since … , Scout used 14% of the tokens, the crew 36%*, never "of your limit"), then tokens and cost with its share of all wisp usage, one insight at most (*Check-ins … use … a day; 86% found nothing. … Change schedule…*), tokens per day (repeating vs asked), *Where it went* by kind with runs a day × tokens each for check-ins and triggers, *Biggest jobs* (a click closes the dialog and opens the job), and the outcomes line. The header doesn't move when you switch member, crew or range. Whole crew ranks members by tokens with your own tasks last. Codex reads tokens and a faint *no price*; a member on another machine says its usage is counted there; a new member says *Nothing in the last 30 days*; no windows known: no limits line. At 390px the tabs get their own row and the legend its own line. Light and dark, split view and 390px.
- **Manual** (UI), **Suite** (`test/crew.test.js`, `test/spells.test.js`)

### WEB-32b · Crew: starts when a task finishes or is marked done
- **Steps:** add a member from the *Verifier* template (its *A task finishes* chip is on) in a project, also turn on *I mark a task done*, **Add to crew**. Run a task in that project and let it finish; then mark it done. Edit the member, turn *CI fails* on for a member with no project, Save. Open Automations → Triggers.
- **Expected:** the row says *When a task finishes or a task is marked done*, and its details list it beside the bolt. Each event starts one job, shown as *Finished “…”* / *Marked done “…”* in the thread with the task as a link; the member's own jobs finishing start nothing, nor does a task in another project. CI with no project is refused with a toast and the editor comes back as it was. Automations lists the member's triggers (*When a task in … finishes → Name*), with no *Run now*. Light and dark, split view, feed and 390px.
- **Manual** (UI), **Suite** (`test/crew.test.js`)

### WEB-33 · Fold the task list's sections
- **Steps:** with tasks in *Needs you* and *Working*, click each heading (*Needs you*, *Crew*, *Working*, *Done*, *Archived*), then Tab to one and press Enter. Reload. In split view open a Working task, fold *Working*, then press Esc.
- **Expected:** each section folds and unfolds at once, the chevron turns, the headings stay in line; Crew's **+** adds instead of folding. Folded *Needs you* shows its count as a pill. Folds survive the reload. The open task keeps its row in the folded section until it's closed. Light and dark, split view, feed and 390px.
- **Manual** (UI), **Suite** (`test/spells.test.js`)

### WEB-34 · Later: scheduled follow-ups, tasks and reminders
- **Steps:** in the prompt box type `in 5 minutes run the e2e suite`, pause, check the chip, press Enter. Type `remind me to review the PR in 1 hour`, Enter. Type `make the cron run at 2pm` (no chip), clear it. Type `tomorrow at 9 check the nightly`, click × on the chip, then Enter. Open a finished task; in its reply box type `in 10 min check again`, Enter; then type a message and use the clock button → *In 30 min*. Right-click a row above the box → **Change time…** → *Pick a time…* `16:30` → **Move**; × on another row, then **Undo**. Mark the task done. Right-click it → **Send follow-up now**. Click a Scheduled plan row: its page opens; change the prompt, click away, then **Start now**. Ask an agent `in 2 minutes check the file again` and wait. Let a reminder come due (or **Remind me now**), then **Snooze…** → *In 10 min*. Settings → General → turn off *Read times in prompts*, type `in 5 min x`. With the prompt box empty, click the clock → *Pick a time…*, type `tomorrow 10`, Enter; attach a file, type `run the e2e suite in 5 min`, Enter.
- **Expected:** the chip shows the time only once you pause (*Starts at 14:35*, *Reminds you at 15:30*), Send's icon turns into a clock, and Alt+Enter would start it now. Enter clears the box at once and the plan shows in *Scheduled* (soonest first, time in the time column) and home's *Coming up*. Text that only mentions a time runs now; × makes it run now. The reply box's follow-ups show above it (*At 14:45 · set by you*), the card gets a clock pill (in *Needs you*) and moves to *Scheduled* once marked done. Changes, cancels and Undo show at once and roll back with a toast if refused. When due, the same task gets a new turn showing just the message, with its context (the agent remembers). The agent's `resume_later` shows as *Scheduling a follow-up in 2 min*; when that turn ends the task goes to *Scheduled* (unread dot, the time in the time column, no clock pill), not *Needs you* nor home's *Needs you* or the tab title's count, and its follow-up comes back into the same task. A due reminder lands in *Needs you* with a bell and *Reminder*, notifies, has no reply box, and snoozes back to *Scheduled*. Archived tasks drop their follow-ups. With the setting off, no chip and nothing is scheduled. The clock is enabled on an empty box; *Pick a time…* becomes a field in that row (no ring, the time on the right with ↵, Escape back to the row); Enter sets *Starts Tue 10:00* and puts the caret in the prompt; the typed *in 5 min* doesn't replace it, and the plan starts at 10:00 with the file. Light and dark, split view, feed and 390px.
- **Manual** (UI), **Suite** (`test/later.test.js`, `test/spells.test.js`, `test/routes.test.js`)

### WEB-36 · Side panel: shell in the worktree, PR without the noise
- **Steps:** ship a worktree task (fake `gh` with a failing, a running and two passing checks, an approval, a review thread, a person's and two bots' comments). At 1440px open it and click the action row's **Shell** button. Type `git status -sb`, then switch to another task and back; press `⌃\`` twice; *⋯* → *Copy path*; End shell (stop icon) → **End shell**, then **Start again**. Click the task's PR row: on **PR #1** open *2 passed*, *2 from bots*; **Ask to fix** on the failing check; **Send to agent** on the thread. Resize the panel by its edge, double-click it. At 1000px open the panel, press `[`. At 390px in the app: open the task, tap the **Shell** row, type, Back, tap the PR row, **Ask to fix**; open Shell again and press the phone's Back. Scroll a long task down, tap the pinned row's PR chip, Back, then its shell icon. Archive the task.
- **Expected:** the panel is a third column (480px) whose head is its tabs (*Changes · PR #1 · Shell*), the Shell button is pressed while it shows, the task's details fold into its bar and its PR row hides while PR shows. The shell starts in the worktree (*Starting zsh in … on This computer* shimmer first; a shell that prints nothing for 4s says *Still starting zsh: it runs your ~/.zshrc first*), keeps its screen across tasks (one that ended starts afresh when you come back to it: no dead screen), and isn't a take over (no *In terminal* pill, follow-ups still go). The place line shows the computer, branch, ↑ commits and changed files. Checks list failing first; passed ones fold into one row; bots' comments fold into *2 from bots*. Ask to fix fills the reply box with the check and the end of its log (not sent); at 390px it goes back to the task with the draft. At 1000px the list makes way while the panel is open, and `[` closes the panel and brings the list back. At 390px: the page's head is Back and the tabs (text only, equal widths); under the task's actions the PR row (chevron, Merge at its right end) and a *Shell* row (*This computer*, then *Running on This computer* with a green dot once one's started); each slides in as a page whose head is Back and *Shell* / *PR #1*, and Back (head or phone) returns to the task; scrolling a long task takes the whole bar away and pins one 48px row (state, action icons, the PR chip, the shell icon with a green dot while it runs) that opens the PR and the shell and goes when you scroll back up; the shell fills the page with the key row (Esc, ^C, Tab…); PR's verdict is a bar at the bottom; rows are 44px. Archiving ends the shell. On a machine or cloud computer the shell runs there; an older wisp there says to update it. Light and dark.
- **Manual** (UI), **Suite** (`test/workspace.test.js`, `test/spells.test.js`)

### WEB-47 · Side panel: Changes
- **Steps:** at 1440px open a finished worktree task, then in its worktree edit a tracked file in two places, add a new file under a deep folder with a long name, delete a file and touch `package-lock.json`. Click the action row's **Changes**. Fold the file that opened, open two files' diffs, scroll one sideways, **Expand all**, **Collapse all**; open the generated row; `⋯` → *Copy path*. Switch tabs with the mouse and with ←/→. Press `D` on another task; open one started without a worktree. Start a task that edits as it goes and keep Changes open on it. At 390px open the panel from the task's **Changes** button; at 360px look at the long path.
- **Expected:** the panel opens on *Changes* (the tab pressed, the action row's button pressed): *N files +a −d vs main*, files sorted by path with A/M/D badges, `+n −n` lined up in fixed columns, the deleted file struck through, the lockfile folded into *1 generated file*. The first file's diff is already open (every file's with three or fewer, *Collapse all* in the summary), and folding one keeps it folded on the next refresh. Files that arrive with the panel open open too while there are three or fewer, until you fold one (`qa/web.mjs` checks it). Diffs open under their rows, numbered, the open row sticking to the top; Expand all flips to Collapse all. A long folder is cut from its start (*…/css/*) before the name shortens, and keeps its *…/* when the name fills the row (never a bare *./*; `qa/web.mjs` checks it). A file name too long to sit beside the counts and controls takes the whole line and they drop to a line under it, in the same columns as every other row; the other rows stay one line. Without a worktree the note says *Not a worktree: showing the edits wisp saw*, the summary *edits wisp saw*. While the agent works rows appear and update in place (no jump, open diffs stay open). Ship it from there (or from another window): the commit box, the Stage boxes and *uncommitted* in the place line go as soon as it lands, without a reload, and the files stay (`qa/web.mjs` checks it). Phones: Back and the tabs fill the head, rows are 44px. Light and dark.

### WEB-43b · Comment on a line of a diff
- **Steps:** at 1440px open a finished worktree task with changes, press `D` (or the task's **Changes**), open a file's diff. Hover a line and click the **+** over its sign, type a note, press Enter. Click another line's number, then shift-click a line a few rows down, type, **Add to follow-up**. Hover a removed line and comment on it. Click the first row in the tray, change the note, **Save**. With the reply box empty, click **Send comments**. At 390px in the app (dark): open the task, swipe to Changes, open a diff, tap a line number, tap a second one, type, **Add to follow-up**, Back, **Send comments**.
- **Expected:** the **+** covers the line's sign only (the code doesn't move); the card opens under the line(s) with the label (*src/a.js:42*, *src/a.js:42–48*), the first line of code and the range hint, the lines lit. Marks sit at the gutter's left, numbered in the same order as the answer's comments; the tray rows read *note · src/a.js:42* (*removed* for a removed line), and clicking one opens Changes on that file, flashes the mark and opens the note. **Send comments** shows only while the box is empty and keeps its room while you type. Sending clears the tray and marks at once; the new turn's prompt shows the cards, and the agent gets `On "src/a.js", lines 42–48:` with the quoted code (a removed line by its old number, *numbered as before the change*). A refused send puts them back. Captured edits (no worktree) have no line numbers and no **+**. Light and dark.
- **Manual** (UI), **Suite** (`test/comments.test.js`, `test/spells.test.js`)

### WEB-43c · Review Changes: revert a hunk or a file, mark files viewed
- **Steps:** at 1440px open a finished worktree task whose file has two hunks far apart (and a new file), press `D`, open the file's diff. Scroll it sideways; hover the second hunk and click its **Revert**, then **Undo** on the toast. Tab to a hunk's Revert and press Enter. `⋯` → **Revert file…** → **Revert file**, then **Undo**. Revert the new file from its `⋯`, then **Undo**. Tick **Viewed** on a file, reload, then have the agent (or the editor) change that file. Start a follow-up and, while it runs, click a hunk's Revert. At 390px in the app (dark): open the task, swipe to Changes, open a diff, tap **Revert**, Undo, tap a file's Viewed box.
- **Expected:** Revert shows on the hunk's first line at the panel's right edge whatever the sideways scroll, only while the pointer (or focus) is on that hunk, and the code doesn't move. Clicking it takes the hunk's rows away at once; the diff reloads without it and the toast says *Reverted* with **Undo**, which puts the file back exactly (the other hunk untouched). *Revert file…* asks first (red **Revert file**); the file's row goes, a new file is removed, and Undo brings either back. While the agent works: a red toast *The agent is working on this task: wait for it, or stop it.* and the rows stay. A hunk that changed since: *This part changed since you looked: Changes is up to date now.* and the list reloads. Viewed folds the file and dims its row without moving anything in it; the summary says *1 of 2 viewed*; it survives a reload and goes when the file's diff changes. Phones: Revert and the Viewed box are always shown and 44px to tap. Light and dark.
- **Manual** (UI), **Suite** (`test/hunks.test.js`, `test/workspace.test.js`, `test/spells.test.js`)

### WEB-43d · Stage and commit from Changes
- **Steps:** at 1440px open a finished worktree task whose file has two hunks far apart and a new untracked file, press `D`, open the file's diff. Hover the second hunk and click **Stage**; click it again (**Unstage**). Click the file's **+**, then its **−**, then **+** again. Focus the commit box with it empty, keep the title, press ⌘Enter. With nothing staged, type a message and click **Commit**. Then ⌘K → *Commit staged changes…* with the panel closed. Change the file in the worktree under the page and click a hunk's **Stage**. Start a follow-up and, while it runs, click a file's **+**. At 390px (dark) and in the app (dark): the same, tapping.
- **Expected:** the hunk's button says **Unstage** at once and the file's **+** gets a dot (part staged); `git diff --cached` holds that hunk only; Revert doesn't move when the label flips. The file's **−** sits on the accent's tint once it's all staged; nothing in the row moves. The commit row shows under the summary while anything is staged or still to stage: *1 staged* inside the box (*Commits all 2* when none is). Focusing the empty box puts the task's title in, selected; Enter or ⌘Enter commits, the box clears at once and the toast says *Committed abc1234*; the commit holds only what was staged (the new file stays untracked). With nothing staged Commit takes everything. ⌘K's item opens Changes with the box focused. A hunk that changed since: it flips back with *This part changed since you looked: Changes is up to date now.*; while the agent works: *The agent is working on this task: wait for it, or stop it.* and nothing changes in git. Phones: the toggle, Stage, the box and Commit are 44px in the app; the path keeps its room (on touch phones the pencil is in ⋯). Light and dark.
- **Manual** (UI), **Suite** (`test/stage.test.js`, `test/workspace.test.js`, `test/spells.test.js`)

### WEB-40 · Watch agents work
- **Steps:** at 1440px start a task whose prompt says `WATCH` (the fake agent opens a page with `wisp_watch`, sends a state per file, then closes it; `FAKE_WATCH_STEP=1600` slows it down) and open it at once. Watch it to the end; copy the *Run it yourself* command. Switch the system to dark. Reload. Close the panel, open it from the task's **Watch** button, then *More* → **Watch**, right-click → **Watch**, ⌘K *Watch*. Open the task's shell, start another `WATCH` task meanwhile and open it. At 390px start one and open it, tap **Watch** in the working card, then Back. Turn Settings → **Watch agents work** off and start another.
- **Expected:** the side panel opens by itself on *TS migration* (eye icon) with *Reading the project*, then a green pulsing dot and *Converting billing.js*… while the bar and the list fill in place: the frame never reloads or flashes. At the end the dot becomes a check and *All 6 files converted*; the page stays with 6 of 6. Copy gives `cd <repo> && npx tsc --noEmit`. Dark repaints the page without reloading it. After a reload the panel comes back on the page with its last state. While the shell shows, a new page doesn't take its place. The activity says *Opened Watch: TS migration* with the eye. At 390px the page doesn't open by itself; Watch opens it as a page with Back, the run strip at the bottom. Off: the agent isn't offered `wisp_watch` and nothing opens. Light and dark.
- **Manual** (UI), **Suite** (`test/watch.test.js`, `test/spells.test.js`)

### WEB-41 · Watch a running app
- **Steps:** start a second wisp (the "app") on another port with a task in it. At 1440px start a task whose prompt says `WATCHURL` with `FAKE_WATCH_URL` at that wisp, `FAKE_WATCH_PATHS` naming `/#/s/<its task>` then `/`, and `FAKE_WATCH_STEP=3500`. Open it; click the address's open button. At 390px tap **Watch** in the working card.
- **Expected:** the panel opens on *The app* showing the other wisp, live and usable; the caption line reads *Starting the dev server* with `localhost:<port>` and the open button at its right. Each navigate loads the frame at the new address (the other wisp opens its task, then the list), with the caption following; the reload loads it again. At the end *Done: the app is running*, the app still showing. The open button opens the address in a new tab. *Run it yourself* shows `npm run dev`. On a phone away from the agent's computer (no grid), a line says it points at the agent's computer. Light and dark.
- **Manual** (UI), **Suite** (`test/watch.test.js`)

### WEB-46 · Preview: run the task's app, pick an element
- **Steps:** finish a worktree task, then in its worktree add `package.json` with `scripts.dev` = a tiny node HTTP server that listens on `PORT` (sends `X-Frame-Options: DENY`) and serves a page with a `<button class="primary">Save</button>`. At 1440px open the task, the side panel, then **Preview**. Click **Run**. Click **Pick element**, hover Save, click it. Click **Logs**. Open More. Click **Stop**. Type `node -e "process.exit(1)"` and Run. Type `npm run dev` back, Run, then delete the task. At 390px (dark) open another such task and use More → **Run app**. In the phone app, swipe to the panel and tap **Preview**.
- **Expected:** the tab sits after Shell on a worktree task only. Before running: *npm run dev* in a mono box, *From package.json: a guess…* under it. Run shows the amber *Starting · npm run dev* bar at once, with the app's output in the frame's place, then a green *Running · localhost:<port>* and the page (framed despite X-Frame-Options); the port is the same on the next run. Pick outlines Save with *button.primary* above it; the click adds *In the preview, `<button class="primary">` "Save" (selector: main > form > button.primary):* to the reply box and focuses it. Logs shows the output in the terminal's colours. More says **Stop app**. Stop shows the Run box at once and the app's port stops answering. The failing command shows *Exited with code 1*, its last lines and **Run again**. Deleting the task stops its app. 390px: Run app opens Preview as a page and runs it; nothing spills past the edge; where the address won't fit whole (390 and 360px with Pick, 390 and 360px in the app) the bar says *Starting* or *Running* alone, never *Running · loca…*; 412px in the app shows it whole. Phone app: five equal segments; a line says the address is the task's computer's, no Pick. Light and dark. A repo with `.conductor/settings.toml` whose `run` has several lines: a box as tall as its lines (6 at most, then it scrolls), *From `.conductor/settings.toml`* under it, Enter adds a line, Run sends them all; a toml that can't be read says so there and wraps. Keyboard: Enter on Run lands on the bar (ring) and Tab goes on to its buttons; Logs and Restart keep focus; Escape while picking goes back to Pick; Stop and an exit land on the command. A tap on Stop on a phone doesn't open the keyboard.
- **Manual** (UI), **Suite** (`test/runs.test.js`, `test/spells.test.js`)

### WEB-37 · Comment on an answer
- **Steps:** run a task whose answer has text, code and a picture (the fake agent's `SHOWCASE`). At 1440px select a few words in the text, click **Comment**, type a note, press Enter. Hover the code block, click its comment button, type, **Add to follow-up**. Click the picture's comment button, click a spot on it, type, Enter. Click the first row above the reply box, change the note, **Save**. Type *Then run the tests.* and press Enter. At 390px (touch) do the same with taps; on a video, pause at a second first.
- **Expected:** the bubble sits above the selection (below it on touch); the note card opens beside the words or the pin, the picked words stay lit. Marks are numbered 1, 2, 3 in order: a raised tag after the words, a ring with a corner tag round the code, a pin on the picture where it was clicked (on the picture itself, not on the letterbox). Rows above the box show the block, the quote and the note; the placeholder reads *Add a message, or send your 2 comments as they are*. Clicking a row scrolls to its mark, flashes it and opens the note. Sending clears rows and marks at once; the new turn's prompt shows three numbered cards over *Then run the tests.*, and the agent gets a `<comments>` list naming each block. A refused send puts the rows and the text back. At 390px the card is a bottom sheet, the picture keeps its comment button up, the pin hint says *Tap a spot* with *Cancel*. Light and dark.
- **Manual** (UI), **Suite** (`test/comments.test.js`, `test/spells.test.js`)

### WEB-38 · My Stuff
- **Steps:** run a task whose answer has a picture, a video, code and a doc. Hover each and click **Save to My Stuff** (the tray beside Copy / Download). Click **Open** in the toast. Type a word in the search (or press `/` first), clear it with Esc; pick *Pictures*, then *All*; switch *By time* / *By task* and grid / list. Click a picture (← → go through the others), a doc, a snippet, a link. Hover a card: star it, **⋯ → Edit details…**, add a note and tags, Save; **⋯ → Remove**, then **Undo**. Drop two files on the page, and paste a screenshot. Back in the reply, click a saved button again. Ask an agent to “save that to my stuff”, and to “use the logo from my stuff”. At 390px open it from the tray beside New task.
- **Expected:** each Save turns the button accent at once and a card appears with a light running under its preview, then fills in; saving the same thing again finds the one kept. Cards show the thing itself (picture, the video's first frame playing muted on hover, a doc's opening as a page, a snippet's first lines with its language, a link's site, else the file type), its kind, size, time and the task it came from; an agent's save has a ✦ badge. The chips count what matches the words. Removed cards go at once and come back with Undo; the file goes only when the toast does. Dropped and pasted files show at once. Every Save button follows the list (saved in another window, removed here). The agent's `wisp_save` card shows *Saving … to My Stuff*; `wisp_stuff` hands it the file's path. Stacked: a page with Back, two cards a row, the filters beside the search. Light and dark.
- **Manual** (UI), **Suite** (`test/stuff.test.js`, `test/spells.test.js`, `test/routes.test.js`)

### WEB-39 · My Stuff: @-mentions, updates, apps
- **Steps:** with a doc and an app in My Stuff, type `@` then a few letters of the doc in the prompt box; pick it with Enter; add text and send. On a card, **⋯ → Use in a new task**. Ask an agent to “make slides about X and save them to my stuff”, then “add a slide to @<the deck>”. Click **Launch** on the app's card, use the app, come back; **⋯ → Stop**. On the updated deck, **⋯ → Restore the version of …**, then Undo.
- **Expected:** the picker lists crew first, then My Stuff with pictures; the pick shows as a chip in the box and in the sent prompt (clicking the chip opens it, or launches an app). The agent's prompt carries a `<wisp-stuff>` note with the file's path. The agent's update keeps the card where it was, with *v2*, and a toast says it was updated. Launch opens a new tab at `localhost:<port>` (the same port each time; on wisp Cloud its preview address), the card shows *Running*; Stop clears it. Restore swaps content back. Phone app: Launch says apps open in a browser.
- **Manual** (UI), **Suite** (`test/stuff.test.js`)

### WEB-35 · Ask near the limit
- **Steps:** with Settings → Usage → *Ask near the limit* at 90% and a Claude Code account whose weekly window reads 91% (run a task with `FAKE_LIMITS` reporting `seven_day` at 0.91), type a task in the prompt box and press Enter. Press Esc. Press Enter again, then Enter (Start anyway). Send a follow-up on a finished task. Set the line to 95%, send another. On a finished task, click an action reply in its answer (*Commit this and open a PR*), then **Send anyway**; do it again with **Wait until …**. Back at 90% with the window at 96%, click **Wait until …** on the row. Schedule a task 1 minute out (Start later) and wait for it. Open it: **Wait until …**, then **Start now** from Scheduled; schedule another and **Skip this run**. Open the harness picker.
- **Expected:** the hold row shows at once under the prompt box (no request, the prompt stays): *Claude Code’s weekly window is at 91%, past the 90% you set to ask at.* with **Start anyway** and **Wait until …**; Esc closes it and keeps the draft; a second Enter within 300 ms does nothing. Start anyway launches; follow-ups after that don't ask until 95%. Wait until moves it to Scheduled. The action reply shows the same row; Send anyway sends that reply (a new turn) and Wait until schedules it for the reset. A job for a crew member (*@Ada …* in the prompt box, or the box in Ada's thread) shows the same row without Wait until, and Start anyway starts the job at once (not *Held before it started*). **Follow up** on a finished job in Ada's thread shows the row over its box (*Send anyway*, no Wait until; Esc keeps the text, Enter asks again), and Send anyway sends it as a new turn of that job. The scheduled task lands in *Needs you* with a *Held* pill and *Weekly window at 91%* under the title; its page shows the prompt and the held card. Wait until moves it to Scheduled (*Waiting for the weekly reset*, the reset in the time column); Start now runs it at once; Skip leaves *Skipped before it started*. The picker says *Weekly window at 91%* in place of the model count. Each action is instant and rolls back with a toast if refused. Light and dark, split view and 390px.
- **Manual** (UI), **Suite** (`test/guard.test.js`, `test/spells.test.js`)

### WEB-48 · Edit and reorder what's waiting
- **Steps:** near the limit, press **Wait until …** on the hold row, then click the task under *Scheduled*. Change its prompt, press ⌘Enter; change it again and click away; change it once more and press Esc twice. Right-click the row → **Edit task**. On a running task queue three follow-ups (Queue on). Hover the second: click the pencil, change it, Enter; edit another and press Esc. Drag the first by its grip below the third. Right-click one → **Move up** / **Move down**. Hover a follow-up scheduled for a time → pencil, change it, Enter. Hover a queued one → **Combine with the next one**; right-click → **Combine all into one**. Hover one → **Send now** while the run works. Queue two more and press **Stop**, wait, then **Send now** on the second. At 390px tap a queued row. Reload.
- **Expected:** the plan opens as a page in the main pane (390px: a page over the list with Back) with the prompt in a box, Start now, Change start time…, Delete; its row is selected. ⌘Enter and clicking away save it, the row's title follows at once; Esc leaves the box, then the page, saving what was typed. The pencil shows on hover only (always on a touch screen) and nothing in the row moves when it does; Enter saves, Esc keeps the old text; a row's entrance never replays. While dragging the others make room; on drop *Next · after …* and *Queued #n* follow the new order. Every change shows at once, survives a reload, and rolls back with a toast if refused. wisp's own queued follow-ups (reports back) have no pencil. Combine leaves one row saying both, where the first was. Send now interrupts the run, and the next turn is that follow-up; the rest still go after it. After Stop the rows stay, the first marked *Held after Stop*, and nothing goes out until Send now or a new message, after which the rest carry on. A tap on a phone opens the row's menu (Send now, Edit, Combine, Move, Cancel). Light and dark, split view and 390px.
- **Manual** (UI), **Suite** (`test/e2e.test.js`, `test/spells.test.js`)

### WEB-42 · Open a delegate's task, and back up
- **Steps:** launch `DELEGATE the review, with @Ada` with two delegates (Codex, Claude Code Haiku) and a crew member Bo whose delegates are Ada and Codex; send `@Bo DELEGATE the check`. While the lead works, click a delegate's live row; once it's done, click the **→** on a report, and **Open @… task** inside an unfolded one. Esc; × ; **Go to the lead**. From Bo's job open Ada's job; open the trail's **…**. Copy the address of a subagent's task and open it in a new tab. At 390px do the same with Back.
- **Expected:** every delegate (agent or crew member) opens as a task of its own in the main pane; a subagent's row appears under its lead in the list (indented, no Mark done, Save or right-click menu) and leaves once you open an unrelated task. The head names the tasks above it (*Lead › Ada › job*; more than two levels fold into **…**, a menu of the rest), each opens that task. Esc, × and Back go up one level to the task it was opened from, then home. A subagent's task has no follow-up box: the dock says it takes work from its lead, with **Go to the lead**; Rerun, Take over, Ship it, Mark done and More are hidden. A pasted link to a subagent opens it under its lead. Light and dark, split view and 390px.
- **Manual** (UI), **Suite** (`test/spells.test.js`)

### WEB-44 · Add a goal to a task that's already going
- **Steps:** open a finished task without a goal, click into its reply box and press the **target** button in its bar. Type a condition in *Done when* and press Enter with the message box empty. On another task, open the line, fill it, type a message and press Enter in the message box. Press the button on a task whose goal is still going, then on one whose goal was met. Press Esc in the line. Light and dark, split view and 390px.
- **Expected:** the button opens a *Done when* line between the message and the bar, focused, and lights up; the folded box stays open while it is. Its hint says *Enter sets it*, or *Sent with your message* once the box has text (hidden on touch screens). Enter alone sets the goal: the band shows at once and the idle task is checked. With a message, the follow-up runs and the goal is checked after that turn (not the one before). Either way the line closes and empties; a refusal opens it again with the text and a toast. A goal still going lights the button and it opens **Edit goal…**; after one ends (met, can't be done) it reads **New goal** and opens the line. Esc closes the line and goes back to the message. Not on subagents, delegates, the tour or terminal tasks.
- **Manual** (UI), **Suite** (`test/goal.test.js`, `test/spells.test.js`)

### WEB-45 · Judges on a goal
- **Steps:** in New task turn on **Goal**, type a Done when, click **Judges** at the end of its line. **Add judge** three times (with a crew member, pick one from the menu), change one judge's harness and model, pick **All**, click away and launch. Open the task while it works; hover the judges' faces in the band. Edit goal… → **Judges** → **Majority**, Save goal. Clear the judges from Edit goal…. Reload New task. At 390px do the same.
- **Expected:** the button shows the judges' faces and *3 judges · All* (icon only at 390px); the popover's rule line follows the pick (*All 3 must say it's met*, *2 of 3 must say it's met*). The task's goal carries the judges and the rule; after each round the band shows each face tinted by its vote and *2/3*, the tooltip each judge's vote and why; a round sent back says *2 of 3 judges say met (all must agree)* and what the dissenting judge wants. With All one dissent sends it back; with Majority 2 of 3 meet it. Clearing them goes back to wisp's own check. The launcher's judges and rule survive a reload. Light and dark, split view and 390px.
  **Reading a check:** click the band's faces, then a judge's row; Back; click the check line, then a face under *Earlier rounds*; Esc. On a goal without judges click the check line and a round. Open one while it checks. **Expected:** a page over the task with the judge, the round, the vote and the why, *What wisp asked it*, the transcript and *What it saw*; no reply box, band or Ship; Back returns to the task as it was, side by side and stacked. A judge that gave no JSON says so and keeps its steps; one under way grows live. None of it shows in the list, Needs you, ⌘K or notifications.
- **Manual** (UI), **Suite** (`test/goal.test.js`, `test/goal-runs.test.js`, `test/spells.test.js`)

### WEB-49 · iPhone Home Screen app (wisp Grid)
- **Steps:** on a wisp Grid in iPhone Safari, open home; hide the *Add wisp to your Home Screen* row with ×, reload. Clear site data, then Share → **Add to Home Screen**, open it from the Home Screen. Portrait and landscape; Settings → Notifications; open a task, Back; force-quit and open again; sign out on the grid and open it. In desktop Chrome on this computer, and in the Android app, open home.
- **Expected:** the row shows only in an iPhone's browser on a Grid, until × (it doesn't come back). The icon reads *wisp* with the logo. It opens full screen; nothing sits under the status bar, the notch, the Dynamic Island or the home indicator (the list's head, the task's head and the reply box keep clear of them), the status bar is readable in light and dark. The second open paints from cache, then refreshes; a grid deploy reloads it onto the new build. Notifications reads *On iPhone, alerts come from the ntfy app*; nothing throws. Signed out, it drops its cache and lands on the sign-in. Desktop browsers and the Android app look as before: no install offer, no new padding.
- **Automated** (WEB-49: emulated `navigator.standalone`: `html.standalone`, `viewport-fit=cover`, the service worker registers; a browser tab gets none of it), **Suite** (`test/static.test.js`, `test/spells.test.js`), **Manual** (a real iPhone on grid.trywisp.dev)

### WEB-50 · Panes: pin, the card, a code change, Full auto, staying in the frame
- **Preconditions:** an app in My Stuff whose `wisp-app.json` has `"uses": ["tasks:read", "tasks:write"]`, loading `/_wisp/pane.js`.
- **Steps:**
  1. ⋯ → **Pin on home**: the Allow card lists what it asks and says *assume whoever wrote it can see what it reads*. **Allow and pin**.
  2. From the pane, call `wisp.tasks.launch({ prompt: 'a\u202Eb' })`.
  3. **Cancel**; Esc; a click outside. Then call it again and press **Send**.
  4. Call it twice at once, and once with ⌘K open.
  5. Change a file in the app's folder, then call it again. **Allow…** on its bar, then call it again.
  6. Pin the app beside a task running in Full auto (or the task that made the app).
  7. From the pane: `location = 'http://127.0.0.1:<another port>/?x'`, a meta refresh to it, then `location = '/other.html'`.
  8. Frame wisp's page from an app with no `uses`.
- **Expected:**
  - 2: wisp's own card over the page (not in the frame): project, harness, mode as the launcher names it, the prompt with `<U+202E>` and its length. Cancel has the focus, Send is disabled for 600 ms, and Enter on Cancel doesn't send.
  - 3: each of the three rejects with *You didn’t send it.* and nothing starts; Send starts a task in your default mode.
  - 4: the second is refused with *A card is already waiting for you.*; with ⌘K open, *wisp has a dialog open: close it, then try again.*; a dialog that opens over the card counts as Cancel.
  - 5: *This pane changed since you allowed it: allow it again from its bar.*, no card, *Changed since allowed* on the bar; after allowing, the card opens again.
  - 6: **Allow…** is hidden; pinning from My Stuff toasts *Not while … runs in Full auto.*, no card.
  - 7: both navigations are blocked, the other port gets no request and the frame shows Chrome's blocked page until **Reload the pane**; the same-origin one works and `wisp.*` still answers.
  - 8: Chrome refuses the frame.
- **Suite** (`test/panes.test.js`), **Manual** (real Chrome)

### WEB-51 · Make a pane, and the starters
- **Preconditions:** a fake harness; a few tasks in different states, on a harness or account of their own, one by a crew member, one with a PR; `budget.json` with windows for one harness.
- **Steps:**
  1. In New task, send `make me a pane PANESAVE home` (the fake harness's `wisp_save`).
  2. Reply `PANEUPDATE <its id>`, watching the pane on home.
  3. **Allow…** on its bar, save again, then call `wisp.tasks.done()` from the pane.
  4. ⌘K → **Make a pane…**, and My Stuff → **Make a pane**. Press **Add** on Agent board, then **Allow and pin**.
  5. Drag a card to Done; press **Done** on another; **Follow up** on a third and Send and Cancel on wisp's card. Do more than 6 writes in a minute.
  6. **Add** Allowance board, **Allow and pin**. Give `budget.json` closed periods (`periods`) and tasks with `stats` and `plan` on those weeks, then call `wisp.usage.accounts()` from the pane.
- **Expected:**
  - 1: the task runs in Edits in an empty folder, on this computer. A toast says *Pinned Fake pane on home* and the pane shows there with *No access yet*: no Allow card opens, nothing is allowed.
  - 2: the pane shows the new version with no empty frame between, and the node stays where it is.
  - 3: after that second save the bar says *Changed since allowed*, and the call is refused with no card.
  - 4: Add asks from the Allow card on that click, and nothing is added to `allowed` until you press it. Add twice gives one item.
  - 5: cards land in the right columns with harness, account, machine, crew name, PR and time. Done works both ways, by finger too: on a narrow pane the columns stack, Done's heading stays at the bottom edge to drop on, and the grip is 44px to a finger; cancelling wisp's card shows *You didn’t send it.* on the task's card, as does *Slow down*.
  - 6: a row per account and a bar per window with *resets in …*; a harness with no windows says so; no burn rate until it can be told. Each window carries `periods` (newest first, `used` and `outside` null for a period known only from its turns, `rough` on differences) and `shrink`, which stays null until 2 full weekly periods per side. With `/usage/periods` failing the board keeps its windows, with `periods: []`. A copy of the board from an earlier wisp updates at the next start (v2, Restore brings it back); a changed copy, or one you went back to, stays.
- **Suite** (`test/panes.test.js`), **Manual** (real Chrome)

### WEB-52 · Home panes: tiles, sizes, a spell's layout, rows and pages
- **Preconditions:** three apps in My Stuff, each pinned on home; each shows a counter or the time it loaded, so a reload shows.
- **Steps:**
  1. At 1440px, open home. Drag the boundary between the first two tiles, then the one under the tiles. Press Tab to a grip and use the arrow keys.
  2. Reload the page.
  3. Double-click a boundary, then the bottom grip.
  4. Cast a spell with `parts: { 'split.panes': { props: { columns: 2, widths: '2,1', height: 500 } } }`, drag, then remove the spell.
  5. Set `columns` to 1, then hide `split.pane.grip`.
  6. Narrow the window past 900px, and widen it again.
  7. At 390px (and in the phone app), open New task. Tap a row, then Back; tap it again, then Esc; open it and press the phone's Back, twice. Unpin a pane from its page.
- **Expected:**
  - 1: three tiles fill home's width, past the 760px read width. No tile goes under 300px, a height stays between 200 and 1600, and the apps' counters don't change during a drag.
  - 2: the sizes are as you left them. The apps reload with the page, and only then.
  - 3: the boundary's column count goes back to the spell's widths or equal, and the height to the spell's or 420.
  - 4: the spell's layout shows at once, with two columns and the third pane on a second row; a drag saves over it; removing the spell shows equal tiles again, not the sizes from under the spell.
  - 5: one under the other at the read width, with no boundary grip; then no grips at all.
  - 6: below 900px the tiles go and a row per pane shows, with no grips; widening brings the tiles back with the apps still running.
  - 7: no frame exists until a row is tapped. The page fills home with Back, the name, Reload and Unpin. The name sits in the middle of the row, or above the line saying what the pane still asks for. Back goes pane page → home page → list, one step each, by the button, Esc or the phone's Back, and home is where it was scrolled. Reopening doesn't reload the app. Unpinning closes the page.
- **Automated** (`qa/web.mjs`, the name on the page), **Suite** (`test/panes.test.js`, `test/spells.test.js`), **Manual** (real Chrome)

### WEB-53 · Bring in Conductor worktrees
- **Steps:** in the QA home (`HOME` set to a temp folder), `git worktree add ~/conductor/workspaces/demo/tokyo -b dev/fix-login` in the QA repo, change a tracked file there, stage a new one, leave an untracked one, and put a non-empty `<uuid>.jsonl` in `~/.claude/projects/<the folder with every non-alphanumeric as ->/`. Add a second worktree under `~/conductor/workspaces/demo/lima`, and a detached one beside them.
  1. Pick that project in the launcher (a chip, the sidebar filter, or adding the project). Pick No folder, another project and a machine, and come back. Hover the line, then click its words.
  2. Type in the prompt box, then clear it.
  3. Take *Not now*, then *Undo* on its toast. Take *Not now* again and add a new worktree there.
  4. Bring the first ones back with `POST /api/projects/:id/foreign-worktrees/dismiss` `{ undo: paths }` and take *Bring in* (once with two worktrees, once with one). Double-click it. Open a task and its side panel.
  5. Send a follow-up to the tokyo task and roll that turn back.
  6. Archive it, follow up again, then delete it and pick the project again.
  7. Rename the tokyo folder away, look at Changes and Shell in the side panel, and follow up on a task still holding it.
- **Expected:**
  - 1: one line under the bar, in the recipes' row: *2 worktrees from Conductor*, with *Bring in* and *Not now*. The prompt box and the bar don't move, side by side, stacked or in the first-task layout (in the app, where an empty recipes row isn't shown, the box grows under the bar). The tip and the click on its words say how many have uncommitted changes and chats to resume, the branches, and that the detached one can't be brought in. No request for No folder, a clone, a machine or a project not picked; each project is asked about once.
  - 2: typing gives the row back to the recipes (*Save as recipe*); an empty box brings the line back, without a fade.
  - 3: the line goes at once, with the toast *Won't offer these 2 worktrees again*. *Undo* brings it back and the server offers them again. After a second *Not now* only the new worktree is offered. A refusal of either brings back what was there, with a red toast.
  - 4: the line goes at once and one POST goes out. After a moment the toast says *Bringing in…* (up to ~20 s offline). Then *Brought in 2 worktrees*, with the tasks in the list (stacked, you're back on the list); with one, *Brought in 1 worktree* and that task opens. Worktrees that didn't come are counted in the toast with the first reason. A refusal brings the line back with a red toast. Each task is not unread, on its branch, titled from the branch, its card says *Brought in from Conductor*, and it has one wisp turn with the list of its folder, branch, uncommitted files (*1 uncommitted file, as it was*) and chat, with no duration in its foot. The side panel says *Brought in from Conductor: archive and delete leave this folder.* Nothing in the folder changes.
  - 5: the follow-up runs in the folder with `--resume <that uuid>`. The rollback puts all three uncommitted changes back byte for byte (the staged one comes back unstaged).
  - 6: archive, delete and merge leave the folder and branch, and the merge confirm doesn't say it removes the worktree. The deleted task's worktree is offered again without a reload.
  - 7: the panel says *This worktree's folder is gone: showing the edits wisp saw.* (the shell line to match), and the follow-up is refused in a toast with *This worktree's folder is gone: <path>*; nothing appears at that path.
- **Suite** (`test/bring-in.test.js`, `test/spells.test.js`), **Manual** (real Chrome)

### WEB-54 · A turn says what moved in the CLI
- **Preconditions:** the fake harness; a task with one finished turn, run with `FAKE_CLI_VERSION` and `FAKE_TOOLS` set. For Codex, `FAKE_CODEX_DEBUG_WAIT` set to a file, so its probe lands after the answer.
- **Steps:**
  1. Change `FAKE_CLI_VERSION` and `FAKE_TOOLS` (five new tools, one `mcp__github__create_issue`) and reply. Press **Transcript**, then go back.
  2. Reply with nothing changed.
  3. With the harness's change line showing on the turn too, reply, then press **Trust this version**.
  4. On Codex, change `FAKE_CODEX_CATALOG` and reply. Scroll a little into the answer, then create the wait file.
  5. Cast a spell with `ui: { hide: ['turn.whatChanged'] }`.
  6. Open the task at 390px, then Back.
- **Expected:**
  - 1: while it runs, no line. Finished, one line under the prompt, in both views: *Since the last turn: Claude Code 1.0 → 1.1, Read, Edit, Grep and 2 more added.*, then *Possible cause, not proof; a server-side change won’t show.* An MCP tool reads *create issue (github)*.
  - 2: no line on the new turn; the one above keeps its own when unfolded.
  - 3: the version is on the harness's line only: nothing else moved, so no line of ours. After Trust, the version moves to our line at once.
  - 4: *Since the last turn: Codex model catalog changed (gpt-11 added).*, with the slug you set, shows when the file appears. The answer doesn't move and its entrance doesn't play again.
  - 5: the line goes; the rest of the turn stays.
  - 6: the whole line, limit included, wraps inside the page with nothing past the edge.
- **Suite** (`test/what-changed.test.js`, `test/spells.test.js`), **Manual** (real Chrome)

### WEB-55 · Cache gone cold
- **Preconditions:** the fake harness with `FAKE_CONTEXT=1h`; a Claude task with one finished turn (`contextTokens` about 480k, `cacheTtlMs` 3600000). Age it by moving the turn's `endedAt` back in the stored session, or with Playwright's clock.
- **Steps:**
  1. Open the task with the turn 74 minutes old, then let it reach 76 with the task open.
  2. Press **Fork…** on the line, then close the dialog. Type a reply and press Send once.
  3. Pick another harness in the box. Type `/btw why`. Set a time with Send later.
  4. Age a task with `FAKE_CONTEXT=5m` by 7 minutes; one with `FAKE_CONTEXT=none` by a day; a Codex task by a day; a task under 100k by a day.
  5. Hit a usage limit on the large task with the reset 3 hours away, with Settings → Wait for the reset off, then press **Wait until**. Repeat with the reset 10 minutes away.
  6. Open a task stopped by a usage limit with the turn 2 hours old, so its cache has already gone cold.
  7. Cast a spell with `ui: { hide: ['composer.cold', 'composer.coldFork', 'limit.cold'] }`.
  8. Look at 1440, 1000 and 390 wide, and in the app's page, light and dark, side by side and stacked.
- **Expected:**
  - 1: nothing at 74 minutes. By 76, within 30 seconds and with no reload: *Cache gone cold: this reply re-reads about 480k* and **Fork…** in the hint, with no button moved and the transcript where it was. At 390 and in the app's page the folded box shows nothing and doesn't move: the line arrives with the bar when you tap the box, goes with it when you tap away, and stays beside a draft while the bar does.
  - 2: Fork… opens the Fork dialog. One Send click sends: no hold, no ask, no second step. The line goes while it runs.
  - 3: each one replaces the line; clearing it brings the line back.
  - 4: the 5-minute task shows it. The others show nothing.
  - 5: *Cache will have gone cold by then: this reply re-reads about 480k* under the card's buttons, also after Wait. With the reset 10 minutes away, inside the TTL: *Cache may have gone cold by then: if so, this reply re-reads about 480k*.
  - 6: *Cache gone cold: this reply re-reads about 480k* once, in the reply box. The card has no cold line.
  - 7: all three go; Send and the rest of the card stay.
  - 8: at 1000 the short form *Cache cold: re-reads about 480k* with the number whole. Under about 950 wide, or at 1000 with the side panel open, it's cut short; its title holds the whole line. Fork… stays whole.
- **Suite** (`test/cold-cache.test.js`, `test/adapters.test.js`, `test/spells.test.js`), **Manual** (real Chrome)

### WEB-55b · Compact now
- **Preconditions:** the fake harness with `FAKE_CONTEXT=1h`, a Claude task with one finished turn (about 480k tokens, Opus). A window near the line (`FAKE_LIMITS`) for the hold row.
- **Steps:**
  1. Open the task's More, right-click it, and open ⌘K.
  2. Type a follow-up that crosses your line, so the hold row shows. Press **Compact now**.
  3. Age a turn past 60 minutes, then past 75. Try a task under 200k, a Codex task, a side discussion and a task whose last turn hit a limit.
  4. Compact a task marked Done, one you've read in review, one unread, an archived one and one in For later. Compact one with a goal. Make one fail (`FAKE_FAIL`).
  5. Make the server refuse (end the task's cache between opening the menu and clicking).
  6. With `FAKE_COMPACT=none`, press Compact now.
  7. Cast a spell with a `card.menu` button `{ "compact": true }`, and one with `ui: { hide: ['hold.compact', 'hold.compactNote', 'menu.compact', 'turn.compact'] }`.
  8. Send a follow-up after a compact, then hover Compact now in each place.
  9. Look at 1440, 1000 and 390 wide, light and dark, side by side and stacked.
- **Expected:**
  - 1: **Compact now** in all three, with *About $0.74 now, $3.84 once the cache is cold*: a dim second line in the menus, which are as wide as on a task without the offer.
  - 2: Working at once, with a quiet *Compact now* line (no `/compact` bubble) and a *Compacting* panel; the row says *Compacting* too. No hold, no ask. The draft stays in the box, and the answer above stays open and doesn't move. The turn ends on *Compacted from 481k to 10k tokens.*, the row keeps that answer's verdict and line, and the cold line and the offer are gone.
  - 3: at 60 minutes the offer's gone while the cold line isn't up yet; past 75 only Fork…. None of the others offers it.
  - 4: each stays where it was, read or unread, and nobody is pinged; the goal isn't checked and isn't cancelled. The failed one shows like any run, in Needs you.
  - 5: the turn rolls back and a red toast says why.
  - 6: *Not enough messages to compact.*, the cold line stays true, and the offer goes.
  - 7: the button compacts; the four parts go.
  - 8: the compact folds to one muted row with what it did. Each tooltip says the prices are estimates at API list prices and that a plan pays no dollars.
  - 9: at 390 the row's Send anyway and Wait until stay on their line; Compact now and its prices wrap under them, inside the box.
- **Suite** (`test/compact.test.js`, `test/cold-cache.test.js`), **Manual** (real Chrome)

### WEB-56 · The keyboard stays in the reply box after Send
- **Preconditions:** a finished task, open; the fake harness with `FAKE_DELAY=1500`.
- **Steps:**
  1. Click the reply box, type a follow-up and press Enter.
  2. Type *edit* straight away.
  3. Repeat with the row in a folded Needs you section, and at 390px wide in a browser.
  4. Repeat in the phone app's page, tapping Send.
- **Expected:**
  - 1: the row moves to Working, the box empties and still has the focus ring.
  - 2: *edit* is in the box. No toast, no Changes panel, no *Stop and take over?*.
  - 3: the same; the transcript doesn't scroll.
  - 4: the box lets go, so the keyboard drops and the run shows.
- **Suite** (`test/keep-focus.test.js`), **Scripted** (`qa/web.mjs`), **Manual** (real Chrome)

### WEB-57 · A failed run says why
- **Preconditions:** the fake harness with `FAKE_FAIL=1`, then `FAKE_LIMIT_ONCE=<file>` for a usage limit.
- **Steps:**
  1. Start a task and open it the moment it fails.
  2. Press **Try again** on the failed task.
  3. Hit a usage limit on another task. Hit a too-many-devices refusal on a Codex task (`FAKE_LIMIT_TEXT`).
  4. Open a task with a stored failure whose terminal block has `command: 'claude run'`.
  5. Open a task whose report has a terminal block with a real command.
- **Expected:**
  - 1: *Claude Code failed* with `fake: not logged in (401)` in the hero and on the row. The terminal shows the output as it arrives, with no `$` line, no typing and no **Run**. Never *Something went wrong*.
  - 2: **Try again** sends a follow-up.
  - 3: both terminals have no `$` line and no **Run**. The rows read *At limit* and *Refused* in amber; the failed one in step 1 reads *Failed* in red. An agent's own blocked report still reads *Blocked*.
  - 4: the same, on the stored task.
  - 5: that block keeps its `$` line and **Run**.
- **Suite** (`test/failure-screen.test.js`), **Manual** (real Chrome)

### WEB-57b · Sign in from the failed turn
- **Preconditions:** the fake harness with `FAKE_SIGNED_OUT=<file>` (the first run is signed out, later ones work) and `fake-login` as the Claude CLI's login.
- **Steps:**
  1. Start a Claude task. Open it when it ends.
  2. Press **Sign in**, open the link, paste the code in the card. Type part of it first and let a run elsewhere update the page.
  3. Repeat on a task, but sign in from Settings → Agents instead; go back to the task.
  4. Type `/login` in a signed-out task's reply box; then in a healthy task's.
  5. Press **Sign in**, then **Mark done** on the task, then finish the login.
  6. A task whose run says signed out while `claude auth status` says `loggedIn: true`.
  7. A task on a Claude CLI below 2.1.318 (`FAKE_CLI_VERSION`).
- **Expected:**
  - 1: *Claude Code is signed out*, the real line in the terminal block, **Sign in** there at first paint. The row reads *Signed out* in amber. Auto doesn't move the task.
  - 2: the paste box keeps its text and focus. Sign in, Cancel and Try again share one slot; from *Starting the sign-in…* through the link to *Checking the code…* the card keeps its height. *Continue* lights up once there's a code. On a phone the box and *Continue* each take the full width and stay above the keyboard. *Signed in. Sending your request again…*, then one new turn in the same conversation.
  - 3: no run starts by itself. The card says *Signed in* with **Try again**, which sends it once.
  - 4: nothing is sent to the agent. The signed-out task's sign-in starts; the healthy task opens Settings → Agents.
  - 5: *Signed in. Sending your request again…*, no new turn, then within about 8 s *Signed in* with **Try again**, unlocked.
  - 6: moments after the run ends the hero becomes *Claude Code couldn’t use its sign-in*, the row reads *Failed*, and the card has **Try again** and **Sign in again**, no **Sign in**. The raw line stays.
  - 7: the card carries the note about Claude Code before 2.1.318.
- **Suite** (`test/sign-in.test.js`), **Manual** (real Chrome)

### WEB-58 · No connection, in wisp's words
- **Preconditions:** a finished task open, then the browser offline (DevTools, or `ctx.setOffline(true)`).
- **Steps:**
  1. Type a reply and press Enter.
  2. Open Changes, or any panel not loaded yet.
  3. Stop wisp answering instead (`kill -STOP` its process). On a finished task, and on a running one with two queued follow-ups, type a reply and press Enter. After the toast, `kill -CONT` it and press Enter again.
- **Expected:**
  - 1: a red toast above the reply box says *Can’t reach wisp. Check the connection and try again.*, and the text stays in the box. Never *Failed to fetch*.
  - 2: the same words in the panel.
  - 3: the box empties and a finished task shows Working at once. By 20 s the text is back, the toast says *wisp took too long to answer. Try again.* and the finished task is back in Needs you. Sent again, the reply runs once (the stalled request may land first: one new turn, not two), the task doesn't stay on Working, and both queued follow-ups are still there, also after Stop.
- **Suite** (`test/api-errors.test.js`, `test/reply-send.test.js`, `test/reply-once.test.js`), **Manual** (real Chrome)

### WEB-59 · Old worktrees: what goes, what stays, and that it comes back
- **Steps:** with finished worktree tasks (one with an uncommitted file, one with an open PR, one kept with *Keep worktree*, one running, and a folder in `worktrees/` no task knows), open Settings → Worktrees. Set *Clean up automatically* to 3 days; click **Clean up N**; Remove the uncommitted one; reply to a cleaned task.
- **Expected:** rows show size, last use and when each goes, sizes and states arrive without the rows moving. Clean up asks once, then takes only idle clean tasks: the uncommitted, open PR, kept and running rows stay. Remove on the uncommitted one asks and names what's lost; on a running task it's disabled. The leftover goes only by its own Remove. The reply brings the folder back on its branch, with `.env`.

### WEB-60 · wisp stops answering
- **Preconditions:** a running task open, then wisp killed (`kill -9`).
- **Steps:**
  1. Watch the page for 4 seconds.
  2. Wait one more second, at 1440, 1000 and 390px, in both themes and in the app.
  3. On home and, stacked, on the list.
  4. Start wisp again.
- **Expected:**
  - 1: nothing shows, so a blip never flashes.
  - 2: *Reconnecting to wisp…* sits on the head's bottom edge, over no title or pill, and the working panel's dots and shine stop.
  - 3: it sits at the top, clear of the bar's buttons.
  - 4: it goes within about 2 seconds, and nothing else moves.
- **Suite** (`test/reconnecting.test.js`), **Manual** (real Chrome)

### WEB-61 · No output for 12 min
- **Steps:** with a task hanging on a fake agent (`FAKE_HANG`-style), leave it past 12 minutes, or move the page's clock forward. Reload. Send an activity event (a new step, or the result of a call that printed nothing). Then let a question reach it. Repeat with a delegate running, and with the page's stream dropped (offline in DevTools) past 12 minutes.
- **Expected:** the panel's status row says *No output for 12 min* at its right end (a narrow row gives up the count and the time first), counts up by the minute, and is there at once after a reload. New activity clears it within a second, and so does a question. No line while a delegate works or while the page has lost its stream and hasn't read the task again. Nothing else changes: no card, no toast, Stop as before. Light and dark, split view and 390px.

### WEB-63 · The list stays where you put it
- **Run:** `qa/web.mjs` for the launch and Open; a live run by hand (`FAKE_DELAY=3000`) for the rest.
- **Steps:** with 25 tasks, more than the list shows: launch from New task with the list at the top. Press **Open** on the toast. Open a task at the top, send a follow-up. While it runs, scroll the list to the end and let the run finish. Search (⌘K) for a task whose row is above, then below, the list's view. J and K through the list. At 390px, launch from New task.
- **Expected:** the launch leaves the list at the top with a *Sent to* toast, and with a short list the wisp flies to the row instead, no toast. Open shows the task and brings its row into view. The follow-up and the finish don't move the list: rows stay under the same spot (an invisible correction of a few dozen px is fine), even with the task's row off-screen. Search brings the row into view, clear of New task, and only if it's out of view. J and K scroll to the focused row. At 390px the launch goes back to the list with the new row in view.
