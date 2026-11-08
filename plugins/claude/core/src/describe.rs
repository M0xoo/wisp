//! What a Claude Code tool call is, in words: the live ticker's sentence and a coarse kind for the
//! trail (`describe_tool`), a permission prompt's subject (`action_of`), the exact thing allowed
//! (`detail_of`), the --allowedTools rule for a retry (`rule_of`), and the diff an edit's input holds.

use serde_json::Value;
use wisp_harness_kit::js::{self, or, str, string, truthy};
use wisp_harness_kit::protocol::crew_tool_label;
use wisp_harness_kit::{
    Change, Edit, HarnessEvent, IoStep, Out, Re, RunPaths, Tool, ToolKind, clip, clip_value,
    describe_command, rel, rel_value,
};

static GITHUB: Re = Re::new(r"^https://github\.com/");
static SLASH: Re = Re::new(r"[\\/]");

fn file_of(input: &Value, paths: &RunPaths) -> String {
    rel_value(
        or(
            or(&input["file_path"], &input["notebook_path"]),
            &input["path"],
        ),
        paths,
    )
}

/// `String(v ?? '')`
fn string_or_empty(v: &Value) -> String {
    if v.is_null() {
        String::new()
    } else {
        string(v)
    }
}

fn mcp_name(name: &str) -> String {
    name.split("__").skip(1).collect::<Vec<_>>().join(" · ")
}

/// wisp's own MCP tools, by full name.
fn wisp_tool(name: &str, input: &Value) -> Option<Tool> {
    let t = |label: String| Some(Tool::new(ToolKind::Tool, label));
    match name {
        "mcp__wisp__ask_user" => Some(Tool::new(ToolKind::Wait, "Waiting for your answer")),
        "mcp__wisp__delegate" => {
            // [...new Set(tasks.map((t) => t.subagent))].join(', ')
            let mut who: Vec<&Value> = Vec::new();
            for task in js::arr(&input["tasks"]) {
                let s = if task.is_object() {
                    &task["subagent"]
                } else {
                    &Value::Null
                };
                if !who.contains(&s) {
                    who.push(s);
                }
            }
            let names = who
                .iter()
                .map(|v| string_or_empty(v))
                .collect::<Vec<_>>()
                .join(", ");
            Some(Tool::new(
                ToolKind::Agent,
                format!(
                    "Delegating to {}",
                    clip(
                        if names.is_empty() {
                            "subagents"
                        } else {
                            &names
                        },
                        60
                    )
                ),
            ))
        }
        "mcp__wisp__subagent_results" => Some(Tool::new(ToolKind::Agent, "Waiting on subagents")),
        "mcp__wisp__resume_later" => t(if truthy(&input["cancel"]) {
            "Cancelling a scheduled follow-up".into()
        } else if truthy(&input["minutes"]) {
            format!("Scheduling a follow-up in {} min", str(&input["minutes"]))
        } else {
            "Scheduling a follow-up".into()
        }),
        "mcp__wisp__wisp_tag" => {
            let tags = js::arr(&input["tags"]);
            let list = tags
                .iter()
                .map(|x| format!("#{}", str(x)))
                .collect::<Vec<_>>()
                .join(" ");
            t(if tags.is_empty() {
                "Tagging the task".into()
            } else {
                format!("Tagging the task: {}", clip(&list, 60))
            })
        }
        _ => wisp_store_tool(name, input),
    }
}

/// wisp's MCP tools for the task's PR, My Stuff and wisp's own records.
fn wisp_store_tool(name: &str, input: &Value) -> Option<Tool> {
    let t = |label: String| Some(Tool::new(ToolKind::Tool, label));
    match name {
        "mcp__wisp__wisp_pr" => t(if truthy(&input["remove"]) {
            "Detaching a PR".into()
        } else {
            let pr = if truthy(&input["pr"]) {
                string(&input["pr"])
            } else {
                String::new()
            };
            format!("Attaching PR {}", clip(&GITHUB.replace(&pr, ""), 60))
        }),
        "mcp__wisp__wisp_save" => {
            let named = or(&input["title"], &input["name"]);
            let what = if truthy(named) {
                string(named)
            } else {
                let src = or(or(&input["app"], &input["path"]), &input["url"]);
                let src = if truthy(src) {
                    string(src)
                } else {
                    String::new()
                };
                let last = SLASH.split(&src).last().copied().unwrap_or("").to_owned();
                if last.is_empty() { "it".into() } else { last }
            };
            let id = truthy(&input["id"]);
            t(format!(
                "{} {} {} My Stuff",
                if id { "Updating" } else { "Saving" },
                clip(&what, 50),
                if id { "in" } else { "to" }
            ))
        }
        "mcp__wisp__wisp_stuff" => t("Looking in My Stuff".into()),
        "mcp__wisp__wisp_blocks" => t("Reading block formats".into()),
        "mcp__wisp__wisp_stats" => t("Reading wisp stats".into()),
        "mcp__wisp__wisp_sessions" => t("Listing wisp tasks".into()),
        "mcp__wisp__wisp_session" => t(format!(
            "Reading wisp task {}",
            clip_value(
                if truthy(&input["id"]) {
                    &input["id"]
                } else {
                    &Value::Null
                },
                40
            )
        )),
        _ => None,
    }
}

fn on_file(kind: ToolKind, verb: &str, f: String) -> Tool {
    Tool::new(kind, format!("{verb} {f}")).file(f)
}

/// Human sentence for the live ticker + a coarse kind for the trail summary.
pub fn describe_tool(name: &str, input: &Value, paths: &RunPaths) -> Tool {
    match name {
        "Read" => on_file(ToolKind::Read, "Reading", file_of(input, paths)),
        "Edit" | "MultiEdit" => on_file(ToolKind::Edit, "Editing", file_of(input, paths)),
        "Write" => on_file(ToolKind::Edit, "Writing", file_of(input, paths)),
        "NotebookEdit" => on_file(ToolKind::Edit, "Editing notebook", file_of(input, paths)),
        "Bash" => {
            let cmd = &input["command"];
            let label = if truthy(&input["description"]) {
                clip_value(&input["description"], 80)
            } else {
                describe_command(&str(cmd), paths)
            };
            let mut t = Tool::new(ToolKind::Run, label);
            // v1 passed `input.command` as it came; JSON drops it when missing.
            t.detail = match cmd {
                Value::Null => None,
                Value::String(s) => Some(s.clone()),
                other => Some(other.to_string()),
            };
            t
        }
        "Grep" => Tool::new(
            ToolKind::Search,
            format!("Searching for “{}”", clip_value(&input["pattern"], 40)),
        ),
        "Glob" => Tool::new(
            ToolKind::Search,
            format!("Finding {}", clip_value(&input["pattern"], 50)),
        ),
        "WebSearch" => Tool::new(
            ToolKind::Web,
            format!("Searching the web: {}", clip_value(&input["query"], 50)),
        ),
        "WebFetch" => Tool::new(
            ToolKind::Web,
            format!("Reading {}", clip_value(&input["url"], 60)),
        ),
        "Task" | "Agent" => Tool::new(
            ToolKind::Agent,
            format!(
                "Delegating: {}",
                clip_value(or(&input["description"], &input["prompt"]), 60)
            ),
        ),
        "TodoWrite" => {
            let active = js::arr(&input["todos"])
                .iter()
                .find(|t| t["status"].as_str() == Some("in_progress"));
            Tool::new(
                ToolKind::Plan,
                active.map_or_else(
                    || "Planning".into(),
                    |a| clip_value(or(&a["activeForm"], &a["content"]), 80),
                ),
            )
        }
        // the name is how a shared task finds the skills it used
        "Skill" => Tool::new(
            ToolKind::Tool,
            if truthy(&input["skill"]) {
                format!("Using the {} skill", clip(&string(&input["skill"]), 64))
            } else {
                "Using a skill".into()
            },
        ),
        _ => wisp_tool(name, input)
            .or_else(|| crew_tool_label(name.strip_prefix("mcp__wisp__").unwrap_or(name), input))
            .unwrap_or_else(|| {
                Tool::new(
                    ToolKind::Tool,
                    if name.starts_with("mcp__") {
                        format!("Using {}", mcp_name(name))
                    } else {
                        format!("Using {name}")
                    },
                )
            }),
    }
}

/// A permission prompt's subject: "run `npm publish`", "edit src/a.ts", "fetch https://…".
pub fn action_of(name: &str, input: &Value, paths: &RunPaths) -> String {
    let f = file_of(input, paths);
    match name {
        "Bash" => format!("run `{}`", clip_value(&input["command"], 200)),
        "Edit" | "MultiEdit" | "NotebookEdit" if !f.is_empty() => format!("edit {f}"),
        "Write" if !f.is_empty() => format!("write {f}"),
        "WebFetch" => format!("fetch {}", clip_value(&input["url"], 120)),
        "WebSearch" => format!("search the web for “{}”", clip_value(&input["query"], 80)),
        "ExitPlanMode" => "leave plan mode and start making changes".into(),
        _ if name.starts_with("mcp__") => format!("use {}", mcp_name(name)),
        _ => format!("use {name}"),
    }
}

/// The exact thing being allowed, so "always allow" matches only the same command or file.
pub fn detail_of(name: &str, input: &Value, paths: &RunPaths) -> String {
    if name == "Bash" {
        return string_or_empty(&input["command"]);
    }
    let f = or(
        or(&input["file_path"], &input["notebook_path"]),
        &input["path"],
    );
    if truthy(f) {
        return rel(&string(f), paths);
    }
    // String(input.url ?? input.query ?? input.pattern ?? '')
    string_or_empty(
        [&input["url"], &input["query"], &input["pattern"]]
            .into_iter()
            .find(|v| !v.is_null())
            .unwrap_or(&Value::Null),
    )
}

/// An --allowedTools rule for a retry: the exact command for Bash, the tool for the rest.
pub fn rule_of(name: &str, input: &Value) -> String {
    if name == "Bash" && truthy(&input["command"]) {
        format!("Bash({})", string(&input["command"]))
    } else {
        name.to_owned()
    }
}

/// The diff an edit's input already holds, so wisp shows real diffs without asking the agent. A Write
/// needs the file as it is now (tool_use streams before the tool runs): an IO step (edge case 6).
pub fn capture_change(name: &str, input: &Value, paths: &RunPaths) -> Option<Out> {
    let file = input["file_path"].as_str().filter(|s| !s.is_empty())?;
    let r = rel(file, paths);
    let edit = |e: &Value| Edit {
        before: str(&e["old_string"]),
        after: str(&e["new_string"]),
    };
    let change = |edits| {
        Out::Event(HarnessEvent::Change(Change {
            file: r.clone(),
            op: "edit".into(),
            edits,
            early: Some(true),
            before_file: None,
        }))
    };
    match name {
        "Edit" => Some(change(vec![edit(input)])),
        "MultiEdit" => Some(change(
            js::arr(&input["edits"])
                .iter()
                .map(|e| {
                    if e.is_object() {
                        edit(e)
                    } else {
                        edit(&Value::Null)
                    }
                })
                .collect(),
        )),
        "Write" => Some(Out::Io(IoStep::WriteBefore {
            abs: wisp_harness_kit::paths::resolve(&paths.cwd, file),
            file: r,
            after: string_or_empty(&input["content"]),
        })),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn p() -> RunPaths {
        RunPaths::new("/w", "/private/w")
    }

    #[test]
    fn patterns_compile() {
        assert!(GITHUB.compiles() && SLASH.compiles());
    }

    #[test]
    fn labels() {
        let d = |n: &str, i: Value| describe_tool(n, &i, &p()).label;
        assert_eq!(
            d(
                "Bash",
                json!({"command": "x", "description": "Run  the\ntests"})
            ),
            "Run the tests"
        );
        assert_eq!(
            d("Bash", json!({"command": "curl -s https://example.com"})),
            "Fetching example.com"
        );
        assert_eq!(
            d("mcp__github__get_issue", json!({})),
            "Using github · get_issue"
        );
        assert_eq!(
            d("mcp__wisp__wisp_crew_add", json!({"member": "Ada"})),
            "Adding Ada to your crew"
        );
        assert_eq!(
            d(
                "mcp__wisp__delegate",
                json!({"tasks": [{"subagent": "a"}, {"subagent": "b"}, {"subagent": "a"}]})
            ),
            "Delegating to a, b"
        );
        assert_eq!(
            d("mcp__wisp__wisp_save", json!({"path": "/x/y/report.md"})),
            "Saving report.md to My Stuff"
        );
        assert_eq!(
            d(
                "mcp__wisp__wisp_pr",
                json!({"pr": "https://github.com/o/r/pull/1"})
            ),
            "Attaching PR o/r/pull/1"
        );
        assert_eq!(
            d(
                "TodoWrite",
                json!({"todos": [{"status": "in_progress", "content": "Fix it"}]})
            ),
            "Fix it"
        );
    }

    #[test]
    fn edge_7_both_spellings_of_the_folder() {
        assert_eq!(
            describe_tool("Read", &json!({"file_path": "/private/w/a.js"}), &p())
                .file
                .as_deref(),
            Some("a.js")
        );
        assert_eq!(
            describe_tool("Read", &json!({"file_path": "/w/a.js"}), &p())
                .file
                .as_deref(),
            Some("a.js")
        );
    }

    #[test]
    fn rules_and_details() {
        assert_eq!(
            rule_of("Bash", &json!({"command": "npm publish"})),
            "Bash(npm publish)"
        );
        assert_eq!(rule_of("WebFetch", &json!({})), "WebFetch");
        assert_eq!(
            detail_of("Edit", &json!({"file_path": "/w/src/a.ts"}), &p()),
            "src/a.ts"
        );
        assert_eq!(
            action_of("Write", &json!({"file_path": "/w/a"}), &p()),
            "write a"
        );
        assert_eq!(
            action_of("Bash", &json!({"command": "ls"}), &p()),
            "run `ls`"
        );
    }

    #[test]
    fn edge_6_write_reads_the_file_before_the_cli_does() {
        let step = capture_change(
            "Write",
            &json!({"file_path": "a.txt", "content": "new"}),
            &p(),
        );
        assert_eq!(
            step,
            Some(Out::Io(IoStep::WriteBefore {
                abs: "/w/a.txt".into(),
                file: "a.txt".into(),
                after: "new".into()
            }))
        );
    }
}
