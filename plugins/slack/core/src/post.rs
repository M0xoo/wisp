//! What wisp posts to Slack (v1 `Slack#body`, `#buttons`, `#report`, `#click`, `slackManifest`).
//! Every post sets `parse: none`, no link names and no unfurling: unfurling fetches URLs an agent
//! wrote. The text in here has already been through [`crate::mrkdwn::fit`].
use serde_json::{Value, json};

use crate::mrkdwn::sections;

pub const MAX_BUTTONS: usize = 25;
const ACTION: &str = "wisp:";

/// `chat.postMessage` in a thread.
pub fn body(chat: &str, ts: &str, text: &str) -> Value {
    json!({ "channel": chat, "thread_ts": ts, "text": text, "mrkdwn": true, "parse": "none", "link_names": false, "unfurl_links": false, "unfurl_media": false })
}

/// The same post with its buttons under the words.
pub fn with_buttons(mut body: Value, buttons: Vec<Value>) -> Value {
    let text = body
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let mut blocks = sections(&text);
    blocks.push(json!({ "type": "actions", "elements": Value::Array(buttons) }));
    if let Some(o) = body.as_object_mut() {
        o.insert("blocks".into(), Value::Array(blocks));
    }
    body
}

/// The same post under a crew member's name (`chat:write.customize`).
pub fn as_member(mut body: Value, by: &str) -> Value {
    if let Some(o) = body.as_object_mut() {
        o.insert("username".into(), by.into());
        o.insert("icon_emoji".into(), ":robot_face:".into());
    }
    body
}

/// `chat.postEphemeral`: a line only the clicker sees.
pub fn ephemeral(chat: &str, user: &str, ts: &str, text: &str) -> Value {
    json!({ "channel": chat, "user": user, "thread_ts": ts, "text": text, "parse": "none", "link_names": false })
}

/// `chat.update` of a clicked message: its buttons gone, and a line that says what and who.
pub fn clicked(chat: &str, ts: &str, text: &str, blocks: &[Value], line: &str) -> Value {
    let mut kept: Vec<Value> = blocks
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) != Some("actions"))
        .cloned()
        .collect();
    kept.push(json!({ "type": "context", "elements": [{ "type": "mrkdwn", "text": line, "verbatim": true }] }));
    json!({ "channel": chat, "ts": ts, "text": text, "blocks": kept, "parse": "none", "link_names": false })
}

/// One choice as a button, signed for its ask by the hub.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Choice {
    /// already through [`crate::mrkdwn::label`]
    pub label: String,
    /// `a` (answer) or `r` (reply)
    pub code: &'static str,
    pub session: String,
    pub reference: String,
    pub index: u32,
    pub sig: String,
}

/// One per choice, at most [`MAX_BUTTONS`]: past that they're left to the Choices line.
pub fn buttons(choices: &[Choice]) -> Vec<Value> {
    choices
        .iter()
        .take(MAX_BUTTONS)
        .map(|c| {
            let value = json!({ "k": c.code, "s": c.session, "r": c.reference, "i": c.index, "sig": c.sig }).to_string();
            json!({ "type": "button", "action_id": format!("{ACTION}{}", c.index), "text": { "type": "plain_text", "text": c.label }, "value": value })
        })
        .collect()
}

/// A crew member's report starts with their name, once.
pub fn titled(title: &str, by: Option<&str>) -> String {
    match by.filter(|b| !b.is_empty()) {
        Some(b) if !title.starts_with(&format!("{b}: ")) => format!("{b}: {title}"),
        _ => title.to_owned(),
    }
}

/// A report: title, text, the choices in words (all an app without buttons has), and how to answer.
/// `dm`: replies in a DM's thread reach wisp; in a channel only a mention does.
pub fn report(
    title: &str,
    text: &str,
    choices: &[String],
    by: Option<&str>,
    dm: bool,
    me: Option<&str>,
) -> String {
    let here = if dm {
        "Reply in this thread to answer or follow up.".to_owned()
    } else {
        format!(
            "Mention {} in this thread to answer or follow up.",
            me.filter(|m| !m.is_empty()).unwrap_or("wisp")
        )
    };
    let choices = if choices.is_empty() {
        String::new()
    } else {
        format!("Choices: {}", choices.join(" · "))
    };
    [titled(title, by), text.to_owned(), choices, here]
        .into_iter()
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// The app to create at api.slack.com/apps → From a manifest: Socket Mode, so no URLs, the two
/// events and the exact scopes. `url`: one Slack posts its events to instead (then no socket, and no
/// clicks: those would need a request URL of their own).
pub fn manifest(url: Option<&str>) -> Value {
    let url = url.filter(|u| !u.is_empty());
    let mut events = json!({ "bot_events": ["app_mention", "message.im"] });
    if let (Some(u), Some(o)) = (url, events.as_object_mut()) {
        o.insert("request_url".into(), u.into());
    }
    json!({
        "display_information": { "name": "wisp", "description": "Start and steer your wisp tasks from Slack.", "background_color": "#1a1a1a" },
        "features": {
            "app_home": { "home_tab_enabled": false, "messages_tab_enabled": true, "messages_tab_read_only_enabled": false },
            "bot_user": { "display_name": "wisp", "always_online": true },
        },
        "oauth_config": { "scopes": { "bot": ["app_mentions:read", "chat:write", "chat:write.customize", "im:history"] } },
        "settings": {
            "event_subscriptions": events,
            "interactivity": { "is_enabled": url.is_none() },
            "org_deploy_enabled": false,
            "socket_mode_enabled": url.is_none(),
            "token_rotation_enabled": false,
        },
    })
}
