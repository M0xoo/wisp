# The crew

Named agents that stay on hand and keep working: *Scout · CI watcher*, *Quill · PR reviewer*. Code:
`server/crew.js` (members, schedule, queue, memory, mentions), `server/routes/crew.js`,
`web/js/features/crew.js` (section, thread, editor, `@` picker), `web/js/spirit.js` (avatars).

## Naming

- **Crew** for the group, **crew member** (or their name) for one. Not *agents*: in wisp an agent is
  the harness running a task (Settings → *Agents*, "the agent's verdict"), and a second meaning would
  make every sentence ambiguous. Not *assistants* (sounds like chat) or *subagents* (that's Delegate).
- A member's work is a **job**; it runs as a task, so the page still says *task* for the card.
- Kinds of job, as the page names them: *Check-in* (their schedule), *Job* (you sent it), *Delegated*,
  *Trigger*, *Tagged* (an `@mention`).
- Their face is a **spirit**: a will-o'-the-wisp, which is where wisp got its name.

## Where it sits, and the flow

A member is like a teammate you keep a conversation with. Everything about it happens in one place,
its thread; its work never mixes with your tasks.

- **The list.** The *Crew* section is pinned above *Working*, in split view and the feed, rows in a
  fixed order (when they joined). A row never moves: what changes is its status line (*Asking you:
  …*, *Running tests · 2 jobs*, *Reported: …*, *Looks again 14:30*, *Every 30 min*, *Paused*), the
  dot on its face (amber: asking you; blue: a report you haven't read) and its spirit's mood. Under a
  member sit only its live jobs (working, asking you, an unread report, or the one open), as ordinary
  cards; three at most unless it's open. Crew jobs never show in *Needs you*, *Working* or *Done*.
- **Opening a member** is opening a task: in split view its thread takes the main pane (any open task
  closes), in the feed it unfolds under the row. The row looks selected.
- **The thread**: a task's header (face, name, role, state, Pause, ⋯, close), then its jobs oldest
  first, each what was asked and where from (*You*, *Check-in*, *Tagged in “…”*, *Delegated by
  “…”*, *Trigger …*) and the member's answer: working (its live line), asking you (the question, its
  choices or Allow / Deny, a box to answer), or done (headline, summary, the tasks it followed up in,
  **Open job**, **Follow up**). Quiet check-ins fold into one faint line. At the bottom, the box that
  hands it a job (it shows *Starting up* at once; `@` brings another member in as a delegate of that
  job). Beside the thread on a wide pane (folded above it otherwise): schedule and next check-in, jobs
  at once, project, computer, harness, mode, delegates, the actions, the notebook, the brief, and the
  tasks it's part of.
- **When it needs you**: the row and its face say so, a notification names it, and either opens the
  thread at that job, where you answer without opening anything else. Answering is optimistic: the
  job carries on at once and goes back to asking if the server refuses.
- **When it finishes**: the answer fills in on its job, the row says *Reported: …*, a notification
  names it. Seeing it in the thread marks it read. A quiet check-in only adds its line. No toast or
  notification while its thread is on screen: it shows there.
- **Opening a job** (**Open job**, a notification of the job itself, a link) opens it as a task in the
  main pane, nested under its member, with the member as a crumb in the header. Esc goes from the job
  back to the thread at that job, and from the thread home.
- **In another task**: `@Ada …` starting a follow-up is answered under the message (the task's agent
  isn't interrupted); **Reply to Ada** continues the same job, so Ada remembers the thread. A member
  tagged in or delegated by a task can follow up there by itself (`followUp`), shown as *@Ada (your
  crew’s …): …*; its thread moves along with that follow-up so the answer stays above it. Those jobs
  are filed under Done: their answers already reached where they were asked.
- **Delegates**: a member has a team like a task's (any harness, other crew members, never itself);
  every job of its gets it. A job that was itself delegated hands nothing on to the crew, so members
  can't loop; one on another machine can't reach the crew here.
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

## Skills and instructions

A member's **kit** (`kit` on the member, `web/js/skill-md.js`, `web/js/features/crew-kit.js`): files it
uses on every job, kept with it rather than in a repo, so a member without a project or on another
machine still has them.

- **Instructions file** (`rules`): an AGENTS.md just for them, in full in every job's note, after the
  brief. Theirs win over the repo's for their work.
- **Skill**: a name (lowercase-with-dashes), *when to use it* and the steps, as Claude's SKILL.md.
  Progressive: the note lists each skill's name, when and the path of its SKILL.md, written to
  `<home>/crew/<id>/skills/<name>/`; the job reads it only when it fits, and the folder is added to
  the harness's readable dirs. A skill imported from this computer keeps its own folder (`path`) for
  its scripts and references. On another machine there is no file to read, so the skills go in full.
- **The section** sits beside the thread after the brief: a row a file (icon, name, when / size), a
  switch in a fixed column (off: kept, not used), the row opens the editor. **Add** offers *Instructions
  file*, *Skill*, *From this computer…* (the harnesses' skills and AGENTS.md / CLAUDE.md files, and the
  project's) and *Upload .md files…*; `.md` files dropped on the section join too. Everything saves the
  whole kit optimistically and rolls back with a toast.
- **Generate** (*Generate with Ada…*, first in **Add**): a goal and suggestions, then an ordinary job
  (`crew.kit: true`, shown as *You · Build your kit*) whose note says how to study the job and the
  project and to hand files back as `kit` in the crew block. Any job may do that, rarely. What comes
  back is an **offer** on the member (`m.offers`, one a job, newest 10), each file checked on its own so
  one bad file doesn't lose the rest. The thread shows it under that job: a box a file (ticked), a
  click reads or edits it first (*Added* once saved), *Replaces yours* / *Same as yours* for a name
  they have, then **Add n to their kit** and **Dismiss**. Adding is one PATCH of the kit and the offer;
  afterwards the job keeps one line, *Added to their kit: …*. Never added without you: these files
  go in every job's prompt.

## On another machine

A member with `machine` keeps its identity, memory, schedule and queue here: one source of truth, so
moving it between machines never splits what it knows. Its jobs run on the machine as that wisp's
tasks, launched with `crewJob` (the member's id, the job's kind and the note written here). That
wisp hides the `crew` block like ours and keeps it on the turn (`crewOut`); this wisp files it when
the job's summary streams in as ended, or on the next tick for one it missed. Each turn is filed
once (`seen`); answers it owes (`away`: an @mention's reply) are paid then.
