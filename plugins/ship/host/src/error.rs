//! wisp-ship's one error enum, mapped to the wire's `{code, message, retry}` at the edge.

use wisp_kernel::WireError;
use wisp_ship_core::Refusal;

#[derive(Debug, thiserror::Error)]
pub enum ShipError {
    /// a request Ship it won't do, in v1's words (400 or 409)
    #[error("{}", .0.message())]
    Refused(Refusal),
    /// gh failed: its own `error:`/`fatal:` line, or its last lines
    #[error("{0}")]
    Gh(String),
    #[error("{0}")]
    NotFound(String),
    #[error(transparent)]
    Wire(#[from] WireError),
}

impl From<Refusal> for ShipError {
    fn from(r: Refusal) -> Self {
        Self::Refused(r)
    }
}

impl ShipError {
    /// `name: message`, for one repo of a task across several.
    #[must_use]
    pub fn in_repo(self, name: &str, of: usize) -> Self {
        if of <= 1 {
            return self;
        }
        match self {
            Self::Refused(r) => Self::Refused(r.in_repo(name, of)),
            Self::Gh(m) => Self::Gh(format!("{name}: {m}")),
            Self::NotFound(m) => Self::NotFound(format!("{name}: {m}")),
            Self::Wire(mut w) => {
                w.message = format!("{name}: {}", w.message);
                Self::Wire(w)
            }
        }
    }
}

impl From<ShipError> for WireError {
    fn from(e: ShipError) -> Self {
        match e {
            ShipError::Refused(Refusal::Invalid(m)) | ShipError::Gh(m) => WireError::invalid(m),
            ShipError::Refused(Refusal::Conflict(m)) => WireError::conflict(m),
            ShipError::NotFound(m) => WireError::not_found(m),
            ShipError::Wire(w) => w,
        }
    }
}

pub type Result<T, E = ShipError> = std::result::Result<T, E>;
