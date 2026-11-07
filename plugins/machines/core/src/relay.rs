//! The v1 whole-stream relay: the downgrade path for a peer that only speaks v1 (plan §7.2.1). Its
//! `/api/events` is read whole and each frame turned into a mirror change, ids qualified as
//! `<id>@<machine>` the way v1's `machines.js` did (`#relay`, `summary`, `session`).
//!
//! Only the machine's **own** sessions pass: two wisps that list each other (two computers on one
//! grid always do) would otherwise hand each task back and forth forever, one `@machine` longer on
//! each lap. Its welcome tour (`agent: 'wisp'`) and delegates' runs stay there too (edge case 3).
use serde_json::{Map, Value};
use wisp_machines_api::qualify;

/// A machine's own session id: not one it shows from its own machines.
pub fn own_id(id: Option<&str>) -> bool {
    id.is_some_and(|id| !id.is_empty() && !id.contains('@'))
}

/// A summary this side never shows: its welcome tour, a delegate's run.
pub fn hidden(s: &Value) -> bool {
    s.get("agent").and_then(Value::as_str) == Some("wisp")
        || s.get("delegated").and_then(Value::as_bool).unwrap_or(false)
}

/// What one v1 frame means here.
#[derive(Debug, Clone, PartialEq)]
pub enum Relayed {
    /// a row of the list (the summary as the machine sent it, ids not qualified)
    Upsert(Value),
    Removed(String),
    /// `activity`, `turn`, `goal-run`: passed on with `sessionId` qualified
    Pass {
        event: String,
        data: Value,
    },
    /// `finished`: the row, and the event with its session rewritten by the caller
    Finished {
        session: Value,
        data: Value,
    },
    Drop,
}

pub fn relay(machine: &str, event: &str, data: Value) -> Relayed {
    let str_at = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).map(str::to_owned);
    let id = match event {
        "finished" => data.get("session").and_then(|s| str_at(s, "id")),
        "activity" | "turn" | "goal-run" => str_at(&data, "sessionId"),
        _ => str_at(&data, "id"),
    };
    if !own_id(id.as_deref()) {
        return Relayed::Drop;
    }
    let id = id.unwrap_or_default();
    match event {
        "summary" if hidden(&data) => Relayed::Drop,
        "summary" => Relayed::Upsert(data),
        "activity" | "turn" | "goal-run" => {
            let mut data = data;
            data["sessionId"] = Value::String(qualify(&id, machine));
            Relayed::Pass {
                event: event.to_owned(),
                data,
            }
        }
        "finished" => {
            let session = data.get("session").cloned().unwrap_or(Value::Null);
            if hidden(&session) {
                Relayed::Drop
            } else {
                Relayed::Finished { session, data }
            }
        }
        "removed" => Relayed::Removed(id),
        _ => Relayed::Drop,
    }
}

/// The machine's list as `GET /sessions?here=1` answered it: its own, shown rows only.
pub fn own_rows(list: &Value) -> Vec<Value> {
    list.as_array()
        .map(|a| {
            a.iter()
                .filter(|s| !hidden(s) && own_id(s.get("id").and_then(Value::as_str)))
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

/// How a machine's rows are tagged here.
#[derive(Debug, Clone)]
pub struct Tag<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub target: &'a str,
    /// a sandbox shows as one wherever its task says where it runs
    pub sandbox: bool,
}

impl Tag<'_> {
    fn value(&self) -> Value {
        let mut m = Map::new();
        m.insert("id".into(), self.id.into());
        m.insert(
            "name".into(),
            if self.sandbox {
                "Sandbox".into()
            } else {
                self.name.into()
            },
        );
        m.insert("target".into(), self.target.into());
        if self.sandbox {
            m.insert("sandbox".into(), true.into());
        }
        Value::Object(m)
    }
}

/// The local project a remote folder belongs to: `(id, name, color)`.
pub type ProjectFor<'a> = &'a dyn Fn(&str) -> Option<(String, String, Option<String>)>;

fn q_field(o: &mut Map<String, Value>, k: &str, m: &str) {
    if let Some(Value::String(s)) = o.get_mut(k) {
        *s = qualify(s, m);
    }
}

fn q_ids(o: &mut Map<String, Value>, m: &str) {
    q_field(o, "id", m);
    q_field(o, "parentId", m);
    if !o
        .get("groupId")
        .is_some_and(|g| g.as_str().is_some_and(|s| !s.is_empty()))
    {
        o.insert("groupId".into(), Value::Null); // random, shared across machines when one launch fans out
    }
    if let Some(Value::Object(f)) = o.get_mut("forkedFrom") {
        q_field(f, "id", m);
    }
    if let Some(Value::Array(forks)) = o.get_mut("forks") {
        forks.iter_mut().for_each(|f| {
            if let Value::String(s) = f {
                *s = qualify(s, m)
            }
        });
    }
}

/// A remote summary as the list here shows it (v1 `summary()`).
pub fn summary(tag: &Tag<'_>, project_for: ProjectFor<'_>, s: &Value) -> Value {
    let Value::Object(mut o) = s.clone() else {
        return s.clone();
    };
    q_ids(&mut o, tag.id);
    if let Some(Value::Array(g)) = o.get_mut("group") {
        for x in g.iter_mut() {
            *x = summary(tag, project_for, x);
        }
    }
    let scratch = o.get("scratch").and_then(Value::as_bool).unwrap_or(false);
    let p = if scratch {
        None
    } else {
        project_for(o.get("cwd").and_then(Value::as_str).unwrap_or(""))
    };
    o.insert(
        "projectId".into(),
        p.as_ref().map_or(Value::Null, |p| p.0.clone().into()),
    );
    if let Some((_, name, color)) = p {
        o.insert("project".into(), name.into());
        if let Some(c) = color {
            o.insert("color".into(), c.into());
        }
    }
    o.insert("machine".into(), tag.value());
    Value::Object(o)
}

/// A remote session as the page opens it (v1 `session()`): children, delegations, attachments too.
pub fn session(tag: &Tag<'_>, s: &Value) -> Value {
    let Value::Object(mut o) = s.clone() else {
        return s.clone();
    };
    let m = tag.id;
    q_ids(&mut o, m);
    if let Some(Value::Object(c)) = o.get_mut("children") {
        c.values_mut().for_each(|v| {
            if let Value::String(s) = v {
                *s = qualify(s, m)
            }
        });
    }
    if let Some(Value::Object(c)) = o.remove("childSessions") {
        o.insert(
            "childSessions".into(),
            Value::Object(
                c.into_iter()
                    .map(|(k, v)| (qualify(&k, m), session(tag, &v)))
                    .collect(),
            ),
        );
    }
    let turns = o.get_mut("turns").and_then(Value::as_array_mut);
    for t in turns.into_iter().flatten() {
        for (list, key) in [("delegations", "sessionId"), ("attachments", "id")] {
            if let Some(Value::Array(xs)) = t.get_mut(list) {
                xs.iter_mut()
                    .filter_map(Value::as_object_mut)
                    .for_each(|x| q_field(x, key, m));
            }
        }
    }
    if !o.contains_key("turns") {
        o.insert("turns".into(), Value::Array(Vec::new()));
    }
    o.insert("machine".into(), tag.value());
    Value::Object(o)
}

#[cfg(test)]
#[path = "relay_tests.rs"]
mod tests;
