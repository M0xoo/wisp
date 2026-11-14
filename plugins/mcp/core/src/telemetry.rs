//! The catalogue events a tool call stands for (ADR-0021; v1 routes/control.js, internal.js, connectors.js):
//! a task's agent launching tasks (`wisp_launch`) or acting on one (`wisp_task`), and the crew and connector
//! tools an agent or the user (`wisp mcp`) called. Only after the call worked; `agent` is the caller's harness, filled in by the host.

use serde_json::{Map, Value, json};

/// `(event, props)` for tool `name` called with `args`; `agent_side`: a task's agent called it (not `wisp mcp`).
pub fn of(name: &str, args: &Map<String, Value>, agent_side: bool) -> Option<(&'static str, Value)> {
    let s = |k: &str| args.get(k).and_then(Value::as_str).filter(|v| !v.is_empty());
    let by = if agent_side { "agent" } else { "user" };
    match name {
        "wisp_launch" if agent_side => Some((
            "agent_launch",
            json!({ "harness": s("agent").unwrap_or("auto"), "machine": s("machine").is_some(), "team": args.get("team").is_some_and(|t| !t.is_null()) || s("preset").is_some() }),
        )),
        "wisp_task" if agent_side => Some(("agent_task", json!({ "action": s("action").unwrap_or("") }))),
        "wisp_crew_add" | "wisp_crew_edit" | "wisp_crew_remove" | "wisp_crew_kit" => {
            Some(("crew_tool", json!({ "by": by, "op": name.trim_start_matches("wisp_crew_") })))
        }
        "wisp_connector_add" | "wisp_connector_signin" => Some((
            "connector_tool",
            json!({ "op": name.trim_start_matches("wisp_connector_"), "transport": s("transport").or_else(|| s("url").map(|_| "http")).unwrap_or("stdio") }),
        )),
        _ => None,
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn tool_calls_count_as_their_catalogue_events() {
        let a = |v: Value| v.as_object().cloned().unwrap();
        let (e, p) = of("wisp_launch", &a(json!({ "agent": "codex" })), true).unwrap();
        assert_eq!((e, p["harness"].as_str()), ("agent_launch", Some("codex")));
        assert_eq!(of("wisp_launch", &a(json!({})), false), None, "the user's own editor launching isn't an agent's launch");
        assert_eq!(of("wisp_task", &a(json!({ "action": "reply" })), true).unwrap().1["action"], "reply");
        let (e, p) = of("wisp_crew_kit", &a(json!({})), true).unwrap();
        assert_eq!((e, p["by"].as_str(), p["op"].as_str()), ("crew_tool", Some("agent"), Some("kit")));
        assert_eq!(of("wisp_connector_add", &a(json!({ "url": "https://x" })), true).unwrap().1["transport"], "http");
        assert_eq!(of("wisp_list", &a(json!({})), false), None);
    }
}
