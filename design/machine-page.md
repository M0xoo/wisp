# This Mac (the page)

What agents cost the computer wisp runs on, and acting on it from one place. The owner had to
restart a 24 GB Mac (2026-11-07) with nothing in wisp saying which task held the memory. The server
side (`server/machine.js`, `GET /machine`, `POST /machine/stop`, `POST /automations/pause`) is in
design/machine.md; this file is the page. Words and sums live in `web/js/machine-view.js` (DOM-free,
`test/machine-view.test.js`), the pane and the chip in `web/js/features/machine.js`, the look in
`web/css/machine.css` (class prefix `mh-`: `mc-` is Machines').

## Name

By the OS wisp runs on, not the browser's (a phone looks at the computer): **This Mac**, **This PC**
(Windows), **This computer** (Linux, a cloud box). `GET /config` carries `platform`.

## Where

- **Settings → This Mac**, between Spells and Worktrees.
- **⌘K → What’s using my computer** (`commands.js`).
- **The top-bar chip** (`#machineChip`), beside Update. Only when it matters: free memory under the
  floor + 10 points, work held by the guard, automations paused, or processes left behind. It reads
  *12% memory · 9 running*, *Paused until 20:00* or *2 left behind*; on a phone only the first part
  (*12%*). The number is `--warn` near the floor and `--bad` under it; the chip itself stays neutral.
  It reads `GET /load` every 15 s while the page is visible (cheap, no `ps`), and the left-behind count
  from the pane's last `/machine`. Click opens the pane.
- **Task rows**: a running task whose summary has `res` (the server sets it over 500 MB or 50% CPU)
  shows its RAM (*3.4 GB*, `.q-res`) in a fixed-width column of `.it-side`, before the time. Under the
  thresholds nothing renders, so most rows never change.

## The pane, top to bottom

1. **Gauges**: Memory (free %, *21 GB of 24 GB used*, the floor dashed), CPU (% of cores, the
   ceiling dashed), Disk (free, what wisp's folders take, what can go). Each with the last hour from
   `history` (1-min points). Side by side three across; stacked, one line each with the sparkline
   beside it.
2. **What’s using it**: running tasks outside the crew and crew members (their jobs summed), by RAM,
   in fixed columns RAM / CPU / Folder, then **Later ▾** and **Stop**. wisp itself is the last row, no
   actions. Stacked, the numbers go on a second line, labelled.
   - **Stop**: the row goes at once, then `POST /sessions/:id/stop` for each id; refused, it comes back
     with a red toast.
   - **Later ▾**: In 1 hour, Tonight (20:00, while that's over an hour ahead), Tomorrow morning (9:00).
     Stops, then schedules a follow-up (*Carry on where you stopped.*) through `later.js`
     (`timeMenu` with its own `choices`).
3. **Left behind** (only when there's some): command (mono), its task, age, pid, RAM, **Stop**, and
   **Stop all** (asks first). `POST /machine/stop {pid}`; optimistic, rolled back with the server's
   reason.
4. **Free up space**: the reclaim groups as recommendations, safest first: merged or closed PRs, Done
   tasks, finished crew jobs, then folders no task knows. **Review** opens Settings → Worktrees (the
   *Left over* filter for the last); **Remove** sends the group's ids to `POST /worktrees/clean`
   (`leftovers` for the last, which asks first and is marked danger). A line says what the automatic
   cleanup does by itself next.
5. **Automations**: *Waiting for memory: 12% free, needs 20%*, *Automations paused until 20:00* or *Running as
   usual*. **Pause automations ▾** (For 1 hour, Until tomorrow 8:00, Pick a time…) or **Resume now**,
   at once, then `POST /automations/pause {until}` (0 resumes). The limits in one line, with
   **Change** to Settings → Usage → Machine load (the knobs live there, one place).
6. **Last 24 hours**: lowest free memory, most runs at once, how long automations waited, disk freed.

## Behaviour

- **Cached first**: the last `/machine` is kept (module and `localStorage`), painted at once, replaced
  quietly. With nothing cached, every section shows placeholders of its real shape (`.rec-sk`), and
  a failed read says so where the time goes.
- **Refresh without moving**: `/machine` every 10 s while the pane shows. Rows are keyed; only a
  changed row is rewritten and only one out of place moves, so focus stays and nothing replays.
- **Same names**: Stop, Later, Pause automations, Resume now, Remove, Review.
- **Spells**: slot `machine.head` (a button at the top of the pane); parts `machine.chip`,
  `machine.pane`, `machine.gauges`, `machine.using`, `machine.leftBehind`, `machine.freeUp`,
  `machine.automations`, `machine.day` and `card.ram`. The pause setting is the server's
  (`automationsPausedUntil`).

## Not now

The guard's three knobs stay in Settings → Usage (one place to change them). Per-process trees,
SIGSTOP, quiet hours, a daily digest (spec → NOT NOW).
