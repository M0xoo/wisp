//! Issues as a trigger source (ADR-0043: `issue.opened`, `issue.labeled`; v1 `issues`), sans-IO: a poll's list
//! against what the last one saw. The cursor keeps each issue's labels; the first poll only fills it, so a new
//! trigger doesn't fire on every open issue.

use std::collections::BTreeMap;

use serde_json::{Value, json};
use wisp_automations_api::TriggerEvent;
use wisp_issues_api::Issue;

/// The events since `cursor` (`{ "<id>": [labels] }`), and the new cursor (the issues listed now, capped at 500).
pub fn issue_events(on: &str, issues: &[Issue], cursor: &Value, at: i64) -> (Vec<TriggerEvent>, Value) {
    let before: Option<BTreeMap<String, Vec<String>>> = serde_json::from_value(cursor.clone()).ok().filter(|_| cursor.is_object());
    let mut next: BTreeMap<String, Vec<String>> = before.clone().unwrap_or_default();
    let mut out = Vec::new();
    for i in issues {
        let was = before.as_ref().map(|b| b.get(&i.id));
        let ev = |key: String, summary: String, extra: Value| {
            let mut payload = json!({ "id": i.id, "ref": i.reference, "number": i.number, "title": i.title, "url": i.url, "labels": i.labels, "assignee": i.assignee, "text": i.body });
            if let (Some(p), Value::Object(e)) = (payload.as_object_mut(), extra) {
                p.extend(e);
            }
            TriggerEvent { on: on.to_owned(), key, at, payload, summary, ..TriggerEvent::default() }
        };
        match (on, was) {
            ("issue.opened", Some(None)) => {
                out.push(ev(format!("issue:{}:opened", i.id), format!("{} opened: {}", i.reference, i.title), json!({})));
            }
            ("issue.labeled", Some(prev)) => {
                let had = prev.cloned().unwrap_or_default();
                for l in i.labels.iter().filter(|l| !had.contains(l)) {
                    out.push(ev(
                        format!("issue:{}:label:{l}", i.id),
                        format!("{} labelled {l}: {}", i.reference, i.title),
                        json!({ "label": l }),
                    ));
                }
            }
            _ => {}
        }
        next.insert(i.id.clone(), i.labels.clone());
    }
    while next.len() > 500 {
        let Some(k) = next.keys().next().cloned() else { break };
        next.remove(&k);
    }
    (out, serde_json::to_value(next).unwrap_or_default())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::assert_is_empty)]
mod tests {
    use super::*;

    fn issue(id: &str, labels: &[&str]) -> Issue {
        Issue {
            id: id.into(),
            reference: format!("#{id}"),
            number: wisp_issues_api::IssueNumber::Int(id.parse().unwrap()),
            title: format!("bug {id}"),
            url: String::new(),
            labels: labels.iter().map(|s| (*s).to_owned()).collect(),
            assignee: String::new(),
            body: String::new(),
            updated_at: None,
        }
    }

    #[test]
    fn new_issues_and_new_labels_fire_once() {
        let (first, c) = issue_events("issue.opened", &[issue("1", &[])], &Value::Null, 0);
        assert!(first.is_empty(), "the first poll only fills the cursor");
        let (opened, c) = issue_events("issue.opened", &[issue("1", &[]), issue("2", &["bug"])], &c, 1);
        assert_eq!(opened.iter().map(|e| e.key.as_str()).collect::<Vec<_>>(), ["issue:2:opened"]);
        let (labeled, c) = issue_events("issue.labeled", &[issue("1", &["bug"]), issue("2", &["bug"])], &c, 2);
        assert_eq!(labeled.iter().map(|e| e.key.as_str()).collect::<Vec<_>>(), ["issue:1:label:bug"], "2 had bug already");
        assert_eq!(labeled[0].payload["label"], "bug");
        let (again, _) = issue_events("issue.labeled", &[issue("1", &["bug"])], &c, 3);
        assert!(again.is_empty());
    }
}
