# Feedback: every action answers at once

The owner, 2026-11-08: *"Something I hate in wisp v1: an action happens and there's no immediate feedback.
The user should always feel the app is responsive: action → something happens: loading, navigate directly,
something appears."*

This is a hard rule for every feature, built in and checked, not left to each screen.

## The rule

**Within one frame (≤ 100 ms, target ≤ 16 ms) of any user action, the screen visibly changes**, in one of
these ways (in order of preference):

1. **The result itself, optimistically.** The row is renamed, archived, marked done; the message appears in
   the transcript; the input clears; the toggle flips. If the server refuses, it rolls back with a toast
   saying why (`tryApi` in v1, `defineCommand` + `optimistic` in v2).
2. **Navigate at once.** Opening a task, a crew member, a pane or Settings switches the view immediately
   and shows the shell of the destination (title, head, skeleton rows of the right height) while its data
   arrives. Never wait on the network before navigating.
3. **Something appears where the result will be.** A new task shows its row and its page in a *Starting*
   state before the server has answered; a queued follow-up shows in the queue with its count; an upload
   shows its chip with progress.
4. **The control shows it's working.** When none of the above is possible (a sign-in, an export, a check
   that must ask the server), the control that was pressed switches to its pending state at once: a spinner
   in place of its icon, the same width, disabled against a second press, and the action can be cancelled
   if it can take more than 2 s. Past 10 s, say what it's waiting for.

**Never:** a click with no visible change; a spinner somewhere other than where the user acted; a page that
stays on the old view while the new one loads; a button that can be pressed twice because nothing changed;
silent failure.

## How v2 makes it automatic

- **Commands** (`@wisp/client` `defineCommand`) must declare `optimistic` (a patch) or `pending` (which
  control shows the pending state). There is no third option: `optimistic: 'none'` without `pending` is a
  type error.
- **Kit controls are bound to commands:** `Button`, `IconButton`, `MenuItem`, `Switch` and Toolbar items take
  `command={…}` and show their pending state, disabled, at the same width, for exactly as long as the
  command is in flight. Features don't wire spinners by hand.
- **Navigation is synchronous:** `navigate(intent)` updates `Nav` in the same tick; views render their
  skeleton from what's already in the entity store, then fill in. A view may not await data before its
  first render (lint: no top-level `await`/resource gate in a view's first render).
- **Errors are never silent:** a rejected command always rolls back and toasts; a failed read shows an
  inline retry where the data would be.

## How it's checked (`qa/feedback.mjs`)

For every interactive element in every view of `qa/views.mjs` (the same sweep as `qa/buttons.mjs`), with the
network slowed to 400 ms:

1. Click (or press Enter on) it, and record the first DOM mutation or style change in the page.
2. **Fail** if nothing visibly changed within 100 ms, if the change is outside the element's own area and
   not a navigation or a new element where the result goes, or if the element can be activated again while
   its command is pending.
3. Rejections are simulated (the mock peer refuses one command in ten): the UI must roll back and show a
   toast within 100 ms of the refusal.

A screen isn't done until it passes, alongside the parity and layout gates.
