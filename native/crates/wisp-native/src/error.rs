//! The one error type. It crosses the wire as `{code, message, retry}` (AGENTS.md).

use std::io;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("bad request: {0}")]
    BadRequest(String),
    #[error("no process with id {0:?}")]
    UnknownId(String),
    #[error("id {0:?} is already running")]
    DuplicateId(String),
    #[error("couldn't start {cmd}: {reason}")]
    Spawn { cmd: String, reason: String },
    #[error("process {0:?} has exited")]
    Exited(String),
    #[error("{0} is not supported here")]
    Unsupported(&'static str),
    #[error(transparent)]
    Io(#[from] io::Error),
}

impl Error {
    /// Stable code for the wire; the TS side switches on it.
    pub fn code(&self) -> &'static str {
        match self {
            Error::BadRequest(_) => "bad_request",
            Error::UnknownId(_) => "unknown_id",
            Error::DuplicateId(_) => "duplicate_id",
            Error::Spawn { .. } => "spawn_failed",
            Error::Exited(_) => "exited",
            Error::Unsupported(_) => "unsupported",
            Error::Io(_) => "io",
        }
    }

    /// Whether the same request may succeed later (only an OS hiccup might).
    pub fn retry(&self) -> bool {
        matches!(self, Error::Io(e) if matches!(e.kind(), io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock))
    }

    pub fn spawn(cmd: &str, reason: impl std::fmt::Display) -> Error {
        Error::Spawn { cmd: cmd.to_owned(), reason: reason.to_string() }
    }
}

pub type Result<T> = std::result::Result<T, Error>;
