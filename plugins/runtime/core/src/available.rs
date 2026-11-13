//! `wisp_available` in words (v1 routes/control.js `GET /internal/available/:id`): everything a task's agent can
//! pick from, in one read. Pure: the host gathers the harnesses, machines, projects, saved teams and crew.

/// A harness on this computer (`runtime.agents`).
#[derive(Debug, Clone, Default)]
pub struct Harness {
    pub id: String,
    pub name: String,
    pub available: bool,
    pub signed_in: Option<bool>,
    pub version: Option<String>,
    pub models: Vec<String>,
    pub efforts: Vec<String>,
}

/// One of the user's machines (`machines.list`, sandboxes left out).
#[derive(Debug, Clone, Default)]
pub struct Machine {
    pub id: String,
    pub name: String,
    pub cloud: bool,
    /// 'online', 'asleep', or another state as the machines plugin names it
    pub state: String,
    pub harnesses: Vec<String>,
}

/// What the asking task is.
#[derive(Debug, Clone, Default)]
pub struct This {
    pub id: String,
    pub agent: String,
    pub model: String,
    pub mode: String,
    pub cwd: String,
    pub subagents: Vec<String>,
    /// the mode cap a channel started it with
    pub cap: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct Available {
    pub harnesses: Vec<Harness>,
    pub machines: Vec<Machine>,
    /// the user's wisp Grid makes sandboxes (never offered to a capped task)
    pub sandbox: bool,
    /// (name, path)
    pub projects: Vec<(String, String)>,
    /// (name, its members in words)
    pub presets: Vec<(String, String)>,
    /// crew names
    pub crew: Vec<String>,
    pub this: This,
}

const MAX_MODELS: usize = 15;
/// v1 lists the 30 projects used last.
pub const MAX_PROJECTS: usize = 30;

const SANDBOX: &str = "- `sandbox` **Sandbox**: a fresh box of its own on the user's wisp Grid for each subagent (machine: \"sandbox\" in delegate): it can install anything (sudo apt-get), run servers and drive a real browser (the browser connector) without touching the user's computers. It gets a copy of your folder; its changes come back when it finishes. Claude Code only (or auto); kept for this task, so delegating to it again finds its files and installs.";

fn harness(a: &Harness) -> String {
    if !a.available {
        return format!("- {} ({}): {}", a.id, a.name, if a.signed_in == Some(false) { "not signed in" } else { "not installed" });
    }
    let version = a.version.as_deref().map(|v| format!(" {v}")).unwrap_or_default();
    let models: Vec<&str> = a.models.iter().map(String::as_str).filter(|m| !m.is_empty()).collect();
    let models = if models.is_empty() {
        String::new()
    } else {
        let more = if models.len() > MAX_MODELS { ", …" } else { "" };
        format!(": models {}{more}", models.iter().take(MAX_MODELS).copied().collect::<Vec<_>>().join(", "))
    };
    let efforts = if a.efforts.is_empty() { String::new() } else { format!("; thinking {}", a.efforts.join(", ")) };
    format!("- **{}** ({}{version}){models}{efforts}", a.id, a.name)
}

fn machine(m: &Machine) -> String {
    let state = match m.state.as_str() {
        "asleep" => "asleep (wakes when it gets work)",
        s => s,
    };
    let list = if m.harnesses.is_empty() { String::new() } else { format!("; harnesses {}", m.harnesses.join(", ")) };
    format!("- `{}` **{}**{}: {state}{list}", m.id, m.name, if m.cloud { " (cloud)" } else { "" })
}

fn or(lines: Vec<String>, none: &str) -> Vec<String> {
    if lines.is_empty() { vec![none.to_owned()] } else { lines }
}

/// The whole answer.
pub fn available_text(a: &Available) -> String {
    let t = &a.this;
    let mut out = vec!["## Harnesses on this computer".to_owned()];
    out.extend(a.harnesses.iter().filter(|h| h.id != "wisp").map(harness));
    out.push("- **auto**: wisp picks the harness and model from what worked before".into());
    out.extend([String::new(), "## Machines".into()]);
    out.extend(or(a.machines.iter().map(machine).collect(), "None: everything runs on this computer."));
    if a.sandbox {
        out.push(SANDBOX.into());
    }
    out.extend([String::new(), "## Projects".into()]);
    out.extend(or(a.projects.iter().take(MAX_PROJECTS).map(|(n, p)| format!("- **{n}**: {p}")).collect(), "None yet."));
    out.extend([String::new(), "## Subagent presets (saved teams)".into()]);
    out.extend(or(a.presets.iter().map(|(n, m)| format!("- `{n}`: {m}")).collect(), "None."));
    out.extend([String::new(), "## This task".into()]);
    let model = if t.model.is_empty() { String::new() } else { format!(" ({})", t.model) };
    out.push(format!("Task `{}` on {}{model}, mode {}, in {}.", t.id, t.agent, t.mode, t.cwd));
    out.push(if t.subagents.is_empty() {
        "No subagents yet: delegate creates them on the fly.".into()
    } else {
        let names: Vec<String> = t.subagents.iter().map(|n| format!("`{n}`")).collect();
        format!("Its subagents: {} (delegate to them by name).", names.join(", "))
    });
    if !a.crew.is_empty() {
        let names: Vec<String> = a.crew.iter().map(|n| format!("@{n}")).collect();
        out.push(format!("The user's crew: {} (wisp_crew reads them).", names.join(", ")));
    }
    out.push(String::new());
    if let Some(cap) = &t.cap {
        out.push(format!("A channel started this task with a cap of {cap}: nothing it starts may go above that, leave this computer, or leave this project; it can't change the user's crew or connectors. That goes for what you delegate too."));
    }
    out.push("Modes: plan (read-only) | edits (auto-accept edits) | auto (no permission prompts).".into());
    out.push("delegate: subagents for this task (their edits land in your folder; any harness, any machine). wisp_launch: a separate task the user follows on its own. wisp_task: follow up, stop, finish or archive a task.".into());
    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Available {
        Available {
            harnesses: vec![
                Harness {
                    id: "claude".into(),
                    name: "Claude Code".into(),
                    available: true,
                    version: Some("2.1".into()),
                    models: (0..17).map(|i| format!("m{i}")).collect(),
                    efforts: vec!["low".into(), "high".into()],
                    ..Harness::default()
                },
                Harness { id: "codex".into(), name: "Codex".into(), signed_in: Some(false), ..Harness::default() },
                Harness { id: "wisp".into(), name: "wisp".into(), available: true, ..Harness::default() },
            ],
            machines: vec![Machine {
                id: "m1".into(),
                name: "devbox".into(),
                cloud: true,
                state: "asleep".into(),
                harnesses: vec!["claude".into()],
            }],
            projects: vec![("web".into(), "/code/web".into())],
            this: This { id: "t1".into(), agent: "claude".into(), mode: "auto".into(), cwd: "/code/web".into(), ..This::default() },
            ..Available::default()
        }
    }

    #[test]
    fn it_lists_harnesses_machines_projects_and_this_task_in_v1s_words() {
        let t = available_text(&sample());
        assert!(t.starts_with("## Harnesses on this computer\n- **claude** (Claude Code 2.1): models m0, m1"), "{t}");
        assert!(t.contains("m14, …; thinking low, high\n- codex (Codex): not signed in\n- **auto**"), "{t}");
        assert!(!t.contains("(wisp)"), "the tour isn't a harness: {t}");
        assert!(t.contains("- `m1` **devbox** (cloud): asleep (wakes when it gets work); harnesses claude"), "{t}");
        assert!(t.contains("## Projects\n- **web**: /code/web\n"), "{t}");
        assert!(t.contains("## Subagent presets (saved teams)\nNone."), "{t}");
        assert!(t.contains("Task `t1` on claude, mode auto, in /code/web.\nNo subagents yet"), "{t}");
        assert!(!t.contains("A channel started this task"), "{t}");
    }

    #[test]
    fn empty_sections_say_so_and_a_cap_is_named() {
        let mut a = Available { this: This { cap: Some("plan".into()), ..This::default() }, ..Available::default() };
        a.this.subagents = vec!["helper".into()];
        let t = available_text(&a);
        assert!(t.contains("## Machines\nNone: everything runs on this computer."), "{t}");
        assert!(t.contains("## Projects\nNone yet."), "{t}");
        assert!(t.contains("Its subagents: `helper` (delegate to them by name)."), "{t}");
        assert!(t.contains("A channel started this task with a cap of plan: nothing it starts"), "{t}");
    }
}
