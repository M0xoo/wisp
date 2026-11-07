//! The one wire error: `{code, message, retry}` (plan §3.1 rule 8). Every crate maps its own error
//! enum (thiserror) into this at the boundary.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Code {
    NotFound,
    Invalid,
    Forbidden,
    Conflict,
    Unavailable,
    DepthExceeded,
    ReentrantHook,
    Timeout,
    ServiceGone,
    Vetoed,
    PluginOff,
    TooLarge,
    Internal,
}

#[derive(Debug, Clone, Serialize, Deserialize, thiserror::Error)]
#[error("{code:?}: {message}")]
pub struct WireError {
    pub code: Code,
    pub message: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub retry: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

impl WireError {
    pub fn new(code: Code, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            retry: false,
            details: None,
        }
    }
    pub fn not_found(m: impl Into<String>) -> Self {
        Self::new(Code::NotFound, m)
    }
    pub fn invalid(m: impl Into<String>) -> Self {
        Self::new(Code::Invalid, m)
    }
    pub fn forbidden(m: impl Into<String>) -> Self {
        Self::new(Code::Forbidden, m)
    }
    pub fn conflict(m: impl Into<String>) -> Self {
        Self::new(Code::Conflict, m)
    }
    pub fn internal(m: impl Into<String>) -> Self {
        Self::new(Code::Internal, m)
    }
    pub fn unavailable(m: impl Into<String>) -> Self {
        Self {
            retry: true,
            ..Self::new(Code::Unavailable, m)
        }
    }
    #[must_use]
    pub fn with_details(mut self, d: Value) -> Self {
        self.details = Some(d);
        self
    }
    /// HTTP status for the edge. A refusal (< 500) is an answer, never logged as an error.
    pub fn status(&self) -> u16 {
        match self.code {
            Code::NotFound => 404,
            Code::Invalid => 400,
            Code::Forbidden => 403,
            Code::Conflict | Code::Vetoed => 409,
            Code::TooLarge => 413,
            Code::Timeout => 504,
            Code::Unavailable | Code::ServiceGone | Code::PluginOff => 503,
            Code::DepthExceeded | Code::ReentrantHook | Code::Internal => 500,
        }
    }
}

pub type Result<T, E = WireError> = std::result::Result<T, E>;
