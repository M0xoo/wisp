//! How an edge is set up: tokens, the user's set, the proxy, previews, the bundle, timeouts.
use std::path::PathBuf;
use std::time::Duration;

use crate::auth;

#[derive(Debug, Clone)]
pub struct EdgeConfig {
    /// wisp's own token: the CLI and wisp's helpers send it; never handed to an agent
    pub master: String,
    /// `user:full`, or `box` on a grid box
    pub user_set: String,
    pub proxy: crate::TrustedProxy,
    /// previews on (trusted proxy on and `WISP_PREVIEW_URL` set)
    pub previews: bool,
    /// the built web app; None: the API only
    pub web_dir: Option<PathBuf>,
    /// where `server.json` is written after listen; None: not advertised (tests)
    pub home: Option<PathBuf>,
    pub version: String,
    /// keep-alive idle and header read timeout (v1: 65 s / 66 s)
    pub keep_alive: Duration,
}

impl EdgeConfig {
    pub fn new(master: impl Into<String>, version: impl Into<String>) -> Self {
        Self {
            master: master.into(),
            user_set: auth::sets::USER.into(),
            proxy: crate::TrustedProxy::off(),
            previews: false,
            web_dir: None,
            home: None,
            version: version.into(),
            keep_alive: Duration::from_secs(65),
        }
    }
}
