# v2 round, item 5: the GitHub Action, the image and the git hook (ADR-0040)

Edge cases were written into ADR-0040 first ("the git hook, the Action and the image"): 5, one named test each.

## Built

**`wisp hook install | uninstall | status`** (`crates/wisp/src/hook_cli.rs`)
- It installs a `prepare-commit-msg` in the repo's hooks folder (`git rev-parse --git-path hooks`, so `core.hooksPath` and worktrees count).
- A commit made in a wisp task's run (`WISP_TASK`, which the runtime sets for every run) gets `Wisp-Task: <id>`, the trailer Ship it writes. It works with no wisp running.
- It never adds a second trailer. A `WISP_TASK` that isn't an id adds nothing.
- A hook the repo had is kept as `prepare-commit-msg.local` and runs first: its failure still stops the commit. Uninstall puts it back, and installing twice is a no-op.
- Tests, run against real git: `hook_adds_the_trailer_only_inside_a_task`, `hook_never_doubles_the_trailer` and `hook_install_keeps_the_users_own_hook`.

**The GitHub Action** (`action/action.yml` + `action/run.sh`, published as `wisp-agents/action`)
- A composite action: Node 22, `npm install -g wisp-agents@<version>`.
- It runs a prompt (`wisp "<prompt>" --json`), a declared task (`wisp run <name>`) or a formula (`wisp run -f`), then `wisp wait`, then `wisp show`.
- The report goes to the job summary and, on a pull request, to `gh pr comment`. The outputs are `task` and `state`.
- `fail-on: failed` fails the job when the task ends in error. Harness keys pass through the job's env.
- Test: `the_action_runs_a_task_and_posts_its_report` runs `run.sh` under bash 3.2 with a fake `wisp` and `gh`. It checks the calls, the comment body, the summary, the outputs, no comment off a PR, and exit 1 on error.

**The image** (`ci/image/Dockerfile`)
- `node:22-bookworm-slim` with wisp, git, gh and jq. It runs as user `wisp` (uid 1001) in `/work`, with `WISP_UPDATE_CHECK=0` and the entrypoint `wisp`.
- Test: `the_image_runs_wisp_headless` checks the Dockerfile's shape. **The image wasn't built: there's no Docker on this Mac.**

Clippy `-D warnings` is clean on `wisp`.

## What's left

- **Publishing:**
  - the `wisp-agents/action` repo, which mirrors `action/` and needs a tag (`v1`);
  - a workflow that builds and pushes `ghcr.io/wispagents/wisp` on release.
  - Both need the owner's GitHub org.
- **The CLI:** `wisp run -f`, `wisp run <name>` and workflows don't take `--wait --json`, so the Action reads the id from their `wisp attach <id>` line. A JSON mode for them would be cleaner.
- **The Action's goal gate** ("gate on a goal"): it fails on an error state, not on a goal verdict yet. That needs the goal's state in `wisp show --json`.
- **A real CI run** of the action and a `docker build` of the image (CI's job).
