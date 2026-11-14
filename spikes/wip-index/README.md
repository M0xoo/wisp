# wip-index: the task-start pin and git's snapshot on a 50,000-file checkout

The pin (`crates/wisp-harness-kit/src/wip.rs`) and the git plugin's `work_tree()` (`snapshot`, `patch`)
write a tree through a temporary index. Seeded by `read-tree HEAD`, that index has no stat cache, so
`add` re-hashes every tracked file at each task start. Seeded by a copy of the user's `.git/index`
(one open handle, mtime kept for git's racy-clean check), `add` only re-reads what changed, and the
staged adds and removals come along (the two `diff --cached --diff-filter=A/D` passes are gone).

The repo: 50,000 tracked files in 2,000 folders, 20 edited, one staged new file, one staged removal,
the user's index fresh (after a `git status`). macOS 24.6, APFS, Apple git 2.39.5, warm cache.

## The pin (`work_in_progress`, all its git calls)

    CARGO_TARGET_DIR=/tmp/wisp-target-coder cargo test -p wisp-harness-kit --release --test wip_bench -- --ignored --nocapture

| seeded by        | min     | median  | max     | (9 runs) |
|------------------|---------|---------|---------|----------|
| `read-tree HEAD` | 1849 ms | 1936 ms | 2076 ms |          |
| the index's copy |  185 ms |  200 ms |  230 ms | second run: 190 / 196 / 230 |

The first run after making the repo was cold: max 13,480 ms before.

## The git plugin's work tree (`add -A`, untracked included)

    spikes/wip-index/snapshot.sh "$TMPDIR/wisp-wip-bench-50000" 5

| seeded by        | 5 runs                         |
|------------------|--------------------------------|
| `read-tree HEAD` | 3845 2124 1970 1800 1817 ms    |
| the index's copy |  245  241  224  214  219 ms    |

The script times git's own calls (`cp -p` for the copy); the plugin's copy is `copy_keeping_mtime` in
`plugins/git/host/src/write.rs`.
