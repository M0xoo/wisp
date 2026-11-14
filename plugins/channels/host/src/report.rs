//! A task a channel started answers there, whatever the notifications say (v1 remote.js `notify`/`send`): when
//! it finishes or asks, each running transport that `reports` it (Slack's thread, Discord's, the GitHub issue,
//! the mail thread) or that it started from (Telegram) gets v1's message, made safe to leave. An ask only wisp
//! can answer goes under the task its thread belongs to (a subagent's parent, …), and where approvals can't be
//! given it's one fixed line, once (`wisp_channels_core::report`).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::Value;
use wisp_channels_api::policy::Seen;
use wisp_channels_api::scrub::safe_msg;
use wisp_channels_api::views::{Msg, SessionView, TurnView};
use wisp_channels_api::{Phone, Transport};
use wisp_channels_core::default_project::project_of;
use wisp_channels_core::report::{MAX_HOPS, Report, message, report_kind, up_of};
use wisp_kernel::Ctx;
use wisp_runtime_api::commands as rt;

use crate::{Live, hub, lock, running};

/// Asks said as a waiting line, per channel (a restart ends every ask, so memory is enough).
pub type Said = Mutex<HashMap<String, Seen>>;

/// The task with its open ask and its newest turn, as the message reads them.
async fn task(ctx: &Ctx, id: &str) -> Option<SessionView> {
    let t = hub::typed::<rt::Get>(ctx, hub::get(id)).await.ok()?;
    let mut s = hub::session_view(&t);
    s.ask = t.pointer("/ext/wisp.runtime/ask").cloned().and_then(|a| serde_json::from_value(a).ok());
    if let Ok(Value::Array(turns)) = hub::typed_json::<rt::Turns>(ctx, serde_json::json!({ "id": id, "limit": 1 })).await {
        s.turns = turns.iter().filter_map(|t| serde_json::from_value::<TurnView>(t.clone()).ok()).collect();
    }
    Some(s)
}

/// A channel that answers for this task: it reports it, or the task started there.
fn answers(t: &dyn Transport, live: &Live, s: &SessionView) -> bool {
    t.reports(Some(s)) || hub::started_on(&live.st, &s.id).is_some_and(|c| c == t.name())
}

/// The transports that answer for `session`, the task each reports under, and that task's message.
async fn fan_out(ctx: &Ctx, live: &Arc<Live>, session: &str, preview: Option<&str>) {
    let Some(s) = task(ctx, session).await else { return };
    if s.agent == "wisp" {
        return;
    }
    let all = running(live);
    let projects = Phone::projects(&hub::KPhone(ctx.clone())).await.unwrap_or_default();
    let project = s.cwd.as_deref().and_then(|c| project_of(c, &projects)).map(|p| p.name.clone());
    let msg = message(&s, project.as_deref(), preview);
    for t in all {
        let Some(lead) = lead_for(ctx, live, t.as_ref(), &s).await else { continue };
        let out = {
            let mut said = lock(&live.said);
            match report_kind(t.name(), &lead, said.entry(t.name().to_owned()).or_default(), t.name() == "github") {
                Report::Full => msg.clone(),
                Report::Waiting(line) => Msg { title: line, text: String::new(), actions: Vec::new() },
                Report::Quiet => continue,
            }
        };
        if let Err(e) = t.publish(&safe_msg(&out, t.layer()), Some(&lead)).await {
            tracing::warn!(channel = t.name(), "report not sent: {}", e.message);
        }
    }
}

/// v1 `#heldUp`: the task itself when `t` answers for it; for an ask only wisp can answer, the first task up the
/// chain `t` answers for, carrying the ask. None: `t` answers for none of them.
async fn lead_for(ctx: &Ctx, live: &Live, t: &dyn Transport, s: &SessionView) -> Option<SessionView> {
    if answers(t, live, s) {
        return Some(s.clone());
    }
    if !s.ask.as_ref().is_some_and(wisp_channels_api::AskView::needs_wisp) {
        return None;
    }
    let mut at = s.clone();
    for _ in 0..MAX_HOPS {
        let up = up_of(&at)?;
        at = task(ctx, &up).await?;
        if answers(t, live, &at) {
            return Some(SessionView { ask: s.ask.clone(), ..at });
        }
    }
    None
}

/// A task's own turn ended (done or failed): its report goes where the task came from.
pub(crate) fn finished(ctx: &Ctx, live: &Arc<Live>, session: &str, preview: String) {
    let (c, l, id) = (ctx.clone(), live.clone(), session.to_owned());
    ctx.spawn(async move { fan_out(&c, &l, &id, Some(&preview)).await });
}

/// A task asked: the question, or the waiting line, goes where it (or the task it came from) started.
pub(crate) fn asked(ctx: &Ctx, live: &Arc<Live>, session: &str) {
    let (c, l, id) = (ctx.clone(), live.clone(), session.to_owned());
    ctx.spawn(async move { fan_out(&c, &l, &id, None).await });
}

/// For a declared notification: false when the fan-out already covers this transport for this task.
pub(crate) fn covered(live: &Live, t: &dyn Transport, s: &SessionView) -> bool {
    s.agent != "wisp" && answers(t, live, s)
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_runtime_keeps_the_open_ask_where_the_report_reads_it() {
        // `runtime.get` answers the task with its ask in its own ext slot (runtime/host more/ask.rs `with_slot`)
        let t =
            serde_json::json!({ "id": "s1", "ext": { "wisp.runtime": { "ask": { "id": "a1", "question": "Which?", "options": ["x"] } } } });
        let a: wisp_channels_api::AskView =
            serde_json::from_value(t.pointer("/ext/wisp.runtime/ask").cloned().unwrap_or_default()).unwrap_or_default();
        assert_eq!((a.id.as_str(), a.options.len()), ("a1", 1));
    }
}
