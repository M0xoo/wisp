//! The store's one error enum (plan §9.2), mapped to the kernel's `WireError {code, message, retry}` at
//! the edge. The store raises four kinds of refusal (invalid, not found, conflict, closed) and wraps
//! what SQLite or the file system said; a plugin's own `WireError` can travel through a write closure.

use wisp_kernel::{Code, WireError};

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    /// the caller asked for something malformed: a bad column, op, name or value
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    NotFound(String),
    /// a constraint (unique, foreign key, check, not null) refused the write, or a newer schema
    #[error("{0}")]
    Conflict(String),
    /// the writer thread has stopped (the store was closed)
    #[error("the store is closed")]
    Closed,
    #[error("{0}")]
    Internal(String),
    #[error("sqlite: {0}")]
    Sqlite(rusqlite::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    /// a plugin's own error, returned from inside a write closure; it reaches the caller unchanged
    #[error("{0}")]
    Wire(WireError),
}

pub type Result<T, E = StoreError> = std::result::Result<T, E>;

pub(crate) fn invalid(m: impl Into<String>) -> StoreError {
    StoreError::Invalid(m.into())
}

impl StoreError {
    pub fn code(&self) -> Code {
        match self {
            Self::Invalid(_) | Self::Json(_) => Code::Invalid,
            Self::NotFound(_) => Code::NotFound,
            Self::Conflict(_) => Code::Conflict,
            Self::Closed => Code::Unavailable,
            Self::Wire(w) => w.code,
            Self::Internal(_) | Self::Sqlite(_) | Self::Io(_) => Code::Internal,
        }
    }
}

// Constraint failures are the caller's conflict, a STRICT type refusal is the caller's mistake;
// anything else SQLite says is ours.
impl From<rusqlite::Error> for StoreError {
    fn from(e: rusqlite::Error) -> Self {
        if let rusqlite::Error::SqliteFailure(f, msg) = &e {
            let text = msg.clone().unwrap_or_else(|| f.to_string());
            // SQLITE_CONSTRAINT_DATATYPE: a STRICT column refused the value's type
            if f.extended_code == 3091 || f.code == rusqlite::ErrorCode::TypeMismatch {
                return Self::Invalid(text);
            }
            if f.code == rusqlite::ErrorCode::ConstraintViolation {
                return Self::Conflict(text);
            }
        }
        Self::Sqlite(e)
    }
}

impl From<WireError> for StoreError {
    fn from(w: WireError) -> Self {
        Self::Wire(w)
    }
}

impl From<StoreError> for WireError {
    fn from(e: StoreError) -> Self {
        match e {
            StoreError::Wire(w) => w,
            StoreError::Closed => WireError::unavailable("the store is closed"),
            other => WireError::new(other.code(), other.to_string()),
        }
    }
}
