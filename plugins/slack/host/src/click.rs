//! Buttons and clicks (v1 slack.js `#buttons`, `interactive`, `#click`): a report's choices as buttons, each signed
//! for its ask, so a click can't answer another. A click passes the same door as a message (a stranger's does
//! nothing), is acked like any envelope, and answers through wisp; the message loses its buttons and says what and
//! who. A reply button only on a task that isn't in Full auto (a button can't say which mode: that's for words).
//! Typed answers always work.

use serde_json::Value;
use wisp_channels_api::policy::{Gate, GateArgs, gate};
use wisp_channels_api::scrub::{defuse, scrub_out};
use wisp_channels_api::views::{ActArgs, ActionKind, Msg, SessionView, Signed};
use wisp_channels_api::Mode;
use wisp_kernel::Result;
use wisp_slack_core::post::{self, Choice};
use wisp_slack_core::{event, mrkdwn};

use crate::{Slack, lock, s, slack_text};

pub const DEAD_BUTTON: &str = "That button doesn’t work any more.";
pub const IN_WORDS: &str = "Say that in words here, so it runs in Edits at most.";

/// The report's choices as signed buttons: answers, and replies unless the task runs in Full auto.
pub fn choices(msg: &Msg, sv: &SessionView, sign: &dyn Fn(ActionKind, &str, u32) -> String) -> Vec<Choice> {
    let clean = |t: &str| defuse(&scrub_out(t, false).text);
    msg.actions
        .iter()
        .filter(|a| a.kind == ActionKind::Answer || (a.kind == ActionKind::Reply && sv.mode != Some(Mode::Auto)))
        .map(|a| Choice { label: mrkdwn::label(if a.label.is_empty() { "OK" } else { &a.label }, &clean), code: a.kind.code(), session: sv.id.clone(), reference: a.reference.clone(), index: a.index, sig: sign(a.kind, &a.reference, a.index) })
        .collect()
}

/// Blocks Slack won't take: the words go without them.
pub fn no_blocks(code: &str) -> bool {
    matches!(code, "invalid_blocks" | "invalid_blocks_format" | "msg_blocks_too_long")
}

impl Slack {
    /// A line only the clicker sees.
    async fn only(&self, chat: &str, user: &str, ts: &str, text: &str) -> Result<()> {
        let token = s(&self.cfg(), "botToken").to_owned();
        self.call("chat.postEphemeral", &post::ephemeral(chat, user, ts, &slack_text(text)), &token).await.map(drop).map_err(Into::into)
    }

    /// A click on one of wisp's buttons.
    pub(crate) async fn click(&self, payload: &Value) -> Result<()> {
        let Some(c) = event::click(payload) else { return Ok(()) };
        let user = c.user.clone().unwrap_or_default();
        let cfg = self.cfg();
        let senders: Vec<String> = cfg.get("senders").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect();
        let g = {
            let (mut seen, mut limit) = (lock(&self.seen), lock(&self.limit));
            let id = c.id.as_ref().map(|i| format!("click:{i}"));
            #[allow(clippy::cast_possible_truncation)]
            let at_s = c.action_ts.map(|t| t as i64);
            gate(GateArgs { sender: Some(&user), senders: &senders, id: id.as_deref(), at_s, seen: Some(&mut seen), limit: Some(&mut limit), now_ms: self.hub.now_ms(), ..GateArgs::default() })
        };
        if let Gate::Refused { reply, why } = g {
            self.hub.phone().count("refused", Some(&format!("{why:?}").to_lowercase()));
            if let Some(r) = reply {
                self.only(&c.chat, &user, &c.root, &r).await?;
            }
            return Ok(());
        }
        let b = event::button(&c.value);
        let kind = b.as_ref().and_then(|b| ActionKind::from_code(&b.k)).filter(|k| *k != ActionKind::Done);
        let (Some(b), Some(kind)) = (b, kind) else { return self.only(&c.chat, &user, &c.root, DEAD_BUTTON).await };
        if !self.hub.verify(&Signed { s: b.s.clone(), k: b.k.clone(), r: b.r.clone(), i: b.i, sig: b.sig.clone() }) {
            return self.only(&c.chat, &user, &c.root, DEAD_BUTTON).await;
        }
        if kind == ActionKind::Reply && self.hub.phone().session(&b.s).await.ok().flatten().is_none_or(|sv| sv.mode == Some(Mode::Auto)) {
            return self.only(&c.chat, &user, &c.root, IN_WORDS).await;
        }
        let result = match self.hub.act(&ActArgs { session_id: b.s.clone(), kind: kind.into(), reference: Some(b.r.clone()), index: Some(b.i), text: None, approvals: false }).await {
            Ok(r) => r,
            Err(e) => return self.only(&c.chat, &user, &c.root, &format!("Couldn’t send that: {}", wisp_slack_core::truncate(&e.message, 300))).await,
        };
        if !result.starts_with('✓') {
            return self.only(&c.chat, &user, &c.root, &result).await;
        }
        let line = format!("{} · <@{user}>", slack_text(&result));
        let token = s(&cfg, "botToken").to_owned();
        let text = c.text.clone().unwrap_or_else(|| slack_text(&result));
        if let Err(e) = self.call("chat.update", &post::clicked(&c.chat, &c.message_ts, &text, &c.blocks, &line), &token).await {
            // no network: a post wouldn't get through either
            if e.code().is_none() {
                return Err(e.into());
            }
            self.call("chat.postMessage", &crate::body(&c.chat, &c.root, &line), &token).await.map_err(wisp_kernel::WireError::from)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wisp_channels_api::views::Action;

    #[test]
    fn a_reports_choices_are_signed_buttons_and_a_reply_only_outside_full_auto() {
        let msg = Msg { title: "t".into(), text: "x".into(), actions: vec![Action { label: "Yes".into(), kind: ActionKind::Answer, reference: "ask1".into(), index: 0 }, Action { label: "Reply".into(), kind: ActionKind::Reply, reference: "turn1".into(), index: 1 }, Action { label: "Done".into(), kind: ActionKind::Done, reference: "turn1".into(), index: 2 }] };
        let sign = |k: ActionKind, r: &str, i: u32| format!("{}:{r}:{i}", k.code());
        let edits = SessionView { id: "t1".into(), mode: Some(Mode::Edits), ..SessionView::default() };
        let c = choices(&msg, &edits, &sign);
        assert_eq!(c.iter().map(|c| (c.code, c.sig.as_str())).collect::<Vec<_>>(), [("a", "a:ask1:0"), ("r", "r:turn1:1")], "Done is no choice");
        let auto = SessionView { mode: Some(Mode::Auto), ..edits };
        assert_eq!(choices(&msg, &auto, &sign).len(), 1, "no reply button in Full auto");
        assert!(no_blocks("invalid_blocks") && !no_blocks("ratelimited"));
    }
}
