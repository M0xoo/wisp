//! The one error of wisp-connectors-core. Every message is v1's words: the page shows them as they are.
use serde_json::json;
use wisp_kernel::{Code, WireError};

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ConnectorError {
    /// a body that can't be a connector, or a request that makes no sense now (400)
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    NotFound(String),
    /// a capped task, or one that may not change the user's connectors (403)
    #[error("{0}")]
    Forbidden(String),
    /// the sign-in or registration server refused (v1 answered 502)
    #[error("{0}")]
    Upstream(String),
}

impl ConnectorError {
    pub fn invalid(m: impl Into<String>) -> Self {
        Self::Invalid(m.into())
    }
}

impl From<ConnectorError> for WireError {
    fn from(e: ConnectorError) -> Self {
        match e {
            ConnectorError::Invalid(m) => WireError::invalid(m),
            ConnectorError::NotFound(m) => WireError::not_found(m),
            ConnectorError::Forbidden(m) => WireError::forbidden(m),
            // not `unavailable()`: retrying the same sign-in gets the same answer
            ConnectorError::Upstream(m) => WireError::new(Code::Unavailable, m).with_details(json!({ "status": 502 })),
        }
    }
}

pub type Result<T, E = ConnectorError> = std::result::Result<T, E>;
