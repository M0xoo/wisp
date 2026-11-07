# AGENTS.md

Notes for coding agents (and people) working on wisp itself. README.md covers what wisp does;
this covers how the code is laid out and the rules a change has to follow.

## Layout

- `server/`: the Node server (no dependencies). `index.js` boots it, `routes/` is the HTTP API,
  `store.js` keeps each task in `sessions/<id>.json` and a light copy in `sessions/.light/` that a
  start reads (turns' `activity`, `changes` and `raw` load from the full file when first read),
  `runner.js` runs sessions, `adapters/` has one file per harness, `spells.js` validates and stores
  spells, `spell-guide.js` is the reference the *Cast a spell* agent reads, `pane-guide.js` the one
  the *Make a pane* agent reads (from `web/js/pane-bridge.js`), `starters/` holds the panes wisp
  ships with (`GET /stuff/starters`), `crew.js` runs the crew
  (named long-lived agents: their schedule, queue, memory and `@Name` mentions; their jobs are tasks).
  `channels/` is how wisp is reached from outside: `policy.js` (who may speak, what may leave),
  `grammar.js` and `lists.js` (what a message can say), `channel.js` (the base class) and one file per
  channel (`github.js` polls through `gh`, and on a public repo reports only a fixed line; `slack.js`
  holds a Socket Mode connection through `ws.js`, a WebSocket client that knows no channel, and
  refuses to run on a grid box, which sleeps; `discord.js` does the same over a gateway connection,
  with no privileged intent); `conversation.js` is what a message does once it's through the door,
  shared by Telegram, GitHub, Slack and Discord: a new channel hands in what differs, not a copy; `remote.js` is their hub and `services/phone.js` what they ask of wisp.
  `capped.js` is what a task a channel started below Full auto may do with wisp's tools: the routes
  enforce it by the session a call authenticates as (`agent-token.js`: each agent's token speaks for
  that session only), and it's copied to all it starts. A new `/internal` route or tool needs a line there.
  `accounts.js` keeps a harness's several accounts (a login folder each, linked to the CLI's own).
  `services/worktrees.js` removes idle tasks' worktrees (`defaults.worktreeCleanup`, a low disk) and
  answers Settings → Worktrees; only what a follow-up can bring back goes on its own.
- `web/`: the page, vanilla JS as native ES modules, no build step. `index.html` holds the markup
  and the icon sprite, `css/` has one stylesheet per area (linked in order in `index.html`),
  `js/core/` (state, api, bus, DOM helpers), `js/ui/` (toasts, dialogs, popovers, keys) and
  `js/features/` (feed, split view, launcher, composer, settings, spells, …).
- `web/js/spell-schema.js`: what spells may touch. DOM-free and shared by the server and the page.
- `desktop/`: the Tauri shell, being built beside Electron (`electron/` stays what users get until the
  gate in `qa/scenarios/desktop.md` is met). `src-tauri/` is Rust, kept small: window, menu, links and a
  Node child that runs the unchanged server through `entry.mjs`; stdin is its leash, so it can't
  outlive the shell. `scripts/package.mjs` builds the downloads under electron-builder's names, with the pinned Node of
  `scripts/fetch-node.mjs` beside wisp's files: `.github/workflows/tauri-package.yml`, on release dry runs
  only. `src/init.js` is the page's bridge, its `Notification` (`src/notify.rs`,
  tauri-plugin-notification) and its drag regions (WebKit has no
  `-webkit-app-region`: a new rule in the CSS goes there too, a test checks). Linux is blocked: a release
  build doesn't compile until `on_navigation` can tell a frame from the page (`qa/scenarios/desktop.md`). IPC is one capability
  for exactly `http://localhost:<port>` (`capability.json`). `npm run dev:tauri`; not on npm.
- `mobile/`: the Android app (Capacitor + sshj). It shows wisp's own page through an SSH tunnel
  and starts wisp with `server/machines/bootstrap.js` (keep that file and `server/shq.js` free of
  Node imports). The page sees `MOBILE` (`web/js/core/state.js`): hide desktop-only actions there.
  In the app, what it connects to are *Computers*; *Machines* (desktop SSH) isn't shown there.
  There the page comes from a service worker's cache (`web/sw.js`) and first paints the last data
  seen (`web/js/features/cache.js`); `server/http/static.js` stamps index.html with the build
  that tells them it's stale, preloads app.js's static imports, and names every script and
  stylesheet by its content (`?v=`, modules through an import map) so they're cached for good (a new
  module needs nothing). Round trips cost most over the tunnel (HTTP/1.1, six at a time): the stylesheets
  go as one (`/css/all.css`), the phone's first open loads its modules only once the service worker
  has unpacked them all from one request (`/_pack`), and modules go without their comment lines.
- `grid/`: wisp Grid (`wisp grid …`), wisp for many people on a server: sign-in (Google, GitHub,
  OIDC), the edge that serves `<handle>.<domain>`, hostd that starts and stops each user's wisp,
  boxd (`grid/boxd.js`: the root helper that runs their containers; Node built-ins only, imports
  nothing from wisp) and the database (`node:sqlite`, so grid code needs Node 22.13+; nothing else
  does). wisp itself
  only knows trusted-proxy mode (`server/http/trust.js`), `GET /api/status`, and cloud computers
  as machines with `kind: 'grid'` (`server/machines.js`, `server/services/cloud.js`). `grid/inbox.js`
  holds channels' webhooks (`/_in/<token>`, off unless `grid.json` has `channels`), answers them at
  once and delivers to the box's `POST /api/channels/inbound`, which verifies them itself
  (`Channel.inbound()`, `server/routes/channels.js`). Only delivery carries `x-wisp-proxy-via: inbox`;
  never let anything from outside set it, and never make a channel count as use of a box (no
  `lastTouch`, no `lastActivityAt`). A new channel is a row of `CHANNELS` there.
- `docs/`: the site (https://trywisp.dev/). `agents/`, `guides/`, `integrations`, `changelog` and
  `404` are generated by `node scripts/site.mjs` (guides from `scripts/guides.mjs`) and gitignored:
  edit the scripts, not the output.
- `test/`: `node --test`. `npm test` runs every `test/*.test.js` (`scripts/test.mjs` finds them): a
  new file needs no listing. `test/real-clis.mjs` is `npm run test:real`, on signed-in CLIs.
  `test/helpers.js` installs fake harnesses (`test/fixtures/fake-agent.mjs`) and a fake `gh`.
- `qa/`: end-to-end scenarios per surface (web, grid, desktop, Android) in `qa/scenarios/`, and
  scripts that run them against an isolated wisp with fake agents (`node qa/web.mjs`, …). Not part
  of `npm test`; see `qa/README.md`. A change to a flow they cover updates its scenario.
- `design/`: how wisp looks and behaves (UI, UX, phones, words, the site) and the checklist for a UI
  change. Read `design/README.md` before touching `web/`, `mobile/`, `electron/`, `desktop/` or `docs/`.

## Commands

```sh
npm test                                   # every test/*.test.js
npm test -- --test-reporter=tap            # the same, with flags for node --test
node --test test/spells.test.js            # one file
npm run dev:web                            # the server with the page, restarts on server changes
```

CI has three tiers, from fast to thorough (`.github/workflows/`, all calling `suite.yml`):
`pr.yml` runs the suite once on Linux with Node 22 (about a minute). Label a PR `ci:full` to get
the main matrix when it touches process launching, paths, shells or terminals. `main.yml` runs
every OS on Node 20 and 22, plus the real CLIs (`real-clis.yml`) after each merge. `nightly.yml`
adds the Node LTS and the newest Node and runs the suite three times per job. A test that fails
there only some of the time is flaky: fix it, don't retry it. Tests can't rely on the network
(no `npx` downloads) or on which harness Auto picks.

## UI and UX

Every UI change follows `design/` and ends with `design/checklist.md`: seen in real Chrome at
desktop and phone widths, in light and dark, side by side and stacked. In short: tokens only,
instant actions that roll back with a toast, nothing that jumps or loads empty, the same action under
the same name everywhere, phones first-class.

## Everything is customizable by spells

A spell is JSON that wisp layers over itself at runtime (README → Spells). Users rely on being able
to change any part of wisp with one, so **every piece of UI you add or change must be reachable
from a spell**. A change that adds UI without this is not done.

Spells never see wisp's markup. They use names from `web/js/spell-schema.js`, and wisp maps those
names to its DOM. When you add or change UI:

1. **Places to add things → `SLOTS`.** A new area where buttons, chips or panels make sense gets a
   slot (`'sidebar.top'`, `'split.head'`, …) with a one-line description. Slots that act on a task
   also go in `CARD_SLOTS`. Render it with `slotHtml(slot, session)` from
   `web/js/features/spells.js`, and repaint on the bus `spells` event. Allow the slot for buttons
   / chips in `server/spells.js` (`BUTTON_SLOTS`, the chips list).
   The spell click handler finds the task from the closest `.item[data-id]` or `#splitHead[data-id]`:
   a slot outside both needs `data-task` on the button or its own case there.
2. **Things to restyle or hide → `PARTS`.** Name each visible element (`'split.title'`) and map it
   to a selector. Keep selectors stable: renaming a class means updating `PARTS`, never breaking
   spells. Never add questions, approvals, waiting pills, the spell review or Settings → Spells.
3. **Behaviour knobs → `PART_PROPS`.** Typed props (`'string'`, `'int'` 1–40, `'px'` 160–1600,
   `'bool'` or a list of values). `server/spells.js` validates them (`PROP_RANGE`); the page reads
   them with `spellProp(part, key)` and re-applies on the `spells` bus event.
4. **User settings → `SETTINGS`.** A setting in Settings that a spell could reasonably set goes
   here with its allowed values. The server overlays spell values on `config.defaults` and locks
   them (`lockedBy`); add the control to `LOCKABLE` in `web/js/features/settings.js` so the row
   says which spell set it. Nothing secret, no telemetry or feedback switches.
5. **New icons** in the sprite (`web/index.html`) go in `ICONS` too.
6. **Tell the agent.** `server/spell-guide.js` builds the *Cast a spell* reference from the schema
   automatically; for a notable new capability add a worked example to `SPELL_EXAMPLES` (the
   tests check every example is a valid spell). `scripts/guides.mjs` builds the site's spells guide
   from the schema; add a sentence there when the capability needs explaining.
7. **Test it** in `test/spells.test.js`: the new slot / part / prop / setting is accepted, and bad
   values are refused with a useful message.

Example: the split view (`web/js/features/split.js`) is reachable through the
`sidebar.top` and `split.head` slots, the `sidebar`, `split.*` and `topbar.view` parts, and the
`sidebar` (`width`, `side`: left by default, `details`), `split.main` (`readWidth`) and `split.home` (`greeting`)
props.

## Split view

The page has one layout, split view (the feed and its `view` setting are gone; a spell that still
sets `view` loads with a warning). The task list's cards (`S.nodes`) are rows in the sidebar; at
most one is open: its head stays in the list and its `.it-body` is `position: fixed` over
`#splitStage` (split.js keeps `--sb-*` on that box), so code that looks things up through `n.card`
keeps working. Under `SPLIT_MIN_WIDTH` (900px), and always in the phone app, the panes stack
(`body.stack`, `isStacked()`): the list fills the window, and a task, a crew member's thread or home
opens over it as a page (`body.stack-page`, set only by `paintSplit`) with Back (`goBack()`; `goHome()`
is New task). Side by side the crew is a rail beside the list (`body.has-rail`, `crewRailOn()` in
split.js, design/crew.md) and `--side-w` stays the list's own width; stacked, it's the Crew section.
Scrolling goes through `web/js/features/scroll.js` (`scrollByPx`, `keepInPlace`,
`feedAnchor`, `topInset`, `watching`): use it instead of touching `#stage` directly.

## Conventions

- Match the code around you: short comments that say why, the same naming, no new dependencies.
- In `web/js`, give `on*` handlers block bodies: an expression arrow that returns `false` cancels
  the click (and silently breaks submit buttons in dialogs).
- Never re-append a DOM node that's already in place on a refresh: re-inserting replays its CSS
  entry animation. Compare and only move what changed (see `renderFeed`, `renderBody`).
- UI actions update at once (optimistic), and roll back with an error toast if the server refuses
  (`tryApi`).
- In `server/runner.js` the store may be a test stub: call optional methods as `store?.method?.()`.
- Borders are plain 1px neutral lines (`var(--line)`, `var(--line-2)`), no coloured side stripes.
- Keep `:has()` to small, local boxes. Anchored on `body`, `.stage` or `#feed`, followed by `> *`, or
  matching things that change everywhere (`.open`, `.i`, `[hidden]`), it makes every class change restyle the
  whole page (each open and Back on a phone paid ~25 ms per change). Set a class from the JS instead
  (`has-quick`, `l-cmp`, `pv-on`); `node qa/mobile-perf.mjs` shows the cost.
- Don't end a selector in an `:is()` list (`.bar :is(.a, .b)`, `:is(.a, .b):hover`): Chrome can't
  index it by class and tries it on every element of every restyle. Write the list out
  (`.bar .a, .bar .b`). An `:is()` in the middle (`:is(.a, .b) .c`) is fine, and so is one whose
  arguments differ in specificity or hold combinators, which a list can't replace.
- New integrations ship off by default behind a Settings switch, with tests.
- `scripts/site.mjs` must handle CRLF input (Windows CI).
- User-facing features and fixes get a `CHANGELOG.md` entry under *Unreleased*. Releases also
  update README, the docs site and the version (`package.json`, `package-lock.json`, `README.md`,
  `docs/index.html`, `docs/integrations.md`, `docs/install.sh`, `scripts/guides.mjs`).
- `main` is protected: work on a branch and open a PR.
- Releasing is merging the version bump: `.github/workflows/release.yml` sees a version npm doesn't
  have and builds the desktop app (`packaging/desktop/electron-builder.yml`), drafts the GitHub
  release from that version's CHANGELOG section (`scripts/release-notes.mjs`, so the bump needs a
  `## [x.y.z] - date` section), publishes to npm, publishes the release, then bumps the Homebrew tap
  from `packaging/homebrew/wisp-agents.rb`. Nobody runs `npm publish` by hand, and no one approves
  the run: the `npm` environment only deploys from `main`, so merging is the gate. A version with a
  `-` (`0.38.0-beta.1`) is a beta: npm `next`, a GitHub prerelease, no Homebrew. Nightlies come
  from the same workflow (npm allows one trusted publisher per package): when `nightly.yml` passes
  on main and main moved, it publishes `<next patch>-nightly.<yyyymmdd>.<hhmm>` to npm `nightly`
  and moves the rolling `nightly` prerelease to it. The updater follows the `updateChannel`
  setting (`server/update.js`, `CHANNELS`). Download names carry
  no version (`wisp-mac-arm64.dmg`): the site, README and the app's updater (`server/update.js`,
  method `app`) link `releases/latest/download/<name>`, so don't rename them.
  The Android app ships the same way from `.github/workflows/android.yml`: each main build goes to
  Play's internal testing, and bumping `mobile/package.json`'s version promotes it (`scripts/play.mjs`).
