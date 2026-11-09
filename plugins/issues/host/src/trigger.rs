//! `issue.opened` and `issue.labeled` (ADR-0043): a polled trigger source over the picker's own lister (gh
//! through proc, cached a minute), so the trigger and the picker read GitHub the same way.

use std::sync::Arc;

use serde_json::{Value, json};
use wisp_automations_api::{Polled, SourceOn, TriggerSource};
use wisp_issues_api::{ListArgs, Source};
use wisp_kernel::{BoxFuture, Ctx, Result, WireError};

use crate::list::Lister;

pub struct Issues(pub Arc<Lister>, pub Ctx);

impl TriggerSource for Issues {
    fn plugin(&self) -> &'static str {
        "wisp.issues"
    }
    fn ons(&self) -> Vec<SourceOn> {
        let fields = json!({ "type": "object", "properties": { "project": { "type": "string" }, "label": { "type": "string" }, "author": { "type": "string" } } });
        vec![
            SourceOn { on: "issue.opened".into(), title: "An issue opened".into(), fields: fields.clone(), mode: "poll".into(), every: Some(5) },
            SourceOn { on: "issue.labeled".into(), title: "An issue labelled".into(), fields, mode: "poll".into(), every: Some(5) },
        ]
    }
    fn poll(&self, on: &str, spec: &Value, cursor: Value) -> BoxFuture<'static, Result<Polled>> {
        let (lister, ctx, on) = (self.0.clone(), self.1.clone(), on.to_owned());
        let project = spec.get("project").and_then(Value::as_str).unwrap_or_default().to_owned();
        Box::pin(async move {
            if project.is_empty() {
                return Err(WireError::invalid(format!("{on} needs a project (the repo it watches)")));
            }
            let call = ctx.root_call();
            let list = lister.list(&call, ListArgs { source: Source::Github, project: Some(project), q: String::new() }).await?;
            if let Some(e) = list.error {
                return Err(WireError::unavailable(e));
            }
            let now = ctx.clock()?.now_ms();
            let (events, cursor) = wisp_issues_core::trigger::issue_events(&on, &list.issues, &cursor, now);
            Ok(Polled { events, cursor, retry_at: None })
        })
    }
}
