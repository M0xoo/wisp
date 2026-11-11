//! What Slack sent, read down to what a person said (v1 `Slack#event`, `#click`, grammar's
//! `stripFormatting(…, 'slack')`). A mention or a DM by a person is a message; an edit, a join, a
//! bot's message and this bot's own are not. A click is wisp's only if its action is wisp's.
use serde_json::Value;

const ACTION: &str = "wisp:";

/// A person's message to the bot: an `app_mention`, or a message in a DM.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Message {
    pub event_id: Option<String>,
    /// the same message sent as two events (`message` and `app_mention`) carries one of these
    pub client_msg_id: Option<String>,
    pub channel: String,
    pub ts: String,
    pub thread_ts: Option<String>,
    pub user: String,
    /// as Slack wrote it: [`strip_formatting`] before the grammar reads it
    pub text: String,
    /// a direct message: a stranger here gets one line, and lists are whole
    pub dm: bool,
}

impl Message {
    /// The thread the answer goes in.
    pub fn root(&self) -> &str {
        self.thread_ts.as_deref().unwrap_or(&self.ts)
    }
    /// One at a time per thread.
    pub fn key(&self) -> String {
        format!("{}:{}", self.channel, self.root())
    }
    /// When it was sent, in seconds (a `ts` is `<seconds>.<sequence>`).
    pub fn at_s(&self) -> Option<f64> {
        self.ts
            .parse::<f64>()
            .ok()
            .filter(|t| t.is_finite() && *t > 0.0)
    }
    /// What marks it as seen: the event, and the message itself.
    pub fn ids(&self) -> Vec<String> {
        self.event_id
            .iter()
            .cloned()
            .chain(self.client_msg_id.as_ref().map(|c| format!("m:{c}")))
            .collect()
    }
}

/// Why an event isn't a message for wisp. None of them is answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Skip {
    /// no event, or one wisp doesn't take (a channel message that doesn't mention it)
    Kind,
    /// an edit, a join, a bot's message
    Subtype,
    /// from a bot, from nobody, or from this bot
    Bot,
}

fn text(v: &Value, k: &str) -> Option<String> {
    v.get(k)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// An `events_api` payload (or an `event_callback` body) → the message in it. `me`: this bot's user id.
pub fn message(payload: &Value, me: Option<&str>) -> Result<Message, Skip> {
    let Some(e) = payload.get("event").filter(|e| e.is_object()) else {
        return Err(Skip::Kind);
    };
    let ty = e.get("type").and_then(Value::as_str).unwrap_or_default();
    let im = e.get("channel_type").and_then(Value::as_str) == Some("im");
    if ty != "app_mention" && !(ty == "message" && im) {
        return Err(Skip::Kind);
    }
    if e.get("subtype")
        .and_then(Value::as_str)
        .is_some_and(|s| !s.is_empty() && s != "file_share")
    {
        return Err(Skip::Subtype);
    }
    let user = text(e, "user");
    if e.get("bot_id").is_some_and(|b| !b.is_null() && b != "")
        || user.is_none()
        || user.as_deref() == me.filter(|m| !m.is_empty())
    {
        return Err(Skip::Bot);
    }
    let channel = text(e, "channel").unwrap_or_default();
    Ok(Message {
        event_id: text(payload, "event_id"),
        client_msg_id: text(e, "client_msg_id"),
        dm: channel.starts_with('D'),
        channel,
        ts: text(e, "ts").unwrap_or_default(),
        thread_ts: text(e, "thread_ts"),
        user: user.unwrap_or_default(),
        text: e
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
    })
}

/// The thread an event belongs to, whatever it is: its work queues behind that thread's.
pub fn thread_key(payload: &Value) -> Option<String> {
    let e = payload.get("event")?;
    let chat = e.get("channel").and_then(Value::as_str).unwrap_or_default();
    let root = text(e, "thread_ts")
        .or_else(|| text(e, "ts"))
        .unwrap_or_default();
    Some(format!("{chat}:{root}"))
}

/// `link` or `link <code>`, the whole message, any case. → Some(code), Some(None) for a bare `link`.
pub fn link_code(text: &str) -> Option<Option<&str>> {
    let head = text.get(..4)?;
    if !head.eq_ignore_ascii_case("link") {
        return None;
    }
    let rest = &text[4..];
    if rest.is_empty() {
        return Some(None);
    }
    let code = rest.trim_start();
    (code.len() < rest.len() && !code.is_empty() && !code.contains(char::is_whitespace))
        .then_some(Some(code))
}

/// A click on one of wisp's buttons, on a message wisp posted.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Click {
    pub user: Option<String>,
    /// what makes a click seen: its trigger, else its time
    pub id: Option<String>,
    pub action_ts: Option<f64>,
    pub value: String,
    pub chat: String,
    pub message_ts: String,
    /// the thread the message is in
    pub root: String,
    pub blocks: Vec<Value>,
    pub text: Option<String>,
}

impl Click {
    pub fn key(&self) -> String {
        format!("{}:{}", self.chat, self.root)
    }
}

/// A `block_actions` payload whose first action is wisp's. Anything else is acked and ignored.
pub fn click(payload: &Value) -> Option<Click> {
    if payload.get("type").and_then(Value::as_str) != Some("block_actions") {
        return None;
    }
    let action = payload.get("actions")?.get(0)?;
    if !action
        .get("action_id")
        .and_then(Value::as_str)
        .is_some_and(|a| a.starts_with(ACTION))
    {
        return None;
    }
    let chat = payload
        .pointer("/container/channel_id")
        .and_then(Value::as_str)
        .or_else(|| payload.pointer("/channel/id").and_then(Value::as_str))
        .filter(|c| !c.is_empty())?;
    let m = payload.get("message")?; // wisp's buttons are on messages it posted, never an ephemeral one
    let ts = text(m, "ts")?;
    let action_ts = text(action, "action_ts");
    Some(Click {
        user: payload
            .pointer("/user/id")
            .and_then(Value::as_str)
            .map(str::to_owned),
        id: text(payload, "trigger_id").or_else(|| action_ts.clone()),
        action_ts: action_ts.and_then(|t| t.parse().ok()),
        value: action
            .get("value")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        chat: chat.to_owned(),
        root: text(m, "thread_ts").unwrap_or_else(|| ts.clone()),
        message_ts: ts,
        blocks: m
            .get("blocks")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        text: text(m, "text"),
    })
}

/// A button's value as wisp signed it: `{ k, s, r, i, sig }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Button {
    pub k: String,
    pub s: String,
    pub r: String,
    pub i: u32,
    pub sig: String,
}

/// The value, or None: not JSON, or not the shape wisp writes (an index has to be a whole number).
// one-letter wire keys (s, r, i, k); the f64 → u64 cast runs only on a whole, non-negative number
#[allow(
    clippy::many_single_char_names,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss
)]
pub fn button(value: &str) -> Option<Button> {
    let v: Value = serde_json::from_str(value).ok()?;
    let s = v.get("s")?.as_str()?.to_owned();
    let r = v.get("r")?.as_str()?.to_owned();
    let i = v
        .get("i")
        .filter(|i| i.is_u64() || i.as_f64().is_some_and(|f| f.fract() == 0.0 && f >= 0.0))?;
    let i = u32::try_from(i.as_u64().or_else(|| i.as_f64().map(|f| f as u64))?).ok()?;
    let k = v
        .get("k")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let sig = v
        .get("sig")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    Some(Button { k, s, r, i, sig })
}

// ---------- Slack's markup, gone before the grammar reads it ----------

/// Slack's `<…>` and `&amp;` off a message. A bare link stays a URL, a label that says something
/// else keeps its URL beside it (nothing is hidden from the agent), `<#C1|general>` reads `#general`,
/// `<!here>` reads `@here`, and `bot`'s own mention goes.
pub fn strip_formatting(text: &str, bot: Option<&str>) -> String {
    let t = text.replace("\r\n", "\n");
    let t: String = t
        .chars()
        .filter(|c| !matches!(c, '\u{200b}'..='\u{200d}' | '\u{2060}' | '\u{feff}'))
        .map(|c| if c == '\u{a0}' { ' ' } else { c })
        .collect();
    let bot: String = bot
        .unwrap_or_default()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
        .collect();
    let mut out = String::with_capacity(t.len());
    let mut rest = t.trim();
    while let Some(at) = rest.find('<') {
        out.push_str(&rest[..at]);
        let tail = &rest[at..];
        let Some(close) = tail.find('>') else {
            out.push_str(tail);
            rest = "";
            break;
        };
        let inner = &tail[1..close];
        let after = &tail[close + 1..];
        if !bot.is_empty() && is_bot(inner, &bot) {
            rest = after.trim_start_matches(|c: char| c.is_whitespace() || c == ',' || c == ':');
            continue;
        }
        if let Some(word) = token(inner) {
            out.push_str(&word);
        } else {
            out.push('<');
            rest = &tail[1..];
            continue;
        }
        rest = after;
    }
    out.push_str(rest);
    out.trim()
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

fn is_bot(inner: &str, bot: &str) -> bool {
    inner
        .strip_prefix('@')
        .and_then(|r| r.strip_prefix(bot))
        .is_some_and(|r| r.is_empty() || r.starts_with('|'))
}

fn word(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// One `<…>` (without its brackets) as plain words, or None: not Slack markup.
fn token(inner: &str) -> Option<String> {
    if let Some(scheme) = ["https://", "http://", "mailto:"]
        .iter()
        .find(|p| inner.starts_with(**p))
    {
        let (url, label) = inner
            .split_once('|')
            .map_or((inner, None), |(u, l)| (u, Some(l)));
        return (url.len() > scheme.len()).then(|| link(url, label));
    }
    if let Some(r) = inner.strip_prefix('#') {
        let (id, name) = r.split_once('|').map_or((r, None), |(a, b)| (a, Some(b)));
        return word(id).then(|| format!("#{}", name.filter(|n| !n.is_empty()).unwrap_or(id)));
    }
    let r = inner.strip_prefix('!')?;
    let (head, label) = r.split_once('|').map_or((r, None), |(a, b)| (a, Some(b)));
    let end = head
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .unwrap_or(head.len());
    if end == 0 {
        return None;
    }
    Some(
        label
            .filter(|l| !l.is_empty())
            .map_or_else(|| format!("@{}", &head[..end]), str::to_owned),
    )
}

/// Slack writes a bare example.com as a link labelled example.com.
fn link(url: &str, label: Option<&str>) -> String {
    let bare = url.strip_prefix("mailto:").unwrap_or(url);
    let schemeless = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .unwrap_or(url);
    match label.filter(|l| !l.is_empty()) {
        None => bare.to_owned(),
        Some(l) if l == url || l == bare || l == schemeless => l.to_owned(),
        Some(l) => format!("{l} ({url})"),
    }
}

