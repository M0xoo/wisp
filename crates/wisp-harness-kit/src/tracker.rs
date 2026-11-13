//! The rules of v1's `fileTracker` (adapters/common.js), sans-IO: for harnesses that only report
//! "file X changed" after the fact. The driver reads the disk and git; this decides what the "before"
//! side is. In order: the content after the previous change we saw, else a snapshot taken when the
//! harness announced the edit (only if it predates the write: the harness doesn't wait for us), else
//! the file as it was when the turn started (the work in progress through a temporary index,
//! [`crate::wip`], pinned once per folder per tick),
//! else nothing (a new file).

use std::collections::HashMap;

use crate::event::{Change, Edit, HarnessEvent};

/// Where `change` finds the "before" side.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Before {
    /// known without IO (the last change, or the announced snapshot)
    Known(Option<String>),
    /// ask git for the file at the pinned base (None there means a new file)
    Git,
}

/// One run's tracker state, keyed by project-relative path.
#[derive(Debug, Default)]
pub struct Tracker {
    /// content after our last change (None = missing)
    known: HashMap<String, Option<String>>,
    /// content when the harness announced an edit
    announced: HashMap<String, Option<String>>,
}

impl Tracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether `remember(file)` needs a snapshot: only the first announcement before any change counts.
    pub fn wants_snapshot(&self, file: &str) -> bool {
        !self.known.contains_key(file) && !self.announced.contains_key(file)
    }

    /// The snapshot the driver took for an announcement (v1 `remember`).
    pub fn remembered(&mut self, file: &str, snapshot: Option<String>) {
        if self.wants_snapshot(file) {
            self.announced.insert(file.to_owned(), snapshot);
        }
    }

    /// Step one of `change`: given the file now, where its "before" comes from.
    pub fn before(&self, file: &str, after: Option<&str>) -> Before {
        if let Some(k) = self.known.get(file) {
            return Before::Known(k.clone());
        }
        // An empty snapshot may be the write caught half way (truncated, not written yet): ask git.
        match self.announced.get(file) {
            Some(was) if was.as_deref() != after && was.as_deref() != Some("") => {
                Before::Known(was.clone())
            }
            _ => Before::Git,
        }
    }

    /// Step two: record the change and answer the `change` event, or None when nothing changed.
    pub fn changed(
        &mut self,
        file: &str,
        before: Option<String>,
        after: Option<String>,
    ) -> Option<HarnessEvent> {
        self.known.insert(file.to_owned(), after.clone());
        self.announced.remove(file);
        if before == after {
            return None;
        }
        let op = if before.is_none() { "create" } else { "write" };
        Some(HarnessEvent::Change(Change {
            file: file.to_owned(),
            op: op.to_owned(),
            edits: vec![Edit {
                before: before.clone().unwrap_or_default(),
                after: after.unwrap_or_default(),
            }],
            early: None,
            before_file: Some(before),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(
        t: &mut Tracker,
        file: &str,
        after: Option<&str>,
        git: Option<&str>,
    ) -> Option<HarnessEvent> {
        let before = match t.before(file, after) {
            Before::Known(b) => b,
            Before::Git => git.map(str::to_owned),
        };
        t.changed(file, before, after.map(str::to_owned))
    }

    fn edit(e: &HarnessEvent) -> (String, String, String) {
        match e {
            HarnessEvent::Change(c) => (
                c.op.clone(),
                c.edits[0].before.clone(),
                c.edits[0].after.clone(),
            ),
            _ => (String::new(), String::new(), String::new()),
        }
    }

    #[test]
    fn before_comes_from_git_then_the_last_change() {
        let mut t = Tracker::new();
        let e = run(&mut t, "a.js", Some("v2"), Some("v1"));
        assert_eq!(
            e.as_ref().map(edit),
            Some(("write".into(), "v1".into(), "v2".into()))
        );
        let e = run(&mut t, "a.js", Some("v3"), Some("v1"));
        assert_eq!(
            e.as_ref().map(edit),
            Some(("write".into(), "v2".into(), "v3".into()))
        );
        assert!(run(&mut t, "a.js", Some("v3"), None).is_none(), "unchanged");
    }

    #[test]
    fn announced_snapshot_wins_unless_empty_or_already_written() {
        let mut t = Tracker::new();
        t.remembered("b.js", Some("old".into()));
        t.remembered("b.js", Some("later".into())); // only the first counts
        let e = run(&mut t, "b.js", Some("new"), Some("git"));
        assert_eq!(
            e.as_ref().map(edit),
            Some(("write".into(), "old".into(), "new".into()))
        );

        let mut t = Tracker::new();
        t.remembered("c.js", Some(String::new())); // caught half way
        let e = run(&mut t, "c.js", Some("new"), Some("git"));
        assert_eq!(
            e.as_ref().map(edit),
            Some(("write".into(), "git".into(), "new".into()))
        );

        let mut t = Tracker::new();
        t.remembered("d.js", Some("new".into())); // the write had already landed
        let e = run(&mut t, "d.js", Some("new"), None);
        assert_eq!(
            e.as_ref().map(edit),
            Some(("create".into(), String::new(), "new".into()))
        );
    }

    #[test]
    fn a_missing_file_is_created() {
        let mut t = Tracker::new();
        match run(&mut t, "n.js", Some("x"), None) {
            Some(HarnessEvent::Change(c)) => {
                assert_eq!((c.op.as_str(), c.before_file), ("create", Some(None)));
            }
            other => assert!(other.is_some(), "a change"),
        }
    }
}
