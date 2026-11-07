//! wisp-lsp-core: wisp.lsp's pure, sans-IO logic (no tokio, fs, net or clock). The host feeds it the
//! server's bytes and the files' text, and does what it says.
//!
//! - [`frame`]: LSP's Content-Length frames, decoded incrementally
//! - [`client`]: one server's conversation (ids, open versions, diagnostics, the server's questions)
//! - [`servers`]: which server for which file, where it is found, how npm installs it
//! - [`request`]: the route's body, and the LSP request each op makes
//! - [`answer`]: answers mapped to what the editor shows (places inside the task's folder, capped)
//! - [`edit`]: a rename's `WorkspaceEdit` applied to a file's text
//! - [`url`]: `file:` URLs ↔ paths

pub mod answer;
pub mod client;
pub mod edit;
pub mod frame;
pub mod request;
pub mod servers;
pub mod url;

#[cfg(test)]
mod testrng;

pub use client::{Action, Client};
pub use servers::{SERVERS, ServerSpec, lang_id, lang_of, spec};
