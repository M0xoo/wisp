# This Mac: what agents cost the computer

What the page reads to show, per task, the memory, CPU and disk agents take, what they left
running, and what can be freed (spec: E1 server, E2 page). The server is `server/machine.js`; the
guard it extends is `server/load.js` (design/budget.md → Machine load).

## `GET /api/machine`

One object. Bytes are bytes, times are ms since the epoch, CPU is a percent.

```js
{
  at,                                   // when this was read
  mem: { total, freePct, pressure, per }, // total bytes; freePct 0–100 or null; pressure: Linux PSI some avg10, else null;
  // per: what every process's rss below is: 'footprint' (macOS phys_footprint, Activity Monitor's
  // Memory column) or 'rss' (Linux, Windows' working set, or a Mac where it couldn't be read)
  cpu: { pct, cores },                  // pct: load as % of all cores (100 = every core busy), null before the first sample
  disk: { free, total, worktrees, reclaimable }, // the disk <home>/worktrees is on; worktrees: bytes wisp's folders take (null until measured); reclaimable: sum of reclaim[].bytes
  wisp: { rss, cpu },                   // wisp's own server process: rss bytes, cpu % of one core (ps %cpu)
  guard: {
    held,          // null, or what holds automations now: 'paused' | 'battery' | 'memory' | 'cpu' | 'runs'
    why,           // the sentence the page shows ("Automations paused until 20:00"), or null
    floor,         // memoryFloor in %, null when off
    ceiling,       // cpuCeiling in % of cores, null when off
    maxRuns,       // null when off
    runs,          // wisp's runs going now
    pausedUntil,   // defaults.automationsPausedUntil, 0 when not paused
    battery,       // null off a Mac or without one; else { pct, charging, hold } (hold: the batteryHold %, null when off)
  },
  tasks: [{ id, title, crew, rss, cpu, procs, worktreeBytes }],
  // one row per running task: rss bytes and cpu % of one core summed over its process tree;
  // procs: how many; crew: the crew member's id for a crew job, else null; worktreeBytes: its folders
  // from the last worktree look (null until measured). Sorted by rss, biggest first.
  crew: [{ id, name, rss, cpu, jobs }], // per crew member with a job running: the sum of its jobs' rows; jobs: how many
  leftovers: [{ pid, command, rss, cpu, task, since }],
  // processes a finished run left running: task is the task's id, or null when only its folder
  // (under <home>/worktrees) ties it to wisp; since: when it started; command trimmed to 200 chars.
  leftoverGroups: [{ id, command, task, count, rss, cpu, pids, commands, since }],
  // the same processes by what started them: command is the program and script of each one's
  // topmost left-behind ancestor, before the first flag ("node …/bin/wisp.js": three test servers on
  // three ports are one group); task as above (a child takes its root's); rss and cpu summed; pids
  // and up to 10 distinct full command lines; since: the oldest. id: for File a fix. Biggest first.
  history: [{ at, freePct, cpu, runs, held, worktreeBytes }], // 1-min points, the last 24 h, oldest first; held: boolean
  reclaim: [{ kind, count, bytes, ids }],
  // kind: 'merged' (a merged or closed PR), 'done' (Done tasks), 'crew' (finished crew jobs),
  // 'leftover' (folders no task knows). ids: task ids, or folder names for 'leftover'. Only folders
  // that hold nothing else (clean, idle, not kept) count. A group with nothing in it is left out.
  // kind 'harness' (last, once measured): the harnesses' own folders, with more fields:
  //   { kind: 'harness', count, bytes, ids, total, measuredAt, harnesses: [{ id, name, bytes, parts: [{ label, path, bytes }], removable: { count, bytes }, how }] }
  //   count / bytes: what Remove frees (crash dumps, stale temp files); ids: the harnesses with any.
  //   total: every harness folder's bytes. parts: each folder measured, path with ~ for home.
  //   how: the sentence naming the CLI's own way to keep less (the rest is never wisp's to delete).
  //   Shown even when count is 0: it says where the disk went.
}
```

Acting on it:

- `POST /api/worktrees/clean { ids }` for a reclaim group (`{ leftovers: ids }` for `leftover`).
- `POST /api/machine/stop { pid }`: stops a pid in `leftovers` or in a running task's tree (SIGTERM,
  SIGKILL 5 s later). Anything else, wisp itself or its parents: 403. `{ stopped: pid }`.
- `POST /api/automations/pause { until }`: holds automations until then (ms); `0` resumes.
  Sets `defaults.automationsPausedUntil` and broadcasts `config`. `{ pausedUntil }`.
- `POST /api/machine/harness/clean { ids? }`: removes the `harness` group's removable files (all
  harnesses without `ids`), checked again at that moment. `{ removed, freed }`; then measures again.
- `POST /api/machine/fix { group }`: *File a fix* for a `leftoverGroups[].id`. A task for the crew's
  Bugsy (the member named or handled `bugsy`, through its own assign, as a task you gave) with the
  command lines, the task they came from and "kill what you spawn"; without a Bugsy, a task in that
  task's project. `{ crew, session }`, `{ crew, queued }` (Bugsy busy) or `{ session }`. 404: the
  group is gone; 409: no Bugsy and no task to file it in. It never stops the processes.
- Stopping a task is the task's own Stop (`POST /api/sessions/:id/stop`), not this.

## What gets measured, and when

- One `ps` per 10 s tick (Windows: one PowerShell `Get-CimInstance Win32_Process`), only while a
  run is going or `GET /machine` was read in the last 30 s. Idle and unread, nothing runs.
- A run's tree: the runner's child pid and everything under it. Every agent is spawned with
  `WISP_TASK=<task id>` in its env, and a pid once seen in a tree stays tagged with that task, so a
  process reparented to pid 1 is still known. On Linux `/proc/<pid>/environ` (and on macOS `ps -E`
  where the system shows it) finds the tag on processes wisp never saw.
- Left behind: tagged with a task that isn't running, or with a command line under
  `<home>/worktrees`, and older than 2 min. Whatever wisp itself started outside a run (Preview's
  dev server, the panel's shell and terminals) is wisp's own and never listed.
- Disk numbers come from Settings → Worktrees' last look (`app.worktrees.view()`); no `du` of its own.

## Memory per process on a Mac

Activity Monitor's Memory column is `phys_footprint`; RSS leaves out compressed memory and counts
shared pages (wisp's own server: 803 MB RSS, 1,039 MB footprint, the same as `footprint -p`). `ps`
has no column for it, and `top -l 1 -stats pid,mem` costs ~0.5 s of CPU per call over every
process. So after the `ps`, one `/usr/bin/perl -e` asks `proc_pid_rusage` (the `proc_info`
syscall) for only the pids shown: the runs' trees, the leftovers and wisp (~15 ms for 60 pids, no
root). A pid it can't read keeps its RSS; perl missing or failing: all RSS, and `mem.per` says so.

## Harness data

`server/harness-disk.js`. Per harness, its own folders: `~/.claude` (or `CLAUDE_CONFIG_DIR`),
Cowork's VM (`~/Library/Application Support/Claude/vm_bundles`), `/tmp/claude-<uid>`; `~/.codex`
(or `CODEX_HOME`) and the Codex app's folder; `~/.cursor` and the Cursor app's; opencode's data and
cache (XDG); `~/.gemini` (Antigravity) and its app's; `~/.copilot`; `~/.grok`. Only folders that
are there, in one `du -sk`, at most every 6 h (a removal measures again), never while the machine is
short, and never on Windows (no du). Those folders hold sign-ins: nothing opens a file. What's
removable is found by name and `lstat` only:

- crash dumps over an hour old: a `Crashpad`'s `completed/`, `pending/`, `new/`, and Antigravity's
  `crashes/` folders (Claude, Codex, Cursor, Antigravity);
- Claude Code's `claude-<hex>-cwd` temp files in `/tmp` and the OS temp folder, over a day old and
  named by no running process.

Everything else gets the `how` line. On the owner's Mac (7 Nov): 165 GB in 7 harnesses, 150 GB of
it Antigravity's `~/.gemini/antigravity/scratch`; the `du` took 7 s under a load of 190.

## The task list

A running task's summary gets `res: { rss, cpu }` when its tree takes over 500 MB or 50% CPU, and
loses it under. The summary is only re-sent when `rss` or `cpu` moved by more than 20%, so a card
doesn't repaint every tick. Under the thresholds nothing shows, so rows don't shift.

## Automations: paused, on battery

Both hold the same work the guard holds (check-ins, the crew queue, triggers, goal rounds, agents'
own follow-ups and wake-ups), with the same waits state:

- `defaults.automationsPausedUntil` (ms): "Automations paused until 20:00". Expires by itself.
- `defaults.batteryHold` (`off` | `20` | `40`, default `20`), macOS only: on battery and under that
  percent, "Waiting for power: battery at 14%". On the charger it goes on.

What you start by hand, answers and a running task's delegates never wait (as with the guard).

## Spells

Settings: `batteryHold`. `automationsPausedUntil` is a time, not a choice, so it isn't a spell
setting; a spell can't pause automations. The page's slot and parts (E2) are machine-ui's.
