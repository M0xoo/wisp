# wisp-native protocol, version 1

The server starts one `wisp-native` per host and talks to it over stdio: **one JSON object per
line**, UTF-8, `\n`-terminated. Requests go to the helper's stdin, events come from its stdout.
stderr is a log (`WISP_NATIVE_LOG=debug|info|warn`, default `warn`), never parsed.

The TypeScript mirror is `packages/native/src/protocol.ts`; the Rust side is
`crates/wisp-native/src/protocol.rs`. A change to one changes the other and this page.

- **Ids** are strings the server picks (`p1`, `p2`, …). An id is unique among running children.
- **Bytes** (program output, typed input) are base64 (standard alphabet, padded).
- **Unknown fields are ignored** in both directions, so a newer server can drive an older helper.
  `protocol` in `hello` is bumped only for a change an older peer would misread.
- **Errors** are events with the wire's one error shape: `{code, message, retry}`.
- **The leash:** when stdin closes (the server exited or crashed), the helper kills every tree it
  started (SIGTERM, 500 ms, SIGKILL), then exits 0. On Windows each tree's Job Object has
  `KILL_ON_JOB_CLOSE`, so even a killed helper takes its trees with it.

## Events (stdout)

| type | fields | when |
|---|---|---|
| `hello` | `protocol: 1`, `version`, `pid`, `platform` (`macos`/`linux`/`windows`), `arch` | first line, once |
| `started` | `id`, `pid` | a spawn succeeded; always the first event for its id |
| `data` | `id`, `stream` (`stdout`/`stderr`; a PTY is always `stdout`), `data` (base64) | output |
| `exit` | `id`, `code: number\|null`, `signal: string\|null` (`"SIGTERM"`) | **the last event for an id**; output that the child printed comes before it (300 ms drain) |
| `killed` | `id`, `ref?`, `signalled`, `survivors` | answer to `kill`; `survivors` is 0 unless something refused SIGKILL for 2 s |
| `list` | `ref?`, `items: [{id, pid, pty, exited}]` | answer to `list` |
| `error` | `id?`, `ref?`, `code`, `message`, `retry` | a request was refused |

Error codes: `bad_request` (unreadable line, unknown signal, bad base64), `unknown_id`,
`duplicate_id`, `spawn_failed` (program or folder not found, no PTY), `exited` (input to a child
that has exited), `unsupported` (resize without a PTY, a signal Windows can't send), `io`.

## Requests (stdin)

```jsonc
// Start a program. env is the WHOLE environment (absent: inherit the helper's). With pty, it runs
// on a terminal of that size (set before the program starts). cwd must exist.
{"type":"spawn","id":"p1","cmd":"claude","args":["--resume","x"],"cwd":"/repo","env":{"PATH":"…"},"pty":{"cols":100,"rows":30}}
// Windows only: args already quoted for cmd.exe, passed as written.
{"type":"spawn","id":"p2","cmd":"cmd.exe","args":["/d","/s","/c","\"…\""],"verbatim":true}

{"type":"data","id":"p1","data":"aGkNCg=="}        // typed input / stdin bytes
{"type":"eof","id":"p2"}                           // close stdin (pipes)
{"type":"resize","id":"p1","cols":120,"rows":40}   // PTY only
{"type":"signal","id":"p1","signal":"SIGINT","tree":false}   // send and return; tree: the whole tree
{"type":"kill","id":"p1","signal":"SIGTERM","graceMs":2000,"tree":true,"ref":"k1"}   // → killed
{"type":"list","ref":"l1"}                         // → list
```

`kill` sends `signal` (default `SIGTERM`, then `SIGCONT` so a stopped process can act on it) to
the tree, waits up to `graceMs` (default 2000, at most 60000) for it to go, then SIGKILLs what is
left, re-walking the tree each round (a dying process may fork), and answers `killed`. It works on
an exited child too: its tree stays reachable (the last 256 exited children are kept), so what a
program left running in the background can still be killed.

Signals by name: `SIGHUP SIGINT SIGQUIT SIGKILL SIGTERM SIGUSR1 SIGUSR2 SIGWINCH SIGCONT SIGSTOP
SIGTSTP SIGALRM SIGPIPE`, with or without `SIG`. On Windows, `SIGKILL`, `SIGTERM` and `SIGHUP`
terminate; others are `unsupported`.

## What a tree is

- **Unix.** Every child leads its own process group: `setsid` for a PTY child (it also gets the
  terminal as its controlling tty), `process_group(0)` for a piped one. The tree is that group,
  plus every descendant found by walking parent links in a snapshot of the process table taken
  before anything is signalled (`/proc` on Linux, `proc_listallpids` on macOS), so a grandchild
  that left the group (`setsid`, a daemon) is reached too. Once the root has exited, only its
  group seeds the walk: its pid may belong to a stranger by then, its group id can't.
- **Windows.** Every child is put in its own Job Object right after it starts; what it starts
  joins the job. Killing the tree is `TerminateJobObject`. A child that couldn't be assigned is
  killed by walking its descendants (Toolhelp snapshot), as `taskkill /T` did.

## Example session

```
→ {"type":"spawn","id":"p1","cmd":"sh","args":["-c","echo hi; exit 3"],"pty":{"cols":80,"rows":24}}
← {"type":"started","id":"p1","pid":30781}
← {"type":"data","id":"p1","stream":"stdout","data":"aGkNCg=="}
← {"type":"exit","id":"p1","code":3,"signal":null}
→ {"type":"spawn","id":"p2","cmd":"nope"}
← {"type":"error","id":"p2","code":"spawn_failed","message":"couldn't start nope: No such file or directory (os error 2)","retry":false}
```
