//! A crew member as code (`crew:` in a formula, ADR-0026). The fields a user sets up; what the crew keeps
//! by itself (its log, queue, check-in counts, links) is data, not part of the spec.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A crew member: who they are, what runs their jobs, when they check in.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CrewSpec {
    /// what they do ("reviewer", "release manager")
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub role: String,
    /// a spirit code or an emoji ('' rolls one from the name)
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub avatar: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub color: String,
    /// the standing instructions every job of theirs starts with
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub brief: String,
    /// the folder they work in
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub cwd: String,
    /// the computer their jobs run on ('' = this one)
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub machine: String,
    /// '' | job | own: a worktree per job, or one of their own
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub sandbox: String,
    /// an agent profile's name or a harness (`reviewer`, `codex`)
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub agent: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub model: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub effort: String,
    /// plan | edits | auto
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub mode: String,
    /// when they check in: a cron, or words ("every weekday at 9")
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub cron: String,
    /// how many of their jobs may run at once
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parallel: Option<u32>,
    /// their kit: `[{ name, description?, body }]` skills and notes
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub kit: Vec<Value>,
    /// who they delegate to: `[{ crew, why? }]`
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub team: Vec<Value>,
    /// no check-ins or jobs until resumed
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub paused: bool,
    /// their notebook (a file: it stays a file)
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub notebook: String,
    /// what else starts their jobs (trigger kinds: `ci`, `done`, `finished`)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub on: Vec<String>,
}
