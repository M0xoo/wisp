# v2 UI parity burndown

`qa/parity.mjs --views=<view>` against `design/v1-reference/` (pixels ≤ 0.5 %, no differing region over 8×8 px, every
PARTS element's metrics within ± 0.5 px). One row per view; the score is shots passing out of shots; the note is the
first gap the gate reports. Run: `QA_PARITY_PORT=4592 PW_DIR=/tmp/pw node qa/parity.mjs --views=<view>` (4590 was
held by another vite from this worktree on 2026-11-12).

## 2026-11-12 (round 19), first pass

| View | Shots | Pass | Pixels ok | Metrics ok | First gap |
|---|---:|---:|---:|---:|---|
| home | 48 | 0 | 0 | 0 | 1440-light-rest: 1.8 % px, 106/168 parts off; `feed` box y 161→185, h 414.5→666, margin-top 8→0 |
| task | 72 | 0 | 0 | 48 | 1440-light-rest: 5.6 % px, 104/154 parts off (`feed` then missing; fixed since, not re-run) |
| task.transcript | 8 | 0 | 0 | 0 | not reachable at 1440: the opener's click (v1 `.it-actions [data-a="transcript"]`) finds nothing |
| task.changes | 8 | 0 | 0 | 0 | not reachable at 1440: the same, for Changes |
| palette | 12 | 0 | 0 | 0 | 1440-light-rest: 77 % px (the palette's backdrop/sheet differ), 110/171 parts off |
| settings.general | 12 | 0 | 0 | 0 | 1440-light-rest: 2.2 % px, 127/192 parts off |
| settings.agents | 8 | 0 | 0 | 0 | 1440-light-rest: 4.6 % px, 126/190 parts off |
| settings.usage | 8 | 0 | 0 | 0 | 1440-light-rest: 6.6 % px, 135/199 parts off |
| crew | 12 | 0 | 0 | 0 | not reachable at 600: the opener's click finds nothing |
| stuff | 12 | 0 | 0 | 0 | 1440-light-rest: 4.3 % px, 92/122 parts off |

**Fixed in this pass**
- *home not reachable at 600 px*: shell-list replaced the whole `shell.sidebar:list` area and New task (`sidebar.new`,
  v1 `.split-top`) went with it, so a phone-width page had no way to start a task. `SidebarTop` is the frame's now,
  over any list (seen in Chrome at 600).
- *`feed#0: missing` in every view*: shell-list's rows container carries v1's `feed` part too (`list.rows feed`).

**Next, in order** (each is shared by most views, so it moves every score)
1. The sidebar's vertical rhythm: `feed` 24 px lower than v1 (the Tasks/Repo tabs row v1 doesn't have at that place)
   and 8 px top margin.
2. The task page's openers: `task.transcript` and `task.changes` (v1 `[data-a=…]` actions → the v2 parts).
3. The crew opener at 600.
4. The palette's sheet (77 % px).

## 2026-11-12 (round 20): home and the list

`home` (48 shots, all widths, themes, states): 0 pass, but 1440-light-rest went from 1.8 % px / 106 of 168 parts off
to **0.9 % px / 40 of 168**; 600 px is 0.0 % px, 23 of 117 parts off.

**Fixed (the list, measured as v1's #feed)**
- The 24 px: wisp.history's Tasks · Repo tab row sat over the list. Repo moved to ⌘K and the project + menu (*Repo
  history*); nothing is drawn over the list.
- v1's names on shell-list's row, so it is measured: the item `card` (kit `FeedItem`, v1's 1px transparent border),
  its head `card.head` (v1-parts.json), `card.dot`, `card.title`, `card.sub`, `card.side`, `card.status`,
  `card.goal`, `card.overlap`, `card.time`, `card.run`, `card.quickDone`, `card.quickLater`; the section heading
  `section.heading` (an `h4` with the button role, as v1's). Kit: `ListRow` `also` (extra part names) and `strong`.
- The kit's feed row is v1 split.css's `.it-head` number for number: a 10px dot column, 10px/1px gaps, 9px 12px
  padding, the title across to the time (13px, 20px line, 36px right), the sub 19.5px faint, the run line 11.5px/17px
  faint, the time absolute in the corner (top 9, right 12, ≥ 26px; an absolute grid item with a placement sits in
  its grid area, so the placement is cleared), the quick actions floating (top 7, right 40 / 68, 24px, 4px apart,
  bg-2, faint). Title 500 ink-2, 600 ink while it wants you. Hover and open fill the item, keyboard focus outlines it.
- No `<button>` inside a feed row (v1 had none: parity counts buttons in order): the row's hit is a `div` with the
  button role, the quick actions are kit `RowButton`s.
- v1's state words: Finished, Report, Partial, At limit ("Done" is the list a task goes to when you mark it done).
  v1's goal pill (ring and round) and overlap pill (merge mark, ×n) on rows; kit `GoalPill`, `OverlapPill`, `RowPill`.
- The list is as tall as its rows (v1 #feed) and shrinks to scroll; no scrollbar gutter; 2px between items, as
  padding between consecutive items so the virtual list measures it.
- A row with nothing to say on its third line has none (wisp's own Welcome task).
- The section heading is v1's sec-toggle: 28px, 10.5px in, 4px under it, 11px medium.

**Left, each needs the owner (not fixed here)**
1. The dot's colour: v1 colours it by the task's project (`--pc`), the rebuilt row (81f8eb96) by unread (accent) /
   read (grey). Kept as rebuilt; parity reports it on every row (`card.dot … bg`).
2. The project selector (10d8f30f) replaces v1's chips: one button where v1 had two, so every later `x.button`
   compares to the wrong one. Needs an allowed.md rule or a re-captured reference.
3. `launcher.tryTwo`: v1 dropped *Try it two ways* itself (#771, 3435a2b9) after the references were captured;
   `launcher.team` sits 32px left for the same reason. The references need a re-capture (`qa/v1-reference.mjs`).
4. `section.needs`: v1's section is a container; shell-list's list is one virtual list (headings and rows as
   siblings), so there is no section box to measure.
5. 390 / 320 px: the composer's bar folds (ADR-0012) where v1 didn't fold the same items; per-shot detail in
   qa/out/parity/home/.

`task` (72 shots): **24 pass** (600 and 390 px: 12/12 each, light and dark, browser and desktop, every state); 1440
from 4.7 % px to 0.7 % px (only the list's owner-level items above remain: dot colour, section box, selector);
320 px 1.2 % px, 0 parts off.

**Fixed (the task page)**
- *The transcript was empty in every task shot*: the mock (apps/web/dev/seed.ts, `fromV1`) named a task's topic by
  the peer-prefixed id, the client subscribes by the bare id (as the server names it). Every task view's parity was
  measuring a page with no turns.
- v1's hero in a task (R.hero `own` / `echo`): the latest answer has no state row (the task bar says it) and no title
  that only repeats the task's; `BlockContext.inTask` / `taskTitle` (additive). The hero's v1 CSS (`cb-hero` had
  none): 26px/1.2 title, 12/6 margins (4 on top when own), 14px/1.6 summary; 22px under 720px.
- The row's run line is v1's (harness, model, computer): the project and the branch it also showed (from 0cfaa100)
  truncated all four; they're on the task page.
- The open row's title is 500 ink-2 unless unread or waiting (v1 `.item.open:not(.unread)`), and ends before the
  quick actions while they show (64 / 92px).

`task.transcript`: reachable now (the mock's topic fix); 1440 2.7 % px, 30 of 153 parts off. **Next:** v2 shows the
steps as a plain list after the answer; v1's Transcript (transcript.js) is a view of its own: a head ("Transcript ·
1 message · 4 steps"), the steps on a timeline (icons, a line, +/− on an edit, chevrons on what folds), the agent's
message and the end, then the hero with its state row and meta ("Finished · 369ms · $0.01 · 1 file touched"), the
receipt without the act counts, and the Transcript action pressed. That is F-task-34 (the kit's Transcript).

`task.changes`: reachable now; 1440 11.1 % px, 80 of 178 parts off. **Next:** with Changes open v1's main pane is
508px wide (the side panel beside it); v2's stays 708px.

Mock: `runtime.agents` and `plugins.ui` answer (empty) in apps/web/dev/mock-commands.ts, so task shots no longer
carry a "the mock peer has no runtime.agents" toast.

**Still to run this round:** palette, crew (its opener at 600), settings panes, stuff.

## 2026-11-12 (round 20, second pass): the owner's decisions applied

- **The project selector** (10d8f30f) is an owner decision: allowed.md §5 and the new rule kind `owner`
  (`*  topbar.projects  owner`): the part's box masked, its metrics and what's inside it skipped, the generic parts
  (`x.button`…) counted again on both sides without it.
- **The dot** is v1's: the task's project colour (`colorToken`, slate without a project), warn while it asks, pulsing
  while it runs; unread is the title's (600, ink), never the dot's.
- **Try it two ways**: v1 dropped it (#771); the references that showed it are re-captured from v1 origin/main
  a5b1c646 with the same tool and seed (`REF_RESTORE=1`, both modes).
- **task.transcript**: v1's Transcript (F-task-34) on the kit's `Timeline`; 1440 from 30 to 15 parts off. Parity's
  translator maps v1's `.item.open .it-actions [data-a=…]` to v2's task bar (the opener never reached it).
- **task.changes**: the main pane is already 508px beside the panel, as v1's. The panel's content is next: the mock
  has no `git.changes`, and the pane needs v1's head, stats, commit row, Stage / Viewed per file (item 3).

`home` against the re-captured references (13 views from v1 origin/main a5b1c646, both modes): at rest **1 of 162
parts off** at 1440, 1024 and 900 (only `section.needs`), 0.5–0.9 % px; 600 px 0.0 % px, 2 parts off; 4 shots pixel-
clean. **Next:** the hover and focus states compare everything inside the row by document order (`target#n`), and
v2's row nests differently from v1's `.it-head` (lead › dot, main › hit › title …): its element tree has to follow v1's
for those to line up; 390 / 320 px: the composer bar's folded items (autoPreview, harness) sized as v1's.

## 2026-11-12 (round 21)

At 1440 light, at rest; before → after. Re-captured from v1 origin/main a5b1c646 as each was reached (Try two ways gone,
#771; crew also predated the crew tint, #768): palette, crew, crew.add, every `settings.*` pane (`index.json` recaptures).

| View | Before | After | Left |
|---|---|---|---|
| task.changes | 80/178 parts, 11.1 % px | 20/174, 3.0 % px | v1's Preview tab, the comments line, the panel's own left border, the main pane's card.title weight |
| palette | 110/171, 77 % px | 3/165, 0.9 % px | the home launcher's border behind it (every overlay); 390: 3.1 % px, the rest is home behind |
| crew.add | not opened (opener untranslated) | 16/176, 13.5 % px | the Task panel tint row (no `bg` on a member yet), Delegate, Import… (no import view); at 390 v1 opens it from the phone list's Crew section, which v2 lacks |
| crew | 26/50, 24.4 % px | 17/50, 1.6 % px | the Skills "+ Add" (F-crew-10 partial), two avatar part names |
| crew.org | 15/112, 7.7 % px | same | no Org page in v2 (F-crew-14): `crew.org` isn't a registered view |
| settings.general | 21/187, 1.4 % px | 7/187, 1.3 % px | v1's Updates row (v2 has an Updates pane); "Open tasks in" is the owner's rename (bcc9c039) |
| settings.notifications | | 9/181, 1.7 % px | Accept tasks from channels row |
| settings.agents | 126/190, 4.6 % px (old ref) | 13/185, 3.6 % px | the accounts rows |
| settings.connectors | | 10/182, 3.5 % px | connectors list and Import |
| settings.memory | | 4/180, 1.1 % px | |
| settings.automations | | 5/181, 1.1 % px | webhook triggers row |
| settings.spells | | 8/182, 7.2 % px | spells are gone in v2 (ADR-0031) |
| settings.usage | 135/199, 6.6 % px (old ref) | 18/194, 5.3 % px | the budget section |
| settings.worktrees | | 10/186, 5.6 % px | the worktrees list and cleanup |
| settings.privacy | | 5/182, 3.7 % px | mask env files, project ask rows |
| stuff | 92/122, 4.3 % px | 12/118, 1.1 % px | Make a pane (no dialog in v2 yet) |

Kit fixes behind several rows at once: Settings nav rows 1px apart (v1 .sx-nav), fields on a Settings group take
--surface (v1 --field-bg), the kit Select's trigger answers to `form.select`, a bare dialog is the card itself (its
edge and corners) and drops its own hidden head, kbd is v1's `1px 5px` / 5px radius, and the crew page's wide
two-column padding now applies (a container query can't style its own container).

## 2026-11-12 (round 23): Settings panes

1440 light at rest, parts off; before (round 21/22) → after. Light and dark both 0 where checked (agents).

| View | Before | After | What it took |
|---|---|---|---|
| home | 1/162 | 0/162 | the launcher's border is `--line` (v1's `.card` wins over `.launcher`); section.needs' box (`VirtualList` groups) |
| palette | 2/165 | 0/165 | the same two |
| settings.general | 6/187 | 0/187 | Theme row, the transcript hint's V key, Updates at the end through `shell.settings:general` |
| settings.notifications | 4/181 | 0/181 | `settings.acceptChannels`, the overlay's `settings` part |
| settings.agents | 13/185 | 0/185 | rows with lines between, the accounts box (`SettingsInset`), Signed in · Sign out, GitHub row, the Ask switch with the Lean row, "Installed something new?" Re-check; buttons keep `letter-spacing: normal` |
| settings.auto | not recorded | 0/180 | nothing of its own (the kit fixes above) |
| settings.automations | 5/181 | 0/181 | `settings.webhookTriggers` |
| settings.cloud | not recorded (3) | 0/183 | the sign-in's title inside its box (`SettingsBlock`), the note (`SettingsNote`), the lede in the frame, a primary button's icon 8px from its label |
| settings.connectors | 10/182 | 0/182 | Found in OpenCode and Cursor (seeded) with its download tile, chip examples (`Button variant="chip"`), heads 22px under what's above, 2px in, button at the bottom |
| settings.machines | not recorded (4) | 0/184 | v1's layout: one row with Manage (the list moved into a dialog), the line, Reach this computer from anywhere (wisp.grid-client through `shell.settings:machines`), SSH rows with commands to copy (`CopyCommand`); the pane is a block so margins meet as in v1 |
| settings.memory | 4/180 | 0/180 | nothing of its own |
| settings.privacy | 5/182 | 0/182 | the two rows' part names, the note |
| settings.worktrees | 10/186 | 0/186 | the total and rules in one box, v1's fixed columns (`SettingsItem`), v1's `.pk-seg` filter (`Tabs variant="seg"`), seeded worktrees |
| settings.spells | 8/182 | 6/182 | v1's Spells is v2's Plugins (ADR-0031): the opener now lands on Plugins; Cast a spell (an agent writes the change) isn't in Plugins yet |
| settings.usage | 18/194 | 14/194 | not started: Plan budget, Automations stop at (per harness), Machine load |
| stuff | 4/118 | 3/118 | card.title weight |
| crew.org | 5/112 | 4/112 | |
| task.changes | 20/174 | 19/174 | v1's Preview tab and comments (not started) |

Phone and dark checked by eye at 390 (Agents, Machines dark; Worktrees, Agents, Connectors light) and 1440 dark
(Machines). Other widths still differ (390: the phone settings list v1 doesn't have; 900: the frame is 8px wider).

## 2026-11-12 (round 24)

1440 light at rest, parts off.

| View | Before | After | What it took |
|---|---|---|---|
| settings.usage | 14/194 | 0/194 | v1's layout: Charts and breakdowns, Crew track record (slot), Plan budget in v1's order with each harness's line and logo, Spare allowance, Window changes, Machine load (wisp.machine through `shell.settings:usageEnd`); `ChoiceSetting` is v1's `.pk-seg` |
| settings.spells | 6/182 | 0/182 | Plugins pane: v1's Cast box (it starts a real task), an empty card, Install as v1's "Add a spell" box, the foot line |
| task.changes | 19/174 | 0/174 | Preview tab, comments on lines, reply box tools on desktop, the panel's own edge, the place ⋯, gutter padding, head button pressed, re-captured reference |
| task | | 0/150 | (checked after the reply-box change) |
| crew.org | 4/112 | 2/112 | re-captured reference; left: crew.avatar#1 and the same x.button weight as stuff |
| stuff | 3/118 | 1/118 | re-captured reference (rows read by an earlier view); x.button#11 fw 500 vs 400 left: a probe of the same box reads 400 |

## 2026-11-12 (round 25)

| View | Before | After |
|---|---|---|
| home (1440) | 0 parts, 19 regions | 0 parts, 16 regions (rest recorded in allowed.md §6) |
| palette (1440) | 0 parts, 37 regions | 0 parts, 14 regions |
| task (1440) | 0 parts, 17 regions | 0 parts, 8 regions |
| stuff (1440) | 1 | 0 |
| crew.org (1440) | 2 | 0 |
| crew (390) | not reachable | reachable: 81/86 (the phone member page) |
| task.transcript (390) | not reachable | reachable: 11/32 |
| settings.* (390) | see the round notes | see the round notes |

## 2026-11-12 (round 26)

Settings panes, parts off (light unless named).

| View | 390 before | 390 after | 900 after | dark 1440/900/390 |
|---|---|---|---|---|
| settings.general | 3 | 0 | 0 (was 25) | 0/0/0 |
| settings.notifications | 3 | 0 | 0 | 0/0/0 |
| settings.agents | 4 | 0 | 0 | 0/0/0 |
| settings.connectors | 9 | 0 | 0 | 0/0/0 |
| settings.auto | 18 | 0 | 0 | 0/0/0 |
| settings.machines | 9 | 0 | 0 | 0/0/1 (a 1 px button) |
| settings.cloud | 1 | 0 | 0 | 0/0/0 |
| settings.memory | 1 | 0 | 0 | 0/0/0 |
| settings.automations | 2 | 0 | 0 | 0/0/0 |
| settings.spells | 12 | 4 (File…) | 1 (label) | 1/1/4 |
| settings.worktrees | 19 | 0 | 0 | 0/0/0 |
| settings.usage | 43 | 0 | 0 | 0/0/0 |
| settings.privacy | 4 | 4 (v1 wraps its title) | 0 | 0/0/4 |

1440 light after: every Settings pane 0 (spells 1: the Install/Review label); home, palette, task, stuff, crew.org
0. Dark Settings pixels 3.4 % → 0.9 % (the scrim).
