//! The one error enum of wisp-mcp-core, mapped to the wire error at the boundary.

use wisp_kernel::WireError;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum McpError {
    /// v1's words for a missing argument ("prompt is required")
    #[error("{0} is required")]
    Required(&'static str),
    /// `wisp mcp` answers an unknown tool with a JSON-RPC -32602 (v1 mcp-wisp.js)
    #[error("Unknown tool: {0}")]
    UnknownTool(String),
    /// the embedded tool definitions don't parse: a broken build, caught by the golden tests
    #[error("tool definitions: {0}")]
    Defs(String),
    /// an owner's `{ error }`: a refusal the agent reads and acts on
    #[error("{0}")]
    Refused(String),
}

impl McpError {
    /// The JSON-RPC error code this answers with, when it isn't a tool result.
    pub const fn rpc_code(&self) -> Option<i64> {
        match self {
            Self::UnknownTool(_) => Some(crate::rpc::INVALID_PARAMS),
            _ => None,
        }
    }
}

impl From<McpError> for WireError {
    fn from(e: McpError) -> Self {
        let message = e.to_string();
        match e {
            McpError::Required(_) => Self::invalid(message),
            McpError::UnknownTool(_) => Self::not_found(message),
            McpError::Defs(_) => Self::internal(message),
            McpError::Refused(_) => Self::conflict(message),
        }
    }
}
