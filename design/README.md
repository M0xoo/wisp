# Design guidelines

How wisp looks and behaves, for coding agents (and people) changing its page, phone app, desktop
app or site. AGENTS.md says how the code is laid out; these files say what a UI change has to feel
like. Most of the rules here come from a bug we shipped and then fixed: the commit is named
where it helps.

Read this file before any change under `web/`, `mobile/`, `electron/` or `docs/`, then the one
that matches your change:

| File | Covers |
|---|---|
| [ui.md](ui.md) | Look: tokens, type, spacing, buttons and the form kit, icons, borders, motion, dark mode |
| [ux.md](ux.md) | Behaviour: instant actions, errors, confirms, loading, stable layouts, scroll and focus, split view side by side and stacked, keyboard |
| [mobile.md](mobile.md) | Phones: narrow browsers vs the Android app (`MOBILE`), touch targets, Back, what to hide |
| [copy.md](copy.md) | Words: the names wisp uses, labels, toasts, CHANGELOG lines |
| [site.md](site.md) | trywisp.dev (`docs/`): generated pages, cache busting, install text |
| [crew.md](crew.md) | The crew: naming, where it sits, spirits (avatars), memory and context |
| [goals.md](goals.md) | Goals: a task that keeps going until a condition holds; the band, the checks, the words |
| [checklist.md](checklist.md) | What to check before handing a UI change back |

## The rules that matter most

1. **Quiet and neutral.** One accent (`--accent`), hairline borders, native type. Use the tokens in
   `web/css/tokens.css`; never hard-code a colour, and never add a coloured side stripe.
2. **Every action feels instant.** Update the page first, call the server after, roll back with a
   red toast if it refuses (`tryApi`, `toastError`). Clear inputs at once.
3. **Nothing jumps.** Opening, selecting or refreshing a row never moves its buttons, pills or time.
   A background refresh never moves what you're reading. Never re-append a node that's in place.
4. **Loading never looks empty.** Placeholders have the real shapes and size; cached data paints
   first and is replaced quietly.
5. **Both widths, every time.** A change to a row, task bar or composer is checked side by side
   (≥ 900px) and stacked (narrow windows, the phone app: the task as a page with Back). Tips are
   the one exception: the side-by-side home only.
6. **Same action, same name, everywhere.** Right-click menu, the task's More menu, the ⌘K palette,
   the details column and keys offer the same actions under the same words (*Rerun*, not *Replay*).
7. **Phones are first-class.** 390px wide works, 44px touch targets in the app, no keyboard hints on
   touch, nothing spills past the edge.
8. **Light and dark.** Every change is looked at in both.
9. **Spells reach it.** New UI gets a slot, part, prop or setting (AGENTS.md → *Everything is
   customizable by spells*).
10. **Look at it.** Render it in real Chrome at desktop and phone widths before saying it works, and
    attach a screenshot ([checklist.md](checklist.md)).
