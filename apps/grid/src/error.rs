//! The grid's one error enum. `Http` is v1's `bad(message, status)`: a message for a person and the
//! status it answers with (pages show the message, the JSON API sends `{ error }`). Everything else is
//! a fault of ours and answers 500 with a generic message. `to_wire` maps it to the wire error shape
//! `{code, message, retry}` at any boundary that speaks it (the hostd socket, the CLI's JSON).
//!
//! The grid is a separate deployment that talks to boxes over HTTP, not through the kernel, so it
//! carries the wire shape itself (`WireError` below, the same JSON as `wisp_kernel::WireError`, pinned
//! by a test) instead of linking the kernel.
use serde::{Deserialize, Serialize};

/// `wisp_kernel::Code`'s values, as they go on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Code {
    NotFound,
    Invalid,
    Forbidden,
    Conflict,
    Unavailable,
    Timeout,
    TooLarge,
    Internal,
}

/// The one wire error: `{code, message, retry}` (plan §3.1 rule 8).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireError {
    pub code: Code,
    pub message: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub retry: bool,
}

impl WireError {
    pub fn new(code: Code, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), retry: false }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum GridError {
    /// v1's `bad()`. `full`/`waitlisted`: why a sign-up was turned away, so the sign-in page can offer
    /// the waitlist.
    #[error("{message}")]
    Http { status: u16, message: String, full: bool, waitlisted: bool },
    #[error("grid.db: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("bad JSON: {0}")]
    Json(#[from] serde_json::Error),
    /// grid.json or the environment is wrong: said once, at start.
    #[error("{0}")]
    Config(String),
    /// A call to something outside (a provider, a box, SES, Telegram) failed.
    #[error("{0}")]
    Upstream(String),
    /// A sealed secret is damaged, a key is missing, a signature is malformed.
    #[error("{0}")]
    Crypto(String),
}

pub type Result<T, E = GridError> = std::result::Result<T, E>;

/// v1's `bad(message, status)`.
pub fn bad(message: impl Into<String>, status: u16) -> GridError {
    GridError::Http { status, message: message.into(), full: false, waitlisted: false }
}

impl GridError {
    /// The status an error answers with: its own, or 500 for anything that isn't `Http`.
    pub fn status(&self) -> u16 {
        match self {
            Self::Http { status, .. } if (400..600).contains(status) => *status,
            _ => 500,
        }
    }

    /// What a person is shown: the message of an `Http` error below 500, a generic line otherwise
    /// (the details go to the log, never to the caller).
    pub fn public_message(&self) -> String {
        match self {
            Self::Http { status, message, .. } if *status < 500 => message.clone(),
            Self::Http { message, status: 503, .. } => message.clone(),
            _ => "Something went wrong on the grid.".to_owned(),
        }
    }

    pub fn to_wire(&self) -> WireError {
        let code = match self.status() {
            400 | 422 => Code::Invalid,
            401 | 403 => Code::Forbidden,
            404 => Code::NotFound,
            409 => Code::Conflict,
            413 => Code::TooLarge,
            429 | 503 => Code::Unavailable,
            504 => Code::Timeout,
            _ => Code::Internal,
        };
        let mut w = WireError::new(code, self.public_message());
        w.retry = matches!(self.status(), 429 | 503 | 504);
        w
    }
}

impl From<GridError> for WireError {
    fn from(e: GridError) -> Self {
        e.to_wire()
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn statuses_and_messages() {
        assert_eq!(bad("nope", 404).status(), 404);
        assert_eq!(bad("x", 200).status(), 500);
        let io = GridError::Io(std::io::Error::other("disk"));
        assert_eq!(io.status(), 500);
        assert_eq!(io.public_message(), "Something went wrong on the grid.");
        assert_eq!(bad("Too many requests. Wait a minute.", 429).to_wire().code, Code::Unavailable);
        assert!(bad("busy", 503).to_wire().retry);
        let j = serde_json::to_value(bad("Too much data.", 413).to_wire()).unwrap();
        assert_eq!(j, serde_json::json!({ "code": "too_large", "message": "Too much data." }));
    }
}
