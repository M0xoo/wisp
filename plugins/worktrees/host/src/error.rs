//! The one error enum of wisp-worktrees, mapped to `WireError` at the boundary.

use wisp_kernel::{Code, WireError};

#[derive(Debug, thiserror::Error)]
pub enum WtError {
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Io(String),
    #[error(transparent)]
    Wire(#[from] WireError),
}

impl From<WtError> for WireError {
    fn from(e: WtError) -> Self {
        match e {
            WtError::Invalid(m) => WireError::invalid(m),
            WtError::Conflict(m) => WireError::conflict(m),
            WtError::NotFound(m) => WireError::not_found(m),
            WtError::Io(m) => WireError::new(Code::Internal, m),
            WtError::Wire(w) => w,
        }
    }
}

impl From<std::io::Error> for WtError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e.to_string())
    }
}

pub type Result<T, E = WtError> = std::result::Result<T, E>;
