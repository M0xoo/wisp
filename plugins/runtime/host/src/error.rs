//! wisp.runtime's one error enum (plan §9.2), mapped to the kernel's `WireError` at the edge.

use wisp_kernel::{Code, WireError};

#[derive(Debug, thiserror::Error)]
pub enum RuntimeError {
    #[error("no task {0}")]
    NoTask(String),
    #[error("no turn {0}")]
    NoTurn(String),
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    Conflict(String),
    #[error("no harness {0}")]
    NoHarness(String),
    #[error(transparent)]
    Store(#[from] wisp_store::StoreError),
    #[error(transparent)]
    Proc(#[from] wisp_proc::ProcError),
    #[error(transparent)]
    Wire(#[from] WireError),
    #[error("{0}")]
    Json(#[from] serde_json::Error),
}

pub type Result<T, E = RuntimeError> = std::result::Result<T, E>;

impl From<RuntimeError> for WireError {
    fn from(e: RuntimeError) -> Self {
        match e {
            RuntimeError::NoTask(_) | RuntimeError::NoTurn(_) => WireError::not_found(e.to_string()),
            RuntimeError::Invalid(_) | RuntimeError::Json(_) => WireError::invalid(e.to_string()),
            RuntimeError::Conflict(_) => WireError::conflict(e.to_string()),
            RuntimeError::NoHarness(_) => WireError::new(Code::Unavailable, e.to_string()),
            RuntimeError::Store(s) => s.into(),
            RuntimeError::Proc(p) => p.into(),
            RuntimeError::Wire(w) => w,
        }
    }
}
