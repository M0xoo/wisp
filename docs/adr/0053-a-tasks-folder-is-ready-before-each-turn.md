# ADR-0053: A task's folder is made ready before each of its turns, through an additive `runtime.run@1` `ready`

- Status: accepted
- Date: 2026-11-14
- Source: the lead, round 129: "archiving removes a clean worktree, but nothing brings the folder back before a
  follow-up". v1 `server/git.js` `ensureWorktree` ("Archiving removes a clean worktree; a follow-up brings it back
  from its branch"), called from `routes/sessions.js` before every follow-up, rerun and goal. With ADR-0003
  (interceptors read and decide, extension points provide), ADR-0011 (nothing on the hot path blocks).

## Context

v2's worktrees plugin removes an archived, idle task's clean worktree (its branch stays), and Done's dialog says a
follow-up brings it back. Nothing did: the next turn spawned in a deleted folder and failed with the OS's ENOENT. The
runtime must ask for the folder before any turn starts (a follow-up, a rerun, a held turn released, a crew wake: all go
through `start_turn`), without knowing about worktrees.

`before:run` doesn't fit: an interceptor reads and decides, it never writes, and bringing a worktree back is a write
(`git worktree add`, the ignored files copied), which can take longer than an interceptor's 2 s ceiling. A veto's
`then` runs only after the root command settles, so the turn would already be refused; a hold would park the task in
Review, mark it unread and need a second command to release it, for something that usually takes a few hundred ms.

## Decision

- **`RunPart::ready(&Session, Option<&TurnId>) -> BoxFuture<Result<(), String>>`**, a default method on `runtime.run@1`
  (additive: every existing contributor keeps compiling and answers `Ok`). `turn` is the turn about to start, the id
  its `turn.started` or `turn.held` will carry; None for a side run (a /btw, `runtime.quick`), which has neither. The runtime awaits each contributor's `ready`, in order, at
  the very start of `start_turn`, before `before:run` (trust and the rest read the folder). At most `READY_MS`
  (120 s) each.
- **`Err(why)`, or a timeout, refuses the turn** as a `before:run` veto does: "Not started" with `why`, the task to
  Review. Nothing is spawned. A refused or held turn takes the task out of Archived (a turn was asked for; the
  refusal shouldn't go unseen, and an archived idle task's folder would go again).
- **Then the runtime checks the folder itself:** a task whose `cwd` is set but isn't a folder is refused ("This task's
  folder is gone: …"), so a task never runs anywhere else (not the server's folder, not a scratch one). A task with no
  folder still gets its own scratch folder (`run_folder`).
- **wisp.worktrees contributes `ready`:** for a task with a worktree slot it claims the folder and brings it back on its branch (`Engine::ensure`: prune,
  `worktree add <path> <branch>`, the ignored files again, not its setup). A brought-in (foreign) folder that's gone, a
  branch that's gone, or git refusing is the reason on the refused turn; no folder is made at a foreign path.
- **A claim holds the folder while its turn starts.** Until the turn is saved running the task still reads archived
  and idle, so the archive removal and the hourly sweep each ask `Engine::claimed_since(path, mark)` last thing
  (`still`) and stand down for a claim made after their mark, or one still live: a claim lets go when runtime says
  that turn started or was held (`turn.started`, `turn.held` with its turn id: from then the task's own state guards
  the folder), and lapses after `CLAIM_MS` (150 s) when neither comes (a turn refused after its `ready`). **Claims are
  per turn**, kept by (folder, task, turn): a late `turn.started` of a turn that failed at once lets go of its own
  claims only, never the next queued turn's, which may still be in its `before:run`. A side run's claim (no turn) is
  let go by no event; it lapses.
- **Side runs go through the same step** (`Runtime::folder_ready`): a /btw (`runtime.btw`) awaits every `ready`
  and the folder checks before its entry is saved pending, and `runtime.quick` before it spawns (on its `cwd`). A
  refusal is the command's error (`conflict`, with why); nothing spawns, and no pending /btw is left behind. A /btw
  doesn't take the task out of Archived. While a /btw is pending (`ext["wisp.runtime"].btw[].pending`), the archive
  removal and the sweep (`busy`) leave the folder (a /btw may outlast `CLAIM_MS`); an entry pending longer than
  `archived::SIDE_MS` (330 s, past the /btw's 300 s timeout) was cut off (wisp stopped mid-answer) and no longer
  keeps it.
- **Every extra folder (`dirs`, v1's `also`) is checked too:** after the parts' `ready`, one that's gone (absolute,
  not a folder) refuses the turn, the /btw or the quick run with its name ("One of this task's extra folders is gone:
  …"); it's never dropped from the run. wisp.worktrees' `ready` claims each one for the turn and, when one is gone
  and was (in) a worktree of wisp's (`archived::tree_holding` over `Port::tasks`, read only then), brings that
  worktree back on its branch. The claim holds while the turn starts, as the task's own folder's does; from then the
  working task guards it by state, not by claim: the archive removal and the sweep ask `Port::extra_in_use` (a
  running, asking or queued task names the folder, or one inside it, in its `dirs`: one `runtime.list`, then only
  those few tasks read whole) and leave it. A claim covers the folder it names and the worktree it sits in
  (`fsx::within`); claims are kept per (folder, task, turn), so one task's claim doesn't overwrite another's, nor one
  turn's the next's.
- **Paths are compared as the disk sees them.** `fsx::within` cleans both sides first (`.`, `..`, never above the
  root; Windows' `\\?\` verbatim prefix stripped; either separator), so `/a/wt/../etc` isn't in `/a/wt` and `/a/wt2`
  isn't either. `fsx::norm` also resolves symlinks: `canonicalize` on the longest part of the path that exists, the
  rest (not there, so no link in it) cleaned by text. Claims are kept by their `norm` path and the removals ask by
  the worktree's `norm` path; `archived::tree_holding` and `Port::extra_in_use` compare `norm` paths (`within_real`),
  so a symlink or `..` can neither carry a folder out of a worktree nor hide that a working task uses it.
- **Keep worktree on means archiving never removes the folder** (v1 removed it anyway: `docs/v1-bugs-fixed.md`).

## Consequences

- A turn on a task with a worktree takes the folder's lock once (a `stat` when it's there). Bringing one back runs
  inside `start_turn`, so `runtime.followUp` (and a rerun) answers once the folder is back, as v1's route did; the
  kernel and the edge put no timeout on a command, so a slow `git worktree add` delays the answer, never fails it.
- A turn refused or held after its folder came back leaves the folder for `CLAIM_MS`; the next archive or sweep
  after that may remove it again (it comes back with the next turn).
- A /btw's claims lapse after `CLAIM_MS` (no `turn.started` lets them go): after a quick /btw on an archived task the
  brought-back folder stays until a change to the task after that (or the sweep) looks again. A /btw longer than
  `CLAIM_MS` whose extra folder is another archived task's worktree may see it removed under it (a /btw is plan mode,
  read-only); its own folder is kept by the pending entry.
- Open: `Port::extra_in_use` counts only working tasks: a /btw on a task in Review doesn't keep its extra folders
  once its claims lapse.
- Normalising costs a `canonicalize` per path compared (one per missing ancestor for a folder that's gone), only on
  a claim, a removal or a gone extra folder, never per event. Windows paths compare case-sensitively, as before.
- The archive removal of a task that's another task's extra folder reads the working tasks once per removal (rare:
  an archived, idle, clean worktree), never per turn.
- An extra folder that's gone and isn't wisp's worktree (a plain folder, a brought-in one) is refused, never made.
- Tests: `plugins/runtime/host/tests/folder_ready.rs` (`a_btw_runs_in_the_folder_ready_brought_back`,
  `a_btw_ready_refuses_…`, `a_btw_on_a_task_whose_folder_is_gone_…`, `a_quick_run_in_a_folder_thats_gone_…`,
  `a_task_whose_extra_folder_is_gone_…`, `an_extra_folder_ready_brings_back_…`,
  `ready_is_told_the_turn_it_readies_and_a_btw_none`), `plugins/worktrees/host/tests/flows.rs`
  (`bring_back_…`, `…stands_down_when_a_turn_starts_in_the_folder`, `an_extra_folder_thats_a_removed_worktree_comes_back_and_stays_while_its_task_works`,
  `a_late_turn_started_of_a_turn_that_failed_at_once_keeps_the_next_turns_claim`,
  `a_claim_through_a_symlink_or_dotdot_holds_the_real_folder`), `fsx::within_tests`
  (`a_sibling_with_a_shared_prefix_is_not_within`, `dotdot_is_resolved_before_comparing`,
  `windows_verbatim_prefix_is_stripped`, `a_symlink_pointing_outside_is_not_within_and_one_pointing_in_is`),
  `archived::tests` (`…waits_while_a_btw_is_answered_in_it`, `…held_by_the_innermost_worktree…`),
  `crates/wisp/tests/serve_worktree_back.rs` (`a_btw_on_an_archived_task_runs_in_its_worktree_brought_back`).
