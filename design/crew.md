# The crew

Named agents that stay on hand and keep working: *Scout · CI watcher*, *Quill · PR reviewer*. Code:
`server/crew.js` (members, schedule, queue, memory, mentions), `server/routes/crew.js`,
`web/js/features/crew.js` (section, page, editor, `@` picker), `web/js/spirit.js` (avatars).

## Naming

- **Crew** for the group, **crew member** (or their name) for one. Not *agents*: in wisp an agent is
  the harness running a task (Settings → *Agents*, "the agent's verdict"), and a second meaning would
  make every sentence ambiguous. Not *assistants* (sounds like chat) or *subagents* (that's Delegate).
- A member's work is a **job**; it runs as a task, so the page still says *task* for the card.
- Kinds of job, as the page names them: *Check-in* (their schedule), *Job* (you sent it), *Delegated*,
  *Trigger*, *Tagged* (an `@mention`).
- Their face is a **spirit**: a will-o'-the-wisp, which is where wisp got its name.

## Where it sits

- The *Crew* section is pinned above *Working*, in split view and the feed, rows in a fixed order
  (when they joined). A row never moves: what changes is its status line (*Running tests · 2 jobs*,
  *Asking you*, *Looks again 14:30*, *Every 30 min*, *Paused*) and its spirit's mood.
- Jobs are ordinary cards in *Needs you* / *Working* / *Done*, with the member's face where the
  project dot goes (centred on the dot, so nothing shifts).
- With no crew yet, the section is one dashed row that invites you to add someone. It's useful, so it
  stays (ux.md: empty states are useful or absent).

## Spirits

A spirit is a code, `shape.color.eyes.mouth.extra`, drawn as SVG from `spirit.js`. A new member gets
one rolled at random; a name with no avatar rolls from the name, so it never changes. Mood is drawn
from state, never stored: idle (breathes, blinks on its own beat), live (floats, glances, visor scans,
beacon blinks, a soft glow), asks (hops), sleep (eyes shut, slow sway). Everything stops under
`prefers-reduced-motion`. Faces and trims use `--spirit-*` tokens (light and dark); the glow is the
member's colour (`--pc`), from one shared gradient per colour (`spiritDefs()`), so the same spirit is
the same markup and a repaint that compares HTML leaves it alone.

## Memory and context

Long-lived agents fail in two ways: one endless conversation that outgrows its context, or fresh runs
that forget everything. The crew avoids both:

- **Every job is a new task, with a fresh context.** Parallel jobs don't share a conversation, and
  none grows without bound (follow-ups on a job continue that job, as with any task).
- **What carries over is small and explicit:** the brief (yours), the notebook (theirs, edited by a
  hidden `crew` block at the end of each job: `remember` adds lines, safe with parallel jobs;
  `notebook` rewrites it to tidy), and the log (wisp's, one line per job, the newest 12 in the
  prompt). Soft cap 6,000 characters (they're told the size and asked to tidy), hard cap 12,000
  (the oldest lines go).
- **Quiet is a first-class answer.** A check-in that found nothing sets `quiet`, so it's logged and
  archived (its worktree goes) instead of asking for your attention. Only check-ins can be quiet:
  everything else has someone waiting on it.
- **They pick their own next look** with `wakeIn` (minutes, at least 5), on top of the schedule.
