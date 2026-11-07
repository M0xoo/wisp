//! wisp.stuff's one error enum, mapped to `WireError` at the edge.
use wisp_kernel::{Code, WireError};
use wisp_stuff_core::Bad;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// a refusal the user or agent reads, with its HTTP status
    #[error("{0}")]
    Bad(Bad),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("a lock was poisoned")]
    Poisoned,
    #[error("{0}")]
    Kernel(WireError),
}

pub type Result<T> = std::result::Result<T, Error>;

impl From<Bad> for Error {
    fn from(b: Bad) -> Self {
        Self::Bad(b)
    }
}

impl From<WireError> for Error {
    fn from(e: WireError) -> Self {
        Self::Kernel(e)
    }
}

pub fn bad(status: u16, message: impl Into<String>) -> Error {
    Error::Bad(Bad::new(status, message))
}

fn code_of(status: u16) -> Code {
    match status {
        403 => Code::Forbidden,
        404 => Code::NotFound,
        409 => Code::Conflict,
        413 => Code::TooLarge,
        501 | 503 => Code::Unavailable,
        504 => Code::Timeout,
        s if s >= 500 => Code::Internal,
        _ => Code::Invalid,
    }
}

impl From<Error> for WireError {
    fn from(e: Error) -> Self {
        match e {
            Error::Bad(b) => WireError::new(code_of(b.status), b.message),
            Error::Kernel(w) => w,
            other => WireError::internal(other.to_string()),
        }
    }
}
