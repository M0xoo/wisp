//! `files.changed` as a trigger source (ADR-0043), sans-IO: the host polls `git status --porcelain=v1 -z
//! --untracked-files=all` in a trigger's project; this reads it. Git leaves out what `.gitignore` ignores, and
//! wisp's own worktrees (`<wisp home>/worktrees/…`, where agents edit all day) never fire: a project inside one
//! is skipped, and so is a path that leads into one. An event fires when the set of changed files is new
//! (its hash is the cursor); the first poll only sets the cursor.

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use wisp_automations_api::TriggerEvent;

/// `git status` for the poll.
pub const STATUS_ARGS: [&str; 4] = ["status", "--porcelain=v1", "-z", "--untracked-files=all"];

/// Whether `path` is in one of wisp's own worktrees.
pub fn in_own_worktree(path: &str, wisp_home: &str) -> bool {
    let root = format!("{}/worktrees/", wisp_home.trim_end_matches('/'));
    !wisp_home.is_empty() && (path.starts_with(&root) || format!("{path}/") == root)
}

/// The paths `git status -z` lists (a rename's new name).
pub fn changed_paths(porcelain_z: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut parts = porcelain_z.split('\0').filter(|p| !p.is_empty());
    while let Some(entry) = parts.next() {
        let Some(path) = entry.get(3..) else { continue };
        let xy = &entry[..2.min(entry.len())];
        if xy.contains('R') || xy.contains('C') {
            // `-z` puts the old name after the new one
            parts.next();
        }
        out.push(path.to_owned());
    }
    out.sort();
    out.dedup();
    out
}

/// The event for a poll, if the changed files are new since `cursor`; and the new cursor.
pub fn files_changed(project: &str, porcelain_z: &str, cursor: &Value, wisp_home: &str, at: i64) -> (Option<TriggerEvent>, Value) {
    let root = project.trim_end_matches('/');
    if in_own_worktree(root, wisp_home) {
        return (None, cursor.clone());
    }
    let paths: Vec<String> =
        changed_paths(porcelain_z).into_iter().filter(|p| !in_own_worktree(&format!("{root}/{p}"), wisp_home)).collect();
    let mut h = Sha256::new();
    for p in &paths {
        h.update(p.as_bytes());
        h.update([0]);
    }
    let digest = h.finalize().iter().take(12).fold(String::new(), |mut acc, b| {
        use std::fmt::Write as _;
        let _ = write!(acc, "{b:02x}");
        acc
    });
    let next = json!(digest);
    if cursor.is_null() || *cursor == next || paths.is_empty() {
        return (None, next);
    }
    let summary = match paths.as_slice() {
        [one] => format!("{one} changed"),
        [first, rest @ ..] => format!("{first} and {} more changed", rest.len()),
        [] => String::new(),
    };
    let ev = TriggerEvent {
        on: "files.changed".into(),
        key: format!("files:{root}:{digest}"),
        at,
        payload: json!({ "project": root, "cwd": root, "paths": paths }),
        summary,
        ..TriggerEvent::default()
    };
    (Some(ev), next)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn files_changed_ignores_wisps_own_worktrees_and_gitignored() {
        let home = "/Users/me/.wisp";
        // what git status says: gitignored files (node_modules, dist) are never in it; a nested wisp worktree is
        let st = " M src/a.rs\0?? notes.md\0R  src/new.rs\0src/old.rs\0";
        let (first, c) = files_changed("/w/api", st, &Value::Null, home, 1);
        assert!(first.is_none(), "the first poll only sets the cursor");
        let more = format!("{st}?? b.txt\0");
        let (ev, c2) = files_changed("/w/api", &more, &c, home, 2);
        let ev = ev.unwrap();
        assert_eq!(
            ev.payload["paths"],
            json!(["b.txt", "notes.md", "src/a.rs", "src/new.rs"]),
            "a rename's new name; the old one isn't a path"
        );
        assert!(files_changed("/w/api", &more, &c2, home, 3).0.is_none(), "the same set again: nothing new");
        // a project that is one of wisp's own worktrees never fires, however much changes
        let wt = "/Users/me/.wisp/worktrees/api-1f2e";
        let (none, _) = files_changed(wt, &more, &json!("old"), home, 4);
        assert!(none.is_none());
        // a path into one (a project that holds wisp's home) is dropped
        let (ev, _) = files_changed("/Users/me", "?? .wisp/worktrees/api-1f2e/x.rs\0 M code/y.rs\0", &json!("old"), home, 5);
        assert_eq!(ev.unwrap().payload["paths"], json!(["code/y.rs"]));
        let (none, _) = files_changed("/Users/me", "?? .wisp/worktrees/api-1f2e/x.rs\0", &json!("old"), home, 6);
        assert!(none.is_none(), "only wisp's own edits: nothing");
        // gitignored: git status is asked without --ignored, so ignored files never reach here
        assert!(!STATUS_ARGS.contains(&"--ignored"));
    }
}
