# ADR-0047: Sandboxes are their own plugin; each has one owner and goes with it

- Status: accepted
- Date: 2026-11-11
- Source: v1's `design/sandboxes.md` (origin/main), the owner's brief (2026-11-11: "sandboxes in full"), ADR-0041
  (the grid is the hub; sandboxes as peers), ADR-0042 (each new feature is its own plugin), ADR-0010 (machines).

## Context

The grid already makes sandboxes (`apps/grid/src/sandboxes.rs`: rows, their own token, a box per sandbox, the
per-user cap, sign-ins and env vars sealed per user and given to every sandbox), and `wisp.grid-client` makes one
and keeps it as a `grid` machine. Nothing uses them: no `/sandbox`, no owner, nothing deletes one with its task,
no sign-in from the app, and a delegate or a crew job can't run in one.

## Decision

1. **`wisp.sandbox`** (`plugins/sandbox/{api,core,host,ui}`) owns the feature. It talks to the grid through
   `wisp.grid-client` (make, list, remove, sign-ins, env) and to a sandbox through `machines.route`.
2. **One owner each.** A sandbox machine's `data.owner` is `{task}`, `{pending: when}` until its launch has a task,
   `{lead, member}` (a delegate), `{crew, job}` (one job) or `{crew}` (a member's own), or `{judges: task}`. It is
   never a place you pick: `machines.list` callers that offer places skip machines with `data.sandbox`.
3. **What goes in.** The project travels as one `git bundle --all` plus `git diff HEAD --binary` (uncommitted work),
   and the origin and author; the sandbox's own wisp (`WISP_SANDBOX=1`) takes it with `sandbox.seed` into
   `~/code/<name>` and runs the project's `.wisp/sandbox.sh` once. Only a sandbox accepts `sandbox.seed`.
4. **Ways in.**
   - `sandbox.launch` (New task's `/sandbox …`): make, wait for it, seed, then `runtime.create` there; the task is a
     row of the sandbox's peer, so the app routes it like any remote task.
   - `sandbox.place {owner, cwd}` → `{machine, cwd}`: a seeded sandbox for a delegate, a crew job (per job or the
     member's own, reused) or a goal's judges; the caller routes its command there.
   - Goal judges of a sandboxed task already run in its sandbox (its goal plugin runs there). A goal may also ask
     for judges in a sandbox (`judges: [{… sandbox: true}]`): they run through `sandbox.place {judges: task}`.
5. **Deleted with its owner.** `session.deleted` drops the task's sandboxes, its judges' and its delegates'; a
   member leaving the crew drops theirs; a job's goes with the job's task. A drop removes the sandbox on the grid
   whatever its own wisp answers, then its machine. A sweep (at start and every 10 minutes) drops sandboxes whose
   drop failed and launches that never got a task (30 minutes).
6. **Sign-ins.** Claude: once for all sandboxes (Settings → Cloud → Sandboxes): `claude setup-token` runs on a pty
   here, its link and a code box show, and the token goes to the grid sealed per user; nothing is kept on this
   computer. Codex and the others: their own device login inside a sandbox (`accounts.login.start` routed to its
   peer); a login file is never copied. Until a harness is signed in for sandboxes, a launch on it is refused up
   front (Claude, and Auto → Claude, work from the start).
7. **The rules v1 had:** the Sandbox pill in the machine pill's slot from the launch's first frame; the grid's cap
   and "grid full" fail a launch or a delegation at once, while a crew job waits and retries; a sandbox publishes
   and shares nothing as its owner and makes no sandboxes.

## Consequences

- New plugin, no new dependency. `wisp.grid-client` gains thin wrappers for the grid's sign-in and env routes.
- The grid gives a sandbox's box `WISP_SANDBOX=1`.
- Not here: the Browser tab (needs the box image's Xvfb, Chromium and noVNC, and previews of a box's ports on the
  grid's edge, which answers "Pages in boxes aren't shown" today), network policy, warm sandboxes.

## Edge cases

Each one is a test named after it.
- `a_sandbox_has_one_owner_and_is_never_a_place_you_pick`
- `a_projects_work_goes_in_as_a_bundle_and_its_uncommitted_changes`
- `only_a_sandbox_takes_a_seed_and_its_setup_runs_once`
- `deleting_the_owner_drops_its_sandboxes_whatever_the_sandbox_answers`
- `the_sweep_drops_failed_drops_and_launches_that_never_finished`
- `a_launch_on_a_harness_not_signed_in_for_sandboxes_is_refused_up_front`
- `a_full_grid_fails_a_launch_at_once_and_a_crew_job_waits`
- `claude_setup_token_shows_its_link_and_takes_the_code_and_the_token_goes_to_the_grid`
