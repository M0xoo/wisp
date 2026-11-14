//! The tool table: v1's definitions, kept as v1 printed them (`defs/*.json`, one tool per line, recorded
//! from v1's own `tools/list`), and which of them each caller is offered. Kept as text, never re-serialised:
//! the bytes an agent's prompt was built from stay the bytes it gets, and `tools/list` is a copy.

use std::sync::{LazyLock, OnceLock};

use serde::Deserialize;
use serde_json::value::RawValue;
use wisp_mcp_api::SessionInfo;

use crate::McpError;
use crate::team;

const AGENT_DEFS: &str = include_str!("../defs/agent.json");
const USER_DEFS: &str = include_str!("../defs/user.json");

/// A side discussion's tools (v1 server/side.js): reading, asking the user, the page beside the task, the
/// gate. They carry `readOnlyHint`, the only thing that lets a Claude Code task call them in plan mode.
pub const READ_ONLY_TOOLS: &[&str] = &[
    "approve",
    "ask_user",
    "resume_later",
    "wisp_tag",
    "wisp_watch",
    "wisp_blocks",
    "wisp_stats",
    "wisp_sessions",
    "wisp_session",
    "wisp_stuff",
    "wisp_crew",
    "wisp_connectors",
    "wisp_available",
    "wisp_plugins",
    "wisp_plugin_schema",
    "wisp_plugin_data",
    "wisp_plugin_check",
];
/// Not offered to a task a channel started at a mode cap: the tools that only change or read the user's setup.
pub const CAPPED_OFF: &[&str] = &[
    "wisp_crew_add",
    "wisp_crew_edit",
    "wisp_crew_kit",
    "wisp_crew_remove",
    "wisp_connectors",
    "wisp_connector_add",
    "wisp_connector_signin",
];
/// The tools for writing a plugin (v1's spell tools): only a Cast task's agent has them (v1 `info.spells`), so
/// they don't add to every other agent's list.
pub const PLUGIN_TOOLS: &[&str] = &["wisp_plugins", "wisp_plugin_schema", "wisp_plugin_data", "wisp_plugin_check"];
/// The crew tools `wisp mcp` offers too (without `wisp_crew_kit`: there is no answer to show its files under).
pub const USER_CREW: &[&str] = &["wisp_crew", "wisp_crew_add", "wisp_crew_edit", "wisp_crew_remove"];

/// One tool's definition as JSON text, plain and with v1's `readOnlyHint`.
#[derive(Debug)]
pub struct Def {
    pub name: String,
    pub raw: String,
    pub hinted: String,
}

#[derive(Debug)]
pub struct Table {
    /// a task's agent's tools, in v1's order, `delegate` aside (team.rs writes it per session)
    pub agent: Vec<Def>,
    /// `wisp mcp`'s own tools; its crew tools are the agent's
    pub user: Vec<Def>,
}

#[derive(Deserialize)]
struct Named {
    name: String,
}

static TABLE: LazyLock<Result<Table, McpError>> = LazyLock::new(|| Ok(Table { agent: load(AGENT_DEFS)?, user: load(USER_DEFS)? }));

/// The table, parsed once.
pub fn table() -> Result<&'static Table, McpError> {
    TABLE.as_ref().map_err(Clone::clone)
}

fn load(text: &str) -> Result<Vec<Def>, McpError> {
    let raws: Vec<Box<RawValue>> = serde_json::from_str(text).map_err(|e| McpError::Defs(e.to_string()))?;
    raws.into_iter()
        .map(|r| {
            let Named { name } = serde_json::from_str(r.get()).map_err(|e| McpError::Defs(e.to_string()))?;
            let raw = r.get().to_owned();
            Ok(Def { name, hinted: hint(&raw), raw })
        })
        .collect()
}

/// v1's `{ ...t, annotations: { readOnlyHint: true } }`: the key goes last.
pub fn hint(raw: &str) -> String {
    let body = raw.trim_end().strip_suffix('}').unwrap_or(raw);
    format!("{body},\"annotations\":{{\"readOnlyHint\":true}}}}")
}

impl Table {
    pub fn agent_def(&self, name: &str) -> Option<&Def> {
        self.agent.iter().find(|d| d.name == name)
    }

    /// Every built-in name, of either list: a contributed tool can't take one.
    pub fn is_builtin(&self, name: &str) -> bool {
        name == "delegate" || self.agent.iter().chain(&self.user).any(|d| d.name == name)
    }

    /// `wisp mcp`'s list, comma-joined (without the brackets).
    pub fn user_list(&self) -> &'static str {
        static USER: OnceLock<String> = OnceLock::new();
        USER.get_or_init(|| {
            let crew = USER_CREW.iter().filter_map(|n| self.agent_def(n));
            self.user.iter().chain(crew).map(|d| d.raw.as_str()).collect::<Vec<_>>().join(",")
        })
    }
}

/// Why an agent isn't offered a tool.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    Capped,
    ReadOnly,
    /// a plugin-writing tool, in a task that wasn't started from Cast a plugin
    NotCast,
}

/// The flags a contributed tool brings for the same checks.
#[derive(Debug, Clone, Copy, Default)]
pub struct OwnFlags {
    pub read_only: bool,
    pub capped_off: bool,
}

/// Why `name` isn't offered to this session (v1's `offered`), or `None` when it is. `own`: the flags of a
/// contributed tool by that name.
pub fn not_offered(name: &str, info: &SessionInfo, own: Option<OwnFlags>) -> Option<Refusal> {
    let capped_off = own.map_or_else(|| CAPPED_OFF.contains(&name), |o| o.capped_off);
    let read_only = own.map_or_else(|| READ_ONLY_TOOLS.contains(&name), |o| o.read_only);
    if own.is_none() && !info.spells && PLUGIN_TOOLS.contains(&name) {
        Some(Refusal::NotCast)
    } else if info.capped && capped_off {
        Some(Refusal::Capped)
    } else if info.read_only && !read_only {
        Some(Refusal::ReadOnly)
    } else {
        None
    }
}

/// Is a built-in agent tool there at all for this session (`wisp_watch` and `approve` need their flag; the
/// plugin tools are listed only to a Cast task, `not_offered`)? A tool that isn't answers "Method not found", as v1's fallthrough did.
pub fn exists_for(name: &str, info: &SessionInfo) -> bool {
    match name {
        "wisp_watch" => info.watch,
        "approve" => info.approve,
        _ => true,
    }
}

const fn flags_key(info: &SessionInfo) -> usize {
    (info.watch as usize)
        | (info.approve as usize) << 1
        | (info.spells as usize) << 2
        | (info.read_only as usize) << 3
        | (info.capped as usize) << 4
}

/// A task's agent's list, comma-joined, in v1's order. Without a team it's one of 32 shapes, each built
/// once: `tools/list` runs on every turn of every task.
pub fn agent_list(t: &Table, info: &SessionInfo) -> std::borrow::Cow<'static, str> {
    static CACHE: [OnceLock<String>; 32] = [const { OnceLock::new() }; 32];
    if info.team.is_empty() {
        return std::borrow::Cow::Borrowed(CACHE[flags_key(info)].get_or_init(|| build_agent_list(t, info)).as_str());
    }
    std::borrow::Cow::Owned(build_agent_list(t, info))
}

fn build_agent_list(t: &Table, info: &SessionInfo) -> String {
    let mut out: Vec<std::borrow::Cow<'_, str>> = Vec::with_capacity(t.agent.len() + 1);
    for d in &t.agent {
        // v1's order puts the team tools right after `approve`, before `subagent_results`.
        if d.name == "subagent_results" && not_offered("delegate", info, None).is_none() {
            out.push(team::delegate(&info.team).into());
        }
        if !exists_for(&d.name, info) || not_offered(&d.name, info, None).is_some() {
            continue;
        }
        out.push(if READ_ONLY_TOOLS.contains(&d.name.as_str()) { d.hinted.as_str().into() } else { d.raw.as_str().into() });
    }
    out.join(",")
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic)]
mod tests {
    use super::*;

    fn names(info: &SessionInfo) -> Vec<String> {
        let list: Vec<serde_json::Value> = serde_json::from_str(&format!("[{}]", agent_list(table().unwrap(), info))).unwrap();
        list.iter().filter_map(|x| x["name"].as_str().map(str::to_owned)).collect()
    }

    #[test]
    fn a_plain_tasks_tool_list_lacks_the_plugin_tools_and_a_call_is_refused() {
        for info in [
            SessionInfo::default(),
            SessionInfo { capped: true, ..SessionInfo::default() },
            SessionInfo { read_only: true, ..SessionInfo::default() },
        ] {
            let names = names(&info);
            for n in PLUGIN_TOOLS {
                assert!(!names.iter().any(|x| x == n), "{n} not offered to {info:?}");
                assert_eq!(not_offered(n, &info, None), Some(Refusal::NotCast), "{n} refused for {info:?}");
            }
            assert!(names.iter().any(|x| x == "wisp_sessions"), "the rest stays: {names:?}");
        }
    }

    #[test]
    fn a_cast_tasks_tool_list_has_the_plugin_tools_read_only_capped_and_side_too() {
        let t = table().unwrap();
        for info in [
            SessionInfo { spells: true, ..SessionInfo::default() },
            SessionInfo { spells: true, capped: true, ..SessionInfo::default() },
            SessionInfo { spells: true, read_only: true, ..SessionInfo::default() },
        ] {
            let list: Vec<serde_json::Value> = serde_json::from_str(&format!("[{}]", agent_list(t, &info))).unwrap();
            for n in PLUGIN_TOOLS {
                let tool = list.iter().find(|x| x["name"] == *n).unwrap_or_else(|| panic!("{n} offered to {info:?}"));
                assert_eq!(tool["annotations"]["readOnlyHint"], true, "{n}: they only read");
                assert_eq!(not_offered(n, &info, None), None);
            }
        }
        // a contributed tool brings its own flags: the Cast check is the built-ins'
        assert_eq!(not_offered("wisp_plugins", &SessionInfo::default(), Some(OwnFlags::default())), None);
    }
}
