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

- **`RunPart::ready(&Session) -> BoxFuture<Result<(), String>>`**, a default method on `runtime.run@1` (additive: every
  existing contributor keeps compiling and answers `Ok`). The runtime awaits each contributor's `ready`, in order, at
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
  the turn started or was held (`turn.started`, `turn.held`: from then the task's own state guards the folder), and
  lapses after `CLAIM_MS` (150 s) when neither comes (a turn refused after its `ready`).
- **Keep worktree on means archiving never removes the folder** (v1 removed it anyway: `docs/v1-bugs-fixed.md`).

## Consequences

- A turn on a task with a worktree takes the folder's lock once (a `stat` when it's there). Bringing one back runs
  inside `start_turn`, so `runtime.followUp` (and a rerun) answers once the folder is back, as v1's route did; the
  kernel and the edge put no timeout on a command, so a slow `git worktree add` delays the answer, never fails it.
- A turn refused or held after its folder came back leaves the folder for `CLAIM_MS`; the next archive or sweep
  after that may remove it again (it comes back with the next turn).
- Only a task's own slot comes back; v1's `also` (other folders of one task) has no v2 counterpart yet. A /btw side
  discussion or `runtime.quick` doesn't go through `start_turn` and isn't covered.
- Tests: `plugins/runtime/host/tests/folder_ready.rs`, `plugins/worktrees/host/tests/flows.rs`
  (`bring_back_…`, `…stands_down_when_a_turn_starts_in_the_folder`), `crates/wisp/tests/serve_worktree_back.rs`.
