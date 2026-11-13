#!/usr/bin/env bash
# The git plugin's work_tree() (snapshot, patch) as its git calls, before and after: a temporary
# index from `read-tree HEAD` vs a copy of the user's (mtime kept), then `add -A` and `write-tree`.
# Usage: spikes/wip-index/snapshot.sh <repo> [runs]  (the repo wip_bench.rs makes: $TMPDIR/wisp-wip-bench-50000)
set -euo pipefail
repo=${1:?repo}; runs=${2:-5}
cd "$repo"
idx=$(git rev-parse --absolute-git-dir)/wisp-bench.index
ms() { python3 -c 'import time; print(int(time.time()*1000))'; }
for mode in read-tree copy; do
  out=()
  for _ in $(seq "$runs"); do
    rm -f "$idx"; s=$(ms)
    if [ "$mode" = read-tree ]; then GIT_INDEX_FILE=$idx GIT_OPTIONAL_LOCKS=0 git read-tree HEAD
    else cp -p "$(git rev-parse --absolute-git-dir)/index" "$idx"; fi
    GIT_INDEX_FILE=$idx GIT_OPTIONAL_LOCKS=0 git add -A
    GIT_INDEX_FILE=$idx git write-tree >/dev/null
    out+=($(( $(ms) - s )))
  done
  echo "$mode: ${out[*]} ms"
done
rm -f "$idx"
