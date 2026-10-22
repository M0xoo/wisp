# Changelog

All notable changes to `wisp-agents` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Light and dark mode in Settings → General → Theme**: System (follows your computer, as before), Light or Dark. It also switches from ⌘K, and a spell can set it (`settings.theme`). The page paints the chosen theme from the first frame.

### Changed

- **The top of split view's details column is a tidy list:** one fact a row (state and time, the harness, the project with its colour, the branch), each behind a small dot or icon so the text lines up. Before, a pill, a tag and the time sat on uneven lines.

### Fixed

- Opening a task in the feed no longer shifts its state pill and time sideways, and Done rows line up with the rows above them.
- In split view, the Mark done button on a selected or hovered row no longer leaves a clipped letter of the time beside it.
- The Queue toggle in a running task's follow-up box is now a switch: accent-coloured with the knob on the right when follow-ups queue, faint with the knob on the left when they send now. Spells can restyle it as `composer.queue`.
- In split view, when the open task moves to Working and its row is still in sight, the sidebar no longer scrolls to follow it.
- **Spell chips over the follow-up box work in split view.** Pressing one unfolded the box, the chip moved before the click landed, and nothing happened. Now only typing in the box unfolds it.

## [0.30.4] - 2026-10-23

### Changed

- **Mark done is green, like Reopen**, on the open task's bar, in split view's details column and next to the follow-up box, so the step that ends a task is easy to find.

## [0.30.3] - 2026-10-22

### Removed

- **Replay presentation.** It re-drew the task's report, which shows the same as before since reports reveal only the first time, so it looked like it did nothing. It's gone from *More*, ⌘K and the `R` key (`⇧R` still reruns).

### Fixed

- **No stray dot on flow diagrams.** Each wire's moving dot sat in the diagram's top-left corner until its animation started; it now stays hidden until it begins moving.

## [0.30.2] - 2026-10-22

### Changed

- **Merge and Fix conflicts sit in the same place on a PR.** The PR's next step always comes last: in split view's details column a full-width button after *Check now* (green Merge, red Fix conflicts), in the feed's PR row at its right end. Before, Fix conflicts came first and Merge last, so the button moved when the state changed.

## [0.30.1] - 2026-10-22

### Changed

- **Rerun… is in the open task's bar**, where Replay was (and in split view's details column): the same dialog as the task's right-click menu, `⇧R`. Replay presentation is under *More*, and `R` still does it.
- **An open task's *More* has everything its right-click menu has:** besides Rename, Copy task ID, Archive and Delete, now Save as recipe…, Merge PR, Compare runs, Replay presentation and the menu items spells add. With Rerun, Ship it and Mark done on the bar, split view's details column needs no right-click. *More* opens upwards when there's no room under it.

### Fixed

- **Picking a model, mode or computer keeps the follow-up box open in split view.** It folded back to one line as soon as the picker closed, so you had to click it again; it now stays open until you click or tab somewhere else, and after picking a model you're back typing in it.
- **Split view no longer throws an error every 30 seconds** while a task is open (its time moved to the details column; the refresh still looked in the header).

## [0.30.0] - 2026-10-22

### Added

- **↑ brings back the tasks you launched before.** In an empty prompt box, `↑` puts the last task you sent back in it, `↑` again the one before (the last 50 are kept); `↓` goes forward, and past the newest empties the box. Send one again with a tweak, or to another project, without typing it out. Once you edit it, the arrows move the caret as usual.

### Changed

- **What you type survives a reload.** A task half-written in the prompt box and unsent follow-ups are kept as you type, so wisp updating itself, `⌘R`, or the phone dropping the page no longer throws them away.
- **Marking an open task done opens the next one that needs you**, in the feed too (split view already did): read one report after another with `E`.
- **Split view is the default on big screens, and it's lighter.** With no layout picked, windows 1280px and wider open in split view and narrower ones in the feed (a layout you pick with `\`, the sidebar's layout button or Settings sticks; a feed saved before this goes back to the default once). The top bar is now the sidebar's head (search, layout, settings, the project filter) and *Get the app*, *Machines* and *Automations* sit at its foot, so the open task has the window's full height. Its header is just the title. On a wide window, a details column beside the task holds what used to be stacked over it: the harness by name, the project, when it last changed, the branch, the PR as a card of its own (state and checks, *GitHub*, *Merge*, *Fix conflicts*, Ship it's progress) and the actions with their keys. It stays put while the task scrolls, so they're in reach anywhere in a long report. The follow-up box is one line until you click into it. Sidebar rows give the title the width (the state and PR move under the time), and home is just the prompt box, since what needs you is in the sidebar beside it. Spells reach the new pieces: the `split.details` slot takes buttons, the `split.details` part a `width`, and `split.pr`, `split.actions` and `sidebar.foot` can be restyled or hidden.
- **The branch shows once per task.** A task's own worktree branch is in its header bar (the details column in split view); each message under it shows just the commit it started from (`ef90ec7`), not the branch again. A task in the project folder still names the branch when a turn ran on a different one.

### Fixed

- **Pictures in a reply can be zoomed, on a phone too.** Tapping one showed it a little bigger and no more: the phone app has no pinch zoom, and a pinch in a browser zoomed the whole page. It now opens full screen, where a pinch, a double tap or the wheel zooms in on that spot (up to the picture's own pixels and past), a drag moves around it, and − / + / 0 or the buttons at the bottom zoom too. A tap beside it, a swipe down, `Esc` or × closes it. Pictures attached to a task open the same way.
- **A file dropped next to the prompt box is attached instead of opened.** Dropped anywhere else on the page, the browser opened it in place of wisp, and the desktop app handed it to Preview. It now goes to the box you most likely meant: the follow-up box of the open task you dropped it on (or the one split view shows), else the prompt box, which lights up while you drag. A screenshot pasted while no box has focus lands there too, and a `.spell.json` dropped anywhere opens its review, as it was meant to.
- **A file dropped on the prompt box is uploaded once.** Every time the prompt box repainted (settings or harnesses loading), dropping a file uploaded it once more.

- **Signing in to a harness from Settings → Agents works on Windows.** wisp started `claude`, `codex` and `gh` directly, which can't run the `.cmd` shims npm installs them as there, so the sign-in failed at once. It now unwraps them the way it does for tasks.
- **Pasting a repo you already cloned reuses the clone on Windows** instead of cloning it again into `<name>-2`: git spells the folder `C:/Users/…`, Windows sometimes by its short name (`C:\Users\JOHNSM~1\…`), and wisp took them for two folders.

## [0.29.1] - 2026-10-22

### Changed

- **A tidier page on phones and keyboards.** On a phone the top bar's project picker shows its name again (it was squeezed to an empty pill), the prompt box's send button stays inside the box (where the task runs folds to its icon), the *in* label no longer takes a row of its own, task titles get two lines instead of a few words, and the open task's branch shortens before the labels after it. The layout switch is hidden below 720px, where split view can't start anyway, and touch screens don't show keyboard hints. Cards scrolling under the docked prompt box fade out instead of peeking around it. Every button and link shows a focus ring when you move with the keyboard, small grey text (times, counts, hints) has more contrast, Search calls tasks *Tasks* like the rest of the page, Settings → Notifications has a bell and Automations the same bolt as the top bar, and an open done task's title is no longer greyed out.

## [0.29.0] - 2026-10-22

### Added

- **Take over inside wisp.** *Take over* (`T`) can open the agent's own session in a terminal inside the page instead of a terminal app. On wisp Cloud, where there is no terminal app to open, it always does. In split view the terminal lies over the open task, in the feed it opens as a sheet, and on a phone it fills the screen with a row of keys a phone keyboard lacks (Esc, Tab, ⇧Tab, Ctrl, arrows, Paste). *Back* hides it and the agent keeps going. The card says *In terminal*, so you can open it again on any device: start on your laptop, carry on from your phone. Scrolling works with a wheel, a trackpad or a swipe, also in the full-screen modes of Claude Code and opencode, which scroll themselves and takes clicks (*Jump to bottom*). While the agent starts, the terminal shows a placeholder instead of a black box. You can take over a task that is still working: it stops the run and resumes it in the terminal. It ends when the agent exits, or with *End*. While it is open, follow-ups from the card wait for it. From your desktop, a cloud computer's tasks take over this way too (before, take over didn't work there), and so do an SSH machine's when Settings → General → *Take over in* is set to *In wisp*. Headless Linux servers pick it on their own. It needs macOS or Linux on the computer the task runs on, with Python 3 to resize the terminal. Spells can restyle it (`term`, `term.head`, `term.screen`, `term.keys`, `fontSize`), add buttons to its header (`term.head`) and set `terminal`.

- **GitHub Copilot CLI is a harness.** Pick *Copilot* in the launcher (or `wisp --agent copilot`) to run tasks on `copilot` with any model your Copilot plan includes: the picker lists the models `copilot help config` names (Claude, GPT, Gemini, Grok…), with a thinking level passed as `--reasoning-effort`. Its questions come to you through wisp's `ask_user` (added with `--additional-mcp-config`), follow-ups resume the same session, it can lead a team of subagents, and Take over opens `copilot --resume=<id>`. Plan runs in its plan mode, Edits allows file writes, Full auto passes `--allow-all`. Copilot can't hand a permission prompt to wisp, so commands it refused come back on the card with **Allow & retry**, which re-runs the turn with exactly those commands allowed (`--allow-tool=shell(npm publish)`). Usage counts its tokens; Copilot bills in premium requests, so its turns aren't priced. Needs the Copilot CLI signed in (`npm i -g @github/copilot`, then `copilot login`).
- **Delete your wisp Cloud account yourself.** Your account page on the grid ends with *Delete your account*: type your handle and your cloud computer, its files (your agents' sign-ins included), devices, sessions, stored secrets and the record of what you did are gone at once. Grid admins can do the same with `wisp grid users --delete <handle> --yes`. Before, deleting an account was not wired up at all.

- **wisp Grid says how many seats are left.** With `auth.maxUsers` set, the sign-in page shows *3 seats left*. Once the grid is full it says so before anyone goes through GitHub, instead of turning them away after. People who already have an account still sign in below. On grid.trywisp.dev the first button becomes *Get the next free seat*, which leads to the waitlist. `GET /api/seats` returns `{ open, invite, max, left }` so other pages can show the same count.
- **A guide for keeping Claude Code running overnight.** [Run Claude Code 24/7 without a VPS](https://trywisp.dev/guides/run-claude-code-24-7-without-a-vps.html) compares running your own server (tmux, SSH from the phone, upkeep) with wisp Cloud. The landing page's FAQ answers *Can my agents keep working when my laptop is closed?*

### Changed

- **wisp Grid no longer needs Docker, and can't read the boxes' homes.** A small root service, boxd (`grid/boxd.js`, `grid/deploy/wisp-grid-boxd.service`), runs, stops and deletes the users' containers for the grid over a Unix socket, building `docker run` from its own settings. The boxes' homes, where agents keep their logins, move to `/var/lib/wisp-grid-boxes` (root only). The grid runs as a system user outside the `docker` group, so a bug in it is no longer root on the server. `install.sh` sets this up, `grid init` uses it when boxd is running, and `wisp grid doctor` warns when a grid still runs docker itself. Existing grids move over with `node grid/boxd.js migrate` (grid/README.md → *Moving an existing grid to boxd*).
- **A box's proxy secret stays off the command line.** The container driver passes the box's environment in a 0600 file (`docker run --env-file`) instead of `-e NAME=value`, which anyone on the server could read with `ps`.
- **wisp Cloud's sign-up funnel is visible.** The grid.trywisp.dev sign-in page now counts visits and clicks in PostHog, like trywisp.dev. The grid reports when someone is sent to GitHub (`grid_auth_started`) and when they come back signed in or up (`grid_auth_finished`) or are turned away (`grid_auth_failed`), as the same anonymous visitor. Before, a click on *Sign in with GitHub* on the site was the last thing anyone could see. Self-hosted grids load no script.
- **trywisp.dev is upfront about wisp Cloud's seats.** The Cloud page, the landing page and the Cloud guide used to say *invite only* in some places and *open now* in others. They now show the live seat count. When the seats are gone, the Cloud links lead to the waitlist instead of a sign-in that turns people away. Clicks on them are counted (`cloud_cta_clicked`).
- **New link previews.** Links to the Cloud page, the Cloud guides and the grid's sign-in page show a preview card with the real app on a cloud computer. The main card shows the current tagline and the report.
- **The grid's sign-in page lists only the sign-ins that grid has set up.** It no longer shows a Google button on a grid that only offers GitHub.

## [0.28.2] - 2026-10-22

### Fixed

- **"Use Claude" after signing in from the harness picker picks it.** The harness list could arrive from before the sign-in was checked (often on a cloud computer, which takes seconds to look again), the launcher saw the harness as still signed out and went back to the one it had, so the button seemed to do nothing. A harness you just signed in to now stays usable until wisp's list catches up.

## [0.28.1] - 2026-10-22

### Changed

- **The Android app has wisp's icon.** The launcher shows wisp's orb instead of Capacitor's placeholder (with a themed icon on Android 13+), and the launch screen matches the page's light or dark background. Release builds sign with your Play upload key, and `mobile/README.md` walks through publishing on Google Play.
- **A privacy policy on trywisp.dev.** [trywisp.dev/privacy.html](https://trywisp.dev/privacy.html) says what wisp, the Android app, wisp Cloud and the site collect (and what never leaves your computer), how to turn usage stats off, and how to delete a wisp Cloud account. Every page of the site links to it.

### Fixed

- **Signing in and out shows what's happening.** After pasting Claude's code, the paste box used to sit there empty for seconds until the harness was ready; it now says *Checking the code…* (and comes back if the CLI asks for the code again). Signing out of a harness or a cloud computer, and waking one, take effect at once; a finished cloud sign-in shows *Adding it to Machines…* instead of the empty form; the phone app says *Checking…* when you're back from the browser; and the wisp Grid's sign-in, Allow and Sign out buttons spin while the next page loads instead of looking dead.
- **Signing out of Antigravity works.** Its *Sign out* only said *Sign out of antigravity in a terminal* and stayed signed in, since agy has no logout command. wisp now removes agy's login itself (the macOS keychain, or its file in `~/.gemini` on Linux and wisp Grid). An agent signed in by an API key in wisp's environment now says which key to remove instead.
- **Settings on a wisp Grid work again.** Opening Settings on a cloud computer stopped partway (the Connect pane has no machines summary to fill in), so Settings → Auto showed no goal, repair rounds or scout selected, and the buttons that open Memory, Automations, Usage, phone notifications and what Auto learned, plus Copy address on Connect, did nothing.
- **Signing in to wisp Cloud from the phone app brings you back to the app.** After *Allow* in the browser, the page's only link was *Your account*, so wisp Cloud opened in the browser and the app seemed not to connect. It now says *Back to the wisp app*, and the app opens your wisp as soon as you're back.
- **Cloud computers open inside the phone app again.** They were handed to the browser, so their page wasn't the app's: its top-bar button showed a cloud and *Connect* instead of taking you back to your computers.

## [0.28.0] - 2026-10-22

### Added

- **Signing in to an agent takes effect at once.** It used to read *Not installed* (and refuse a task) for a few seconds while wisp looked up every harness again. Now the picker and launcher treat it as ready as soon as the sign-in finishes, and only that harness is looked up again (here, or on the machine you signed in on).
- **Usage stats for wisp Cloud.** Anonymous counts of agent sign-ins, cloud sign-ins and the *Get the app* card, from a fixed list (the page can't send anything else). A wisp Grid can send its own (sign-ups, sign-ins, devices, boxes starting and sleeping) with `"telemetry": true` in `grid.json`; it's off by default.
- **Get the app, from the browser.** wisp in a browser tab (your cloud computer, or `wisp --browser`) has a *Get the app* button in the top bar: a short card on what the desktop app adds, and a link to trywisp.dev. *Hide this* puts it away; Search still has it. Not shown in the desktop or phone app.
- **A cloud computer's Settings make sense on it.** In your wisp on a grid, Machines becomes *Connect*: its address, and how to open it from wisp on your computer or the phone app through the grid, plus where to sign devices out. No SSH, no Cloud pane (you're already in it), and *This computer* reads *Cloud computer*.
- **wisp Grid: cap the number of accounts.** `auth.maxUsers` in `grid.json` lets the first that many people sign up, then says the grid is full; existing users keep signing in.
- **wisp Grid boxes come with every agent installed.** The user image now has Cursor, Grok and Antigravity next to Claude Code, Codex and opencode, so on a cloud computer you only sign in. Grok and Antigravity sign in from wisp too (a link and a code), and the model picker hides them until you do.
- **Sign in from the model picker.** An agent that's installed but signed out shows *Signed out* in Run with; pick it and the sign-in (link, code, paste box) appears right there, on this computer or on the computer it'll run on, then *Use Claude Code* picks it. No trip to Settings.
- **Cloud sign-in starts with grid.trywisp.dev filled in.** Settings → Cloud and the phone app's *Sign in to wisp Cloud* suggest the hosted grid; type your own grid's address to use that instead. The Machines dialog offers it too, under the SSH form: *Or use a cloud computer*. And the phone app's first screen now starts with a wisp Cloud card (address filled in, one tap to the code), above the steps for using your own computer.
- **wisp Grid: wisp for many people, on your own server.** `wisp grid serve` gives everyone who signs in (Google, GitHub, or your company's OpenID Connect) their own wisp at `<handle>.<your domain>`. It starts when they open it, sleeps when nothing's going on, and wakes for their scheduled tasks. Sign-in uses state, PKCE and checked ID tokens; each person's cookie only works on their own address; secrets are encrypted per user under a master key you can rotate. `wisp grid dev --fake-agents` tries it on your computer in one command, and `wisp grid init` / `doctor` set up a real one (guide: `grid/README.md`). For now each wisp runs as a process on one machine, which is fine for you and people you trust; it doesn't keep users apart from each other.
- **Sign in to Claude Code, Codex and GitHub from Settings → Agents.** No terminal needed: wisp runs the CLI's own login and shows its link, the code to enter, and a box to paste a code back. The login stays where the CLI keeps it, so on a cloud computer it's in your own folder and survives restarts. After GitHub, `git` pushes with it and commits get your GitHub name.
- **Sign in to the agents on a cloud computer from your desktop.** Settings → Cloud lists Claude Code, Codex and GitHub on each cloud computer with a Sign in button; the login runs and stays over there. (In the phone app, the cloud computer's own Settings → Agents does the same.)
- **The model picker only offers agents you're signed in to.** An installed CLI that says it's signed out (and has no API key set) shows as *Signed out* with a Sign in button instead.
- **Settings → Cloud.** Sign in to a wisp Grid from wisp on your computer: a code to allow in the browser, and your cloud computer joins Machines and Run on like any other. Watching it from here doesn't keep it awake; when it sleeps it says *Asleep*, its tasks still show, and sending it something wakes it.
- **Cloud computers in the phone app.** *Sign in to wisp Cloud* adds one next to your SSH computers: allow the code in the browser, then it opens like the others, with no SSH or Tailscale needed.

- **The phone app opens instantly.** wisp's page now comes from a cache on the phone (a service worker, only in the app) instead of over the SSH tunnel each time, and the tasks, open tasks and settings you saw last paint at once while the real ones load; a thin line under the top bar shows while they catch up, or while the tunnel reconnects. Once a computer's wisp has opened on the phone, tapping it (or starting the app) goes straight to that page and connects behind it: it catches up the moment the tunnel is up, and if it can't connect it says why, with a way back to Computers. When wisp on that computer is updated (or you switch to a computer on another version), the page reloads onto it by itself.
- **Feels like an app.** In the phone app, buttons and task headers press in when touched, a long press doesn't select them, sheets slide up and away (drag one down by its header, or tap outside it), the Computers list paints its keys before the plugin answers, and *Open* says *Opening* at once. Dark mode no longer flashes white between the list and wisp.

### Changed

- **Settings keeps its close button at the top.** Only the pane scrolls now: the section's name and the X stay put, also inside Memory, Usage and the other views it opens. On a phone (or any window under 640px) Settings fills the screen and starts as a list of sections; one opens with a back arrow, instead of a row of tabs to scroll sideways. On narrow panes a control that doesn't fit beside its text goes underneath it. Spells can reach the new pieces as `settings`, `settings.nav` and `settings.head`.
- **The prompt box no longer pops in piece by piece.** Before the page has its settings, it shows quiet placeholders the same size and shape as the folder chips, buttons and recipes, and the real ones fade in over them together, so nothing jumps.
- **Faster page loads, especially over a tunnel.** The server keeps the page's files in memory, gzips them, answers an unchanged file with a 304, and index.html preloads all of its modules at once instead of one import level at a time.

### Fixed

- **Auto on a machine picks from that machine's harnesses.** The *Harnesses it may use* list in Settings → Auto came from this computer and was applied everywhere, so on a cloud computer with only opencode signed in, Auto said it found nothing to run on. A place with none of the allowed harnesses now uses what it has. The list also shows harnesses that are only on your machines, and a harness only a machine has no longer stays on probation for good.
- **Settings in the phone app says *Notifications*, not *Desktop notifications*.**
- **The phone app no longer shows a browser error when wisp stops on the computer.** SSH could stay connected after wisp itself quit or crashed there, and the app then loaded a page nobody served. Now the app checks wisp through the tunnel every 15 seconds. If wisp stops answering and SSH can't reach its port either, the app starts wisp again over SSH and reopens the page. If the page fails to load anyway, the app goes back to Computers, which shows *wisp stopped on that computer. Starting it again…*, and reopens wisp once it answers.
- **A task's result reveals itself once.** The staggered entrance (blocks rising in, numbers counting up, the terminal typing its command) plays the first time you see a result; opening the task again just shows it.
- **No keyboard shortcuts in the Android app.** The phone has no keyboard to press them on, so the app no longer shows *Keyboard shortcuts* (or the feed / split view switch) in search, the *Press ⌘L to start typing* prompt hint, the palette's ↑↓ footer, or the key hints in Settings descriptions.

## [0.27.0] - 2026-10-21

### Added

- **Machines for first-timers.** Machines now explains itself in three steps (get the other computer ready, add it, let this computer in) and speaks plainly: *Its address* instead of *SSH host*, and each failure says what happened and what to do (*This computer isn’t allowed in yet*, *Computer not found*, *SSH is off there*, *No answer*), with a link to the Tailscale guide when the computer is out of reach.
- **Let me in, with your password once.** When a machine doesn’t know this computer’s key, Machines asks for your password there instead of sending you to `ssh-copy-id`: wisp signs in with it for one `ssh` call that adds this computer’s key (making one first if you have none), then connects. The password is never stored. Cloud servers that refuse passwords get the by-hand command instead.
- **A computer with only SSH on is enough.** When Node.js is missing (or older than 20) on a machine, wisp installs the current LTS into `~/.wisp/node` on its own: downloaded from nodejs.org, checked against its SHA-256, no admin rights. Desktop Machines and the phone app both do it.
- **wisp for Android (prototype, `mobile/`).** Save your computers and use wisp on them from your phone: the app connects over SSH, starts wisp there with the same script desktop Machines uses (or reuses the running one), forwards its port and shows wisp's own page, so every feature works the same. Each machine uses a key you pick: make one on the phone (the sheet shows the `authorized_keys` command), import an OpenSSH, PEM or PuTTY key, or type a password just for that connection. The connect steps show on each machine's card. One machine is connected at a time and switching takes one tap. A dropped connection comes back on its own. Inside the app, wisp hides Take over, *Open in editor* and keyboard hints. The app calls what it connects to **Computers** (Machines stays the desktop SSH feature). Adding one takes its address and your password once; the app installs its own key there, then Node.js and wisp if they’re missing. Inside wisp, **Computers** in the top bar (and Settings → Computers) goes back to the list; the app opens the last computer used when it starts. See `mobile/README.md` to build it.
- **Notifications in the Android app.** A task that finishes, asks a question or needs your approval now shows an Android notification when the app isn't on screen; tap it to open that task. The app asks for the permission the first time wisp opens, and Settings → Notifications switches it off (or says where to allow it in Android settings). While a machine is connected, a quiet *Connected to …* notification keeps the tunnel open in the background, so alerts keep coming with the screen off. Before, the page relied on the browser's Notification API, which Android's WebView doesn't have, and Android froze the app soon after it left the screen, so the phone only got the in-page toast.
- **Settings → Machines → This computer.** Checks whether another computer, or the phone app, can connect here over SSH: whether an SSH server answers, whether Tailscale is up (and Tailscale SSH), and how many keys are in `authorized_keys`. Each missing piece comes with this OS's command to copy (Remote Login on macOS, openssh-server on Linux, WSL on Windows), plus the `user@host` to connect with. Spells can restyle or hide it (`settings.reachable`).
- **Guide: Connect your machines with Tailscale.** Get a machine ready, connect from the laptop and the phone, and turn on Tailscale SSH for no keys at all. Linked from the README, the Machines guide and the landing page.

### Fixed

- **The PR row stays on top of the follow-up box.** It now sits in the composer's dock, so in split view it's pinned to the bottom with the box instead of scrolling away with the transcript.
- **Split view no longer scrolls the task list to the task you open.** Clicking a task, opening one from the home list, a notification or the palette used to slide the sidebar to it, like the feed does; the task opens in the main pane, so the list now stays where you left it. `j` / `k` still keep the focused task in view.
- **Open tasks no longer stay on "Loading…" after the phone app comes back.** When the app returned from the background, the SSH tunnel was often down or silently dead for up to a minute, and a task that failed to load in that window stayed on *Loading…* for good. Now wisp keeps trying (and reloads every open task once the connection is back), starts a fresh live connection after a while away, and the app checks its tunnel the moment it's back in front and reconnects right away instead of waiting out keep-alives or a retry delay.

## [0.26.0] - 2026-10-21

### Added

- **Split view.** A second layout: every task in a sidebar on the left (Needs you, Working, Done, Archived, as in the feed) and the open one beside it, with its title, pills and actions in a header, the conversation in a reading column and the follow-up box pinned to the bottom. With nothing open, the main pane is home: the prompt box, what needs you, and the keys. Switch with `\`, the new top bar button, ⌘K → *Split view* / *Feed view* or Settings → General → Layout (saved as the `view` setting). `J` / `K` move through tasks with each one open, `Esc` and `N` go home, `E` marks done and opens the next one. Drag the sidebar's edge to resize it (double-click resets). Each task keeps its scroll position: go back to one and it's where you left it (at the end if you were at the end, so new turns show). Windows narrower than 900px keep the feed. Spells reach all of it: `settings: { view: "split" }`, new `sidebar.top` and `split.head` slots, new parts (`sidebar`, `sidebar.new`, `split.main`, `split.home`, `split.head`, `split.title`, `split.body`, `topbar.view`, …) and props (`sidebar` `width` / `side: left|right` (left by default) / `details: minimal|full`, `split.main` `readWidth`, `split.home` `greeting`).
- **AGENTS.md.** Notes for agents working on wisp: layout of the repo, how to test, and the rule that every new piece of UI is reachable by spells through `web/js/spell-schema.js`.
- **`/spell` works in follow-ups.** Type `/spell a floating button that opens my PRs` in any task's follow-up box to cast a spell, the same as from the prompt box; the follow-up isn't sent to that task. The `/` menu there now lists `/spell`.
- **Spells on the site.** The landing page has a Spells section with a working copy of casting one: pick an ask (a floating PRs button, tool stats in the top bar, compact cards, quick replies, a deploy block, a violet look) or type your own, watch the agent's steps, and a small wisp window changes the way the app does. Each spell gets a switch, its reach and its real JSON file; switching it off puts the window back. The spells guide now opens with the same demo and covers what's in a spell file, every slot and action (with its reach), data sources and scripts, blocks, prompt rules and hooks, sharing, the `wisp spell` commands and what to do when something looks wrong. Its reference tables come from wisp's own spell schema.

### Changed

- **Spells have a wizard hat icon.** Everything spell-related (Settings → Spells, ⌘K *Cast a spell…* and *Spells*, the cast dialog and spell cards, spell buttons without their own icon, *Set by …* labels, the try bar and toasts, and the site's spells demo) used the same sparkle as Auto, Memory and Recipes; it's now a wizard hat. Spells can use it as `wizard` in their own buttons. Text output (`wisp spell cast`, reports, phone notifications) uses 🧙 instead of ✨.

## [0.25.0] - 2026-10-21

### Added

- **Spells: change wisp itself, by asking.** A spell is a change wisp layers over itself at runtime: a floating button that opens all your PRs (with how many), a top bar button with your tool stats, a `deploy` block agents can use in their reports, compact cards with an Open PR button on hover, quick replies above the follow-up box, a monospace prompt box with a *Plan on Codex* button, a hook that sends a task back once when its tests fail. Cast one from ⌘K → *Cast a spell…*, Settings → Spells, `/spell …` in the prompt box or `wisp spell cast "…"`. An agent writes it in an empty folder of its own, using new `wisp_spell_schema`, `wisp_spells`, `wisp_spell_data` and `wisp_spell_check` tools, and its report ends with the spell: a live preview with your real data and what it does in plain words. **Try it** applies it to the window only; **Keep** turns it on; a follow-up changes it. Spells add buttons, chips and panels to named places (top bar, floating, prompt box, follow-up box, card head / hover / menu / body, ⌘K, above the feed), restyle or hide named parts, recolour wisp, add block types and prompt rules for agents, `/commands`, settings (shown as *Set by …* in Settings) and hooks. Their data comes from read-only wisp routes and read-only `gh` commands that wisp runs; their code runs in a sandboxed frame with no network, DOM or API and can only return values and blocks. Each spell says how far it reaches (Safe, Acts for you, Reads GitHub, Runs commands). Turning one off puts wisp back exactly as it was; `WISP_SAFE=1` turns them all off. Share a spell as a `.spell.json` file, pasted JSON or a link: Settings → Spells (export, copy, import by file, paste or link) or `wisp spell install|on|off|rm|export`. API: `/spells` (list, install, `check`, on/off, export, data, `try-data`, `off`), `POST /open`, `GET /usage/tools`, and `kind: "spell"` on `POST /sessions`.

### Fixed

- **Spell inputs look like the rest of wisp.** In Settings → Spells and the *Cast a spell* dialog the prompt box was a 32px input squeezed to one line with its resize grip over the text, and *Paste JSON or a link* was monospace; both sat flush against their panel's edge. They now use wisp's standard text box and input, inset like every other settings row.
- **Settings → Spells casts from a prompt box like the launcher's.** The Cast button no longer sits beside the text box: the prompt is a rounded box with the launcher's focus ring and an Enter button in a bar under the text, it grows as you type, and a click anywhere on it puts the cursor in. Long example prompts wrap inside their chip instead of running over the next one.
- **Space above "Needs you" is back.** When something needed you, the first feed group sat flush under the launcher's recipes row.
- **Codex can use wisp's tools outside Full auto.** In Edits and Plan mode `codex exec` refused every MCP call ("requires approval, but approval policy is never"), so `ask_user` and the other wisp tools failed there. wisp's own MCP server is now pre-approved.
- **A report whose last block lost a closing brace keeps that block.** Agents sometimes drop a `}` after a long string (a spell's script); wisp used to skip the block with a warning, and now closes it.

## [0.24.1] - 2026-10-20

### Fixed

- **Update now updates, however you installed wisp.** **Update to X** installs the new version and restarts wisp for every install route: `npx`, `npm install -g`, the `install.sh` script, and now Homebrew. On a Homebrew install it used to run `npm install -g` and then restart the old keg. Now it runs `brew upgrade m0xoo/tap/wisp-agents` and restarts from the new keg. If the install leaves wisp on the same version (the tap doesn't have the release yet, or npm installed into a different folder), the button says so instead of restarting into the old version and then reporting that wisp didn't come back. A git clone of the repo no longer shows the button or tells you to run `git pull`. `GET /update` no longer returns `auto`, and the method can now be `brew`.

## [0.24.0] - 2026-10-20

### Added

- **How to get a missing harness, where you look for it.** Settings → Agents now shows, for each harness wisp didn't find, what to do on that computer's OS: a one-line tip (e.g. that the ChatGPT app is enough for Codex on macOS and Linux but not on Windows, or that the Antigravity and Cursor editors don't include their CLIs), the install command to copy with one click, and a **Docs** link. In the harness picker, hovering a greyed-out harness shows the same tip, and clicking it (or arrowing onto it) shows the steps in place of its models, with **Re-check** (and **Install** for opencode). It still can't be picked. API: unavailable harnesses in `GET /agents` carry `setup: { tip, command?, url }`; adapters provide it through an optional `setup(platform)`.
- **Codex and Claude Code from their desktop apps, no CLI install needed.** If `codex` isn't on PATH, wisp uses the Codex CLI the ChatGPT desktop app ships: `ChatGPT.app/Contents/Resources/codex-cli/bin/codex` on macOS (or `Codex.app/Contents/Resources/codex` from the older Codex app), in `/Applications` or `~/Applications`, and `/usr/lib/chatgpt/resources/codex` from the Linux `.deb`. It shares `~/.codex`, so the app's sign-in carries over. The Windows app is a Store package whose files can't be run from outside it, so on Windows Codex still needs the CLI. If `claude` isn't on PATH, wisp uses the newest copy the Claude desktop app downloads for its Code tab, on macOS and Windows (`<app data>/Claude/claude-code/<version>/…`, including the Store installs' folders). That copy is signed in only while the app runs it, so run it once and `/login`. Both adapters also look in the CLIs' own install folders (`~/.codex/packages/standalone/current/bin`, `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin`, `~/.local/bin`, `~/.claude/local`), which an app started from the Dock or Start menu may not have on PATH. A `WISP_CODEX_BIN` or `WISP_CLAUDE_BIN` override still wins.

### Changed

- **The website shows moving a task to another computer or agent.** A new landing-page section, *Start on your laptop. Finish on the dev box.*, has a working copy of a task card's follow-up box: pick a computer under **Runs on** and an agent, press ↵, and it packs the work, hands the history over and carries on there, the way the app does. It plays once by itself when it comes into view; click anything to try it. A new guide, [Move a task to another machine or agent, mid-way](https://trywisp.dev/guides/move-a-task-to-another-machine-or-agent.html), covers doing it by hand with `git bundle`, what wisp moves, what each agent is told when you switch harness, model or computer, and the CLI and API. The landing FAQ answers it too, and *Machines* is in the landing nav. In *Also in the box*, the Machines tile became *Several folders*, since machines now have their own section. The landing nav no longer wraps onto two lines between 960 and 1200px wide; it drops Control and CLI there.

### Fixed

- **The site builds the same on Windows.** With a CRLF checkout, the integrations page kept its markdown title as a second `<h1>` and the changelog page repeated each release heading, because `scripts/site.mjs` matched `\n` line ends only. It now normalizes line ends when reading `docs/integrations.md` and `CHANGELOG.md`, and the site test passes on Windows CI.
- **Done and Archived count every task and load more as you scroll.** Their headings always said 60 once you had more than that, and the older tasks never showed. The headings now count them all, the lists show 60 cards at first and add the next 60 as you scroll near the end (or click **Show 60 more · N left**), and opening an older task from a notification or ⌘K shows the cards down to it.

## [0.23.0] - 2026-10-20

### Changed

- **Auto's Balanced goal runs frontier models.** When you have a frontier model installed and allowed (Opus, Codex's default, Gemini Argon, Grok 4.x), Balanced now picks it, at the harness's default or medium thinking, instead of Sonnet or Haiku. Best stays on frontier models at high or x-high, so the thinking level is what sets the two apart. Balanced steps down to an everyday model (Sonnet, never Haiku) only while every frontier model is at its limit, so the task still runs, or when you have none; small models' wins no longer pull Balanced to them after 20 outcomes. Cheap is unchanged. For models with the level in their name (Antigravity's `gemini-4-argon-low` / `-medium` / `-high`), the goal now picks the variant: Cheap low, Balanced medium, Best high, and the other variants count as the same model.
- **Guides on the website for what people search for.** Six new pages under [trywisp.dev/guides](https://trywisp.dev/guides/): [run Claude Code and Codex in parallel](https://trywisp.dev/guides/run-claude-code-and-codex-in-parallel.html), [run multiple Claude Code agents in parallel](https://trywisp.dev/guides/run-multiple-claude-code-agents-in-parallel.html), [run coding agents on multiple machines](https://trywisp.dev/guides/run-coding-agents-on-multiple-machines.html), [multi-agent coding](https://trywisp.dev/guides/multi-agent-coding.html), [Claude Code vs Codex on your own repo](https://trywisp.dev/guides/claude-code-vs-codex.html) and [run coding agents in the background](https://trywisp.dev/guides/run-coding-agents-in-the-background.html). Each answers its question in the first paragraph, shows the manual way with `git worktree` and `ssh`, then how wisp does it, and ends with FAQs (with `FAQPage` structured data). `scripts/guides.mjs` holds them; `scripts/site.mjs` renders them into the sitemap. The landing page's title, description and structured data now say *in parallel* and *on your other machines*, its FAQ answers both questions, and Guides is in the nav and footer of every page. The npm description and keywords match.

## [0.22.0] - 2026-10-20

### Added

- **Full transcript, when you want it.** Turn on Settings → General → **Full transcript** and every card shows its run as a timeline: the agent's messages in full, every step it took (commands, reads, edits, searches, questions), and at the end its presentation, rendered as blocks as usual. Click a step to see the whole command and what it printed, the diff that one edit made, or the full error. Long runs of steps fold their middle, and **Jump to the result** skips to the end. While a task runs, the timeline grows live above a one-line status bar with Stop. Any card can switch either way with its **Transcript** button or `V` (also in ⌘K), and keeps that choice. Off by default. Agent messages are now kept whole (they used to be cut at 600 characters), and so is the output of each command, search, web or MCP call, up to 2,000 characters (its start and end), from Claude Code, Codex, opencode, Cursor and Grok. Turns from before this change show their steps without output.
- **Every project runs on every machine.** Projects are no longer tied to one computer. Pick any project, pick a machine under **Run on**, and launch: if the machine has no checkout of it yet, wisp finds one there (a project or a git repo in the usual folders with the same origin) or clones the repo's origin into the machine's clone folder, then remembers it. The launcher shows one row of projects for all the places you picked, the card says "Cloning … on devbox" while it does that, and the Projects dialog lists every project with the places it's checked out on. A folder you add on a machine that's the same repo as a project you already have joins that project instead of becoming a second one. Repos without a git remote can't be cloned this way; wisp says so.
- **Move a task to another computer with a follow-up.** The composer has a new **Runs on** button (shown once you have a machine). Pick another computer and your next follow-up moves the task there: its branch, uncommitted and untracked changes travel as a git bundle and land in a worktree on the same branch, and the earlier turns come along as history, so the harness there is told what happened before it continues. The old session is archived with a "Continues on …" link; the new card shows "From …" and tags each earlier turn with where it ran. A running task has to stop or finish first. API: `"machine"` on `POST /sessions/:id/reply` (`""` for this computer).
- **Rerun on another computer.** The rerun dialog has a **Run on** picker; the rerun uses that computer's checkout of the project, cloned there first if needed.
- **`/btw` side questions.** Type `/btw did you update the docs too?` in a card's follow-up box to ask while the agent works, without interrupting it. A separate read-only run answers it, and the answer shows on the card under the turn you asked during. Claude Code, Codex and opencode answer on a copy (fork) of the agent's conversation, so they know what the run did and why; the task's own conversation never sees the question. Cursor, Antigravity and Grok, and CLIs too old to fork, get wisp's record of the task instead: requests, reports, actions so far and files changed. It also works when the task isn't running, and it adds no turn. Dismiss an answer with its ×; dismissing one that is still running stops it. Typing `/` in the box opens a small command menu (`/btw`, `/feedback`), and a working task shows a quiet **Tip: `/btw` asks without interrupting** next to Show all activity. Click it to start one in the box. It goes away after your first `/btw`, or when you hide it with its ×. CLI: `wisp btw <id> "question"` prints the answer, and `wisp reply <id> "/btw …"` works too, as does a `/btw` reply from Telegram. API: `POST /sessions/:id/btw`, `DELETE /sessions/:id/btw?item=<id>`. SDK: `wisp.btw(id, text)`.

### Changed

- **No folder is picked by default when wisp has no folders.** With no projects added, the launcher now starts on **No folder**, so a prompt runs right away in an empty scratch directory instead of opening the folder picker. Adding a folder picks it, as before.

- **The website is now [trywisp.dev](https://trywisp.dev/), with more pages for search engines to find.** Canonical, Open Graph, structured-data, `robots.txt`, `llms.txt`, the install script and the npm and Homebrew `homepage` use the new domain. The site gained a page per harness ([Claude Code](https://trywisp.dev/agents/claude-code.html), Codex, Cursor CLI, opencode, Antigravity CLI, Grok Build) that shows how wisp runs that CLI: the flags behind each permission mode, how it asks you questions, `/btw` and the take-over command. An [agents overview](https://trywisp.dev/agents/) compares them, and the integrations guide and changelog are now [pages on the site](https://trywisp.dev/changelog.html) instead of GitHub links. `scripts/site.mjs` (`npm run site`) builds these pages, a `404.html` and a `sitemap.xml` with each page's last-commit date. The Pages workflow runs it before each deploy, redeploys when `CHANGELOG.md` or an adapter changes, and pings IndexNow (Bing and friends) afterwards. The harness logos on the landing page link to their pages.

### Fixed

- **The Auto-fix PR conflicts switch works on its own.** In Settings → General it only responded after you had clicked Worktree per task in the same visit.
- **Chevrons inside Done cards point the right way.** Showing the Done list rotated every chevron in its cards too, so collapsed cards looked open.
- **The rerun dialog's Rerun button no longer slides off the edge.** With the **Run on** picker added, the bar under the prompt (place, mode, harness) was wider than the dialog and pushed **Rerun** out of view. The dialog is a little wider, and when space runs short the harness name folds first (its logo stays), then the model; on narrow windows the place and mode buttons show only their icons.

## [0.21.0] - 2026-10-20

### Added

- **One task across several folders.** A task can now work in more than one project at a time, for example an API and the web app that uses it. In the launcher, ⌘-click (Ctrl- or Shift-click) a second project chip, or click the **+** on its corner or next to it in the project list. One agent starts in the first folder and can read and edit the others: Claude Code and Codex get them as `--add-dir`, and every harness is told the paths. Each git repo gets its own worktree. The card reads `api + web` and shows up under either project's filter. **Ship it** opens a pull request in each repo that has changes, and **Merge all** merges them together and syncs each local base branch. CLI: `wisp "…" --also ~/code/web` (repeatable). API: `"also": [folders]` on `POST /sessions`. MCP: `also` on `wisp_launch`.

### Fixed

- **The launcher's project row no longer throws while it isn't laid out.** Refitting the chips of a launcher that had just been painted over (or folded into the dock) read the position of a chip that wasn't there.

## [0.20.0] - 2026-10-19

### Added

- **Fix conflicts button on every conflicting PR.** When a PR has merge conflicts, its row on the card now has a **Fix conflicts** button (with a merge icon) that sends the task a follow-up to merge the base in and resolve them; wisp pushes the result to the PR. The row switches to "Fixing merge conflicts" as soon as you click, and the follow-up starts without waiting on a fetch first.

### Changed

- **PR conflicts are no longer fixed without asking.** wisp used to send the merge follow-up on its own as soon as a PR conflicted. Now it waits for your click on Fix conflicts. To get the old behaviour back, turn on Settings → **Auto-fix PR conflicts**.
- **PR status updates faster.** A PR whose checks are running, whose mergeability GitHub is still working out, or that was just pushed is now checked every 10 seconds instead of every minute, so a passing check or a cleared conflict shows up quickly. The refresh button on the PR row spins while it checks.
- **Auto no longer runs Best tasks twice by default.** Best of two (two picks side by side, the better one marked) is now off unless you turn it on in Settings → Auto → Best of two, or with `PATCH /api/router` `{ "best2": true }`. With the Best goal, a task now runs once, on a single pick. Your manual **vs** Compare in the launcher is unchanged.
- **Auto's Best goal runs frontier models only.** Best now always picks a frontier model (Claude Opus, Codex's default, Grok 4, Gemini Argon), never an everyday or small one like Sonnet or Haiku, however well those did on your past tasks. Before, that was only true for your first 20 outcomes. If every frontier model is busy or at its limit, Best waits instead of stepping down: best-of-2 runs a single pick, and a move at a usage limit stops with a note. Only when you have no frontier model installed (or allowed) does Best use the strongest one you have.
- **An open card stays open when its task finishes.** It used to fold shut if you had scrolled away or switched windows while it worked; now it lands in "Needs you" still open, with the result ready to read.

### Fixed

- **Right-click menus no longer get cut off at the bottom of the window.** The task, project and queued-message menus measured themselves mid pop-in animation, while still scaled down, so near the bottom edge the last item ("Delete session") ended up below the fold. They now measure their real size and stay fully on-screen.

## [0.19.0] - 2026-10-19

### Added

- **Auto picks the thinking level too.** Auto's options are now harness · model · thinking level (`claude:opus:high`), and the goal sets the range of levels: **Cheap** runs low (or minimal), **Balanced** the harness's default or medium, **Best** high or x-high. Within that range Auto learns which level works for each kind of task, the same way it learns models. A model's record at one level counts half at its other levels. Harder thinking starts out a little more likely to work and costs more, and then your outcomes decide. Compare runs and hand-overs use a different model, not just a different level. A rate limit rests the model at every level. A follow-up that changes the level counts as a miss for Auto's pick. Settings → Auto lists the levels it has a record for. Harnesses and models without levels run at their default, as before.

### Changed

- **Shell commands read as English in the live ticker.** Instead of `Running sed -n 15,50p server/a.js`, a task now shows "Reading lines 15–50 of server/a.js". wisp knows the common file, search, git, gh, npm/pnpm/yarn, Python, Node, cargo, go, make and docker commands, follows `&&` chains and pipes (`git status && git diff --stat` → "Checking git status, then summarising changes"), and looks inside `bash -lc '…'`. Works for every harness; a command it doesn't know still shows as `Running …`, and the exact command stays in the activity detail.

## [0.18.1] - 2026-10-19

### Fixed

- **The published 0.18.0 package was missing the Auto checks.** It was built before they merged, so `npm i -g wisp-agents` got none of the entry below. 0.18.1 ships them.

### Added

- **Auto checks the work before it reaches you.** When an Auto run says it's done, wisp runs the project's tests itself: `npm test`, pytest, `go test`, `cargo test`, `make test`, and so on. You can set the command, or turn the check off, per project in **Settings → Auto → Open**. A failure only counts if the test passed before: wisp compares with the base commit and runs a failing suite twice.
  - **Repair:** tests that used to pass now fail, so they go back to the same agent. One round by default; the turn shows as **Sent by wisp**.
  - **Hand over:** still failing, so the task runs again on a stronger tier (small → everyday → frontier) in its own worktree. Both runs show as one task.
  - **Usage limits don't count against a model.** When a harness says it's at its limit (Claude's session limit, a rate limit, no credit left), the run doesn't count as a failure. That harness, or just that model for a rate limit, rests until its limit resets, and the task moves straight to the best pick that can run now (**Moved on**). Settings → Auto → Open shows what's resting and until when.
  - **Quality first until Auto knows you.** Until Auto has 20 of your own outcomes, Balanced only picks everyday and frontier models, and Best only frontier ones. The shipped starting estimates count for less (at most 4 tasks each).
  - **Best of two:** with the **Best** goal, two picks work side by side and wisp marks the better one. Tests decide first, then a cheap model reads both diffs.
  - **Scout:** before a bigger task starts, a cheap model looks around the repo and tells the agent which files matter and how wisp will test.
  - Each turn gets wisp's own tests block (**Run by wisp**). If the agent said "done" and wisp's run disagrees, the turn says so and the card shows **Partial**.
  - Cards show **Tests** / **N failing**, **Pick** and **Handed on**.
  - Your own follow-up or Stop cancels whatever Auto was about to do next. Settings → Auto turns each step on or off. API: `PATCH /api/router` with `check`, `repairs`, `escalate`, `best2`, `scout`; `PATCH /api/projects/:id` with `testCommand`.

## [0.18.0] - 2026-10-19

### Added

- **Merge conflicts on shipped PRs fix themselves.** When something lands on `main` and your shipped PR no longer merges, the task used to sit there until you noticed on GitHub. Now wisp sees it on its PR check (every minute, or when you press refresh): GitHub reports the PR as conflicting, and wisp confirms it locally with `git merge-tree` against a fresh fetch of the base, so a stale GitHub answer can't start a run. The task then gets a follow-up asking it to merge `origin/main` in (no rebase, since the branch is pushed), resolve each conflict keeping both sides' intent, run the cheap checks and commit. When that run ends, wisp checks the merge is complete: no unmerged files, the base is in the branch, no leftover `<<<<<<<` markers. Then it pushes to the PR, and the card shows the usual Push → PR track. While it works, the PR row reads *Fixing merge conflicts* and hides Merge. If the agent stops halfway, nothing is pushed: the card comes back unread with *Conflicts not fixed* and the reason, plus a **Fix conflicts** button to try again. wisp tries once per PR head and at most 3 times per task, so a base that keeps moving can't run up the bill. On by default; turn it off in Settings → General → **Fix PR conflicts** (`defaults.fixConflicts: "off"`). API: `conflict` on the PR, `conflictFix` on the session summary, `POST /api/sessions/:id/fix-conflicts`.

- **Tasks without a folder.** The launcher has a **No folder** chip next to your projects, for general asks that have nothing to do with a repo (explain a concept, draft a message, research something). The agent runs in an empty scratch directory under `~/.wisp/scratch`, with no worktree, and the task shows under *General*. The folder is not added to your projects. The Worktree toggle hides while No folder is picked, and deleting the task deletes its scratch folder. API: `POST /api/sessions {"prompt","scratch":true}`.

- **Add a project from a GitHub URL.** Paste `https://github.com/owner/repo` (or `git@github.com:owner/repo.git`, a link to any page inside the repo, or any other git URL) into Projects and the button turns into **Clone**. Click it and the dialog closes: the launcher already points at the repo (a chip with a spinner, *cloning…*) and the prompt has focus, so you write the task while it clones. Send it before the clone finishes and the task card shows *Cloning owner/repo*, then starts in the clone. If the clone fails, a toast says why, the launcher goes back to the project you had picked and your task comes back into the box. A feed filtered to another project switches to All, so the launcher isn't pulled back to that project. GitHub repos go through `gh repo clone` when gh is installed, so private repos work with your gh login; otherwise plain `git clone`. Repos land in `~/code` (or the first of `~/dev`, `~/Developer`, `~/projects`, `~/src`, `~/repos`… that exists). Click the path in the hint to change it (`defaults.cloneDir`). If the folder there already is that repo, wisp reuses it; another folder with that name gets a `-2` suffix. When gh is signed in, the dialog also lists **Your GitHub repos**, newest push first and minus ones already added, so cloning one is a single click. On a machine tab the clone happens on that machine. CLI: `wisp add https://github.com/owner/repo`. API: `POST /api/projects {"repo":"…"}`; a URL in `path` works too.

### Changed

- **Project chips stay on one row with tens of projects.** The launcher's *in* row used to show every project as a chip (30 projects meant 6 rows on desktop and 14 on a phone), and the top bar cut off whatever didn't fit with no way to scroll to it. Now both show your most recent projects as chips, and the rest go behind a **+N** chip. Fewer chips show when the space is narrow, and a chip is never cut in half. The project you picked, the one you're filtering by, and projects with tasks that need you always keep their chip. **+N** opens a searchable list of every project: type to filter by name or path, use ↑/↓ and Enter to pick. It also has *No folder* and *Other folder…* in the launcher, and *All projects* and *Manage projects…* in the top bar. In the top bar, **+N** shows a badge counting the tasks that need you in the projects it hides. When a phone is too narrow even for *All*, the top bar shows one chip with the current filter that opens the list.

- **Ship it no longer holds you in its dialog.** Clicking *Commit, push & open PR* used to leave the dialog open with a disabled *Shipping…* button until the push and `gh pr create` were done. Now the dialog closes right away, and the card's PR row (just above the composer) shows a live track: **Commit → Push → Open PR**, with a spinner on the step that's running and a check on each one that's done. The server reports each step as `shipping` on the session summary, so other tabs see it too, and the card head shows a *Shipping* pill while the card is collapsed. When the PR is up, the row turns into the PR row with a short highlight, and a toast links to it. If a step fails, the row turns red and says which step failed and why, with **Retry**, which reopens the dialog with your commit message and description still filled in. A second ship while one is running is refused with 409.

### Fixed

- **The launcher is there from the first frame.** On start, the launcher used to sit as an empty strip for one to five seconds, because the page waited for harness detection (`GET /api/agents` runs every CLI, and opencode lists its models) before drawing it. Now `index.html` draws the launcher's shape with a prompt box that already has focus, so you can start typing before the scripts load. The full launcher fills in about 50 ms later, at the same height, and keeps what you typed. Harnesses come from the last list seen (kept in the browser) and refresh when detection answers. `GET /api/agents` now answers from the last detection right away and checks again in the background, sending an `agents` event if anything changed. Warm calls dropped from about 1.2 s to 2 ms. `?fresh=1` and Re-check still wait for a full detection. Empty feed sections no longer flash their headings before the feed loads.

## [0.17.0] - 2026-10-19

### Added

- **Approve what an agent's permissions block, from wisp.** In Edits mode a coding agent used to be refused quietly when it wanted something its permissions don't cover, like `npm publish`, a write outside the project or a network call from Codex's sandbox. You only found out from a half-done report. Now:
  - **Claude Code waits for you.** wisp sends Claude's permission prompts to its own `approve` tool (`--permission-prompt-tool`). The task card shows *Needs your approval*: *Allow Claude Code to run `npm publish`?*, with **Allow**, **Always allow in this task** and **Deny**. The number keys pick an option. You can also type what to do instead: that denies the call and passes your words to Claude. Claude keeps its context, and the desktop notification says *needs your approval*. *Always allow* lets the same command or file through for the rest of the task without asking again.
  - **Every other harness gets an Allow & retry card.** When Codex, opencode, Grok, Cursor or Antigravity is refused, the report shows *Blocked by permissions* under its headline, listing each refused action. wisp reads these refusals from the harness itself: opencode's and Grok's stderr, Cursor's rejected tool calls, Antigravity's `PERMISSION_DENIED` steps and Claude's `permission_denials`. A new `blocked` block in the wisp protocol lets an agent report a refusal it can only see in a command's output, such as Codex's sandbox. **Allow & retry** sends a follow-up that runs those actions. For Claude and opencode only the exact actions are allowed (`--allowedTools "Bash(npm publish)"` or an opencode permission rule). Codex, Grok, Cursor and Antigravity can't allow a single action from the command line, so that one follow-up runs in Full auto, and the card says so. The task stays in Edits. **Deny** closes the card. API: `POST /api/sessions/:id/approve {"turnId","allow"}`. A live approval is answered like a question, through `POST /api/sessions/:id/answer {"text":"Allow"}`, `wisp reply` or the phone buttons.
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

[Unreleased]: https://github.com/M0xoo/wisp/compare/v0.29.0...HEAD
[0.29.0]: https://github.com/M0xoo/wisp/compare/v0.28.2...v0.29.0
[0.28.2]: https://github.com/M0xoo/wisp/compare/v0.28.1...v0.28.2
[0.28.1]: https://github.com/M0xoo/wisp/compare/v0.28.0...v0.28.1
[0.28.0]: https://github.com/M0xoo/wisp/compare/v0.27.0...v0.28.0
[0.27.0]: https://github.com/M0xoo/wisp/compare/v0.26.0...v0.27.0
[0.26.0]: https://github.com/M0xoo/wisp/compare/v0.25.0...v0.26.0
[0.25.0]: https://github.com/M0xoo/wisp/compare/v0.24.1...v0.25.0
[0.24.1]: https://github.com/M0xoo/wisp/compare/v0.24.0...v0.24.1
[0.24.0]: https://github.com/M0xoo/wisp/compare/v0.23.0...v0.24.0
[0.23.0]: https://github.com/M0xoo/wisp/compare/v0.22.0...v0.23.0
[0.22.0]: https://github.com/M0xoo/wisp/compare/v0.21.0...v0.22.0
[0.21.0]: https://github.com/M0xoo/wisp/compare/v0.20.0...v0.21.0
[0.20.0]: https://github.com/M0xoo/wisp/compare/v0.19.0...v0.20.0
[0.19.0]: https://github.com/M0xoo/wisp/compare/v0.18.1...v0.19.0
[0.18.1]: https://github.com/M0xoo/wisp/compare/v0.18.0...v0.18.1
[0.18.0]: https://github.com/M0xoo/wisp/compare/v0.17.0...v0.18.0
[0.17.0]: https://github.com/M0xoo/wisp/compare/v0.16.0...v0.17.0
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
