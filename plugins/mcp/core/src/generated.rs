//! MCP tools generated from the catalogue (ADR-0040): one per command the caller may run, named after it
//! (`runtime.create` → `runtime_create`), its input schema made from its argument type. A command marked
//! `uiOnly` is left out, and a generated tool never takes one of wisp's own tools' names.

use serde_json::{Map, Value, json};
use wisp_kernel::CommandInfo;
use wisp_kernel::decl::{ArgSpec, Kind, parse};

/// The tool name of a command id.
pub fn tool_name(id: &str) -> String {
    id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).collect()
}

/// A JSON Schema for a command's arguments.
pub fn schema_of(spec: &ArgSpec) -> Value {
    if spec.none {
        return json!({ "type": "object", "properties": {} });
    }
    if !spec.object {
        return json!({ "type": "object", "properties": { "args": { "description": "the command's arguments, as JSON" } } });
    }
    let mut props = Map::new();
    let mut required = Vec::new();
    for f in &spec.fields {
        let mut p = match &f.kind {
            Kind::Str => json!({ "type": "string" }),
            Kind::Num => json!({ "type": "number" }),
            Kind::Bool => json!({ "type": "boolean" }),
            Kind::List => json!({ "type": "array", "items": { "type": "string" } }),
            Kind::Choice(c) => json!({ "type": "string", "enum": c }),
            Kind::Json => json!({}),
        };
        if !f.doc.is_empty() {
            p["description"] = json!(f.doc);
        }
        if !f.optional {
            required.push(json!(f.name));
        }
        props.insert(f.name.clone(), p);
    }
    let mut s = json!({ "type": "object", "properties": props });
    if !required.is_empty() {
        s["required"] = Value::Array(required);
    }
    s
}

/// (tool name, command id, read only, the tool as `tools/list` shows it) for each command of `catalogue`
/// that's for MCP, skipping names in `taken`.
pub fn tools(catalogue: &[CommandInfo], taken: &[&str]) -> Vec<(String, String, bool, Value)> {
    catalogue
        .iter()
        .filter(|c| c.ui_only.is_none())
        .filter_map(|c| {
            let name = tool_name(&c.id);
            if taken.contains(&name.as_str()) {
                return None;
            }
            let spec = parse(c.args.as_deref());
            let mut desc = c.title.clone().unwrap_or_else(|| c.id.clone());
            if !spec.doc.is_empty() {
                desc = format!("{desc}. {}", spec.doc);
            }
            let tool = json!({ "name": name, "description": format!("{desc} (wisp command {})", c.id), "inputSchema": schema_of(&spec), "annotations": { "readOnlyHint": c.read_only } });
            Some((name, c.id.clone(), c.read_only, tool))
        })
        .collect()
}

/// A tool call's arguments as the command's: the object as it is, or `args` for a non-object type.
pub fn args_of(spec_object: bool, input: &Value) -> Value {
    if spec_object { input.clone() } else { input.get("args").cloned().unwrap_or(Value::Null) }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn cmd(id: &str, args: Option<&str>, ui: Option<&str>) -> CommandInfo {
        CommandInfo { id: id.into(), plugin: "p".into(), title: Some(format!("Do {id}")), read_only: false, permission: "x:y".into(), args: args.map(str::to_owned), ui_only: ui.map(str::to_owned) }
    }

    #[test]
    fn the_input_schema_follows_the_args_type() {
        let c = cmd("history.track", Some("/** Track a task */ { \n/** the task */ id: string, level?: \"full\" | \"report\" | \"spec\", n?: number, quiet?: boolean, tags?: Array<string>, extra?: Foo, }"), None);
        let t = &tools(&[c], &[])[0];
        assert_eq!(t.0, "history_track");
        let s = &t.3["inputSchema"];
        assert_eq!(s["required"], json!(["id"]));
        assert_eq!(s["properties"]["id"], json!({ "type": "string", "description": "the task" }));
        assert_eq!(s["properties"]["level"]["enum"], json!(["full", "report", "spec"]));
        assert_eq!((s["properties"]["n"]["type"].clone(), s["properties"]["quiet"]["type"].clone(), s["properties"]["tags"]["type"].clone()), (json!("number"), json!("boolean"), json!("array")));
        assert!(t.3["description"].as_str().unwrap().contains("wisp command history.track"));
    }

    #[test]
    fn ui_only_commands_are_left_out_and_hand_made_names_kept() {
        let all = [cmd("a.b", None, None), cmd("c.d", None, Some("a drag on the canvas")), cmd("ask.user", None, None)];
        let names: Vec<String> = tools(&all, &["ask_user"]).into_iter().map(|t| t.0).collect();
        assert_eq!(names, ["a_b"], "ui-only out; ask_user stays the hand-made one");
        assert_eq!(args_of(false, &json!({ "args": [1] })), json!([1]));
    }
}
