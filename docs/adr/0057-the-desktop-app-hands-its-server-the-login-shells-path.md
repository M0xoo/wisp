# ADR-0057: The desktop app hands its server the login shell's PATH on the stdin pipe (`wisp:path`), after the first window

- Status: accepted
- Date: 2026-11-14
- Source: F-desk-5 (round 134, DESK2-08): "a slow ~/.zshrc: the first window shows within 5 s". PR CI's macOS smoke
  saw the first window at 5085 ms (4171 ms on another run) with a 6 s ~/.zshrc.

## Context

An app started from Finder gets launchd's PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), where no agent CLI is (v1
desktop/shell-path.js). Round 134 had `desktop/src-tauri` ask the login shell (`$SHELL -ilc`) for its PATH and start
`wisp serve` on it: the PATH saved last time at once, but on the very first open (nothing saved) it **waited up to
2 s** (`FIRST_LIMIT`) for the shell before starting the server. The first window is only built once the server
answers `/api/health`, and shown at its page's load: so a first open with a slow rc file paid 2 s + the server's cold
start + the page load, and a loaded runner tipped it past 5 s. The server had no way to take a PATH after it started,
so a CLI the shell's answer would have found waited for the next start.

## Decision

1. **Nothing the first window waits on waits for the shell.** The server starts at once, on the saved PATH (merged
   with the inherited one), or the inherited PATH on the very first open. The login shell runs behind it (20 s limit),
   its answer is saved for the next start (`<app data>/shell-path`, as before) and, when it differs from the PATH the
   server started on, **handed to the running server**.
2. **The handover is one line on the server's stdin pipe:** `wisp:path <PATH>\n`. The pipe already exists
   (`WISP_EXIT_WITH_STDIN`: the server stops when it closes) and only the desktop app holds it, so nothing else (no
   HTTP route, MCP tool, peer or plugin) can send it: default deny by construction, desktop only. `wisp serve` reads
   it as a typed `FromShell` (crates/wisp/src/serve.rs); `Path` is the only kind, anything else on the pipe is
   skipped (never taken as the end), and an empty value or one with NUL is refused. The app never writes a value with
   a line break (`server::path_line`).
3. **`wisp_proc::set_path`** makes the handed PATH the one programs are found on (`which`, the Windows resolution
   lookups) and started with (pipes, PTY, detached), in place of the inherited one, wherever the caller didn't set,
   remove or clear PATH itself. The process environment is not mutated (`std::env::set_var` is unsafe under edition
   2024 and racy with the runtime's threads); the override is one `RwLock` in wisp-proc.

## Consequences

- The first window waits only on the server's cold start and the page: DESK2-08's 5 s budget is unchanged.
- On the very first open, a CLI only the login shell's PATH has is found once the shell answers (seconds), not at the
  next start; every later start already has the saved PATH from the first moment. A CLI installed since the last start
  is found as soon as the shell answers, not at the next start.
- Code that reads `std::env::vars()` itself rather than going through the proc service (the connectors pane's config
  discovery, share's secret scrub) still sees the inherited PATH. Agent CLIs and their detection go through the proc
  service.
- Reaches: the desktop app only (a CLI `wisp serve` is started from a terminal and has the user's PATH already).
