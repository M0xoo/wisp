//! The `team` and `skill` kinds: a lead and the subagents it may hand work to, and the skills agents are given.

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One seat on a team.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TeamSlot {
    /// an agent profile's name or a harness
    pub agent: String,
    /// copies of it the lead may run at once
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<u32>,
    /// what the lead gives it
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub why: String,
}

/// A lead and the subagents it may hand work to (v1 `teams`, `subagents`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TeamSpec {
    /// the lead's agent profile
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub lead: String,
    /// its subagents, by name
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub members: BTreeMap<String, TeamSlot>,
}

/// A skill given to agents: a folder or file, or the text inline.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SkillSpec {
    /// what it is for (agents read it to pick it)
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    /// a SKILL.md or its folder
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub path: String,
    /// the skill's text, when it isn't a file
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub body: String,
    /// extra fields a harness's skill format has
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extra: Option<Value>,
}
