//! wisp-mcp-api: the contract of `wisp.mcp`, wisp's MCP server. Two audiences, one handler: every task's
//! agent (v1 `server/mcp-ask.js`: `ask_user`, `delegate`, `wisp_save`, …, by its session's token) and the
//! user's own editors (v1 `server/mcp-wisp.js`, `wisp mcp`). The edge authenticates the token and hands
//! the caller in (`Caller::agent(session, capped)` or the user); the session a tool acts for is the
//! caller's, never an argument.
//!
//! The tools' names, descriptions and schemas are a contract with every live prompt (plan §6.9): they are
//! v1's, byte for byte, with goldens of v1's own `tools/list` output (`plugins/mcp/host/test/goldens`).

pub mod asks;
pub mod owners;

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use wisp_kernel::{BoxFuture, Call, Command, Ctx, Point, Result};

pub use asks::{
    Answered, Ask, AskAnswer, AskAnswerArgs, AskCancel, AskCancelArgs, AskClosed, AskOpen,
    AskOpenArgs, AskOpened, AskPending, AskPendingArgs, AskReply, AskShown, Cancelled, Decision,
    Outcome,
};

pub const PLUGIN_ID: &str = "wisp.mcp";
/// `POST /api/mcp`: one JSON-RPC message (or batch) per request, Streamable HTTP without the stream.
pub const MCP_PATH: &str = "/mcp";

// ---------- who is calling ----------

/// A member of the team a task may delegate to, as the runtime hands it in (v1 `WISP_TEAM`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamEntry {
    pub name: String,
    /// the harness, or a crew member's description ("Ada of the user's crew, CI watcher")
    #[serde(default)]
    pub agent: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, rename = "use", skip_serializing_if = "Option::is_none")]
    pub use_for: Option<String>,
    #[serde(default = "one")]
    pub count: u32,
    /// names of the parallel copies when count > 1 (`x#1`, `x#2`)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub copies: Vec<String>,
    /// where it runs when not here ("devbox")
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub place: Option<String>,
}

const fn one() -> u32 {
    1
}

/// What changes an agent's tool list, per session: v1's env flags on the `mcp-ask.js` child.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SessionInfo {
    /// a side discussion (v1 `WISP_READONLY`): only the tools that read, ask or show, and `approve`
    pub read_only: bool,
    /// started from a channel at a mode cap (v1 `WISP_CAPPED`); an `agent:capped` caller is capped whatever this says
    pub capped: bool,
    /// a Cast a spell task (v1 `WISP_SPELLS`)
    pub spells: bool,
    /// the harness takes a permission-prompt tool (v1 `WISP_APPROVE`)
    pub approve: bool,
    /// the watch page is on (v1 `WISP_WATCH`)
    pub watch: bool,
    /// the team `delegate` describes (v1 `WISP_TEAM`)
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub team: Vec<TeamEntry>,
    /// the turn this run belongs to (v1 `WISP_TURN`)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
}

// ---------- this plugin's commands ----------

/// One JSON-RPC message (or batch) in, its answer out; `None` for notifications. What `POST /api/mcp` runs.
#[derive(Debug)]
pub struct Rpc;
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RpcArgs {
    pub msg: Value,
    /// the folder the user's editor runs `wisp mcp` in (v1 `process.cwd()`)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn: Option<String>,
}
impl Command for Rpc {
    const ID: &'static str = "mcp.rpc";
    const PERMISSION: Option<&'static str> = Some("mcp:call");
    type Args = RpcArgs;
    type Out = Option<Value>;
}

/// The tools this caller is offered, as `tools/list` answers them.
#[derive(Debug)]
pub struct Tools;
impl Command for Tools {
    const ID: &'static str = "mcp.tools";
    const PERMISSION: Option<&'static str> = Some("mcp:call");
    const READ_ONLY: bool = true;
    type Args = Value;
    type Out = Vec<Value>;
}

/// The runtime says what a session's run is (v1 set the env of the `mcp-ask.js` child when it spawned it).
#[derive(Debug)]
pub struct SessionSet;
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SessionSetArgs {
    pub session: String,
    /// `None` forgets the session (it was deleted)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub info: Option<SessionInfo>,
}
impl Command for SessionSet {
    const ID: &'static str = "mcp.session.set";
    type Args = SessionSetArgs;
    type Out = ();
}

// ---------- points ----------

/// Who a contributed tool is offered to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Audience {
    Agent,
    User,
    Both,
}

pub type ToolFn =
    Arc<dyn Fn(Ctx, Call, ToolCall) -> BoxFuture<'static, Result<ToolText>> + Send + Sync>;

/// A tool call as a contributed tool sees it: the arguments, and the session it speaks for (the caller's).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ToolCall {
    pub args: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
}

/// What a tool answers: v1's route body, `{ text }`, or `{ error }` for a refusal the agent acts on.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolText {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// `mcp.tool@1`: a plugin adds a tool of its own. Built-ins get no private API, so v1's tools are wisp.mcp's
/// and contributions go after them; a contribution can't take a built-in name.
pub struct ToolContribution {
    /// `{ name, description, inputSchema }` as `tools/list` shows it
    pub tool: Value,
    pub audience: Audience,
    /// offered in a side discussion (it only reads, asks or shows)
    pub read_only: bool,
    /// hidden from a capped task (a courtesy: the capability set refuses anyway)
    pub capped_off: bool,
    pub run: ToolFn,
}

impl std::fmt::Debug for ToolContribution {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ToolContribution")
            .field("tool", &self.tool.get("name"))
            .field("audience", &self.audience)
            .finish_non_exhaustive()
    }
}

pub const TOOL_POINT: Point<ToolContribution> = Point::new("mcp.tool", 1);

/// `mcp.session@1`: a plugin says what it knows of a session's tools (side: `read_only`, spells, watch).
pub trait SessionFlags: Send + Sync {
    fn id(&self) -> &str;
    /// the flags it sets; `team` and `turn_id` are the runtime's and ignored here
    fn flags(&self, session: &str, ext: &Value) -> SessionInfo;
}

pub const SESSION_POINT: Point<dyn SessionFlags> = Point::new("mcp.session", 1);
