//! The crew MCP tools (v1 server/crew-tools.js): their definitions, what an agent may set on a member,
//! and how a member reads back to it. Agents read these shapes: they have goldens.

use serde_json::{Map, Value, json};
use wisp_crew_api::MemberView;

fn member_props() -> Map<String, Value> {
    let v = json!({
        "name": { "type": "string", "description": "Up to 24 letters, digits, spaces, dots, dashes or underscores; unique. The user tags them as @Name." },
        "role": { "type": "string", "description": "A few words, e.g. \"CI watcher\", \"Docs writer\"." },
        "brief": { "type": "string", "description": "Their standing job and how the user likes it done, written to them (\"Watch CI on main; when a run fails, find why and…\"). Every job they run reads it." },
        "cwd": { "type": "string", "description": "Absolute path of the folder they work in. Default when adding: the current project. \"\" = no folder." },
        "agent": { "type": "string", "description": "Harness: auto, claude, codex, opencode, cursor, antigravity, grok or copilot. Default auto." },
        "model": { "type": "string", "description": "Model id for that harness; \"\" for its default." },
        "effort": { "type": "string", "description": "Thinking level, e.g. low | medium | high; \"\" for the default." },
        "mode": { "type": "string", "enum": ["plan", "edits", "auto"], "description": "plan = read-only, edits = auto-accept edits, auto = no permission prompts. Default auto." },
        "cron": { "type": "string", "description": "When they check in on their own, in words (\"every monday\", \"8am every weekday\", \"every 30 min\") or a 5-field cron, local time. \"\" = only when given work." },
        "parallel": { "type": "integer", "minimum": 1, "maximum": 5, "description": "Jobs at once; more wait in their queue. Default 2." },
        "paused": { "type": "boolean", "description": "Paused members skip check-ins; work for them waits." },
        "avatar": { "type": "string", "description": "An emoji. Default: one rolled from the name." }
    });
    v.as_object().cloned().unwrap_or_default()
}

fn notebook_props() -> Map<String, Value> {
    let v = json!({
        "notebook": { "type": "string", "description": "Their whole notebook rewritten (markdown): lasting facts and the state they compare against next time. \"\" empties it. To add a few lines, use remember." },
        "remember": { "type": "array", "items": { "type": "string" }, "maxItems": 12, "description": "Lines to add to the end of their notebook, e.g. a preference of the user's for this job." }
    });
    v.as_object().cloned().unwrap_or_default()
}

/// The fields the tools may set (the rest is the member's memory and wisp's bookkeeping).
pub const CREW_FIELDS: [&str; 12] =
    ["name", "role", "brief", "cwd", "agent", "model", "effort", "mode", "cron", "parallel", "paused", "avatar"];

fn with(mut a: Map<String, Value>, b: Map<String, Value>) -> Value {
    a.extend(b);
    Value::Object(a)
}

/// `wisp_crew`, `wisp_crew_add`, `wisp_crew_edit`, `wisp_crew_kit`, `wisp_crew_remove`.
pub fn crew_tools() -> Value {
    let member =
        json!({ "member": { "type": "string", "description": "Their name, @handle or id." } }).as_object().cloned().unwrap_or_default();
    let add_extra = json!({
        "checkin": { "type": "boolean", "description": "Start their first check-in right away. Default false." },
        "from": { "type": "string", "description": "Instead of the fields above: members someone shared, as a link to a .crew.json file (https, or gist:<id>) or its JSON. They join paused, in cwd (default: the current project), until the user resumes them." }
    });
    let mut edit = member.clone();
    edit.extend(member_props());
    edit.extend(notebook_props());
    json!([
        {
            "name": "wisp_crew",
            "description": "List the user's crew in wisp: their long-lived agents, each with a name, role, brief, folder, harness, schedule and jobs. Read-only. Use it before changing a member, or when the user asks who is on their crew. With `member`: that one in full, their whole brief, notebook and kit (skills and instructions files, with their text), to read before you change their notebook or propose kit files.",
            "inputSchema": { "type": "object", "properties": { "member": { "type": "string", "description": "Their name, @handle or id: read that member in full." } } }
        },
        {
            "name": "wisp_crew_add",
            "description": "Add a member to the user's crew in wisp, when the user asks for one (\"add a crew member who watches CI\"), or when you need help for a job and the user's brief lets you hire it. They work as tasks: on their schedule (cron), when the user tags @Name in a prompt, or when another task delegates to them. Write the brief to them, from what the user asked. Pick a short, friendly name if the user gave none. Returns the new member. When the user gives a shared crew file or link (\"add the member from gist:abc123\"), pass it as `from` instead.",
            "inputSchema": { "type": "object", "properties": with(member_props(), add_extra.as_object().cloned().unwrap_or_default()) }
        },
        {
            "name": "wisp_crew_edit",
            "description": "Change a member of the user's crew in wisp (rename, new brief, schedule, folder, harness, pause, notebook…) when the user asks. Only the fields given change. Their skills and instructions files aren't set here: propose those with wisp_crew_kit.",
            "inputSchema": { "type": "object", "properties": Value::Object(edit), "required": ["member"] }
        },
        {
            "name": "wisp_crew_kit",
            "description": "Propose skills or instructions files for a crew member's kit, when the user asks you to give them, write or improve one (\"give Gucci a skill for UI reviews\"). A skill is a how-to for one kind of work, read when a job fits its description; an instructions file (rules, e.g. AGENTS.md) is followed on every job. Nothing changes yet: wisp shows the files under your answer, and the user reads them and picks what to add. The same name as one they have replaces it. Read the member with wisp_crew { member } first. Write each file for them: concrete steps, checklists, commands and paths, not generic advice.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "member": { "type": "string", "description": "Their name, @handle or id." },
                    "files": {
                        "type": "array", "minItems": 1, "maxItems": 12, "description": "The files to propose.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "kind": { "type": "string", "enum": ["skill", "rules"], "description": "skill, or rules for an instructions file." },
                                "name": { "type": "string", "description": "A skill: lowercase-with-dashes, up to 64. An instructions file: its file name, e.g. AGENTS.md." },
                                "description": { "type": "string", "description": "A skill only: exactly when to use it. That is how they know to read it." },
                                "body": { "type": "string", "description": "The markdown: the skill's steps, or the instructions." }
                            },
                            "required": ["kind", "name", "body"]
                        }
                    }
                },
                "required": ["member", "files"]
            }
        },
        {
            "name": "wisp_crew_remove",
            "description": "Remove a member from the user's crew in wisp. Their brief, notebook and schedule are deleted; their jobs stay as ordinary tasks. Only when the user asked to remove that member, or a member you added for a job is done; if unsure who they meant, ask the user first. A crew member's job can't remove that member itself.",
            "inputSchema": { "type": "object", "properties": with(member, Map::new()), "required": ["member"] }
        }
    ])
}

fn clip_ellipsis(s: &str, n: usize) -> String {
    if s.chars().count() > n { format!("{}…", s.chars().take(n - 1).collect::<String>()) } else { s.to_owned() }
}

/// A member in one markdown item (v1 `memberLine`).
pub fn member_line(v: &MemberView) -> String {
    let m = &v.member;
    let role = if m.role.is_empty() { String::new() } else { format!(" — {}", m.role) };
    let mut parts = vec![
        format!("{}{}", m.agent, if m.model.is_empty() { String::new() } else { format!(" ({})", m.model) }),
        format!("{} mode", m.mode),
    ];
    parts.push(if !m.machine.is_empty() {
        format!("on machine {}", m.machine)
    } else if !m.cwd.is_empty() {
        format!("in {}", m.cwd)
    } else {
        "no folder".into()
    });
    parts.push(if m.cron.is_empty() { "no schedule".into() } else { format!("checks in on `{}`", m.cron) });
    if m.paused {
        parts.push("paused".into());
    }
    if v.running > 0 {
        parts.push(format!("{} job{} running", v.running, if v.running == 1 { "" } else { "s" }));
    }
    if !m.queue.is_empty() {
        parts.push(format!("{} waiting", m.queue.len()));
    }
    let brief =
        if m.brief.is_empty() { String::new() } else { format!("\n  Brief: {}", clip_ellipsis(&crate::text::squash(&m.brief), 200)) };
    format!("- **{}** (@{}, id `{}`){role} · {}{brief}", m.name, v.handle, m.id, parts.join(" · "))
}

/// A member in full, for `wisp_crew { member }` (v1 `memberDetail`).
pub fn member_detail(v: &MemberView) -> String {
    let m = &v.member;
    let mut head = v.clone();
    head.member.brief = String::new();
    let notebook =
        if m.notebook.is_empty() { "(empty)".to_owned() } else { format!("{}\n\n({} characters)", m.notebook, m.notebook.chars().count()) };
    let kit = if m.kit.is_empty() {
        "No skills or instructions files yet. Propose some with wisp_crew_kit.".to_owned()
    } else {
        let files: Vec<String> = m
            .kit
            .iter()
            .map(|k| {
                let what = if k.kind == "skill" { "Skill" } else { "Instructions" };
                let when =
                    if k.kind == "skill" { format!("When: {}\n\n", k.description.clone().unwrap_or_default()) } else { String::new() };
                format!("### {what}: {}{}\n\n{when}{}", k.name, if k.on { "" } else { " (off)" }, k.body)
            })
            .collect();
        files.join("\n\n")
    };
    let brief = if m.brief.is_empty() { "(none)" } else { m.brief.as_str() };
    [member_line(&head), format!("\n## Brief\n\n{brief}"), format!("\n## Notebook\n\n{notebook}"), format!("\n## Kit\n\n{kit}")].join("\n")
}
