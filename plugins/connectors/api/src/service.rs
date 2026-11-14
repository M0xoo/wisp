//! Services and points: the per-turn lookup the runner calls (from memory, on its hot path), the
//! bridge the edge provides (how a harness starts the proxy), and the point where a harness says
//! where its own MCP config is.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use wisp_kernel::{Call, Point, Result, Service};

use crate::commands::TurnQuery;
use crate::rows::McpServers;

/// The permission every [`ConnectorsApi`] method requires.
pub const PERM_FOR_TURN: &str = "connectors:forTurn";
/// The permission every [`BridgeApi`] method requires.
pub const PERM_BRIDGE: &str = "connectors:bridge";

/// What runtime (or a harness runner) asks per turn. Sync and from memory: no I/O on the runner's path.
pub trait ConnectorsApi: Send + Sync + 'static {
    /// The connectors one turn gets, as `mcpServers` entries that start the proxy by id. Plan mode and
    /// harnesses that don't take servers per turn get none; a harness with a server by that name in
    /// its own config keeps its own. Starts with `call.require(PERM_FOR_TURN)?`.
    fn for_turn(&self, call: &Call, q: &TurnQuery) -> Result<McpServers>;
}

/// `connectors.service@1`, provided by wisp.connectors.
#[derive(Debug)]
pub struct ConnectorsService;

impl Service for ConnectorsService {
    const ID: &'static str = "connectors.service";
    const MAJOR: u32 = 1;
    type Api = dyn ConnectorsApi;
}

/// How a harness starts the proxy: the command line before the connector's id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct Launcher {
    pub command: String,
    pub args: Vec<String>,
}

/// `connectors.bridge@1`, provided by the edge (the bin): how the proxy is started, wisp's URL, and a
/// token whose caller may run `connectors.spec` and `connectors.token` only (v1
/// `connectorToken = HMAC(master, "connectors")`). Every method starts with `call.require(PERM_BRIDGE)?`.
pub trait BridgeApi: Send + Sync + 'static {
    fn launcher(&self, call: &Call) -> Result<Launcher>;
    fn url(&self, call: &Call) -> Result<String>;
    fn token(&self, call: &Call) -> Result<String>;
}

#[derive(Debug)]
pub struct BridgeService;

impl Service for BridgeService {
    const ID: &'static str = "connectors.bridge";
    const MAJOR: u32 = 1;
    type Api = dyn BridgeApi;
}

/// Where the harnesses keep their configs: the user's home and the env that moves them
/// (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `COPILOT_HOME`, `XDG_CONFIG_HOME`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Where {
    pub home: PathBuf,
    pub env: BTreeMap<String, String>,
}

impl Where {
    pub fn var(&self, k: &str) -> Option<&str> {
        self.env.get(k).map(String::as_str).filter(|v| !v.is_empty())
    }
}

/// A harness's own MCP config (`connectors.harness@1`): which files, and the servers in them. Built-in
/// harnesses use this same point (wisp.connectors contributes v1's five until each harness plugin
/// contributes its own); a user's harness plugin adds itself the same way.
pub trait HarnessMcp: Send + Sync + 'static {
    /// the harness id (`claude`, `codex`)
    fn agent(&self) -> &str;
    /// what Settings calls it ("Claude Code")
    fn label(&self) -> &str;
    /// takes connectors per turn (cursor and antigravity read only their own config)
    fn per_turn(&self) -> bool;
    /// the files its servers are in, for this home and folder (`None`: the global ones only)
    fn files(&self, w: &Where, cwd: Option<&str>) -> Vec<PathBuf>;
    /// those files' texts (`None`: missing) → its servers by name, each `{command, args, env}` or
    /// `{url, headers}` as JSON
    fn servers(&self, texts: &[Option<String>], cwd: Option<&str>) -> BTreeMap<String, Value>;
}

pub const HARNESS_MCP: Point<dyn HarnessMcp> = Point::new("connectors.harness", 1);
