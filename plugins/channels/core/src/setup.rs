//! Settings → Phone's rules (F-chan-13), pure: which fields each channel takes, which of them are secrets, what
//! v1's `remote.update` refused (`server/remote.js`), what a channel still needs, and the state it shows. The hub
//! (`wisp-channels` `setup.rs`) does the IO: secrets, the `channel` resource, the transports.
use serde_json::Value;
use wisp_channels_api::SetupState;

/// The secret fields a channel takes. Kept in `~/.wisp/secrets.json` under [`secret_key`], never in the store.
pub fn secret_fields(transport: &str) -> &'static [&'static str] {
    match transport {
        "ntfy" | "telegram" => &["token"],
        "slack" => &["appToken", "botToken", "signingSecret"],
        "discord" => &["token", "publicKey"],
        _ => &[],
    }
}

/// A plain setting's kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Text,
    Bool,
}

/// The plain settings a channel takes (in its `channel` resource's `routing`).
pub fn setting_fields(transport: &str) -> &'static [(&'static str, Kind)] {
    match transport {
        "ntfy" => &[("topic", Kind::Text), ("server", Kind::Text)],
        "telegram" => &[("allowStart", Kind::Bool)],
        "github" => &[("publicReports", Kind::Bool)],
        "email" => &[("sender", Kind::Text)],
        _ => &[],
    }
}

/// Where a channel's secret field is kept in secrets.json.
pub fn secret_key(transport: &str, field: &str) -> String {
    format!("channels/{transport}/{field}")
}

/// The secret whose change makes it another bot: whoever linked to the old one is unlinked, and a new link code shows.
pub fn link_field(transport: &str) -> Option<&'static str> {
    match transport {
        "telegram" | "discord" => Some("token"),
        "slack" => Some("botToken"),
        _ => None,
    }
}

/// The fields a channel still needs. `cloud`: this wisp is a cloud computer (Slack calls in, so it needs the signing
/// secret instead of the app token; Discord its public key; email exists only there).
pub fn missing(transport: &str, cloud: bool, saved: &[&str], settings: &serde_json::Map<String, Value>) -> Vec<&'static str> {
    let has = |f: &str| saved.contains(&f);
    let text = |f: &str| settings.get(f).and_then(Value::as_str).is_some_and(|s| !s.trim().is_empty());
    let mut out = Vec::new();
    match transport {
        "ntfy" if !text("topic") => out.push("topic"),
        "telegram" if !has("token") => out.push("token"),
        "slack" => {
            out.extend(Some(if cloud { "signingSecret" } else { "appToken" }).filter(|f| !has(f)));
            out.extend(Some("botToken").filter(|f| !has(f)));
        }
        "discord" => {
            out.extend(Some("token").filter(|f| !has(f)));
            out.extend(Some("publicKey").filter(|f| cloud && !has(f)));
        }
        "email" if !cloud => out.push("cloud"),
        "email" if !text("sender") => out.push("sender"),
        _ => {}
    }
    out
}

/// What a channel's health says, as the hub keeps it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Health {
    /// its transport is running
    pub running: bool,
    /// its service's last answer: `Some(true)` worked, `Some(false)` refused
    pub ok: Option<bool>,
    /// it links people with a code and nobody has linked yet
    pub unlinked: bool,
}

/// The state Settings → Phone shows.
pub fn state(enabled: bool, missing: &[&str], h: Health) -> SetupState {
    if !enabled {
        SetupState::Off
    } else if !missing.is_empty() {
        SetupState::Incomplete
    } else if h.ok == Some(false) {
        SetupState::Failing
    } else if !h.running || h.ok.is_none() {
        SetupState::Checking
    } else if h.unlinked {
        SetupState::Linking
    } else {
        SetupState::Connected
    }
}

/// A secret as v1 checked it before saving (`remote.update`), in v1's words. Empty: removed, always fine.
pub fn check_secret(transport: &str, field: &str, value: &str) -> Result<(), String> {
    if !secret_fields(transport).contains(&field) {
        return Err(format!("{transport} has no secret named {field}"));
    }
    let v = value.trim();
    if v.is_empty() {
        return Ok(());
    }
    // a reference would hand the channel another secret of this wisp's: only a value is taken
    if v.contains("${") {
        return Err("Paste the value itself, not a reference to a secret.".into());
    }
    if v.chars().any(char::is_whitespace) {
        return Err(format!("A {} has no spaces in it.", label(field)));
    }
    let ok = match (transport, field) {
        ("slack", "appToken") => v.starts_with("xapp-"),
        ("slack", "botToken") => v.starts_with("xoxb-"),
        ("slack", "signingSecret") => v.len() >= 16,
        ("discord", "token") => discord_token(v),
        ("discord", "publicKey") => v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit()),
        ("telegram", "token") => telegram_token(v),
        _ => true,
    };
    if ok {
        return Ok(());
    }
    Err(match (transport, field) {
        ("slack", "appToken") => "The app-level token starts with xapp-.".into(),
        ("slack", "botToken") => "The bot token starts with xoxb-.".into(),
        ("slack", "signingSecret") => "That isn’t a signing secret: copy it from Basic Information → App Credentials.".into(),
        ("discord", "token") => "That doesn’t look like a bot token: copy it from the Developer Portal → Bot → Reset Token.".into(),
        ("discord", "publicKey") => "The public key is 64 hex characters: Developer Portal → General Information.".into(),
        _ => "That doesn’t look like a bot token: @BotFather gives one like 123456:ABC…".into(),
    })
}

/// A plain setting as v1 checked it, made the way it's kept (trimmed, an address lower-cased).
pub fn check_setting(transport: &str, field: &str, value: &Value) -> Result<Value, String> {
    let Some((_, kind)) = setting_fields(transport).iter().find(|(f, _)| *f == field) else {
        return Err(format!("{transport} has no setting named {field}"));
    };
    if *kind == Kind::Bool {
        return value.as_bool().map(Value::Bool).ok_or_else(|| format!("{field} is true or false"));
    }
    let Some(v) = value.as_str() else { return Err(format!("{field} is text")) };
    let v = v.trim();
    if v.contains("${") {
        return Err("Type the value itself, not a reference to a secret.".into());
    }
    match (transport, field) {
        ("ntfy", "server") if !v.is_empty() && !http_url(v) => Err("ntfy server must be an http(s) URL".into()),
        ("ntfy", "topic") if !v.is_empty() && (v.len() > 64 || !v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')) => {
            Err("ntfy topic: letters, digits, - and _ only".into())
        }
        ("email", "sender") if !v.is_empty() && !address(v) => Err("That doesn’t look like an email address.".into()),
        ("email", "sender") => Ok(Value::String(v.to_lowercase())),
        _ => Ok(Value::String(v.to_owned())),
    }
}

/// v1's random first topic, from 64 random bits: `wisp-` and 14 digits.
pub fn fresh_topic(random: u64) -> String {
    format!("wisp-{:014}", random % 100_000_000_000_000)
}

/// v1's `newLinkCode`: six digits, never starting with 0.
pub fn fresh_code(random: u64) -> String {
    (100_000 + random % 900_000).to_string()
}

fn label(field: &str) -> &'static str {
    match field {
        "appToken" => "app token",
        "botToken" => "bot token",
        "signingSecret" => "signing secret",
        "publicKey" => "public key",
        _ => "token",
    }
}

fn http_url(v: &str) -> bool {
    let rest = v.strip_prefix("https://").or_else(|| v.strip_prefix("http://")).unwrap_or_default();
    !rest.is_empty() && !v.chars().any(char::is_whitespace)
}

/// `[\w-]+\.[\w-]+\.[\w-]+`
fn discord_token(v: &str) -> bool {
    let parts: Vec<&str> = v.split('.').collect();
    parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'))
}

/// `<digits>:<rest>`, as `@BotFather` hands it out
fn telegram_token(v: &str) -> bool {
    v.split_once(':').is_some_and(|(id, rest)| !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()) && rest.len() >= 10)
}

fn address(v: &str) -> bool {
    v.split_once('@').is_some_and(|(user, host)| {
        !user.is_empty() && host.contains('.') && !host.starts_with('.') && !host.ends_with('.') && !host.contains('@')
    }) && !v.chars().any(char::is_whitespace)
}
