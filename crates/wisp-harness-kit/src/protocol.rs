//! What every harness says the same way: attachments in the prompt, wisp's protocol for CLIs with no
//! system-prompt flag, the result text of a CLI that died, wisp's own MCP tools' labels, and the
//! `change` a Write's input holds (v1 `adapters/common.js`).

use serde_json::Value;

use crate::event::{Change, Edit, HarnessEvent, Tool, ToolKind};
use crate::js;
use crate::paths::MAX_SNAPSHOT;
use crate::text::clip;

/// `ask_user` may wait for the human a long time.
pub const ASK_TIMEOUT_MS: u64 = 7 * 24 * 3600 * 1000;

/// The result text for a CLI that ended without saying why: "claude exited with code 1" / "with SIGTERM".
pub fn exit_text(bin: &str, code: Option<i32>, signal: Option<&str>) -> String {
    match signal.filter(|s| !s.is_empty()) {
        Some(s) => format!("{bin} exited with {s}"),
        None => format!("{bin} exited with code {}", code.map_or_else(|| "null".to_owned(), |c| c.to_string())),
    }
}

/// An attachment with a path on disk: what a harness can be pointed at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileNote {
    pub path: String,
    pub mime: String,
    pub size: u64,
}

/// The note appended to a prompt that names its attachments ('' for none).
pub fn attachment_note(files: &[FileNote], how: Option<&str>) -> String {
    if files.is_empty() {
        return String::new();
    }
    let how = how.unwrap_or("Read images and PDFs with your file-reading tool");
    let lines: Vec<String> = files
        .iter()
        .map(|f| {
            // Math.max(1, Math.round(size / 1024)): round half up, as JavaScript's Math.round does.
            #[allow(clippy::cast_precision_loss, clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let kb = ((f.size as f64 / 1024.0 + 0.5).floor() as u64).max(1);
            format!("- {}  ({}, {kb} KB)", f.path, f.mime)
        })
        .collect();
    format!(
        "\n\n<attachments>\nThe user attached these files. {how}; for video/audio/other formats use the shell (e.g. ffmpeg, ffprobe) if needed.\n{}\n</attachments>",
        lines.join("\n")
    )
}

/// Harnesses without a system-prompt flag get the wisp protocol in front of the first prompt.
/// Follow-ups resume the same session, so the protocol is still in context.
pub fn with_protocol(prompt: &str, system_prompt: &str, resume_id: Option<&str>) -> String {
    if resume_id.is_some_and(|r| !r.is_empty()) {
        prompt.to_owned()
    } else {
        format!("{}\n\n---\n\n# Task\n\n{prompt}", js::trim(system_prompt))
    }
}

/// wisp's own tools that say what they touch (opencode, Copilot): `wisp_tag`, `wisp_pr`, `wisp_save`,
/// `wisp_stuff`, `wisp_blocks`, `wisp_stats`, `wisp_sessions`, `wisp_session`, by bare tool name.
pub fn wisp_tool_label(tool: &str, i: &Value) -> Option<Tool> {
    let t = |label: String| Some(Tool::new(ToolKind::Tool, label));
    match tool {
        "wisp_tag" => {
            let tags = js::arr(&i["tags"]);
            let list = tags.iter().map(|x| format!("#{}", js::string(x))).collect::<Vec<_>>().join(" ");
            t(if tags.is_empty() { "Tagging the task".to_owned() } else { format!("Tagging the task: {}", clip(&list, 60)) })
        }
        "wisp_pr" => {
            if js::truthy(&i["remove"]) {
                return t("Detaching a PR".into());
            }
            let pr = if js::truthy(&i["pr"]) { js::string(&i["pr"]) } else { String::new() };
            t(format!("Attaching PR {}", clip(pr.strip_prefix("https://github.com/").unwrap_or(&pr), 60)))
        }
        "wisp_save" => {
            let id = js::truthy(&i["id"]);
            let named = js::or(&i["title"], &i["name"]);
            let what = if js::truthy(named) {
                js::string(named)
            } else {
                let p = js::or(js::or(&i["app"], &i["path"]), &i["url"]);
                if js::truthy(p) { js::string(p).rsplit(['/', '\\']).next().unwrap_or("").to_owned() } else { String::new() }
            };
            let what = if what.is_empty() { "it".to_owned() } else { what };
            t(format!("{} {} {} My Stuff", if id { "Updating" } else { "Saving" }, clip(&what, 50), if id { "in" } else { "to" }))
        }
        "wisp_stuff" => t("Looking in My Stuff".into()),
        "wisp_blocks" => t("Reading block formats".into()),
        "wisp_stats" => t("Reading wisp stats".into()),
        "wisp_sessions" => t("Listing wisp tasks".into()),
        "wisp_session" => t(format!("Reading wisp task {}", clip(&js::str(&i["id"]), 40))),
        _ => None,
    }
}

/// The crew and connector tools of wisp's MCP server, by bare tool name; None for any other tool.
pub fn crew_tool_label(tool: &str, input: &Value) -> Option<Tool> {
    let who_v = js::or(&input["member"], &input["name"]);
    let who = clip(&js::str(who_v), 40);
    let or = |fallback: &str| {
        if who.is_empty() { fallback.to_owned() } else { who.clone() }
    };
    let t = |label: String| Some(Tool::new(ToolKind::Tool, label));
    match tool {
        "wisp_crew" => {
            t(if who.is_empty() { "Listing your crew".to_owned() } else { format!("Reading {who}’s brief, notebook and kit") })
        }
        "wisp_crew_add" => t(format!("Adding {} to your crew", or("a member"))),
        "wisp_crew_edit" => t(format!("Changing {}", or("a crew member"))),
        "wisp_crew_kit" => t(format!("Writing skills for {}", or("a crew member"))),
        "wisp_crew_remove" => t(format!("Removing {} from your crew", or("a member"))),
        "wisp_connectors" => t("Listing your connectors".to_owned()),
        "wisp_connector_add" => t(format!("Adding {} to your connectors", or("a connector"))),
        "wisp_connector_signin" => Some(Tool::new(ToolKind::Ask, format!("Waiting for you to sign in to {}", or("a connector")))),
        _ => None,
    }
}

/// The early `change` for a Write, once the driver read the file it replaces: `before` is None when
/// it is missing or over `MAX_SNAPSHOT` (a new file as far as the diff goes, as in v1).
pub fn write_change(file: &str, before: Option<&str>, after: &str) -> HarnessEvent {
    HarnessEvent::Change(Change {
        file: file.to_owned(),
        op: if before.is_none() { "create" } else { "write" }.to_owned(),
        edits: vec![Edit { before: before.unwrap_or("").to_owned(), after: js::head16(after, MAX_SNAPSHOT).to_owned() }],
        early: Some(true),
        before_file: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn exit_texts() {
        assert_eq!(exit_text("claude", Some(1), None), "claude exited with code 1");
        assert_eq!(exit_text("codex", None, Some("SIGTERM")), "codex exited with SIGTERM");
        assert_eq!(exit_text("x", None, None), "x exited with code null");
    }

    #[test]
    fn attachments() {
        assert_eq!(attachment_note(&[], None), "");
        let n = attachment_note(&[FileNote { path: "/a.png".into(), mime: "image/png".into(), size: 100 }], None);
        assert!(n.contains("- /a.png  (image/png, 1 KB)"), "{n}");
        let n = attachment_note(&[FileNote { path: "/b".into(), mime: "x".into(), size: 1536 }], Some("Look"));
        assert!(n.contains("(x, 2 KB)") && n.contains("files. Look;"), "{n}");
    }

    #[test]
    fn protocol_only_on_the_first_turn() {
        assert_eq!(with_protocol("p", " sys \n", None), "sys\n\n---\n\n# Task\n\np");
        assert_eq!(with_protocol("p", "sys", Some("r1")), "p");
    }

    #[test]
    fn crew_labels() {
        assert_eq!(crew_tool_label("wisp_crew", &json!({})).map(|t| t.label), Some("Listing your crew".into()));
        assert_eq!(
            crew_tool_label("wisp_crew", &json!({"member": "Ada"})).map(|t| t.label),
            Some("Reading Ada’s brief, notebook and kit".into())
        );
        assert_eq!(
            crew_tool_label("wisp_connector_signin", &json!({"name": "Slack"})).map(|t| (t.kind, t.label)),
            Some((ToolKind::Ask, "Waiting for you to sign in to Slack".into()))
        );
        assert!(crew_tool_label("Read", &json!({})).is_none());
    }
}
