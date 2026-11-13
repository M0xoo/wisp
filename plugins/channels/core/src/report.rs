//! What a channel hears about a task (v1 remote.js `message`, `#heldUp`; channel.js `waiting`): the message for
//! a task that asks or finished, with its buttons; which task a report goes under when an ask can only be
//! answered in wisp; and, in a channel that can't take approvals, one fixed line per such ask instead of a
//! report (a task started from Slack that stalls on an approval says so, once).

use serde_json::Value;
use wisp_channels_api::policy::{Seen, approvals_here};
use wisp_channels_api::scrub::{truncate, waiting_line};
use wisp_channels_api::views::{Action, ActionKind, Msg, SessionView};

/// How far up a subagent, a side discussion or a delegated crew job looks for the thread it came from.
pub const MAX_HOPS: usize = 8;
const CONTEXT_MAX: usize = 600;
const PLAIN_MAX: usize = 1000;

fn str_of<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// v1 `message(s, summary)`: the title names the project and the task; an ask's options are answer buttons;
/// a finished turn's `question` block options are reply buttons, else one Mark done.
pub fn message(s: &SessionView, project: Option<&str>, preview: Option<&str>) -> Msg {
    let place = project.filter(|p| !p.is_empty()).map_or_else(|| s.title.clone(), |p| format!("{p}: {}", s.title));
    if let Some(ask) = &s.ask {
        let text = [ask.question.clone(), ask.context.as_deref().map(|c| truncate(c, CONTEXT_MAX))]
            .into_iter()
            .flatten()
            .filter(|t| !t.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n");
        let actions = ask
            .options
            .iter()
            .zip(0u32..)
            .map(|(label, index)| Action { label: label.clone(), kind: ActionKind::Answer, reference: ask.id.clone(), index })
            .collect();
        return Msg { title: format!("❓ {place}"), text, actions };
    }
    let turn = s.turns.last();
    let blocks: Vec<Value> =
        turn.and_then(|t| t.presentation.as_ref()).and_then(|p| p.get("blocks")).and_then(Value::as_array).cloned().unwrap_or_default();
    let of = |ty: &'static str| blocks.iter().filter(move |b| str_of(b, "type") == Some(ty));
    let hero = of("hero").next();
    let q = of("question").next_back();
    let icon = match hero.and_then(|h| str_of(h, "status")) {
        Some("done") => "✅",
        Some("partial") => "🟡",
        Some("blocked") => "⛔",
        _ if turn.is_some_and(|t| t.status == "error") => "⛔",
        _ => "📝",
    };
    let plain = of("markdown").next().and_then(|b| str_of(b, "text")).map(|t| truncate(t, PLAIN_MAX));
    let headline = hero.and_then(|h| str_of(h, "title")).filter(|t| *t != s.title).map(str::to_owned);
    let body = hero
        .and_then(|h| str_of(h, "summary"))
        .map(str::to_owned)
        .or_else(|| preview.filter(|p| !p.is_empty()).map(str::to_owned))
        .or(plain)
        .unwrap_or_else(|| "Ready for review.".into());
    let asked = q.and_then(|q| str_of(q, "question")).map(str::to_owned);
    let text = [headline, Some(body), asked].into_iter().flatten().collect::<Vec<_>>().join("\n\n");
    let turn_id = turn.map(|t| t.id.clone()).unwrap_or_default();
    let options: Vec<String> = q
        .and_then(|q| q.get("options"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|o| o.as_str().or_else(|| str_of(o, "label")).or_else(|| str_of(o, "reply")).map(str::to_owned))
        .collect();
    let actions = if options.is_empty() {
        vec![Action { label: "Mark done".into(), kind: ActionKind::Done, reference: turn_id, index: 0 }]
    } else {
        options
            .into_iter()
            .zip(0u32..)
            .map(|(label, index)| Action { label, kind: ActionKind::Reply, reference: turn_id.clone(), index })
            .collect()
    };
    Msg { title: format!("{icon} {place}"), text, actions }
}

/// The task one up from `s`, for an ask with no thread of its own: a subagent's parent, a side discussion's
/// task, a delegated crew job's asker.
pub fn up_of(s: &SessionView) -> Option<String> {
    s.parent_id
        .clone()
        .or_else(|| s.side_of.as_ref().and_then(|v| str_of(v, "id")).map(str::to_owned))
        .or_else(|| {
            let c = s.crew.as_ref()?;
            (str_of(c, "job") == Some("delegated")).then(|| c.pointer("/from/id").and_then(Value::as_str).map(str::to_owned))?
        })
        .filter(|id| !id.is_empty())
}

/// What a channel posts about a task.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Report {
    /// the report, with its buttons
    Full,
    /// a task stalled on an ask only wisp can answer: this line instead, once per ask
    Waiting(String),
    /// that ask was said here already
    Quiet,
}

/// v1 `waiting(s, { bare })`: a channel that can't take approvals says once that the task waits for you in wisp.
/// `bare`: where strangers read (a public repo), the fixed words with nothing of the ask.
pub fn report_kind(channel: &str, s: &SessionView, said: &mut Seen, bare: bool) -> Report {
    match &s.ask {
        Some(ask) if !approvals_here(channel) && ask.needs_wisp() => {
            if said.first(&ask.id) {
                Report::Waiting(waiting_line(ask, bare))
            } else {
                Report::Quiet
            }
        }
        _ => Report::Full,
    }
}
