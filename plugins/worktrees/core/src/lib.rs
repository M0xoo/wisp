//! wisp-worktrees-core: wisp.worktrees's pure logic (sans-IO: no tokio, fs, net or clock). The host reads
//! files and asks git.service; these functions decide. Each v1 behaviour and `docs/v1-edge-cases.md` Git
//! bullet for worktrees is a test here (property tests use a seeded PRNG, no dependency).
#![cfg_attr(test, allow(clippy::assert_is_empty, clippy::option_option, clippy::doc_markdown, clippy::map_unwrap_or))]
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::indexing_slicing))]

pub mod base;
pub mod changes;
pub mod done;
pub mod include;
pub mod naming;
pub mod offer;
pub mod removal;
pub mod setup;
pub mod source;
pub mod sweep;
pub mod trust;

#[cfg(test)]
mod testrand;

/// Each repo once (`git worktree prune` runs in every repo tasks know, every sweep: entries whose folder
/// is gone pile up in .git/worktrees and every `worktree add` reads them all).
pub fn prune_roots<'a>(roots: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for r in roots {
        if !r.is_empty() && !out.iter().any(|x| x == r) {
            out.push(r.to_owned());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn every_repo_tasks_know_is_pruned_once() {
        assert_eq!(super::prune_roots(["/a", "", "/b", "/a"]), ["/a", "/b"]);
    }
}
