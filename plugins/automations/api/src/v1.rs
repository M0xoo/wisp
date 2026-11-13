//! v1's trigger rows as v2 trigger specs (ADR-0043, `wisp import`): each of v1's 8 kinds maps to a source, and a
//! crew member's `on` (v1 `MEMBER_KINDS`) becomes its `wakes`. The v1 kind lists live only here, for import.

use serde_json::Value;

use crate::model::TriggerBase;
use crate::spec::TriggerSpec;

/// The source a v1 kind is now.
pub fn on_of(kind: &str) -> Option<&'static str> {
    Some(match kind {
        "schedule" => "schedule",
        "ci" => "ci.failed",
        "issues" => "issue.labeled",
        "finished" => "task.finished",
        "done" => "task.done",
        "webhook" => "webhook",
        "slack" => "chat.message",
        "linear" => "linear.issue",
        _ => return None,
    })
}

/// A v1 row's name as a trigger's (`Nightly review` → `nightly-review`).
pub fn name_of(t: &TriggerBase) -> String {
    let base = if t.name.trim().is_empty() { &t.id } else { &t.name };
    let mut out = String::new();
    for c in base.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out = out.trim_end_matches('-').to_owned();
    if out.is_empty() { format!("trigger-{}", t.id) } else { out }
}

/// A v1 trigger row as a spec; None for a kind v1 never had.
pub fn from_v1(t: &TriggerBase) -> Option<(String, TriggerSpec)> {
    let on = on_of(&t.kind)?;
    let name = name_of(t);
    let mut s = TriggerSpec {
        on: on.into(),
        prompt: t.prompt.clone(),
        task: t.recipe_id.clone(),
        crew: t.crew.clone(),
        project: t.cwd.clone(),
        agent: t.agent.clone(),
        model: t.model.clone(),
        mode: t.mode.clone(),
        enabled: (!t.enabled).then_some(false),
        ..TriggerSpec::default()
    };
    match t.kind.as_str() {
        "schedule" => s.cron.clone_from(&t.cron),
        "ci" => {
            s.branch.clone_from(&t.branch);
            s.every = (t.every > 0).then_some(t.every);
        }
        "issues" => {
            s.label.clone_from(&t.label);
            s.every = (t.every > 0).then_some(t.every);
        }
        // the secret URL's token isn't carried: the new trigger reads its secret from secrets
        "webhook" | "linear" => s.secret = format!("${{secret:{name}}}"),
        "slack" => {
            if let Some(c) = &t.channel {
                s.filters.insert("channel".into(), Value::String(c.clone()));
            }
            if let Some(k) = &t.keyword {
                s.filters.insert("keyword".into(), Value::String(k.clone()));
            }
            // v1 saved some open: anyone in the channel could start it, which v2 says out loud
            s.users = t.users.clone().filter(|u| !u.is_empty()).unwrap_or_else(|| vec!["anyone".into()]);
        }
        _ => {}
    }
    if s.prompt.trim().is_empty() && s.task.is_empty() && s.crew.is_empty() {
        s.prompt = format!("{} fired: {{event.summary}}", t.name);
    }
    Some((name, s))
}

/// A v1 member's `on` (`finished`, `done`, `ci`) as its wakes.
pub fn member_wakes(member: &str, on: &[String]) -> Vec<TriggerSpec> {
    on.iter().filter_map(|k| on_of(k)).map(|on| TriggerSpec { on: on.into(), crew: member.to_owned(), ..TriggerSpec::default() }).collect()
}

#[cfg(test)]
#[allow(clippy::assert_is_empty, clippy::unwrap_used)]
mod tests {
    use super::*;

    fn row(kind: &str) -> TriggerBase {
        TriggerBase {
            id: "abc123".into(),
            name: format!("My {kind}"),
            kind: kind.into(),
            enabled: true,
            cwd: "/w/api".into(),
            prompt: "go".into(),
            cron: "0 9 * * 1-5".into(),
            branch: "main".into(),
            label: "bug".into(),
            every: 5,
            ..TriggerBase::default()
        }
    }

    #[test]
    fn v1_trigger_rows_import_to_specs() {
        let want = [
            ("schedule", "schedule"),
            ("ci", "ci.failed"),
            ("issues", "issue.labeled"),
            ("finished", "task.finished"),
            ("done", "task.done"),
            ("webhook", "webhook"),
            ("slack", "chat.message"),
            ("linear", "linear.issue"),
        ];
        for (kind, on) in want {
            let (name, s) = from_v1(&row(kind)).unwrap_or_else(|| panic!("{kind}"));
            assert_eq!((s.on.as_str(), s.project.as_str()), (on, "/w/api"), "{kind}");
            assert_eq!(name, format!("my-{kind}"));
            assert!(crate::spec::check(&s).is_empty(), "{kind}: {:?}", crate::spec::check(&s));
        }
        assert_eq!(from_v1(&row("schedule")).unwrap().1.cron, "0 9 * * 1-5");
        assert_eq!(from_v1(&row("ci")).unwrap().1.branch, "main");
        assert_eq!(from_v1(&row("issues")).unwrap().1.label, "bug");
        assert_eq!(from_v1(&row("webhook")).unwrap().1.secret, "${secret:my-webhook}");
        let slack = TriggerBase { channel: Some("C1".into()), keyword: Some("deploy".into()), ..row("slack") };
        let (_, s) = from_v1(&slack).unwrap();
        assert_eq!(
            (s.filters["channel"].as_str(), s.users.as_slice()),
            (Some("C1"), &["anyone".to_owned()][..]),
            "an open v1 channel stays open, said out loud"
        );
        assert!(from_v1(&row("telepathy")).is_none());
        assert_eq!(from_v1(&TriggerBase { enabled: false, ..row("done") }).unwrap().1.enabled, Some(false));
        // MEMBER_KINDS → wakes
        let wakes = member_wakes("ada", &["finished".into(), "ci".into(), "done".into()]);
        assert_eq!(
            wakes.iter().map(|w| (w.on.as_str(), w.crew.as_str())).collect::<Vec<_>>(),
            [("task.finished", "ada"), ("ci.failed", "ada"), ("task.done", "ada")]
        );
    }
}
