//! wisp-ntfy-core: what the ntfy transport decides, with no IO (v1 `channels/ntfy.js`). A
//! notification carries up to 3 buttons; a tap makes the ntfy app POST a signed answer to
//! `<topic>-reply`, which wisp polls. No free text: ntfy has no reply box.

pub mod config;
pub mod cursor;
pub mod wire;

use wisp_kernel::WireError;

pub use config::{Ntfy, Where, mask, merge_update};
pub use cursor::{Cursor, SEEN_KEPT};
pub use wire::{PollMsg, parse_poll, parse_tap, poll_url, publish_body, reply_url};

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum NtfyError {
    #[error("ntfy: {0}")]
    Http(String),
    #[error("{0}")]
    Invalid(String),
}

impl From<NtfyError> for WireError {
    fn from(e: NtfyError) -> Self {
        match e {
            NtfyError::Http(_) => WireError::unavailable(e.to_string()),
            NtfyError::Invalid(_) => WireError::invalid(e.to_string()),
        }
    }
}

/// At most `max` characters, with `…` when cut (v1 `truncate`).
/// Its own copy: a transport depends on `wisp-channels-api` only (ADR-0003), never on channels' core.
pub fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_owned();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_map() {
        assert_eq!(
            WireError::from(NtfyError::Invalid("x".into())).status(),
            400
        );
        assert!(WireError::from(NtfyError::Http("x".into())).retry);
        assert_eq!(truncate("abcdef", 4), "abc…");
        assert_eq!(truncate("abc", 4), "abc");
    }
}
