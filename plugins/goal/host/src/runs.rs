//! A goal's check records (v1 server/goal-runs.js): each judge's run of each round, kept as a `goal_run` row on
//! its task's topic (`session:<id>`), so the checks popover opens one like a task (plugins/goal/ui RunView): what
//! wisp asked it, what it did, everything it answered, its vote and why. Written when it starts (`running`, so the
//! page opens at once) and again when it ends. A task keeps its last [`KEEP`] (v1: a goal keeps its last 50).

use serde_json::{Value, json};
use wisp_kernel::Ctx;
use wisp_store::{Col, EntityDef, Migration, Query, Row, Store};

pub const OWNER: &str = "goal";
pub const KIND: &str = "goal_run";
/// v1 `GoalRuns`: "A goal keeps its last 50".
pub const KEEP: usize = 50;

const MIGRATIONS: &[Migration] = &[Migration::sql(
    1,
    "CREATE TABLE goal_run (id TEXT PRIMARY KEY, task TEXT NOT NULL, turn_id TEXT NOT NULL, round INTEGER NOT NULL, name TEXT NOT NULL,
       agent TEXT, model TEXT, status TEXT NOT NULL, \"end\" TEXT, verdict TEXT, why TEXT, started_at INTEGER NOT NULL, turn TEXT) STRICT;
     CREATE INDEX goal_run_task ON goal_run (task, started_at);",
)];

fn topics(r: &Row) -> Vec<String> {
    r.get("task").and_then(Value::as_str).map(|t| vec![format!("session:{t}")]).unwrap_or_default()
}

pub const RUN: EntityDef = EntityDef {
    kind: KIND,
    table: "goal_run",
    key: "id",
    columns: &[
        ("id", Col::Text),
        ("task", Col::Text),
        ("turn_id", Col::Text),
        ("round", Col::Int),
        ("name", Col::Text),
        ("agent", Col::Text),
        ("model", Col::Text),
        ("status", Col::Text),
        ("end", Col::Text),
        ("verdict", Col::Text),
        ("why", Col::Text),
        ("started_at", Col::Int),
        ("turn", Col::Text),
    ],
    json_columns: &["turn"],
    parent: None,
    seq: None,
    topics,
};

pub fn install(store: &Store) -> wisp_store::Result<()> {
    store.migrate(OWNER, MIGRATIONS)?;
    store.define_entity(RUN)
}

/// Who ran one check and on what.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Check<'a> {
    pub id: &'a str,
    pub task: &'a str,
    pub turn_id: &'a str,
    pub round: u32,
    pub name: &'a str,
    pub agent: &'a str,
    pub model: &'a str,
    pub prompt: &'a str,
    pub at: i64,
}

/// The record as a check starts: what it was asked, nothing done yet.
pub fn started(c: &Check<'_>) -> Row {
    row(c, "running", None, None, "", &json!({ "id": c.id, "prompt": c.prompt, "status": "running", "startedAt": c.at, "activity": [] }))
}

/// How a check ended: its answer read as a vote, or the run's failure.
#[derive(Debug, Clone, PartialEq)]
pub enum Ended<'a> {
    Voted { met: bool, why: &'a str, text: &'a str, activity: &'a [Value], model: &'a str },
    Failed { why: &'a str },
}

/// The record once the check ended: its vote and why, everything it said (`turn.text`) and did (`turn.activity`).
pub fn ended(c: &Check<'_>, e: &Ended<'_>, at: i64) -> Row {
    match e {
        Ended::Voted { met, why, text, activity, model } => {
            let turn = json!({ "id": c.id, "prompt": c.prompt, "status": "done", "startedAt": c.at, "endedAt": at, "text": text, "activity": activity });
            let model = if model.is_empty() { c.model } else { model };
            row(&Check { model, ..c.clone() }, "done", None, Some(if *met { "met" } else { "not_yet" }), why, &turn)
        }
        Ended::Failed { why } => {
            let turn = json!({ "id": c.id, "prompt": c.prompt, "status": "error", "startedAt": c.at, "endedAt": at, "activity": [] });
            row(c, "error", Some("error"), None, why, &turn)
        }
    }
}

fn row(c: &Check<'_>, status: &str, end: Option<&str>, verdict: Option<&str>, why: &str, turn: &Value) -> Row {
    let mut r = Row::new();
    let text = |s: &str| if s.is_empty() { Value::Null } else { json!(s) };
    for (k, v) in [
        ("id", json!(c.id)),
        ("task", json!(c.task)),
        ("turn_id", json!(c.turn_id)),
        ("round", json!(c.round)),
        ("name", json!(c.name)),
        ("agent", text(c.agent)),
        ("model", text(c.model)),
        ("status", json!(status)),
        ("end", end.map_or(Value::Null, |e| json!(e))),
        ("verdict", verdict.map_or(Value::Null, |v| json!(v))),
        ("why", text(why)),
        ("started_at", json!(c.at)),
        ("turn", turn.clone()),
    ] {
        r.insert(k.into(), v);
    }
    r
}

/// The ids past the newest [`KEEP`] of one task's records, oldest first in `newest_first`'s reverse.
pub fn past_keep(newest_first: &[Row]) -> Vec<String> {
    newest_first.iter().skip(KEEP).filter_map(|r| r.get("id").and_then(Value::as_str).map(str::to_owned)).collect()
}

/// Writes one record (and drops the task's oldest past [`KEEP`]). A refused write is logged: the goal goes on.
pub async fn put(ctx: &Ctx, r: Row) {
    let Ok(store) = ctx.service::<Store>() else { return };
    let task = r.get("task").and_then(Value::as_str).unwrap_or_default().to_owned();
    let out = store
        .write(move |w| {
            w.upsert(KIND, r)?;
            let all = w.query(KIND, &Query::new().select(&["id"]).eq("task", task.clone()).desc("started_at").desc("id"))?;
            for id in past_keep(&all) {
                w.del(KIND, id)?;
            }
            Ok(())
        })
        .await;
    if let Err(e) = out {
        tracing::warn!(error = %e, "goal: writing a check's record");
    }
}

/// After a restart: every record still `running` ends `interrupted` (it never voted). The tasks they were for.
pub async fn interrupted(ctx: &Ctx, at: i64) -> Vec<String> {
    let Ok(store) = ctx.service::<Store>() else { return Vec::new() };
    let out = store
        .write(move |w| {
            let mut tasks: Vec<String> = Vec::new();
            for r in w.query(KIND, &Query::new().eq("status", "running"))? {
                if let Some(t) = r.get("task").and_then(Value::as_str).filter(|t| !tasks.iter().any(|x| x == t)) {
                    tasks.push(t.to_owned());
                }
                w.upsert(KIND, cut_short(r, at))?;
            }
            Ok(tasks)
        })
        .await;
    out.unwrap_or_else(|e| {
        tracing::warn!(error = %e, "goal: ending the checks a restart cut short");
        Vec::new()
    })
}

/// A record a restart cut short: ended `interrupted`, without a vote (v1 goal-run.js ENDS.interrupted).
pub fn cut_short(mut r: Row, at: i64) -> Row {
    r.insert("status".into(), json!("error"));
    r.insert("end".into(), json!("interrupted"));
    if let Some(Value::Object(turn)) = r.get_mut("turn") {
        turn.insert("status".into(), json!("error"));
        turn.insert("endedAt".into(), json!(at));
    }
    r
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn check() -> Check<'static> {
        Check { id: "r1", task: "t1", turn_id: "u1", round: 2, name: "reviewer", agent: "claude", model: "", prompt: "Is it met?", at: 10 }
    }

    /// v1 goal-run.js: the page opens on a running check at once, then reads all it said once it voted.
    #[test]
    fn a_check_is_recorded_as_it_starts_and_with_everything_it_said_when_it_ends() {
        let s = started(&check());
        assert_eq!(
            (s["status"].clone(), s["round"].clone(), s["turn"]["prompt"].clone()),
            (json!("running"), json!(2), json!("Is it met?"))
        );
        assert_eq!(topics(&s), vec!["session:t1".to_owned()], "on its task's topic");
        let said = "Looked at math.js.\n\nNOT MET: add still subtracts";
        let steps = [json!({ "kind": "tool", "label": "Read math.js" })];
        let e = ended(&check(), &Ended::Voted { met: false, why: "add still subtracts", text: said, activity: &steps, model: "opus" }, 20);
        assert_eq!(
            (e["status"].clone(), e["verdict"].clone(), e["why"].clone(), e["model"].clone()),
            (json!("done"), json!("not_yet"), json!("add still subtracts"), json!("opus"))
        );
        assert_eq!(
            (e["turn"]["text"].clone(), e["turn"]["activity"][0]["label"].clone(), e["turn"]["endedAt"].clone()),
            (json!(said), json!("Read math.js"), json!(20))
        );
        let f = ended(&check(), &Ended::Failed { why: "claude couldn't judge: timed out" }, 30);
        assert_eq!((f["status"].clone(), f["end"].clone(), f["verdict"].clone()), (json!("error"), json!("error"), Value::Null));
    }

    /// A restart mid-check: the record ends interrupted, never left spinning on the page.
    #[test]
    fn a_check_a_restart_cut_short_ends_interrupted() {
        let r = cut_short(started(&check()), 99);
        assert_eq!(
            (r["status"].clone(), r["end"].clone(), r["turn"]["status"].clone(), r["turn"]["endedAt"].clone()),
            (json!("error"), json!("interrupted"), json!("error"), json!(99))
        );
    }

    #[test]
    fn a_task_keeps_its_last_fifty_checks() {
        let rows: Vec<Row> = (0..53).map(|i| [("id".to_owned(), json!(format!("r{i}")))].into_iter().collect()).collect();
        assert_eq!(past_keep(&rows), vec!["r50", "r51", "r52"]);
        assert_eq!(past_keep(&rows[..KEEP]), Vec::<String>::new());
    }
}
