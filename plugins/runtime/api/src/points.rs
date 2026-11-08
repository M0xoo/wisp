//! wisp.runtime's extension points. v1's runner called other features through `app.*` (goals, the crew,
//! connectors, accounts); each of those calls is a point its owner contributes to, so the runtime never
//! imports the owner (ADR-0003). Everything here runs on the hot path or near it: keep `fields`,
//! `part`, `check` and `wants` pure and fast (no I/O, no locks held across awaits).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use wisp_kernel::{BoxFuture, Point, Result};

use crate::model::{Activity, FileChange, Mode, Session, Turn};

pub const SUMMARY: Point<dyn SummaryField> = Point::new("runtime.summary", 1);
pub const PROMPT: Point<dyn PromptPart> = Point::new("runtime.prompt", 1);
pub const BLOCK: Point<dyn BlockType> = Point::new("runtime.block", 1);
pub const VIEW: Point<dyn ViewTransform> = Point::new("runtime.view", 1);
pub const AFTER: Point<dyn AfterTurn> = Point::new("runtime.after", 1);
pub const RUN: Point<dyn RunPart> = Point::new("runtime.run", 1);
pub const OUTCOME: Point<dyn TurnOutcome> = Point::new("runtime.outcome", 1);
pub const DELEGATE: Point<dyn DelegateTarget> = Point::new("runtime.delegate", 1);
pub const ACCOUNTS: Point<dyn AccountsProvider> = Point::new("runtime.accounts", 1);

/// `runtime.summary@1`: a plugin adds its fields to the list row from its ext slot. Called once per row
/// *change*, never per list read (the row is cached by the session's rev).
pub trait SummaryField: Send + Sync + 'static {
    fn plugin(&self) -> &str;
    fn fields(&self, session: &Session, last: Option<&Turn>, out: &mut BTreeMap<String, Value>);
}

/// `runtime.prompt@1`: text appended to a turn's system prompt (learned preferences, plugin prompts).
pub trait PromptPart: Send + Sync + 'static {
    fn id(&self) -> &str;
    fn part(&self, session: &Session) -> String;
    /// text put ahead of one turn's prompt (a scheduled follow-up's note)
    fn prefix(&self, _session: &Session, _turn: &Turn) -> String {
        String::new()
    }
    /// text put after the prompt (what an @-mention of My Stuff points at); `tools`: the agent has MCP
    fn expand(&self, _prompt: &str, _session: &Session, _tools: bool) -> String {
        String::new()
    }
}

/// `runtime.block@1`: an answer block type the parser accepts and the UI renders.
pub trait BlockType: Send + Sync + 'static {
    fn type_name(&self) -> &str;
    /// validates and normalises one block in place; Err: drop it, with the reason
    fn check(&self, block: &mut Map<String, Value>) -> std::result::Result<(), String>;
    /// how the agent is told to use it, appended to the protocol's block list
    fn doc(&self) -> Option<&str> {
        None
    }
    /// who adds it, as the agent is told ("From the user's plugin <from>.")
    fn from(&self) -> Option<&str> {
        None
    }
}

/// `runtime.view@1`: what a *client* sees of a task (never what is stored or what the agent reads).
/// v1's .env masking is one. Return None for "unchanged" so the runtime skips the copy.
pub trait ViewTransform: Send + Sync + 'static {
    fn id(&self) -> &str;
    fn activity(&self, _a: &Activity, _turn_id: &str) -> Option<Activity> {
        None
    }
    fn change(&self, _c: &FileChange, _turn_id: &str) -> Option<FileChange> {
        None
    }
    fn block(&self, _b: &Value, _turn_id: &str, _index: usize) -> Option<Value> {
        None
    }
    fn text(&self, _text: &str) -> Option<String> {
        None
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnEnd {
    pub stopped: bool,
    pub is_error: bool,
}

/// `runtime.after@1`: a step after a turn ends, before the task lands (Auto's check, a goal round).
pub trait AfterTurn: Send + Sync + 'static {
    fn id(&self) -> &str;
    /// lower asks first; the first that wants a turn holds the task in Working
    fn order(&self) -> i32;
    fn wants(&self, session: &Session, turn: &Turn, end: TurnEnd) -> bool;
    /// does the step; ends with `runtime.settle` (or a follow-up) on the task
    fn run(&self, session: Session, turn: Turn) -> BoxFuture<'static, Result<()>>;
    /// someone else moved the task on: drop what it was about to do. `by`: who sent the follow-up.
    fn cancel(&self, session: &Session, stop: bool, by: Option<&str>) -> bool;
    /// what it is doing with the task now, for the row's live line
    fn busy(&self, _session: &Session) -> Option<String> {
        None
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpQuery {
    pub mode: Mode,
    pub harness: String,
    pub team: Vec<Value>,
    pub turn_id: String,
    pub sub: bool,
}

/// `runtime.run@1`: what a run gets besides its prompt: folders, env, MCP servers.
pub trait RunPart: Send + Sync + 'static {
    fn id(&self) -> &str;
    fn dirs(&self, _session: &Session) -> Vec<String> {
        Vec::new()
    }
    fn env(&self, _session: &Session) -> BTreeMap<String, String> {
        BTreeMap::new()
    }
    fn mcp_servers(&self, _session: &Session, _q: &McpQuery) -> BTreeMap<String, Value> {
        BTreeMap::new()
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Outcome {
    /// land without marking the task unread or notifying
    pub quiet: bool,
    /// it filed itself (a crew check-in that found nothing)
    pub filed: bool,
    pub later: bool,
}

/// `runtime.outcome@1`: how a finished turn lands.
pub trait TurnOutcome: Send + Sync + 'static {
    fn id(&self) -> &str;
    fn outcome(&self, session: &Session, turn: &Turn) -> Option<Outcome>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    pub id: String,
    pub agent: String,
    pub model: String,
    pub effort: String,
    pub turn_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub place: Option<String>,
}

/// `runtime.delegate@1`: delegation to a team member that isn't a plain harness (a crew member).
pub trait DelegateTarget: Send + Sync + 'static {
    fn id(&self) -> &str;
    fn handles(&self, member: &Value) -> bool;
    fn start(
        &self,
        lead: Session,
        member: Value,
        prompt: String,
    ) -> BoxFuture<'static, Result<Started>>;
    /// a job it started elsewhere, as last fetched, for the lead's reports
    fn child(&self, _id: &str) -> Option<Session> {
        None
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountInfo {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until: Option<i64>,
}

/// `runtime.accounts@1`: a harness's several accounts. Without one, a harness runs on the CLI's login.
pub trait AccountsProvider: Send + Sync + 'static {
    fn agent(&self) -> &str;
    fn multi(&self) -> bool;
    fn get(&self, id: &str) -> Option<AccountInfo>;
    fn list(&self) -> Vec<AccountInfo>;
    /// the account a run gets: `want` when it has it, else the last pick (by hand skips one at its limit)
    fn pick(&self, want: &str, by_hand: bool) -> String;
    /// conversations stay with the login: another account starts a fresh one
    fn per_login(&self) -> bool {
        false
    }
    /// the provider's own way past a limit ('' when none)
    fn extra(&self) -> String {
        String::new()
    }
    fn cool(&self, _id: &str, _ms: i64, _why: &str) {}
    fn reset_at(&self, _id: &str) -> Option<i64> {
        None
    }
    fn signed_out(&self, _text: &str) -> bool {
        false
    }
    fn key_login(&self) -> bool {
        false
    }
}

/// How a task's agent reaches this wisp (v1 `WISP_URL` / `WISP_TOKEN` and the `mcp-ask.js` server): the
/// edge's address and a token that speaks for that one task (`agent:session`). The install provides
/// it as a kernel service (`Arc<dyn AgentAccess>`); without one, runs get no wisp MCP server.
pub trait AgentAccess: Send + Sync + 'static {
    /// `http://127.0.0.1:<port>`, no trailing slash
    fn url(&self) -> String;
    fn token(&self, session: &str) -> String;
}
