//! Capability sets (ADR-0008, plan §6.5): permissions `ns:action{k:v}` bound to a context. Default deny.
//! The sets themselves are data (`capabilities.json` in this crate, plus each plugin's manifest).
use serde::{Deserialize, Serialize};

/// Who a call speaks for: decided by the token at the edge, never by the protocol.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Caller {
    /// 'user:full', 'agent:session', 'agent:capped', 'crew:<name>', 'box', 'apikey', 'preview',
    /// 'pane:<id>', 'plugin:<id>', 'kernel'
    pub set: String,
    /// the session an agent token speaks for
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    /// the plugin making a nested call
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin: Option<String>,
}

impl Caller {
    pub fn user() -> Self {
        Self { set: "user:full".into(), session: None, plugin: None }
    }
    pub fn kernel() -> Self {
        Self { set: "kernel".into(), session: None, plugin: None }
    }
    pub fn agent(session: impl Into<String>, capped: bool) -> Self {
        let set = if capped { "agent:capped" } else { "agent:session" };
        Self { set: set.into(), session: Some(session.into()), plugin: None }
    }
}

/// A named set of permission patterns. `proc:spawn{bin:*}` matches `proc:spawn{bin:claude}`;
/// `runtime:*` matches every runtime permission.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapabilitySet {
    pub id: String,
    pub allow: Vec<String>,
    #[serde(default)]
    pub deny: Vec<String>,
}

/// Does `caller`'s set allow `permission`? The full matcher (scopes, plugin manifests, deny lists) is
/// the kernel agent's; this conservative version allows only the user and the kernel.
pub fn allowed(caller: &Caller, _permission: &str) -> bool {
    caller.set == "user:full" || caller.set == "kernel"
}
