//! The crate's one error type (plan §9.2). The edge maps it to `WireError {code: "invalid", …}`.

/// What can go wrong with a wire value.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ProtocolError {
    #[error("bad JSON pointer: {0}")]
    Pointer(String),
    #[error("patch at {path}: {why}")]
    Patch { path: String, why: &'static str },
}

impl ProtocolError {
    /// The `WireError` code this maps to at the edge.
    pub fn code(&self) -> &'static str {
        "invalid"
    }
}
