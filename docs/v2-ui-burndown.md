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
