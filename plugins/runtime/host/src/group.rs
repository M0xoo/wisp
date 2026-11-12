//! Runs of one ask side by side (v1 compare.js, F-comp-30; ADR-0027: compare is reruns side by side). The
//! runs `wisp --compare` starts share a group, kept in runtime's own slot (`ext["wisp.runtime"].group`) where
//! the caller put it; the list row carries it as `groupId`, so the task's More can offer Compare runs.

use std::collections::BTreeMap;
use std::sync::Arc;

use serde_json::{Value, json};
use wisp_kernel::Setup;
use wisp_runtime_api::model::{Session, Turn};
use wisp_runtime_api::points::{SUMMARY, SummaryField};

/// The task's group, if it was started as one of several runs.
pub fn group_of(s: &Session) -> Option<&str> {
    s.ext.get("wisp.runtime").and_then(|o| o.get("group")).and_then(Value::as_str).filter(|g| !g.is_empty())
}

struct Group;

impl SummaryField for Group {
    #[allow(clippy::unnecessary_literal_bound)] // the trait's signature
    fn plugin(&self) -> &str {
        "wisp.runtime"
    }
    fn fields(&self, session: &Session, _last: Option<&Turn>, out: &mut BTreeMap<String, Value>) {
        if let Some(g) = group_of(session) {
            out.insert("groupId".into(), json!(g));
        }
    }
}

pub fn setup(s: &mut Setup) {
    let g: Arc<dyn SummaryField> = Arc::new(Group);
    s.contribute(&SUMMARY, g);
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn a_run_of_a_compare_carries_its_group_on_the_row_v1_compare_group() {
        let mut s = Session::default();
        let mut out = BTreeMap::new();
        Group.fields(&s, None, &mut out);
        assert!(out.is_empty(), "a task started alone has no group");
        s.ext.insert("wisp.runtime".into(), json!({ "titleAuto": true, "group": "" }));
        Group.fields(&s, None, &mut out);
        assert!(out.is_empty(), "an empty group is none");
        s.ext.insert("wisp.runtime".into(), json!({ "titleAuto": true, "group": "g-1" }));
        Group.fields(&s, None, &mut out);
        assert_eq!(out.get("groupId").unwrap(), "g-1");
    }
}
