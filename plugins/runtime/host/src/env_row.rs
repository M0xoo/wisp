//! .env values in a task's own row (ADR-0050, `wisp_runtime_core::env_session`): where its text (a forked /btw's
//! answer, a title from its answer, the list row's preview and live line, its tags, any plugin's slot) quotes a value
//! the task read is kept with the row when it is written, so the sync stream masks it before those values are in
//! memory again; `runtime.get`, `runtime.list`, `runtime.search` and `wisp_sessions` answer it masked too.

use std::sync::Arc;

use serde_json::{Value, json};
use wisp_kernel::WireError;
use wisp_runtime_api::model::{SearchHit, Session, Summary};
use wisp_runtime_core::env_session::{self as es, HIDE, Part, SUMMARY};

use crate::runtime::Runtime;

/// What `known` couldn't be read leaves in a row: unreadable ranges, so every agent text of it is hidden (fail closed).
const UNREAD: &str = "unread";

/// The ranges a task's row keeps (`body.envHide`): always written, `{}` when nothing quotes a value, so a row
/// written since ranges existed is told from one stored before.
pub(crate) fn session_hide(s: &Session, known: Option<&[String]>) -> Value {
    match known {
        None => json!(UNREAD),
        Some([]) => json!({}),
        Some(k) => serde_json::to_value(s).map_or_else(|_| json!(UNREAD), |v| Value::Object(es::hide_of(&v, &es::SESSION, k))),
    }
}

/// The list row's own ranges (`summary.envHide`), only when it quotes one (or `known` couldn't be read).
pub(crate) fn summary_hide(summary: &mut Summary, known: Option<&[String]>) {
    summary.fields.remove(HIDE);
    let h = match known {
        None => json!(UNREAD),
        Some([]) => return,
        Some(k) => match serde_json::to_value(&*summary) {
            Ok(v) => {
                let m = es::hide_of(&v, &SUMMARY, k);
                if m.is_empty() {
                    return;
                }
                Value::Object(m)
            }
            Err(_) => json!(UNREAD),
        },
    };
    summary.fields.insert(HIDE.into(), h);
}

/// A task as `runtime.get` answers it: `part`'s text masked against what it read (`known`), all of its agent text
/// hidden when that couldn't be read. An error, never the task as it is, when the round trip fails.
pub(crate) fn mask_session(s: Session, part: &Part, known: Option<&[String]>) -> Result<Session, WireError> {
    crate::env_view::masked(s, |v| match known {
        Some(k) => es::mask(v, part, "", Some(k)),
        None => es::hide_whole(v, part),
    })
}

fn quotes_a_line(x: &Summary) -> bool {
    [x.title.as_str(), x.preview.as_str(), x.live.as_str()].iter().any(|t| t.contains('='))
        || x.fields.get("question").and_then(Value::as_str).is_some_and(|q| q.contains('='))
}

/// A list row as it leaves (`runtime.list`, `wisp_sessions`): its kept ranges, what its task read when that is in
/// memory, .env-shaped lines in its text. `mask` off: as it is, the ranges dropped.
pub(crate) fn summary_out(r: &Runtime, x: &Arc<Summary>, mask: bool) -> Summary {
    let kept = x.fields.contains_key(HIDE);
    if !mask {
        let mut s = (**x).clone();
        s.fields.remove(HIDE);
        return s;
    }
    let known = r.env.get(x.id.as_str()).map(|v| v.0);
    if !kept && !quotes_a_line(x) && known.as_ref().is_none_or(Vec::is_empty) {
        return (**x).clone();
    }
    let mut s = crate::env_view::masked((**x).clone(), |v| es::mask(v, &SUMMARY, "", known.as_deref())).unwrap_or_else(|_| {
        let mut s = (**x).clone();
        wisp_envmask::DOTS.clone_into(&mut s.title);
        s.preview.clear();
        s.live.clear();
        s
    });
    s.fields.remove(HIDE); // a read is never patched: its ranges stay here
    s
}

/// `runtime.search`'s hits: each one's title and snippet (the list row's) as [`summary_out`] has them.
pub(crate) fn search_out(r: &Runtime, hits: Vec<SearchHit>, mask: bool) -> Vec<SearchHit> {
    if !mask {
        return hits;
    }
    hits.into_iter()
        .map(|mut h| {
            let row = r.lock_list().get(h.id.as_str()).cloned();
            if let Some(row) = row {
                let s = summary_out(r, &row, true);
                (h.title, h.snippet) = (s.title, s.preview);
            } else {
                wisp_envmask::DOTS.clone_into(&mut h.title);
                h.snippet.clear();
            }
            h
        })
        .collect()
}
