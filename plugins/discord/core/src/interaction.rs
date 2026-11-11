//! Interactions (v1 discord.js `slashCommand`, `slashText`, `#fromInteraction`, `#choices`, `#buttons`,
//! `inbound`): `/wisp` as Discord registers it, its options read back as the words you'd have typed (so they go
//! through the same grammar as a message), what a person's press or keystroke is, a report's choices as signed
//! buttons, and the Ed25519 check of an interaction Discord posted to a URL (a cloud wisp's, held by the grid).
//! Sans-IO.

use ed25519_dalek::{Signature, Verifier as _, VerifyingKey};
use serde_json::{Value, json};

pub const PING: u64 = 1;
pub const COMMAND: u64 = 2;
pub const COMPONENT: u64 = 3;
pub const AUTOCOMPLETE: u64 = 4;
pub const PONG: u64 = 1;
pub const MESSAGE: u64 = 4;
pub const DEFERRED: u64 = 5;
pub const UPDATE: u64 = 6;
pub const CHOICES: u64 = 8;
/// only whoever used it sees the answer
pub const EPHEMERAL: u64 = 1 << 6;
/// an interaction's token lasts 15 minutes: nothing can be said after that
pub const HELD_MAX_MS: i64 = 14 * 60_000;
pub const MAX_BUTTONS: usize = 25;
const THREAD_TYPES: [u64; 3] = [10, 11, 12];

/// `/wisp`. Mode has no Full auto to pick; a cloud wisp (`in_box`) reaches no machine.
pub fn slash_command(in_box: bool) -> Value {
    let named = |name: &str, description: &str| json!({ "type": 3, "name": name, "description": description, "autocomplete": true });
    let mut options = vec![json!({ "type": 3, "name": "prompt", "description": "What to do, or help, status, stop", "required": true }), named("crew", "A crew member"), named("project", "Where it runs")];
    if !in_box {
        options.push(named("machine", "Which computer"));
    }
    options.push(named("model", "Which model"));
    options.push(json!({ "type": 3, "name": "mode", "description": "How far it may go", "choices": [{ "name": "Plan", "value": "plan" }, { "name": "Edits", "value": "edits" }] }));
    json!({ "name": "wisp", "type": 1, "description": "Start or steer a wisp task", "contexts": [0, 1], "options": options })
}

/// The options as you'd have typed them: `@crew in project on machine with model mode: prompt`.
pub fn slash_text(options: &Value) -> String {
    let get = |k: &str| options.as_array().into_iter().flatten().find(|o| o["name"] == k).and_then(|o| o["value"].as_str()).map(str::trim).filter(|v| !v.is_empty());
    let front: Vec<String> = [get("crew").map(|c| format!("@{c}")), get("project").map(|p| format!("in {p}")), get("machine").map(|m| format!("on {m}")), get("model").map(|m| format!("with {m}")), get("mode").map(str::to_owned)].into_iter().flatten().collect();
    let prompt = get("prompt").unwrap_or_default();
    if front.is_empty() { prompt.to_owned() } else { format!("{}: {prompt}", front.join(" ")) }
}

/// What a person did, read down to what wisp needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Kind {
    Ping,
    /// `/wisp`, its options as typed words
    Command(String),
    /// a button's `custom_id`
    Button(String),
    /// the option being typed, and what's typed so far
    Autocomplete { option: String, typed: String },
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Interaction {
    pub id: String,
    pub token: String,
    pub app: String,
    pub channel: String,
    pub user: String,
    pub bot: bool,
    pub dm: bool,
    pub in_thread: bool,
    pub kind: Kind,
}

fn snowflake(v: &Value) -> Option<String> {
    v.as_str().filter(|s| !s.is_empty() && s.len() <= 25 && s.bytes().all(|b| b.is_ascii_digit())).map(str::to_owned)
}

/// An interaction's `d` (the gateway's) or body (a URL's); None: not one.
pub fn read(d: &Value) -> Option<Interaction> {
    let id = snowflake(&d["id"])?;
    let t = d["type"].as_u64()?;
    let user = if d["member"]["user"].is_object() { &d["member"]["user"] } else { &d["user"] };
    let s = |v: &Value| v.as_str().unwrap_or_default().to_owned();
    let kind = match t {
        PING => Kind::Ping,
        COMMAND if d["data"]["name"] == "wisp" => Kind::Command(slash_text(&d["data"]["options"])),
        COMPONENT => Kind::Button(s(&d["data"]["custom_id"])),
        AUTOCOMPLETE => {
            let o = d["data"]["options"].as_array().into_iter().flatten().find(|o| o["focused"] == true);
            Kind::Autocomplete { option: o.map(|o| s(&o["name"])).unwrap_or_default(), typed: o.map(|o| s(&o["value"])).unwrap_or_default() }
        }
        _ => Kind::Other,
    };
    Some(Interaction {
        id,
        token: s(&d["token"]),
        app: s(&d["application_id"]),
        channel: s(&d["channel_id"]),
        user: s(&user["id"]),
        bot: user["bot"] == true,
        dm: d["guild_id"].as_str().is_none_or(str::is_empty),
        in_thread: d["channel"]["type"].as_u64().is_some_and(|c| THREAD_TYPES.contains(&c)),
        kind,
    })
}

/// Autocomplete's answer: names that contain what's typed (any case), 25 at most, each cut to 100.
pub fn choices(pairs: &[(String, String)], typed: &str) -> Value {
    let typed = typed.to_lowercase();
    let cut = |s: &str| s.chars().take(100).collect::<String>();
    Value::Array(pairs.iter().filter(|(n, _)| n.to_lowercase().contains(&typed)).take(25).map(|(n, v)| json!({ "name": cut(n), "value": cut(v) })).collect())
}

/// A button's `custom_id`: `<kind code>:<session>:<ref>:<index>:<sig>`.
pub fn custom_id(code: &str, session: &str, reference: &str, index: u32, sig: &str) -> String {
    format!("{code}:{session}:{reference}:{index}:{sig}")
}

/// `(code, session, ref, index, sig)`; None: not one of wisp's (anything more, or less, is nobody's).
pub fn parse_custom_id(id: &str) -> Option<(String, String, String, u32, String)> {
    let parts: Vec<&str> = id.split(':').collect();
    let [code, session, reference, index, sig] = parts.as_slice() else { return None };
    Some(((*code).to_owned(), (*session).to_owned(), (*reference).to_owned(), index.parse().ok()?, (*sig).to_owned()))
}

/// One button per choice, five to a row, 25 at most; none at all when an id won't fit (the words still say them).
/// `buttons`: `(label, custom_id, done)`.
pub fn rows(buttons: &[(String, String, bool)]) -> Vec<Value> {
    if buttons.iter().any(|(_, id, _)| id.len() > 100) {
        return Vec::new();
    }
    let all: Vec<Value> = buttons
        .iter()
        .take(MAX_BUTTONS)
        .map(|(label, id, done)| {
            let label: String = if label.trim().is_empty() { "OK".into() } else { label.chars().take(80).collect() };
            json!({ "type": 2, "style": if *done { 2 } else { 1 }, "label": label, "custom_id": id })
        })
        .collect();
    all.chunks(5).map(|c| json!({ "type": 1, "components": c })).collect()
}

/// What the grid answers Discord at once for an interaction it holds (Discord gives three seconds, a box may be
/// asleep): "thinking" for `/wisp`, "seen" for a press. None: not held (a ping, a keystroke: those need the box's
/// own answer, live).
pub fn early(d: &Value) -> Option<Value> {
    match d["type"].as_u64()? {
        COMMAND => Some(json!({ "type": DEFERRED })),
        COMPONENT => Some(json!({ "type": UPDATE })),
        _ => None,
    }
}

/// Discord's signature: Ed25519 over the timestamp and the body, by the application's public key (hex).
pub fn signed(public_key: &str, timestamp: &str, body: &[u8], signature: &str) -> bool {
    let (Some(key), Some(sig)) = (hex::<32>(public_key), hex::<64>(signature)) else { return false };
    let Ok(key) = VerifyingKey::from_bytes(&key) else { return false };
    let mut msg = timestamp.as_bytes().to_vec();
    msg.extend_from_slice(body);
    key.verify(&msg, &Signature::from_bytes(&sig)).is_ok()
}

fn hex<const N: usize>(s: &str) -> Option<[u8; N]> {
    let s = s.trim().as_bytes();
    if s.len() != N * 2 {
        return None;
    }
    let mut out = [0u8; N];
    for (i, pair) in s.chunks(2).enumerate() {
        let d = |c: u8| (c as char).to_digit(16);
        out[i] = u8::try_from(d(pair[0])? * 16 + d(pair[1])?).ok()?;
    }
    Some(out)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::format_collect)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer as _, SigningKey};

    /// v1 discord.js `slashText`: options read back as the words you'd type, so `/wisp` and a mention say the same.
    #[test]
    fn slash_options_read_as_the_words_youd_have_typed() {
        let o = json!([{ "name": "prompt", "value": "fix the build" }, { "name": "crew", "value": "ada" }, { "name": "project", "value": "web" }, { "name": "mode", "value": "plan" }]);
        assert_eq!(slash_text(&o), "@ada in web plan: fix the build");
        assert_eq!(slash_text(&json!([{ "name": "prompt", "value": "status" }])), "status");
        let names = |b: bool| slash_command(b)["options"].as_array().unwrap().iter().map(|o| o["name"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
        assert!(names(false).contains(&"machine".to_owned()) && !names(true).contains(&"machine".to_owned()), "a cloud wisp reaches no machine");
        let mode = slash_command(false)["options"].as_array().unwrap().iter().find(|o| o["name"] == "mode").unwrap().clone();
        assert_eq!(mode["choices"].as_array().unwrap().len(), 2, "Full auto is never a choice");
    }

    #[test]
    fn an_interaction_reads_as_who_where_and_what() {
        let d = json!({ "id": "123", "type": 2, "token": "tok", "application_id": "9", "channel_id": "c1", "guild_id": "g", "channel": { "type": 11 }, "member": { "user": { "id": "u1" } }, "data": { "name": "wisp", "options": [{ "name": "prompt", "value": "hi" }] } });
        let i = read(&d).unwrap();
        assert_eq!((i.user.as_str(), i.dm, i.in_thread, i.kind), ("u1", false, true, Kind::Command("hi".into())));
        let a = read(&json!({ "id": "5", "type": 4, "user": { "id": "u" }, "data": { "options": [{ "name": "project", "value": "We", "focused": true }] } })).unwrap();
        assert_eq!(a.kind, Kind::Autocomplete { option: "project".into(), typed: "We".into() });
        assert!(read(&json!({ "id": "x1", "type": 2 })).is_none(), "an id that isn't a snowflake is nothing");
        let other = read(&json!({ "id": "7", "type": 2, "data": { "name": "other" } })).unwrap();
        assert_eq!(other.kind, Kind::Other, "another bot's command isn't /wisp");
    }

    #[test]
    fn autocomplete_finds_what_contains_the_typed_text_25_at_most() {
        let pairs: Vec<(String, String)> = (0..40).map(|n| (format!("Web {n}"), format!("web-{n}"))).chain([("api".to_owned(), "api".to_owned())]).collect();
        let c = choices(&pairs, "wEB");
        assert_eq!(c.as_array().unwrap().len(), 25);
        assert_eq!(choices(&pairs, "ap"), json!([{ "name": "api", "value": "api" }]));
    }

    /// v1 `#buttons`: five to a row, 25 at most, and none at all if an id is too long (the words still list them).
    #[test]
    fn a_reports_choices_are_signed_buttons_five_to_a_row() {
        let id = custom_id("a", "s1", "q1", 2, "sig");
        assert_eq!(parse_custom_id(&id), Some(("a".into(), "s1".into(), "q1".into(), 2, "sig".into())));
        assert_eq!(parse_custom_id("a:s1:q1:2:sig:more"), None);
        let b: Vec<(String, String, bool)> = (0..7).map(|n| (format!("Choice {n}"), custom_id("a", "s", "r", n, "x"), n == 6)).collect();
        let r = rows(&b);
        assert_eq!((r.len(), r[0]["components"].as_array().unwrap().len(), r[1]["components"][1]["style"].as_u64()), (2, 5, Some(2)));
        assert_eq!(rows(&[("x".into(), "y".repeat(101), false)]).len(), 0);
    }

    /// The grid answers in Discord's three seconds whatever the box is doing: thinking for /wisp, seen for a press;
    /// a ping and a keystroke go live to the box.
    #[test]
    fn the_grid_answers_a_held_interaction_at_once_and_a_ping_waits_for_the_box() {
        assert_eq!(early(&json!({ "type": 2 })), Some(json!({ "type": DEFERRED })));
        assert_eq!(early(&json!({ "type": 3 })), Some(json!({ "type": UPDATE })));
        assert_eq!(early(&json!({ "type": 1 })), None);
        assert_eq!(early(&json!({ "type": 4 })), None);
    }

    #[test]
    fn an_interaction_is_checked_with_the_applications_public_key() {
        let k = SigningKey::from_bytes(&[3u8; 32]);
        let public: String = k.verifying_key().to_bytes().iter().map(|b| format!("{b:02x}")).collect();
        let body = br#"{"type":1}"#;
        let mut msg = b"1700000000".to_vec();
        msg.extend_from_slice(body);
        let sig: String = k.sign(&msg).to_bytes().iter().map(|b| format!("{b:02x}")).collect();
        assert!(signed(&public, "1700000000", body, &sig));
        assert!(!signed(&public, "1700000001", body, &sig), "another time");
        assert!(!signed(&public, "1700000000", br#"{"type":2}"#, &sig), "another body");
        assert!(!signed("zz", "1700000000", body, &sig) && !signed(&public, "1700000000", body, "00"));
    }
}
