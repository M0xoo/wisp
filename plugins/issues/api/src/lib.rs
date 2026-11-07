//! wisp-issues-api: issues to start a task from (New task → Issue, ⌘K). A project's open GitHub issues
//! through gh, the Linear issues assigned to you (a Linear connector's API key), or the Jira ones (a
//! Jira or Atlassian connector's site, email and token). A failure comes back as words the page shows,
//! with what fixes it (`fix`: install | signin | remote | linear | jira | project), never as an error.
//!
//! Shapes are v1's (server/issues.js) field for field, so `GET /api/issues` stays a thin adapter.

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use wisp_kernel::{BoxFuture, Call, Command, Point, Result};

/// GitHub numbers are numbers; Linear and Jira keys (`ENG-7`, `ACME-12`) are strings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(untagged)]
#[ts(export, export_to = "issues/")]
pub enum IssueNumber {
    Int(u64),
    Key(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "issues/")]
pub struct Issue {
    pub id: String,
    #[serde(rename = "ref")]
    pub reference: String,
    pub number: IssueNumber,
    pub title: String,
    pub url: String,
    pub labels: Vec<String>,
    pub assignee: String,
    /// ≤ 4000 characters, `\r\n` made `\n`
    pub body: String,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "issues/")]
pub enum Source {
    #[default]
    Github,
    Linear,
    Jira,
}

impl Source {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "github" => Some(Self::Github),
            "linear" => Some(Self::Linear),
            "jira" => Some(Self::Jira),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Github => "github",
            Self::Linear => "linear",
            Self::Jira => "jira",
        }
    }
}

/// The picker's answer. `linear`/`jira`: whether those sources are connected, for its switch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "issues/")]
pub struct IssueList {
    pub source: Source,
    pub issues: Vec<Issue>,
    pub linear: bool,
    pub jira: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub repo: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub fix: Option<String>,
}

/// A problem in words, with what fixes it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct Problem {
    pub error: String,
    pub fix: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
#[ts(export, export_to = "issues/")]
pub struct ListArgs {
    #[serde(default)]
    pub source: Source,
    /// a project id; None (or "none") for Linear and Jira
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub project: Option<String>,
    #[serde(default)]
    pub q: String,
}

/// `issues.list`: read-only, allowed inside an interceptor.
#[derive(Debug)]
pub struct List;
impl Command for List {
    const ID: &'static str = "issues.list";
    const READ_ONLY: bool = true;
    type Args = ListArgs;
    type Out = IssueList;
}

// ---------- what issues reads through (points other plugins contribute, ports the install provides) ----------

/// A project as issues needs it: its id, name, the repo it was cloned from, its folder here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ProjectRef {
    pub id: String,
    pub name: String,
    /// the repo URL it was added from (a clone, or one on another computer), "" when a folder
    pub repo: String,
    /// its folder on this computer, None when it isn't here
    pub dir: Option<String>,
}

/// `issues.projects@1`: who knows the projects (the projects plugin). The first contributor answers.
pub trait Projects: Send + Sync + 'static {
    fn project(&self, call: &Call, id: &str) -> BoxFuture<'static, Result<Option<ProjectRef>>>;
}
pub const PROJECTS: Point<dyn Projects> = Point::new("issues.projects", 1);

/// A connector with its secret values resolved: env vars and headers by name (v1 connectors.js).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct Connector {
    pub id: String,
    pub name: String,
    pub url: String,
    pub command: String,
    pub args: Vec<String>,
    pub enabled: bool,
    pub env: Vec<(String, String)>,
    pub headers: Vec<(String, String)>,
}

/// `issues.connectors@1`: the MCP connectors and their secrets (the connectors plugin). Read-only.
pub trait Connectors: Send + Sync + 'static {
    fn connectors(&self, call: &Call) -> BoxFuture<'static, Result<Vec<Connector>>>;
}
pub const CONNECTORS: Point<dyn Connectors> = Point::new("issues.connectors", 1);

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct HttpResponse {
    pub status: u16,
    pub status_text: String,
    pub body: Vec<u8>,
}

/// The kernel's one HTTP client (`ctx.service::<Arc<dyn Http>>()`). Declared here until the kernel's
/// `net` service exists; `Err` is "couldn't reach it" in words.
pub trait Http: Send + Sync + 'static {
    fn send(
        &self,
        req: HttpRequest,
    ) -> BoxFuture<'static, std::result::Result<HttpResponse, String>>;
}
