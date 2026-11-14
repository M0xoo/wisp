# wisp.terminal

Terminals inside wisp: a task's shell and its take over (v1 `server/pty.js`, `/sessions/:id/shell`,
`/sessions/:id/term`).

## Intent

- One terminal per task and kind, on a real PTY; a second open answers the one that runs.
- Its state follows plan §4.6.3: a slow start says so after 8 s, a Stop while it starts cancels the start
  (never raced, v1 #435), and an ended terminal never reopens its dead screen (v1 #432).
- A page that opens late sees the screen so far (the last 1 MB), then the output as it comes, as v1's event
  stream (`hello`, `data`, `exit`).
- Keys a page sends without waiting go in in order (numbered per page); a gap is skipped after a while.
- The shell opens in the task's worktree, else its folder.

## Not yet

`terminal.service@1` for runtime's take over, terminal apps (open in Terminal/iTerm), `terminal.apps`.
