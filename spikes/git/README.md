# git: status and Changes on a 1,000-file change

The bench lives with the code: `plugins/git/host/tests/bench.rs` (an ignored test; criterion isn't in
the workspace). A repo with 1,000 committed files, every one then edited (2 lines of 40), plus 50 new
files; status and Changes (merge-base diff, untracked files read whole, stage state, .env masking) timed
15 times; then 8 Changes reads at once on 2 runtime workers while a 1 ms ticker measures how late it runs.

    CARGO_TARGET_DIR=/tmp/wisp-target-rs-git cargo test -p wisp-git --release --test bench -- --ignored --nocapture

The test fails if the ticker's p99 lateness passes 10 ms (a blocked worker).
