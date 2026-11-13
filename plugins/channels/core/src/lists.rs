//! What a channel can ask for (help, projects, models, crew, machines, status), the refusal, and the first
//! reply to a message (v1 channels/lists.js). Text only, from the grammar's [`ChannelCtx`]. Every list ends
//! with a working example in the user's own names: that's how people learn this.

use wisp_channels_api::scrub::truncate;
use wisp_channels_api::{ChannelCtx, Mode};

use crate::mentions::handle_of;

pub const NAMES: [&str; 6] = ["help", "projects", "models", "crew", "machines", "status"];
const MAX: usize = 4000;

pub fn is_list(name: Option<&str>) -> bool {
    name.is_some_and(|n| NAMES.contains(&n))
}

fn first_model(c: &ChannelCtx) -> Option<&str> {
    c.agents.iter().filter(|a| a.available).flat_map(|a| a.models.iter()).map(|m| m.id.as_str()).find(|id| !id.is_empty())
}

/// A message that would work here, with what this wisp really has.
pub fn example(c: &ChannelCtx) -> String {
    let project = c.default_project.as_ref().or(c.projects.first()).map(|p| format!("in {}", p.name));
    let model = first_model(c).map(|m| format!("with {m}"));
    let parts: Vec<String> = [project, model, Some("plan:".to_owned())].into_iter().flatten().collect();
    format!("Try: {} fix the flaky test", parts.join(" "))
}

fn crew_example(c: &ChannelCtx) -> String {
    c.crew.first().map_or_else(|| example(c), |m| format!("Try: @{} look at the failing test", handle_of(&m.name)))
}

fn machine_example(c: &ChannelCtx) -> String {
    c.machines.iter().find(|m| m.usable).map_or_else(
        || example(c),
        |m| {
            format!(
                "Try: on {} {}fix the flaky test",
                m.name,
                c.default_project.as_ref().map(|p| format!("in {} ", p.name)).unwrap_or_default()
            )
        },
    )
}

/// Help, with an example in this wisp's names.
pub fn help_for(c: &ChannelCtx) -> String {
    [
        "Say what you’d type in wisp: options first, then the task.",
        "@name a crew member · in or #project · on machine · with model · plan or edits, then “:”",
        "Reply to wisp’s messages to answer or follow up; in a task’s thread, stop, done and status work too.",
        "Lists: projects, models, crew, machines, status. Start with “:” to send a message as written.",
        "",
        &example(c),
    ]
    .join("\n")
}

/// Help with nothing of yours in it (a place others read).
pub fn help() -> String {
    help_for(&ChannelCtx::default())
}

pub fn projects(c: &ChannelCtx) -> String {
    let Some(first) = c.projects.first() else { return "No projects yet. Open a folder in wisp first.".into() };
    let place = |id: &str| c.machines.iter().find(|m| m.id == id).map_or(id, |m| m.name.as_str()).to_owned();
    let lines: Vec<String> = c
        .projects
        .iter()
        .map(|p| {
            let on = p.machine.as_deref().map(|m| format!(" (on {})", place(m))).unwrap_or_default();
            let dflt = if c.default_project.as_ref().is_some_and(|d| d.id == p.id) { "  ← default" } else { "" };
            format!("• {}{on}{dflt}", p.name)
        })
        .collect();
    let eg = c.default_project.as_ref().unwrap_or(first);
    truncate(&format!("Projects:\n{}\n\nTry: in {} fix the flaky test", lines.join("\n"), eg.name), MAX)
}

/// For this computer, or a machine named in `arg` (`models laptop`).
pub fn models(c: &ChannelCtx, arg: &str) -> String {
    let q = arg.trim().strip_prefix("on ").unwrap_or(arg.trim()).trim().to_lowercase();
    let m = if q.is_empty() {
        None
    } else {
        c.machines.iter().find(|x| x.name.to_lowercase() == q).or_else(|| c.machines.iter().find(|x| x.name.to_lowercase().starts_with(&q)))
    };
    if !q.is_empty() && m.is_none() {
        return format!("No machine “{arg}”. Send machines to see them.");
    }
    let agents = match m {
        Some(m) => match &m.agents {
            Some(a) => a.as_slice(),
            None => return format!("{} is offline, so I can’t say what it has.", m.name),
        },
        None => c.agents.as_slice(),
    };
    let place = m.map_or("this computer", |m| m.name.as_str());
    let up: Vec<_> = agents.iter().filter(|a| a.available && a.id != "wisp").collect();
    if up.is_empty() {
        return format!("Nothing is installed on {place}.");
    }
    let line = |a: &wisp_channels_api::AgentView| {
        let list: Vec<&str> = a.models.iter().map(|x| x.id.as_str()).filter(|id| !id.is_empty()).take(12).collect();
        let models = if list.is_empty() { String::new() } else { format!(": {}", list.join(", ")) };
        let think = if a.efforts.is_empty() { String::new() } else { format!(" (thinking: {})", a.efforts.join(", ")) };
        format!("• {}{models}{think}", a.id)
    };
    let eg = up
        .iter()
        .flat_map(|a| {
            a.models
                .iter()
                .filter(|x| !x.id.is_empty())
                .map(move |x| format!("{}{}", x.id, if a.efforts.iter().any(|e| e == "high") { " high" } else { "" }))
        })
        .next()
        .unwrap_or_else(|| up[0].id.clone());
    let on = m.map(|m| format!("on {} ", m.name)).unwrap_or_default();
    truncate(
        &format!(
            "On {place}:\n{}\n• auto: {}\n\nTry: {on}with {eg} fix the flaky test",
            up.iter().map(|a| line(a)).collect::<Vec<_>>().join("\n"),
            c.goals.join(", ")
        ),
        MAX,
    )
}

pub fn crew(c: &ChannelCtx) -> String {
    if c.crew.is_empty() {
        return format!("No crew yet. Add someone in wisp.\n\n{}", example(c));
    }
    let line = |m: &wisp_channels_api::MemberView| {
        let busy = if m.paused {
            "paused".to_owned()
        } else if m.running > 0 {
            format!("on {} job{}", m.running, if m.running > 1 { "s" } else { "" })
        } else {
            "free".to_owned()
        };
        let role = m.role.as_deref().filter(|r| !r.is_empty()).map(|r| format!(" · {r}")).unwrap_or_default();
        let waiting = if m.queue.is_empty() { String::new() } else { format!(", {} waiting", m.queue.len()) };
        format!("• @{}{role} · {busy}{waiting}", handle_of(&m.name))
    };
    truncate(&format!("Crew:\n{}\n\n{}", c.crew.iter().map(line).collect::<Vec<_>>().join("\n"), crew_example(c)), MAX)
}

pub fn machines(c: &ChannelCtx) -> String {
    let mut lines = vec!["• this computer · online".to_owned()];
    lines.extend(c.machines.iter().map(|m| {
        format!(
            "• {} · {}",
            m.name,
            if !m.usable {
                "offline"
            } else if m.agents.is_some() {
                "online"
            } else {
                "asleep, wakes when it gets work"
            }
        )
    }));
    truncate(&format!("Machines:\n{}\n\n{}", lines.join("\n"), machine_example(c)), MAX)
}

pub fn status(c: &ChannelCtx) -> String {
    if c.tasks.is_empty() {
        return format!("Nothing running or waiting.\n\n{}", example(c));
    }
    let of = |st: &str| c.tasks.iter().filter(|s| s.state == st).map(|s| format!("• {}", s.title)).collect::<Vec<_>>();
    let (running, waiting) = (of("running"), of("waiting"));
    let mut parts = Vec::new();
    if !running.is_empty() {
        parts.push(format!("Running:\n{}", running.join("\n")));
    }
    if !waiting.is_empty() {
        parts.push(format!("Waiting for you:\n{}", waiting.join("\n")));
    }
    parts.push(example(c));
    truncate(&parts.join("\n\n"), MAX)
}

/// The list command `name`, as text (empty for a name that isn't one).
pub fn render(name: &str, c: &ChannelCtx, arg: &str) -> String {
    match name {
        "help" => help_for(c),
        "projects" => projects(c),
        "models" => models(c, arg),
        "crew" => crew(c),
        "machines" => machines(c),
        "status" => status(c),
        _ => String::new(),
    }
}

pub use wisp_channels_api::conversation::refusal;

/// `Opus high`, `Sonnet`, the harness when it runs its default model; with a mode, what really runs there.
pub fn model_label(c: &ChannelCtx, agent: &str, model: &str, effort: &str, mode: Option<Mode>) -> String {
    if agent == "auto" {
        return if model.is_empty() { "Auto".into() } else { format!("Auto {model}") };
    }
    let swapped = mode
        .and_then(|md| c.adapters.iter().find(|a| a.agent.id == agent)?.overrides.iter().find(|o| o.model == model && o.mode == md))
        .map(|o| o.label.clone());
    let a = c.agents.iter().chain(c.adapters.iter().map(|x| &x.agent)).find(|x| x.id == agent);
    let label = a.and_then(|a| a.models.iter().find(|m| !model.is_empty() && m.id == model)).and_then(|m| m.label.clone());
    let name = swapped
        .or(label)
        .or_else(|| (!model.is_empty()).then(|| model.to_owned()))
        .or_else(|| a.and_then(|a| a.name.clone()))
        .unwrap_or_else(|| agent.to_owned());
    if effort.is_empty() { name } else { format!("{name} {effort}") }
}

fn task_line(t: &str) -> Option<String> {
    let s = truncate(&t.split_whitespace().collect::<Vec<_>>().join(" "), 200);
    let mut c = s.chars();
    c.next().map(|f| format!("  {}{}", f.to_uppercase(), c.as_str()))
}

/// The first reply to a task: `▶ api · Opus high · Plan · on laptop`, the task, the notes.
#[derive(Debug)]
pub struct Ack<'a> {
    pub project: Option<&'a str>,
    pub label: &'a str,
    pub mode: Option<Mode>,
    pub machine: Option<&'a str>,
    pub task: &'a str,
    pub notes: &'a [String],
}

pub fn ack_task(a: &Ack<'_>) -> String {
    let on = a.machine.map(|m| format!("on {m}"));
    let head: Vec<String> =
        [a.project.map(str::to_owned), (!a.label.is_empty()).then(|| a.label.to_owned()), a.mode.map(|m| m.label().to_owned()), on]
            .into_iter()
            .flatten()
            .collect();
    let mut out = vec![format!("▶ {}", head.join(" · "))];
    out.extend(task_line(a.task));
    out.extend(a.notes.iter().cloned());
    out.join("\n")
}

/// `▶ Ada has it (queued, 1 ahead) · api · Sonnet`. `ahead`: its place in the member's queue.
pub fn ack_crew(name: &str, ahead: Option<u32>, paused: bool, a: &Ack<'_>) -> String {
    let state = match (ahead, paused) {
        (Some(n), _) => format!(" (queued, {n} ahead)"),
        (None, true) => " (paused, this one runs anyway)".into(),
        _ => String::new(),
    };
    let on = a.machine.map(|m| format!("on {m}"));
    let tail: String =
        [a.project.map(str::to_owned), (!a.label.is_empty()).then(|| a.label.to_owned()), a.mode.map(|m| m.label().to_owned()), on]
            .into_iter()
            .flatten()
            .fold(String::new(), |mut out, x| {
                out.push_str(" · ");
                out.push_str(&x);
                out
            });
    let mut out = vec![format!("▶ {name} has it{state}{tail}")];
    out.extend(task_line(a.task));
    out.extend(a.notes.iter().cloned());
    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use wisp_channels_api::{AgentView, MachineView, ModelView, Problem, ProjectView};

    fn ctx() -> ChannelCtx {
        let api = ProjectView { id: "p1".into(), name: "api".into(), path: "/work/api".into(), ..ProjectView::default() };
        let claude = AgentView {
            id: "claude".into(),
            name: Some("Claude Code".into()),
            available: true,
            signed_in: true,
            models: vec![ModelView { id: "opus".into(), label: Some("Opus".into()), efforts: Vec::new() }],
            efforts: vec!["high".into()],
        };
        ChannelCtx {
            projects: vec![api.clone()],
            default_project: Some(api),
            agents: vec![claude],
            machines: vec![MachineView { id: "m1".into(), name: "laptop".into(), usable: true, agents: None, ..MachineView::default() }],
            goals: vec!["balanced".into()],
            ..ChannelCtx::default()
        }
    }

    #[test]
    fn every_list_ends_with_an_example_in_your_own_names() {
        let c = ctx();
        assert!(help_for(&c).ends_with("Try: in api with opus plan: fix the flaky test"));
        assert!(projects(&c).contains("• api  ← default") && projects(&c).ends_with("Try: in api fix the flaky test"));
        assert!(
            models(&c, "").contains("• claude: opus (thinking: high)")
                && models(&c, "").ends_with("Try: with opus high fix the flaky test")
        );
        assert_eq!(models(&c, "laptop"), "laptop is offline, so I can’t say what it has.");
        assert!(machines(&c).contains("• laptop · asleep, wakes when it gets work"));
        assert!(status(&c).starts_with("Nothing running or waiting."));
        assert!(!help().contains("api"), "help where others read has nothing of yours");
        assert!(is_list(Some("crew")) && !is_list(Some("stop")) && !is_list(None));
    }

    #[test]
    fn a_refusal_says_the_choices_and_that_nothing_started() {
        let p = [Problem { kind: "no-match".into(), text: "No project “web”.".into(), choices: vec!["api".into()] }];
        assert_eq!(refusal(&p), "No project “web”.\nChoices: api\n\nNothing started. Start with “:” to send it as written.");
    }

    #[test]
    fn the_first_reply_names_where_and_how_it_runs() {
        let c = ctx();
        let label = model_label(&c, "claude", "opus", "high", None);
        let a = Ack {
            project: Some("api"),
            label: &label,
            mode: Some(Mode::Plan),
            machine: Some("laptop"),
            task: "fix the   flaky test",
            notes: &[],
        };
        assert_eq!(ack_task(&a), "▶ api · Opus high · Plan · on laptop\n  Fix the flaky test");
        assert!(ack_crew("Ada", Some(1), false, &a).starts_with("▶ Ada has it (queued, 1 ahead) · api · Opus high"));
        assert_eq!(model_label(&c, "auto", "", "", None), "Auto");
    }
}
