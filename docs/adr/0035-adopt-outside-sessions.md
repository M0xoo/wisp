# ADR-0035: Sessions run outside wisp become wisp tasks (`wisp adopt`)

- Status: accepted
- Date: 2026-11-09
- Source: the owner: "when a user works with another harness and wants their session(s) tracked, wisp should do it
  for them: turn them into wisp tasks."
- Builds on v1's Bring in (services/bring-in.js: Conductor worktrees become tasks in place), ADR-0027 (task specs),
  ADR-0033 (`.wisp/` history).

## Decision

- **Every harness module can read its own sessions:** a new point, `harness.sessions@1`, contributed by each
  harness (claude, codex, cursor, opencode, copilot, grok, antigravity). It has:
  - `list(project)`: the sessions the CLI stored for that folder (Claude Code's `~/.claude/projects/<dir>/*.jsonl`,
    Codex's `~/.codex/sessions`, the others' stores; v1's `latestSession`/`hasSession` generalised);
  - `read(id)`: the transcript as normalised events, through the **same parser** that drives live runs (the G6
    goldens), so an adopted session reads exactly like a task wisp ran.
- **Adopting builds a real task:**
  - the spec's steps are the user's prompts in order, with the harness, model and cwd;
  - the base is the commit that was HEAD when the session started (from the reflog and timestamps, marked
    "approximate" when unsure);
  - the changes are the diff between that base and the session's end;
  - the history is the events;
  - its resume id is the session's id, so **the next follow-up continues the same session in that CLI**;
  - it's marked `adoptedFrom: claude-code` (or `codex`, …), and nothing in the harness's own files changes.
- **How the user does it:**
  - CLI:
    - `wisp adopt` lists this folder's recent outside sessions across harnesses and lets you pick;
    - `wisp adopt <session-id>` adopts one, and `wisp adopt --all --since 7d` adopts many;
    - `--track` also saves the result to `.wisp/` (ADR-0033).
  - App and TUI: the project's Repo tab (and Home) shows **Sessions outside wisp** with one-click **Adopt**
    (and Adopt and track); in the TUI it's `a`.
  - Automatic, opt-in per project (`history: { adopt: ask | auto | off }`, default `ask`):
    - `wisp skill install --agent claude` (or codex, …) also installs the CLI's session-end hook, which calls
      `wisp adopt --session $ID` (Claude Code's SessionEnd hook; a polled store watcher for CLIs without hooks);
    - in `ask` mode you get a notice ("Claude Code session in api: track it?"), in `auto` mode it's adopted (and
      tracked if the project tracks).
  - SDK: `w.sessions.list()` and `session.adopt()`.
- **Privacy:** an outside session's transcript is the user's own, but adopting it puts it in wisp (and maybe in the
  repo). It goes through the same scrubbing as everything else, the preview shows what's saved, and a tracked adopted
  session keeps its full transcript in `.wisp/`, like every tracked task (ADR-0033).
- **Bring in stays** (v1's intent): a tool's worktrees (Conductor, others) become tasks in place, never moved or
  removed. Adopt is the same idea for sessions.

## Consequences

- Each harness module adds `sessions.rs` (store paths per OS, pure parsing via its core parser) and tests on
  recorded session files.
- The parity check covers `wisp adopt` in the app, the TUI and the SDK (ADR-0022/0024).

## Edge cases (added 2026-11-09)

Each one is a test named after it.
- `the_same_session_is_adopted_once`: adopting a session that's already a task answers that task and makes no
  new one, whether it comes from the hook, `--all` or by hand.
- `adopting_again_adds_only_new_turns`: a session that went on (in the CLI, or after `wisp open`) gets only its
  new turns appended to its task.
- `a_session_id_never_leaves_the_store`: a session id with `/`, `..` or a separator is refused before any file is
  read or restored.
- Not built: session readers for cursor, opencode, copilot, grok and antigravity. v1 never read them, and there are
  no recorded samples of their stores to test a parser against, so they wait for recorded fixtures rather than
  being guessed.
