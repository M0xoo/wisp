//! v1 copilot.js `describeTool`, `describeMcp`, `blockedOf`, `modelIds`, `modelLabel`.

use serde_json::{Value, json};
use wisp_harness_kit::js::{self, truthy};
use wisp_harness_kit::protocol::{crew_tool_label, wisp_tool_label};
use wisp_harness_kit::{HarnessEvent, Re, RunPaths, Tool, ToolKind, clip, clip_value, rel_value};

static MODEL_KEY: Re = Re::new(r"(?m)^[ \t]*`model`:");
static MODEL_LINE: Re = Re::new(r#"^\s+- "([\w.\-/:]+)"\s*$"#);

fn t(kind: ToolKind, label: impl Into<String>) -> Tool {
    Tool::new(kind, label)
}

pub fn describe_tool(name: &str, a: &Value, paths: &RunPaths) -> Tool {
    let f = rel_value(&a["path"], paths);
    match name {
        // v1 asked the disk whether it was a folder; a trailing slash is all a parser can see
        "view" if js::str(&a["path"]).ends_with('/') => t(ToolKind::Search, format!("Listing {}", if f.is_empty() { "." } else { &f })),
        "view" => t(ToolKind::Read, format!("Reading {f}")).file(f),
        "create" => t(ToolKind::Edit, format!("Writing {f}")).file(f),
        "edit" => t(ToolKind::Edit, format!("Editing {f}")).file(f),
        "bash" | "powershell" => {
            let said = if truthy(&a["description"]) { Some(js::string(&a["description"])) } else { None };
            let (label, title) = wisp_harness_kit::run_label(&js::str(&a["command"]), paths, said.as_deref());
            let mut x = t(ToolKind::Run, label);
            x.title = title; // the whole one, when the label was cut (v1 #780)
            if !a["command"].is_null() {
                x.detail = Some(js::string(&a["command"]));
            }
            x
        }
        "read_bash" | "read_powershell" => t(ToolKind::Run, "Reading command output"),
        "write_bash" | "write_powershell" => t(ToolKind::Run, "Typing into a running command"),
        "stop_bash" | "stop_powershell" => t(ToolKind::Run, "Stopping a command"),
        "list_bash" | "list_powershell" => t(ToolKind::Run, "Checking running commands"),
        "grep" => t(ToolKind::Search, format!("Searching for “{}”", clip_value(&a["pattern"], 40))),
        "glob" => t(ToolKind::Search, format!("Finding {}", clip_value(&a["pattern"], 50))),
        "search_code_subagent" => t(ToolKind::Search, if truthy(&a["query"]) { format!("Searching the codebase: {}", clip_value(&a["query"], 50)) } else { "Searching the codebase".into() }),
        "web_fetch" => t(ToolKind::Web, format!("Reading {}", clip_value(&a["url"], 60))),
        "web_search" => t(ToolKind::Web, format!("Searching the web: {}", clip_value(&a["query"], 50))),
        "task" => t(ToolKind::Agent, format!("Delegating: {}", clip_value(js::or(&a["description"], &a["prompt"]), 60))),
        "read_agent" | "list_agents" | "write_agent" => t(ToolKind::Agent, "Checking on its subagents"),
        "skill" => t(ToolKind::Tool, "Using a skill"),
        _ => t(ToolKind::Tool, if name.is_empty() { "Using a tool".into() } else { format!("Using {}", name.replace('_', " ")) }),
    }
}

pub fn describe_mcp(server: &str, tool: &str, input: &Value) -> Tool {
    if server != "wisp" {
        return Tool::new(ToolKind::Tool, format!("Using {server} · {}", tool.replacen(&format!("{server}-"), "", 1)));
    }
    let bare = tool.strip_prefix("wisp-").unwrap_or(tool);
    match bare {
        "ask_user" => Tool::new(ToolKind::Wait, "Waiting for your answer"),
        "delegate" => {
            let mut who: Vec<String> = Vec::new();
            for x in js::arr(&input["tasks"]) {
                let n = if x["subagent"].is_null() { String::new() } else { js::string(&x["subagent"]) };
                if !who.contains(&n) {
                    who.push(n);
                }
            }
            let who = who.join(", ");
            Tool::new(ToolKind::Agent, format!("Delegating to {}", clip(if who.is_empty() { "subagents" } else { &who }, 60)))
        }
        "subagent_results" => Tool::new(ToolKind::Agent, "Waiting on subagents"),
        _ => wisp_tool_label(bare, input).or_else(|| crew_tool_label(tool, input)).unwrap_or_else(|| Tool::new(ToolKind::Tool, format!("Using wisp · {tool}"))),
    }
}

/// What a refused permission request was for, with the `--allow-tool` rules that allow exactly it.
pub fn blocked_of(ask: &Value, paths: &RunPaths) -> HarnessEvent {
    let (tool, detail, rule): (String, String, Option<Value>) = match js::str_ref(&ask["kind"]) {
        "shell" => {
            let ids: Vec<String> = js::arr(&ask["commands"]).iter().filter_map(|c| c.as_str().map(str::to_owned).or_else(|| c["identifier"].as_str().map(str::to_owned))).filter(|s| !s.is_empty()).collect();
            let detail = if ask["fullCommandText"].is_null() { ids.join(" && ") } else { js::string(&ask["fullCommandText"]) };
            let rule = (!ids.is_empty()).then(|| json!(ids.iter().map(|c| format!("shell({c})")).collect::<Vec<_>>()));
            ("shell".into(), detail, rule)
        }
        "write" => ("write".into(), rel_value(&ask["fileName"], paths), truthy(&ask["fileName"]).then(|| json!([format!("write({})", js::string(&ask["fileName"]))]))),
        "url" => ("url".into(), js::str(&ask["url"]), truthy(&ask["url"]).then(|| json!([format!("url({})", js::string(&ask["url"]))]))),
        "mcp" => {
            let server = if truthy(&ask["serverName"]) { js::string(&ask["serverName"]) } else { "mcp".into() };
            let rule = (truthy(&ask["serverName"]) && truthy(&ask["toolName"])).then(|| json!([format!("{}({})", js::string(&ask["serverName"]), js::string(&ask["toolName"]))]));
            (server, js::str(&ask["toolName"]), rule)
        }
        other => {
            let p = rel_value(&ask["path"], paths);
            (if other.is_empty() { "tool".into() } else { other.to_owned() }, if p.is_empty() { js::str(&ask["toolName"]) } else { p }, None)
        }
    };
    HarnessEvent::Blocked { tool, detail, rule }
}

/// `copilot help config` lists the models it accepts under `model`: `    - "id"` lines.
pub fn model_ids(text: &str) -> Vec<String> {
    let Some(at) = MODEL_KEY.search(text) else { return Vec::new() };
    text[at..].split('\n').skip(1).map_while(|l| MODEL_LINE.group(l, 1).map(str::to_owned)).collect()
}

/// claude-opus-5.5 → Claude Opus 5.5, gpt-6.1-sol → GPT-6.1 Sol, mai-code-1.1-flash → MAI Code 1.1 Flash.
pub fn model_label(id: &str) -> String {
    let words: Vec<String> = id
        .split('-')
        .map(|w| {
            if w == "gpt" || w == "mai" {
                w.to_uppercase()
            } else {
                let mut c = w.chars();
                c.next().map_or_else(String::new, |f| f.to_uppercase().chain(c).collect())
            }
        })
        .collect();
    let s = words.join(" ");
    match s.strip_prefix("GPT ") {
        Some(rest) if rest.starts_with(|c: char| c.is_ascii_digit()) => format!("GPT-{rest}"),
        _ => s,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_and_models() {
        assert!(MODEL_KEY.compiles() && MODEL_LINE.compiles());
        assert_eq!(model_label("claude-opus-5.5"), "Claude Opus 5.5");
        assert_eq!(model_label("gpt-6.1-sol"), "GPT-6.1 Sol");
        assert_eq!(model_label("mai-code-1.1-flash"), "MAI Code 1.1 Flash");
        let help = "Settings:\n  `model`: the model\n    - \"claude-opus-5.5\"\n    - \"gpt-6.1\"\n\n  `theme`: x\n";
        assert_eq!(model_ids(help), ["claude-opus-5.5", "gpt-6.1"]);
        assert_eq!(describe_mcp("wisp", "wisp-wisp_tag", &json!({ "tags": ["a"] })).label, "Tagging the task: #a");
        assert_eq!(describe_mcp("gh", "gh-search", &json!({})).label, "Using gh · search");
    }

    #[test]
    fn a_refusal_names_the_rule_that_allows_it() {
        let p = RunPaths::same("/w");
        let HarnessEvent::Blocked { rule, detail, .. } = blocked_of(&json!({ "kind": "shell", "fullCommandText": "npm publish", "commands": [{ "identifier": "npm publish" }] }), &p) else { panic!() };
        assert_eq!((detail.as_str(), rule), ("npm publish", Some(json!(["shell(npm publish)"]))));
        let HarnessEvent::Blocked { rule, .. } = blocked_of(&json!({ "kind": "write", "fileName": "/etc/x" }), &p) else { panic!() };
        assert_eq!(rule, Some(json!(["write(/etc/x)"])));
    }
}
