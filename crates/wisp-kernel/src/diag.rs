//! Settings → Diagnostics (plan §6.11.2 rule 2): the last failures per plugin and the traces of refused
//! calls, in ring buffers so a noisy plugin can't grow memory.
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FailureRecord {
    pub at: i64,
    pub plugin: String,
    /// 'command', 'interceptor', 'event', 'service', 'setup', 'start', 'exec', 'setting', 'route'
    pub kind: String,
    pub code: String,
    pub message: String,
    /// `plugin:hook` frames, root first
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub stack: Vec<String>,
}

#[derive(Debug)]
pub(crate) struct Diagnostics {
    size: usize,
    by_plugin: Mutex<HashMap<String, VecDeque<FailureRecord>>>,
    refusals: Mutex<VecDeque<FailureRecord>>,
}

fn push(q: &mut VecDeque<FailureRecord>, size: usize, f: FailureRecord) {
    if q.len() >= size {
        q.pop_front();
    }
    q.push_back(f);
}

impl Diagnostics {
    pub(crate) fn new(size: usize) -> Self {
        Self {
            size: size.max(1),
            by_plugin: Mutex::default(),
            refusals: Mutex::default(),
        }
    }

    pub(crate) fn record(
        &self,
        at: i64,
        plugin: &str,
        kind: &str,
        code: &str,
        message: String,
        stack: Vec<String>,
    ) {
        let f = FailureRecord {
            at,
            plugin: plugin.to_owned(),
            kind: kind.to_owned(),
            code: code.to_owned(),
            message,
            stack,
        };
        if let Ok(mut m) = self.by_plugin.lock() {
            push(m.entry(plugin.to_owned()).or_default(), self.size, f);
        }
    }

    /// A call the kernel refused (permission, depth, re-entry, read-only): kept with its trace.
    pub(crate) fn refuse(
        &self,
        at: i64,
        plugin: &str,
        code: &str,
        message: String,
        stack: Vec<String>,
    ) {
        let f = FailureRecord {
            at,
            plugin: plugin.to_owned(),
            kind: "refused".into(),
            code: code.to_owned(),
            message,
            stack,
        };
        if let Ok(mut r) = self.refusals.lock() {
            push(&mut r, self.size * 4, f.clone());
        }
        if let Ok(mut m) = self.by_plugin.lock() {
            push(m.entry(plugin.to_owned()).or_default(), self.size, f);
        }
    }

    pub(crate) fn failures(&self, plugin: &str) -> Vec<FailureRecord> {
        self.by_plugin
            .lock()
            .ok()
            .and_then(|m| m.get(plugin).map(|q| q.iter().cloned().collect()))
            .unwrap_or_default()
    }

    pub(crate) fn refusals(&self) -> Vec<FailureRecord> {
        self.refusals
            .lock()
            .map(|r| r.iter().cloned().collect())
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rings_stay_bounded() {
        let d = Diagnostics::new(3);
        for i in 0..10 {
            d.record(i, "a.b", "command", "internal", format!("{i}"), Vec::new());
            d.refuse(i, "a.b", "forbidden", format!("{i}"), vec!["x:y".into()]);
        }
        assert_eq!(d.failures("a.b").len(), 3);
        assert_eq!(d.refusals().len(), 10);
        assert_eq!(
            d.failures("a.b").last().map(|f| f.message.as_str()),
            Some("9")
        );
        assert_eq!(d.failures("c.d"), Vec::new());
    }
}
