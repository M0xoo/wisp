# Sharing crew members

Built (all three steps below). Code: `server/crew-share.js` (blueprint, export, import, a spell's
members), `server/secret-scan.js`, `web/js/features/crew-share.js` (Share, Import, the review),
`web/js/crew-templates.js`; tests in `test/crew-share.test.js`, `test/secret-scan.test.js` and
`test/spells.test.js`. Where the build differs from the first draft: the blueprint code lives in
`server/crew-share.js` (not `crew.js`, which keeps `DEFINITION` / `REVIEWED` and the lock); export
is one route, `POST /crew/export` (ids, options, `gist`), instead of `GET /crew/:id/export`; and
the open questions are settled at the end.

Two asks, one format:

1. **A spell can bring crew members.** Turn the spell on and they join your crew; turn it off and they
   step out. Update the spell and they get the new brief and kit, but keep what they've learned.
2. **Any member you made can be shared.** One click gives a file, some JSON or a link. Whoever gets it
   pastes or drops it and has their own copy, which they can edit like any member they made.

Both use one portable description of a member, the **blueprint**. A spell's `crew` key is a list of
blueprints. A shared file (`.crew.json`) is one or more blueprints. One validator checks both.

## What exists today

- A member (`server/crew.js:85`) mixes **who they are** (name, role, avatar, brief, schedule, mode,
  harness, kit, delegates) with **where they run** (`cwd`, `machine`) and **what they've done** (`notebook`,
  `log`, `queue`, `offers`, `links`, `seen`, `away`). Only the first group can be shared.
- *Also starts when* (task finished, marked done, CI failed) isn't stored on the member. Those are
  triggers with `crew: <id>` (`Crew.on(m)`), so the blueprint has to recreate them.
- Spells already contribute things that stay theirs while they're on. `recipes` is the closest
  precedent: `Spells.recipes()` adds them with `spell: { id, name }`, and they leave when the spell is
  turned off. Settings do the same with `lockedBy`.
- The share path for spells is already complete: export or copy in Settings → Spells, file drop,
  pasting JSON or a link (`https`, `gist:<id>`), `wisp spell install`, and one review screen before
  anything changes. Crew sharing should reuse all of it instead of building a second pipeline.
- The editor's *Start from* row (`TEMPLATES` in `web/js/features/crew.js`) is already a set of
  blueprints, hard-coded in the page.

## The blueprint

```json
{
  "key": "ci",                       // stable within its file or spell (updates match on it)
  "name": "Scout",
  "role": "CI watcher",
  "avatar": "ghost.sky.visor.flat.antenna",
  "brief": "Watch CI on the default branch…",
  "cron": "*/30 * * * *",            // "" = on call
  "on": ["ci"],                      // trigger kinds: finished, done, ci (recreated as triggers)
  "mode": "plan",                    // plan | edits | auto
  "agent": "claude", "model": "", "effort": "",   // preferences, see below
  "parallel": 2,
  "kit": [{ "kind": "skill", "name": "read-ci-logs", "description": "…", "body": "…" }],
  "team": [{ "agent": "codex" }, { "crew": "review" }]   // crew delegates by key within the bundle
}
```

**Never in a blueprint:** `cwd`, `machine`, `notebook`, `log`, `queue`, `offers`, `links`, `seen`,
`away`, ids and timestamps. A kit skill's `path` doesn't travel either; only its SKILL.md body does.
Export says when a skill had scripts beside it that were left out.

Rules on the receiving side:

- **Harness:** `agent` is a preference. If that harness isn't installed, use Auto and say so in the
  review (*Prefers Codex, which isn't installed here: Auto*).
- **Project:** a blueprint has none. The review asks *Which project?* with the launcher's project
  picker, defaulting to the current one or *Any project*. Paths never come from someone else's file.
  When `on` includes `ci`, a project is required (*Any project* isn't offered): `normalizeTrigger`
  refuses a `ci` trigger with no `cwd` (`server/triggers.js:110`).
- **Member and triggers together:** the member is added to `config.crew`, then
  `Triggers.syncMember(m, on)` creates its triggers. If that throws, the member is taken out again,
  so an import never leaves a member without its triggers (or triggers without a member).
- **Names:** `@Name` mentions need unique names, so a clash becomes *Scout 2* (editable in the review).
- **Delegates:** `{ "crew": "<key>" }` resolves within the same bundle. Anything else is dropped and
  listed in the review.
- **Arrives paused.** Nothing runs until you press Resume, the same way an installed spell stays off
  until you turn it on. The review shows the brief in full, the kit file names, the schedule, the
  events and the mode, so it's clear what the member will do on its own.
- **Risk kind:** any member with a `cron` or an `on` starts jobs without you asking, so it ranks
  `RANK.runs` (**Runs commands**) in the spell's badge (`RANK` in `server/spells.js`), whatever its
  mode. A member in `auto` mode ranks `runs` too. An on-call member in Plan or Edits ranks `acts`.

## 1. Crew members in spells

`crew` becomes a spell key (`known` in `normalizeSpell`), a list of at most 10 blueprints, each checked
by `normalizeBlueprint` (shared with import, in `server/crew.js`).

A spell member's definition and its state are kept apart, so turning a spell off and on loses nothing:

| | Where it lives | What happens |
|---|---|---|
| Definition (brief, kit, schedule, …) | the spell file | read-only in the editor, like a setting a spell set. The editor says *From the “CI crew” spell* |
| Your choices (project, paused, harness override) | `config.crew` entry with `spell: { id, key }` while the spell is on | editable, kept across spell updates |
| What they learned (notebook, log, jobs) | the same entry, as for any member | kept |
| A switched-off spell's members | `config.crewDormant`, keyed `<spellId>:<key>` | out of `config.crew`, so `crew.list`, the scheduler, `@` mentions and triggers need no new filters |

- **Turned on:** each blueprint without an entry gets one, paused, and the review asks for the project.
  Entries that exist come back as they were.
- **Turned off:** the entry moves from `config.crew` to `config.crewDormant[<spellId>:<key>]`, and its
  triggers go with it (switched off, kept on the dormant entry). It leaves the Crew section and stops
  being scheduled or mentionable, with no filter in `crew.list`. Turned back on, it moves back and
  `syncMember` recreates its triggers.
- **Updated (new version):** `Spells.install()` (`server/spells.js:525`) keeps an updated spell on,
  and the server doesn't require the review, so the server has to protect running members. When a
  new version changes a member's `brief`, `kit`, `cron`, `on` or `mode`, the server pauses that member
  and marks it `changed: { from: <old definition> }`. Its row says *Paused: the spell changed*, and
  **Resume** shows the diff (brief, kit files, schedule, events, mode) and asks before it runs again.
  Name, role and avatar changes apply directly. The notebook, project and your other choices stay.
- **Removed:** asks *Keep Scout as your own?* Yes detaches the member (copies the definition into the
  entry and drops `spell`). No deletes the entry the same way removing a member does today.
- **Customizing one:** **Make it mine** in the editor does the same detach. Without it, the spell's
  members stay read-only, so a spell update can't overwrite your edits.

Spell schema work, per AGENTS.md: the `crew` key in `normalizeSpell` plus its `describe` line
(*Adds Scout · CI watcher, every 30 min, Plan mode*), a `SPELL_EXAMPLES` entry in
`server/spell-guide.js` (so *Cast a spell* can write one: `/spell a crew member who reviews my PRs every
hour`), a sentence in `scripts/guides.mjs`, and tests in `test/spells.test.js` that accept a good
blueprint and refuse a bad cron, a skill without a description, too many members or paths.

## 2. Sharing a member you made

**Share…** goes on the member, everywhere its actions are: the thread's ⋯ menu, right-click on the row,
⌘K (*Share Scout…*), and the `crew.page` header for spells. It opens a small dialog modelled on the
spell export:

- **Copy**: the JSON for a chat.
- **Download**: `scout.crew.json`.
- **Create a gist**: `gh gist create`, when `gh` is signed in. The answer is `gist:<id>`, ready to paste.
- Checkboxes: *Include their kit* (on), *Include their notebook* (off, since it can hold anything they
  learned about your code), and *Who they delegate to* (adds those members to the same file).
- Before anything leaves, the brief, kit and notebook pass through a secret scan (tokens, keys,
  `ghp_…`). A hit blocks the share and names the line. The scan is its own small module
  (`server/secret-scan.js`, no wisp imports) with its own tests, so spell export can use it later.
- **The gist is secret** (`gh gist create`'s default, never `--public`), and the dialog confirms first
  (*Post Scout to a secret gist on your GitHub account?*), since it publishes. Tests use the fake `gh`
  from `test/helpers.js`; nothing reaches the network.
- **On the phone** (`MOBILE`), Share offers only **Copy** and **Create a gist**; there's no file to
  download.
- **As a spell** (wrap the member in a one-member spell) comes in step 2, along with `crew` in spells.

File format: `{ "wispCrew": 1, "members": [blueprint, …] }`. A whole crew (*Share my crew…* on the Crew
section's ⋯) is the same file with several members.

**Importing.** These all lead to the same review screen and end with a normal member that you own:

- Drop a `.crew.json` on wisp (as with `.spell.json`).
- Paste JSON or a link (`https`, `gist:<id>`) into a new **Import…** chip at the end of the editor's
  *Start from* row. The fetch is `fetchSpellLink`, generalized to accept `*.crew.json`.
- `wisp crew import ./scout.crew.json` or `wisp crew import gist:abc123`, and `wisp crew export scout`.
- An agent: `wisp_crew_add` accepts a blueprint, so you can say *add the member from gist:abc123*.
- A spell file dropped on the import box is fine too: it goes to the spell review instead.

Imported members are plain members, so editing them, building their kit and everything else works as
it does today.

## 3. Afterwards

- Move `TEMPLATES` out of the page into blueprints served by `GET /crew/templates`, so the built-ins
  test the same format and a spell can add to *Start from* (a slot like `crew.templates`).
- A **crew gallery** on trywisp.dev: blueprints as gists, each with *Copy* and a `wisp crew import
  gist:…` line, generated by `scripts/site.mjs`.
- On Grid, a share link that opens the review in someone else's wisp: `<handle>.<domain>/#import=gist:…`.

## Build order

1. **Blueprint and import/export** (the most useful on its own). Done:
   - `normalizeBlueprint` and `toBlueprint(m)` in `server/crew.js`.
   - `GET /crew/:id/export` and `POST /crew/import` (`dryRun` gives the review). Both go in
     `server/openapi.js`.
   - The Share dialog, the Import chip, file drop and `wisp crew import|export`.
   - Spell parts for the new UI: `crew.share` and `crew.import`.
   - `server/secret-scan.js` with its own test file (added to the `test` script in `package.json`).
   - Tests: a round trip, nothing local leaks, name clashes, missing harness, a `ci` member refused
     without a project, a failed `syncMember` leaves no member behind, the secret scan blocks a share,
     and the gist goes through the fake `gh` without `--public`.
   - The PR tags Sana for review.
2. **`crew` in spells** (done): the spell key, `RANK.runs` for members with `cron` or `on`, `config.crewDormant`,
   pause-and-diff on updates (server side), detach (*Make it mine*), and **As a spell** in the Share
   dialog.
3. **Templates as blueprints, then the gallery** (done: `web/js/crew-templates.js`, published by
   `scripts/site.mjs` as `/crew/<key>.crew.json` with the *Share a crew member* guide; no spell slot
   for *Start from* yet).

Each step gets a CHANGELOG entry, and the UI goes through `design/checklist.md` (split view and the
feed, desktop and phone, light and dark).

## Settled

- **What a spell owns:** name, role, avatar, colour, brief, schedule, events (`on`), mode, kit and
  delegates (`DEFINITION`). Yours: project, machine, harness, model, effort, how many at once,
  paused, notebook. Schedule and mode stayed with the spell (not overridable) so a spell update never
  has to merge with your edits, and Sana's rule (a change to what they do pauses them) stays simple;
  to change them, **Make it mine**.
- **No Plan cap on imports:** they arrive paused and the review shows the mode.
- **A spell's new member gets no triggers until its first Resume**, where its project is picked, so
  nothing queues work for a member you haven't seen.
- **Share link:** `#/crew?src=gist:…` opens the import review in any wisp (Grid included).
