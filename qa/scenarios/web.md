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
  *What should wisp do next?*, the launcher (prompt box, the place as a laptop icon titled *Runs on this computer…*, permission
  mode, harness)
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
- **Expected:** two sessions in one group, each on its own branch; the compare row shows both.
- **Automated** (API), **Suite**

### WEB-22 · `/btw` side question
- **Steps:** on a task, follow up with `/btw did you update the docs?`.
- **Expected:** an answer appears without interrupting or adding a turn to the main run.
- **Automated** (API), **Suite** (`test/btw.test.js`)

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
- **Two tasks, same files:** two open tasks in one repo edit the same lines → both cards show an
  amber *Clash* pill (icon only on a phone), the open card's warning names the other task and the
  file with **Open**, and Ship it / Merge repeat it. The same file at different lines says *Overlap*
  and "merge cleanly". Merging or archiving one clears the other's warning.
  **Suite** (`test/overlaps.test.js`) · **Manual** in the page

### WEB-29 · Take over in a terminal
- **Steps:** *Take over* (`T`) on a finished Claude task; open another task, then the first again.
- **Expected:** the in-app terminal resumes `claude --resume <id>` in the worktree. Another task (or home) puts it away; back on the first task it shows again, with the same screen.
- **Suite** (`test/terminal.test.js`, `test/pty.test.js`) · **Manual** with a real CLI

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
- **Expected:** the chip shows the time only once you pause (*Starts at 14:35*, *Reminds you at 15:30*), Send's icon turns into a clock, and Alt+Enter would start it now. Enter clears the box at once and the plan shows in *Scheduled* (soonest first, time in the time column) and home's *Coming up*. Text that only mentions a time runs now; × makes it run now. The reply box's follow-ups show above it (*At 14:45 · set by you*), the card gets a clock pill (in *Needs you*) and moves to *Scheduled* once marked done. Changes, cancels and Undo show at once and roll back with a toast if refused. When due, the same task gets a new turn showing just the message, with its context (the agent remembers). The agent's `resume_later` shows as *Scheduling a follow-up in 2 min*, and its follow-up comes back into the same task. A due reminder lands in *Needs you* with a bell and *Reminder*, notifies, has no reply box, and snoozes back to *Scheduled*. Archived tasks drop their follow-ups. With the setting off, no chip and nothing is scheduled. The clock is enabled on an empty box; *Pick a time…* becomes a field in that row (no ring, the time on the right with ↵, Escape back to the row); Enter sets *Starts Tue 10:00* and puts the caret in the prompt; the typed *in 5 min* doesn't replace it, and the plan starts at 10:00 with the file. Light and dark, split view, feed and 390px.
- **Manual** (UI), **Suite** (`test/later.test.js`, `test/spells.test.js`, `test/routes.test.js`)

### WEB-36 · Side panel: shell in the worktree, PR without the noise
- **Steps:** ship a worktree task (fake `gh` with a failing, a running and two passing checks, an approval, a review thread, a person's and two bots' comments). At 1440px open it and click the action row's **Shell** button. Type `git status -sb`, then switch to another task and back; press `⌃\`` twice; *⋯* → *Copy path*; End shell (stop icon) → **End shell**, then **Start again**. Click the task's PR row: on **PR #1** open *2 passed*, *2 from bots*; **Ask to fix** on the failing check; **Send to agent** on the thread. Resize the panel by its edge, double-click it. At 1000px open the panel, press `[`. At 390px in the app: open the task, tap the **Shell** row, type, Back, tap the PR row, **Ask to fix**; open Shell again and press the phone's Back. Scroll a long task down, tap the pinned row's PR chip, Back, then its shell icon. Archive the task.
- **Expected:** the panel is a third column (480px) whose head is its tabs (*Changes · PR #1 · Shell*), the Shell button is pressed while it shows, the task's details fold into its bar and its PR row hides while PR shows. The shell starts in the worktree (*Starting zsh in … on This computer* shimmer first; a shell that prints nothing for 4s says *Still starting zsh: it runs your ~/.zshrc first*), keeps its screen across tasks (one that ended starts afresh when you come back to it: no dead screen), and isn't a take over (no *In terminal* pill, follow-ups still go). The place line shows the computer, branch, ↑ commits and changed files. Checks list failing first; passed ones fold into one row; bots' comments fold into *2 from bots*. Ask to fix fills the reply box with the check and the end of its log (not sent); at 390px it goes back to the task with the draft. At 1000px the list makes way while the panel is open, and `[` closes the panel and brings the list back. At 390px: the page's head is Back and the tabs (text only, equal widths); under the task's actions the PR row (chevron, Merge at its right end) and a *Shell* row (*This computer*, then *Running on This computer* with a green dot once one's started); each slides in as a page whose head is Back and *Shell* / *PR #1*, and Back (head or phone) returns to the task; scrolling a long task takes the whole bar away and pins one 48px row (state, action icons, the PR chip, the shell icon with a green dot while it runs) that opens the PR and the shell and goes when you scroll back up; the shell fills the page with the key row (Esc, ^C, Tab…); PR's verdict is a bar at the bottom; rows are 44px. Archiving ends the shell. On a machine or cloud computer the shell runs there; an older wisp there says to update it. Light and dark.
- **Manual** (UI), **Suite** (`test/workspace.test.js`, `test/spells.test.js`)

### WEB-43 · Side panel: Changes
- **Steps:** at 1440px open a finished worktree task, then in its worktree edit a tracked file in two places, add a new file under a deep folder with a long name, delete a file and touch `package-lock.json`. Click the action row's **Changes**. Open two files' diffs, scroll one sideways, **Expand all**, **Collapse all**; open the generated row; `⋯` → *Copy path*. Switch tabs with the mouse and with ←/→. Press `D` on another task; open one started without a worktree. Start a task that edits as it goes and keep Changes open on it. At 390px open the panel from the task's **Changes** button; at 360px look at the long path.
- **Expected:** the panel opens on *Changes* (the tab pressed, the action row's button pressed): *N files +a −d vs main*, files sorted by path with A/M/D badges, `+n −n` lined up in fixed columns, the deleted file struck through, the lockfile folded into *1 generated file*. Diffs open under their rows, numbered, the open row sticking to the top; Expand all flips to Collapse all. A long folder is cut from its start (*…/css/*) before the name shortens. Without a worktree the note says *Not a worktree: showing the edits wisp saw*, the summary *edits wisp saw*. While the agent works rows appear and update in place (no jump, open diffs stay open). Phones: Back and the tabs fill the head, rows are 44px. Light and dark.

### WEB-40 · Watch agents work
- **Steps:** at 1440px start a task whose prompt says `WATCH` (the fake agent opens a page with `wisp_watch`, sends a state per file, then closes it; `FAKE_WATCH_STEP=1600` slows it down) and open it at once. Watch it to the end; copy the *Run it yourself* command. Switch the system to dark. Reload. Close the panel, open it from the task's **Watch** button, then *More* → **Watch**, right-click → **Watch**, ⌘K *Watch*. Open the task's shell, start another `WATCH` task meanwhile and open it. At 390px start one and open it, tap **Watch** in the working card, then Back. Turn Settings → **Watch agents work** off and start another.
- **Expected:** the side panel opens by itself on *TS migration* (eye icon) with *Reading the project*, then a green pulsing dot and *Converting billing.js*… while the bar and the list fill in place: the frame never reloads or flashes. At the end the dot becomes a check and *All 6 files converted*; the page stays with 6 of 6. Copy gives `cd <repo> && npx tsc --noEmit`. Dark repaints the page without reloading it. After a reload the panel comes back on the page with its last state. While the shell shows, a new page doesn't take its place. The activity says *Opened Watch: TS migration* with the eye. At 390px the page doesn't open by itself; Watch opens it as a page with Back, the run strip at the bottom. Off: the agent isn't offered `wisp_watch` and nothing opens. Light and dark.
- **Manual** (UI), **Suite** (`test/watch.test.js`, `test/spells.test.js`)

### WEB-41 · Watch a running app
- **Steps:** start a second wisp (the "app") on another port with a task in it. At 1440px start a task whose prompt says `WATCHURL` with `FAKE_WATCH_URL` at that wisp, `FAKE_WATCH_PATHS` naming `/#/s/<its task>` then `/`, and `FAKE_WATCH_STEP=3500`. Open it; click the address's open button. At 390px tap **Watch** in the working card.
- **Expected:** the panel opens on *The app* showing the other wisp, live and usable; the caption line reads *Starting the dev server* with `localhost:<port>` and the open button at its right. Each navigate loads the frame at the new address (the other wisp opens its task, then the list), with the caption following; the reload loads it again. At the end *Done: the app is running*, the app still showing. The open button opens the address in a new tab. *Run it yourself* shows `npm run dev`. On a phone away from the agent's computer (no grid), a line says it points at the agent's computer. Light and dark.
- **Manual** (UI), **Suite** (`test/watch.test.js`)

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
- **Expected:** the hold row shows at once under the prompt box (no request, the prompt stays): *Claude Code’s weekly window is at 91%, past the 90% you set to ask at.* with **Start anyway** and **Wait until …**; Esc closes it and keeps the draft; a second Enter within 300 ms does nothing. Start anyway launches; follow-ups after that don't ask until 95%. Wait until moves it to Scheduled. The action reply shows the same row; Send anyway sends that reply (a new turn) and Wait until schedules it for the reset. The scheduled task lands in *Needs you* with a *Held* pill and *Weekly window at 91%* under the title; its page shows the prompt and the held card. Wait until moves it to Scheduled (*Waiting for the weekly reset*, the reset in the time column); Start now runs it at once; Skip leaves *Skipped before it started*. The picker says *Weekly window at 91%* in place of the model count. Each action is instant and rolls back with a toast if refused. Light and dark, split view and 390px.
- **Manual** (UI), **Suite** (`test/guard.test.js`, `test/spells.test.js`)

### WEB-38 · Edit and reorder what's waiting
- **Steps:** near the limit, press **Wait until …** on the hold row, then click the task under *Scheduled*. Change its prompt, press ⌘Enter; change it again and click away; change it once more and press Esc twice. Right-click the row → **Edit task**. On a running task queue three follow-ups (Queue on). Hover the second: click the pencil, change it, Enter; edit another and press Esc. Drag the first by its grip below the third. Right-click one → **Move up** / **Move down**. Hover a follow-up scheduled for a time → pencil, change it, Enter. Hover a queued one → **Combine with the next one**; right-click → **Combine all into one**. Hover one → **Send now** while the run works. Queue two more and press **Stop**, wait, then **Send now** on the second. At 390px tap a queued row. Reload.
- **Expected:** the plan opens as a page in the main pane (390px: a page over the list with Back) with the prompt in a box, Start now, Change start time…, Delete; its row is selected. ⌘Enter and clicking away save it, the row's title follows at once; Esc leaves the box, then the page, saving what was typed. The pencil shows on hover only (always on a touch screen) and nothing in the row moves when it does; Enter saves, Esc keeps the old text; a row's entrance never replays. While dragging the others make room; on drop *Next · after …* and *Queued #n* follow the new order. Every change shows at once, survives a reload, and rolls back with a toast if refused. wisp's own queued follow-ups (reports back) have no pencil. Combine leaves one row saying both, where the first was. Send now interrupts the run, and the next turn is that follow-up; the rest still go after it. After Stop the rows stay, the first marked *Held after Stop*, and nothing goes out until Send now or a new message, after which the rest carry on. A tap on a phone opens the row's menu (Send now, Edit, Combine, Move, Cancel). Light and dark, split view and 390px.
- **Manual** (UI), **Suite** (`test/e2e.test.js`, `test/spells.test.js`)

### WEB-42 · Open a delegate's task, and back up
- **Steps:** launch `DELEGATE the review, with @Ada` with two delegates (Codex, Claude Code Haiku) and a crew member Bo whose delegates are Ada and Codex; send `@Bo DELEGATE the check`. While the lead works, click a delegate's live row; once it's done, click the **→** on a report, and **Open @… task** inside an unfolded one. Esc; × ; **Go to the lead**. From Bo's job open Ada's job; open the trail's **…**. Copy the address of a subagent's task and open it in a new tab. At 390px do the same with Back.
- **Expected:** every delegate (agent or crew member) opens as a task of its own in the main pane; a subagent's row appears under its lead in the list (indented, no Mark done, Save or right-click menu) and leaves once you open an unrelated task. The head names the tasks above it (*Lead › Ada › job*; more than two levels fold into **…**, a menu of the rest), each opens that task. Esc, × and Back go up one level to the task it was opened from, then home. A subagent's task has no follow-up box: the dock says it takes work from its lead, with **Go to the lead**; Rerun, Take over, Ship it, Mark done and More are hidden. A pasted link to a subagent opens it under its lead. Light and dark, split view and 390px.
- **Manual** (UI), **Suite** (`test/spells.test.js`)
