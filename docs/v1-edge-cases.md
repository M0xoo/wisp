# v1 edge cases every v2 port must keep

Collected from the agents who read v1 closely, 2026-11-07. Each one was learned from a bug. A Rust port of
the area turns each into a test. The TypeScript reference port that found them is at the git tag
`v2-ts-server-reference` (`git show v2-ts-server-reference:<path>`).

## Harness runners (claude, codex, …)
1. On `--resume`, Claude's first empty zero-turn result is held; a compaction's looks the same but is final.
2. Usage counters add up across results: count the previous totals only if the counters grew by at least this run's output.
3. Subagent output is only in `modelUsage`: split it among subagents, minus the main thread's share.
4. Background tasks keep the turn open: the CLI reports again after its first result.
5. A failed sign-in can look like success: signed out only when no model answered and the text is ≤ 1200 characters.
6. Read a file's "before" before the CLI writes it: at `tool_use` for Write; otherwise the last change, a snapshot, or git pinned at turn start.
7. Paths come in two spellings (`/tmp` and `/private/tmp`).
8. Codex reports at `turn.completed`, before it exits; its usage is the thread's running total.
9. Stopping needs its own flag: Windows reports a killed child as an ordinary exit code.
10. Write `.claude.json` under its lock; codex `developer_instructions` would replace the user's own.
- G6 fixtures: 34 recorded Claude runs with v1 goldens (`plugins/claude/host/test/fixtures` in the reference tag); `describeCommand` matched v1 on 10,047 commands.

## Git, worktrees, ship
1. `GIT_OPTIONAL_LOCKS=0` and `--no-optional-locks` on every read; also `GIT_TERMINAL_PROMPT=0`, `GH_PROMPT_DISABLED=1`, `GIT_EDITOR=true`.
2. Resolve git's full path once (macOS `/usr/bin/git` is an xcrun shim, ~200 ms; read `/var/db/xcode_select_link`).
3. `git worktree add` one at a time per repo.
4. A worktree's base fetch is good for 60 s. Base order: origin/HEAD, origin/main, origin/master, else HEAD sha with remote null. A repo with no commits gets no worktree.
5. Branch `wisp/<slug≤32>-<id[0..6]>`, the full id when taken; a launch from a subfolder keeps that subfolder.
6. After a squash merge, count unpushed from the merged PR's head, else the remote branch, else ahead.
7. Removal safety: dirty paths + HEAD left the branch, "can't tell" = dirty, re-check right before deleting; foreign worktrees (brought in, ~/conductor, .conductor) are never removed; delete a branch only when `rev-list base..branch` is 0 unless forced.
8. Merge: squash with `--match-head-commit`, ready a draft first, then only fast-forward the user's checkout.
9. `merge-tree --write-tree`: exit 1 = conflict, other exits = unknown (git < 2.38). Check conflict markers with `diff -G^<<<<<<< base...HEAD`.
10. Changes are diffed from the merge-base; untracked files whole (≤ 200, binary if NUL in the first 8000 bytes); ≤ 2000 rows per file, rest in `more`; lockfiles/dist flagged generated; `core.quotePath=false`; hunk actions refused when the hunkKey changed.
- Project trust hashes each item, keyed by the main checkout. Ship's boot recheck drains 2 at a time with a 20 ms pause. Cleanup runs `git worktree prune` every sweep. `.worktreeinclude` copies are copy-on-write (`cp -c -R`, `--reflink=always`).

## Machines and the grid client
1. SSH targets must match `/^(?!-)[\w.%+-]+(@[\w.%:[\]-]+)?$/` (else option injection).
2. The remote wisp refuses any Host but `127.0.0.1:<its port>`: rewrite Host on every request through `-L`.
3. Ids `<id>@<machine>` split at the last `@`; only own ids are relayed; `agent:'wisp'` and delegated sessions dropped (two wisps that list each other loop forever).
4. Reconnect only once it has worked: backoff 2/5/15/30/60 s; `@@wisp fail` and grid 401/403 give up.
5. Relay streams never keep a box awake; asleep → poll the edge's `/_grid/state` every 20 s; a request to an asleep box wakes it; a tunnel 503 = offline.
6. Stopping wisp mid-wake aborts the 90 s health loop.
7. Non-JSON error bodies show status + first 200 chars; DELETE needs an explicit content-length.
8. Bootstrap: `cd $HOME`, PATH from the login shell + nvm/volta/homebrew, install wisp's runtime with a SHA-256 check (refuse musl), 330 s health wait, detect a port taken by another program, `exec cat` to hold the session.
9. Let me in: password only via `SSH_ASKPASS` + `SSH_ASKPASS_REQUIRE=force`; one auth method per try; ed25519 key made once, never added twice.
10. Grid tunnel: set ALPN h2 after Upgrade, strip hop headers, Host loopback, drop Origin, random `x-wisp-tunnel` mark compared in constant time, dead after 70 s silent, redial 1/2/5/15/30 s, 401/404 = gone.
- Device sign-in adds 5 s on `slow_down`; a second account's same-named computer gets " (<handle>)"; removing an account removes its computers and sandboxes on the grid first.

## Channels, MCP, connectors
1. Who may speak is checked by stable id, never display name; strangers get silence (one fixed line in a private chat).
2. Messages older than 10 minutes are refused ("Send it again"); duplicate event ids dropped (last 1000); 20 messages per minute per sender, told once per window.
3. A mode above the channel's cap is refused, never lowered; capped tasks stay capped for every follow-up and child; only the user lifts it.
4. Channel text reaches the agent wrapped as untrusted input; `</message>` escaped; sender names sanitised, ≤ 40 chars.
5. Everything leaving is secret-scrubbed; mentions defused with a zero-width space; names the sender didn't type hidden; images/HTML neutralised.
6. ntfy taps and Telegram buttons HMAC-signed and compared in constant time; ntfy's last 20 ids survive a restart.
7. Link codes: one person per code, new code after 5 wrong guesses, 50 wrong a day total and 5 per sender (hashed), persisted.
8. Grid inbound only via the grid's delivery mark; `dropped` applied after the check; channels never wake a box or reach other machines.
9. Asks only wisp can answer are announced once per ask, to the lead's thread (≤ 5 hops up); only Telegram and ntfy may answer approvals.
10. A broken connection is retried ≤ 3 times; routed reports queue per thread (≤ 20) and retry at 15 s/1 m/5 m/15 m/30 m; a 4xx other than 429 is final; a failed first reply is paid before the next; masked tokens in a PUT mean unchanged.

## The HTTP edge
1. Host allow-list: 127.0.0.1, localhost, [::1] at our port, plus the trusted proxy (secret ≥ 32 chars, constant-time). Non-GET with an Origin must be local (via the proxy: `WISP_PUBLIC_URL`). Trigger secret URLs authenticate themselves.
2. Non-GET bodies must be JSON (octet-stream only on uploads); 2 MB cap in bytes, the rest dropped without buffering (413); decode UTF-8 once at the end.
3. Agent tokens are HMAC(master, "session:<id>") and speak for that session only (id from the URL, then `x-wisp-session`, then the body); connector proxies get HMAC(master, "connectors"); any wrong token is 403; the master token never reaches an agent; grid API keys never manage API keys.
4. A refusal (< 500) is an answer, never logged or reported as an error; errors keep `hold` and `sandboxLogin`.
5. JSON ≥ 8 KB: weak ETag, `private, no-cache`, 304 on If-None-Match, brotli q4 else gzip 1, off the main thread; the task list is a prepared answer.
6. Static: content-named URLs immutable for a year, else no-cache + ETag; `x-wisp-build` on index.html; SPA fallback; > 4 MB streamed with ranges; the phone's first open gets the service-worker boot page and `/_pack`.
7. `/_pack` brotli q11 in 64 KB slices (one big job held exit for 10 s).
8. keep-alive 65 s, headers timeout 66 s.
9. `GET /api/status` lets the grid stop an idle box: live runs, sides, terminals, busy channels, non-relay SSE clients, lastActivityAt (non-GET except channel inbound; run start/turn/end), nextWakeAt.
10. Previews off unless `WISP_PREVIEW_URL`; never our own port; Host rewritten, x-wisp-*/hop headers dropped, redirects to localhost made relative, upgrades piped, ECONNREFUSED → 502 page. `server.json` written after listen, removed on exit only if its pid is ours; `secrets.json` 0600 via tmp + chmod + rename.

## Sync
- The server must send `welcome` before any snapshot it answers for subscriptions made in the same connect; the two failing tests in `packages/sync/test/resume.test.ts` (reference tag) are the spec.
- Store measured (node:sqlite): write amplification 17× at 10 events/tx and 113× at 1 event/tx; G1 list p95 4.4 ms with list columns, 7.9 ms with all. Streaming must coalesce; list snapshots must project columns.
