//! The crew core's one error: v1's `bad(message, status)`, by kind. The host maps it to `WireError`.

/// Every refusal carries v1's sentence, which the page and agents show as is.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    /// v1 400
    #[error("{0}")]
    Invalid(String),
    /// v1 404
    #[error("{0}")]
    NotFound(String),
    /// v1 409
    #[error("{0}")]
    Conflict(String),
    /// v1 429: a member's queue is full
    #[error("{0}")]
    TooMany(String),
}

impl Error {
    /// The HTTP status v1 answered with.
    pub fn status(&self) -> u16 {
        match self {
            Self::Invalid(_) => 400,
            Self::NotFound(_) => 404,
            Self::Conflict(_) => 409,
            Self::TooMany(_) => 429,
        }
    }

    /// The same kind of error, with `field: ` in front (v1 crew-share.js `at`).
    #[must_use]
    pub fn prefixed(self, field: &str) -> Self {
        match self {
            Self::Invalid(m) => Self::Invalid(format!("{field}: {m}")),
            Self::NotFound(m) => Self::NotFound(format!("{field}: {m}")),
            Self::Conflict(m) => Self::Conflict(format!("{field}: {m}")),
            Self::TooMany(m) => Self::TooMany(format!("{field}: {m}")),
        }
    }
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

/// v1 `bad(message)`: a 400.
pub fn bad(m: impl Into<String>) -> Error {
    Error::Invalid(m.into())
}
