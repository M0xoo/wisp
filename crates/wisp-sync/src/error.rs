//! The crate's one error type (plan §9.2). The server drops what fails to parse (a client can't
//! break its own stream); the HTTP edge maps a posted message's error to `WireError {code, …}`.

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SyncError {
    #[error("not a client message: {0}")]
    Decode(String),
    #[error("bad {0}")]
    BadMessage(&'static str),
    #[error("no such stream")]
    NoStream,
}

impl SyncError {
    /// The `WireError` code this maps to at the edge.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Decode(_) | Self::BadMessage(_) => "invalid",
            Self::NoStream => "not_found",
        }
    }
}
