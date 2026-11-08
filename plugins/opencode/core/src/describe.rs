//! v1 opencode.js `describeTool`: a finished call in words.

use serde_json::Value;
use wisp_harness_kit::commands::describe_command_value;
use wisp_harness_kit::js::{self, truthy};
use wisp_harness_kit::protocol::{crew_tool_label, wisp_tool_label};
use wisp_harness_kit::{RunPaths, Tool, ToolKind, clip, clip_value, rel_value};

fn t(kind: ToolKind, label: impl Into<String>) -> Tool {
    Tool::new(kind, label)
}

pub fn describe_tool(name: &str, input: &Value, paths: &RunPaths) -> Tool {
    let f = rel_value(js::or(&input["filePath"], &input["path"]), paths);
    let s = |k: &str| js::str(&input[k]);
    match name {
        "read" => t(ToolKind::Read, format!("Reading {f}")).file(f),
        "edit" | "patch" | "apply_patch" | "multiedit" => {
            if f.is_empty() {
                t(ToolKind::Edit, "Editing files")
            } else {
                t(ToolKind::Edit, format!("Editing {f}")).file(f)
            }
        }
        "write" => t(ToolKind::Edit, format!("Writing {f}")).file(f),
        "bash" | "shell" => {
            let label = if truthy(&input["description"]) { clip_value(&input["description"], 80) } else { describe_command_value(&input["command"], paths) };
            let mut tool = t(ToolKind::Run, label);
            if !input["command"].is_null() {
                tool.detail = Some(js::string(&input["command"]));
            }
            tool
        }
        "grep" => t(ToolKind::Search, format!("Searching for “{}”", clip(&s("pattern"), 40))),
        "glob" | "list" => {
            if truthy(&input["pattern"]) {
                t(ToolKind::Search, format!("Finding {}", clip(&s("pattern"), 50)))
            } else {
                t(ToolKind::Search, format!("Listing {}", if f.is_empty() { "." } else { &f }))
            }
        }
        "webfetch" => t(ToolKind::Web, format!("Reading {}", clip(&s("url"), 60))),
        "websearch" => t(ToolKind::Web, format!("Searching the web: {}", clip(&s("query"), 50))),
        "task" => t(ToolKind::Agent, format!("Delegating: {}", clip_value(js::or(&input["description"], &input["prompt"]), 60))),
        "todowrite" => {
            let active = js::arr(&input["todos"]).iter().find(|x| x["status"] == "in_progress");
            t(ToolKind::Plan, active.map_or_else(|| "Planning".to_owned(), |a| clip_value(&a["content"], 80)))
        }
        "wisp_ask_user" => t(ToolKind::Wait, "Waiting for your answer"),
        "wisp_delegate" => {
            let mut seen: Vec<String> = Vec::new();
            for x in js::arr(&input["tasks"]) {
                let n = if x["subagent"].is_null() { String::new() } else { js::string(&x["subagent"]) };
                if !seen.contains(&n) {
                    seen.push(n);
                }
            }
            let who = seen.join(", ");
            t(ToolKind::Agent, format!("Delegated to {}", clip(if who.is_empty() { "subagents" } else { &who }, 60)))
        }
        "wisp_subagent_results" => t(ToolKind::Agent, "Collected subagent reports"),
        n if n.starts_with("wisp_wisp_") => wisp_tool_label(&n[5..], input).or_else(|| crew_tool_label(&n[5..], input)).unwrap_or_else(|| t(ToolKind::Tool, format!("Using {}", n.replace('_', " ")))),
        _ => crew_tool_label(name.strip_prefix("wisp_").unwrap_or(name), input).unwrap_or_else(|| t(ToolKind::Tool, format!("Using {}", name.replace('_', " ")))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn calls_in_words() {
        let p = RunPaths::same("/w");
        assert_eq!(describe_tool("read", &json!({ "filePath": "/w/a.js" }), &p).label, "Reading a.js");
        assert_eq!(describe_tool("bash", &json!({ "command": "npm test", "description": "Run the tests" }), &p).label, "Run the tests");
        assert_eq!(describe_tool("grep", &json!({ "pattern": "add" }), &p).label, "Searching for “add”");
        assert_eq!(describe_tool("wisp_delegate", &json!({ "tasks": [{ "subagent": "a" }, { "subagent": "a" }, { "subagent": "b" }] }), &p).label, "Delegated to a, b");
        assert_eq!(describe_tool("wisp_wisp_save", &json!({ "path": "/x/y/report.md" }), &p).label, "Saving report.md to My Stuff");
        assert_eq!(describe_tool("wisp_wisp_pr", &json!({ "pr": "https://github.com/o/r/pull/1" }), &p).label, "Attaching PR o/r/pull/1");
        assert_eq!(describe_tool("some_tool", &json!({}), &p).label, "Using some tool");
        assert_eq!(describe_tool("edit", &json!({}), &p).file, None);
    }
}
