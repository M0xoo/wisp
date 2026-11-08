# ADR-0027: A task is a spec plus its history; specs are shareable, rerunnable and declarable

- Status: accepted
- Date: 2026-11-08
- Source: the owner: "think about tasks and how they fit into wisp as code, like sharing tasks or rerunning."
- Builds on ADR-0026 (wisp as code).

## Decision

**Every task has two parts:**

| Part | What | Where |
|---|---|---|
| **Spec** (what was asked) | prompt and attachments (by content hash), harness, model, effort, mode, project and folders, base (repo + commit sha + branch), worktree or not, crew member, goal and judges, connectors, the formula overlay it ran with, team/subagents, schedule or trigger that started it | a `TaskSpec` resource, stored with the task, versioned (`v`) |
| **History** (what happened) | turns, activity, answers, changes, cost, follow-ups | the event log (ADR-0004) |

A follow-up adds a *step* to the spec's `steps` (the prompts in order), so a spec describes the whole
conversation that was asked for, not just the first prompt.

**What that gives:**

- **Rerun** = run the spec again. `wisp rerun <id>` (same spec, from the same base commit by default, so
  it starts from the same code), `--from latest` (today's code), `--agent codex --model …` (override any
  field), `--steps 1` (only the first prompt). The new task links to the old one (`rerunOf`). The GUI's Rerun
  and Try it two ways (v1's compare) are reruns with overrides; compare is two reruns side by side.
- **Fork** = a spec plus a history prefix (v1's fork): continue from turn N with the same conversation.
- **Share**, at three levels the sharer picks, all secret-scanned and env-masked (v1's rules):
  1. **Spec**: reproducible, small (`wisp task export <id> > fix-login.task.yml`). The receiver runs it on
     their own code and account (`wisp run -f fix-login.task.yml`). Nothing of the original output is sent.
  2. **Report**: the spec plus the final answers (blocks) and the diff summary, read-only (v1's share on the
     grid, `/share` pages).
  3. **Full**: the spec plus the whole history, transcript included, for debugging together. Imported as a
     read-only task the receiver can fork.

  Shared items carry the wisp version and plugins they need. A receiver missing one sees what's missing
  (ADR-0005 features-from-peer), not an error.
- **Declared tasks** in a formula (ADR-0026):

  ```yaml
  tasks:
    - name: nightly-deps
      prompt: Update dependencies, run the tests, open a PR if green
      project: api
      agent: codex
      schedule: "every day at 2"
      goal: { text: tests pass }
  ```

  A declared task is a template: applying the formula registers it, and each run (scheduled, triggered, or
  `wisp run nightly-deps`) creates a task from it. **Recipes become parameterised task specs**
  (`{param}`). **Triggers and crew jobs produce tasks from specs** in exactly the same way, so there's one way
  a task gets made.
- **Honest about reproducibility:** agents aren't deterministic, so a rerun reproduces the *ask* and the
  *starting point* (base commit, settings, connectors, harness version), not the output. The rerun's head
  shows what differs from the original (harness version, model, base).

## Consequences

- `runtime.create` takes a `TaskSpec` (today's StartArgs are its first form), and a task's spec is
  readable as a resource (`wisp task spec <id>`).
- Every task records its base commit sha when it starts (worktree or not), so "rerun from the same code" works.
- v1's share, compare, rerun, fork, recipes and triggers are reimplemented on specs. Their v1 behaviour is
  the intent to keep (docs/v2-port-intent.md).
