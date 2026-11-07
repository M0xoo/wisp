//! wisp-telegram-core: what the Telegram transport decides, with no IO (v1 `channels/telegram.js`).
//! The Bot API's updates as wisp reads them, signed button taps that fit Telegram's 64 bytes, the
//! long-poll offset and the webhook's seen ring, the webhook secret check, the text a message carries
//! (split at 4096), and the link code that attaches one chat. The host does the calls.

pub mod link;
pub mod poll;
pub mod tap;
pub mod text;
pub mod update;

use subtle::ConstantTimeEq;
use wisp_kernel::WireError;

pub use link::{Guess, LinkBook, LinkOutcome, links_it};
pub use poll::{HookSeen, Offset};
pub use tap::{Tap, encode_tap, parse_tap};
pub use text::{CHUNK_MAX, publish_text, split, truncate};
pub use update::{CallbackQuery, Chat, From, Message, Update, chat_name, forwarded, slash_command};

/// What Telegram's bot commands menu lists (`setMyCommands`), with the options switch on.
pub const COMMANDS: &[(&str, &str)] = &[
    ("new", "Start a task: options, then what to do"),
    ("help", "What you can say here"),
    ("projects", "Where a task can run"),
    ("models", "Harnesses and models"),
    ("crew", "Your crew and what they’re on"),
    ("machines", "Your machines and who’s online"),
    ("status", "What’s running and waiting"),
];

/// The updates wisp asks for, polled or hooked.
pub const UPDATES: &[&str] = &["message", "callback_query"];

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum TelegramError {
    #[error("Telegram: {0}")]
    Api(String),
    #[error("Not an update.")]
    NotAnUpdate,
    #[error("Wrong secret token.")]
    WrongSecret,
    #[error("{0}")]
    Invalid(String),
}

impl From<TelegramError> for WireError {
    fn from(e: TelegramError) -> Self {
        match e {
            TelegramError::Api(_) => WireError::unavailable(e.to_string()),
            TelegramError::WrongSecret => WireError::forbidden(e.to_string()),
            TelegramError::NotAnUpdate | TelegramError::Invalid(_) => {
                WireError::invalid(e.to_string())
            }
        }
    }
}

/// The webhook's `x-telegram-bot-api-secret-token`, compared in constant time: only Telegram knows it.
pub fn secret_ok(got: Option<&str>, want: &str) -> bool {
    // An empty secret is no secret: nothing may pass on it.
    !want.is_empty() && got.is_some_and(|g| g.as_bytes().ct_eq(want.as_bytes()).into())
}

/// A token as Settings shows it: the last four, never the rest. A PUT that sends this back means unchanged.
pub fn mask(token: &str) -> String {
    if token.is_empty() {
        return String::new();
    }
    let tail: String = token
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("••••{tail}")
}

/// A value from a PUT: a masked one (or none) keeps what was there.
pub fn keep_secret(sent: Option<&str>, prev: &str) -> String {
    match sent {
        None => prev.to_owned(),
        Some(s) if s.starts_with("••••") => prev.to_owned(),
        Some(s) => s.trim().to_owned(),
    }
}

/// Bot tokens look like `123456:AA…`; anything else is a paste of the wrong thing.
pub fn token_ok(token: &str) -> bool {
    let Some((id, rest)) = token.split_once(':') else {
        return false;
    };
    !id.is_empty()
        && id.bytes().all(|b| b.is_ascii_digit())
        && rest.len() >= 20
        && rest
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// v1 `lostLine`: what the grid lost while the box slept.
pub fn lost_line(n: u32) -> String {
    if n == 1 {
        "One message didn’t reach wisp while it was asleep. Send it again to run it.".to_owned()
    } else {
        format!("{n} messages didn’t reach wisp while it was asleep. Send them again to run them.")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_is_exact_and_never_empty() {
        assert!(secret_ok(Some("abc"), "abc"));
        assert!(!secret_ok(Some("abd"), "abc"));
        assert!(!secret_ok(Some("ab"), "abc"));
        assert!(!secret_ok(None, "abc"));
        assert!(!secret_ok(Some(""), ""));
    }

    #[test]
    fn masked_tokens_mean_unchanged() {
        assert_eq!(mask("123:abcdefgh"), "••••efgh");
        assert_eq!(mask(""), "");
        assert_eq!(keep_secret(Some("••••efgh"), "old"), "old");
        assert_eq!(keep_secret(None, "old"), "old");
        assert_eq!(keep_secret(Some(" new "), "old"), "new");
        assert_eq!(keep_secret(Some(""), "old"), "");
    }

    #[test]
    fn tokens() {
        assert!(token_ok("123456:AAbbccddeeffgghhiijjkk_-"));
        assert!(!token_ok("abc:AAbbccddeeffgghhiijjkk"));
        assert!(!token_ok("123456"));
        assert!(!token_ok("123456:short"));
    }

    #[test]
    fn errors_map_to_the_wire() {
        assert_eq!(WireError::from(TelegramError::WrongSecret).status(), 403);
        assert_eq!(WireError::from(TelegramError::NotAnUpdate).status(), 400);
        assert!(WireError::from(TelegramError::Api("x".into())).retry);
    }

    #[test]
    fn lost() {
        assert!(lost_line(1).starts_with("One message"));
        assert!(lost_line(3).starts_with("3 messages"));
    }
}
