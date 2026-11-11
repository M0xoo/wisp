//! wisp.runtime's interceptor hooks (plan §6.1b): ordered, with a timeout; each continues, modifies or
//! vetoes. A veto's message reaches the user as v1's refusals did.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use wisp_kernel::Hook;

use crate::commands::{FollowUpArgs, StartArgs};
use crate::model::{Held, Mode};
use crate::{SessionId, TurnId};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RunKind {
    First,
    FollowUp,
}

/// `before:run`: budget, capped mode, side gate, guard, project trust, accounts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeforeRunCtx {
    pub session_id: SessionId,
    pub turn_id: TurnId,
    pub agent: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    pub model: String,
    pub effort: String,
    pub mode: Mode,
    pub cwd: String,
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by: Option<String>,
    /// set by an interceptor that holds the turn instead of refusing it
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hold: Option<Held>,
    /// the account's environment (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`), set by wisp.accounts
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub account_env: BTreeMap<String, String>,
    /// the permission mode for this turn only (an approved retry runs once in Full auto)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub once: Option<Mode>,
    /// set by project trust: run without the repo's hooks and MCP servers
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub untrusted: bool,
    pub kind: RunKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<SessionId>,
    /// you said yes to going past Ask near the limit's line (the follow-up's `confirmLimit`). Additive (2026-11-11).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub confirm_limit: bool,
}

#[derive(Debug)]
pub struct BeforeRun;
impl Hook for BeforeRun {
    const ID: &'static str = "before:run";
    type Ctx = BeforeRunCtx;
}

#[derive(Debug)]
pub struct BeforeCreate;
impl Hook for BeforeCreate {
    const ID: &'static str = "before:create";
    type Ctx = StartArgs;
}

#[derive(Debug)]
pub struct BeforeFollowUp;
impl Hook for BeforeFollowUp {
    const ID: &'static str = "before:followUp";
    type Ctx = FollowUpArgs;
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BeforeDelegateCtx {
    pub from: SessionId,
    pub to: StartArgs,
}

#[derive(Debug)]
pub struct BeforeDelegate;
impl Hook for BeforeDelegate {
    const ID: &'static str = "before:delegate";
    type Ctx = BeforeDelegateCtx;
}
