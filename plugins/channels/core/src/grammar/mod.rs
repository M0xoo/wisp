//! What you'd type in the launcher, in a message: `@ada in api on laptop with opus high plan: fix it` (v1
//! channels/grammar.js). Options are read only from the front and end at `:` or the first word that isn't
//! one, so a sentence that happens to hold "with" or "in" is never eaten. Pure: the [`ChannelCtx`] holds
//! everything it may look at, so wisp Grid's router reads the same grammar ([`parse_route`]).

mod read;
mod resolve;

use wisp_channels_api::{ChannelCtx, MachineView, Parsed, Problem, ProjectView};

use crate::mentions::crew_mentions;
use read::{Opts, drop_colon, lower, read_option, starts_colon, token};

const LISTS: [&str; 6] = ["help", "projects", "models", "crew", "machines", "status"];
const SLASH: [&str; 11] = ["help", "projects", "models", "crew", "machines", "status", "new", "start", "stop", "done", "btw"];

/// `/new @name`: the exact name, then a name prefix, then anywhere in the name or the path.
pub fn find_project<'a>(projects: &'a [ProjectView], q: &str) -> Option<&'a ProjectView> {
    let n = lower(q);
    if n.is_empty() {
        return None;
    }
    projects
        .iter()
        .find(|p| lower(&p.name) == n)
        .or_else(|| projects.iter().find(|p| lower(&p.name).starts_with(&n)))
        .or_else(|| projects.iter().find(|p| lower(&p.name).contains(&n) || lower(&p.path).contains(&n)))
}

pub use wisp_channels_api::markup::{Markup, strip_formatting};

enum Command {
    Unknown(String),
    Named { name: String, arg: String },
}

/// A word or a slash command that isn't a task. `/new` goes on to the options; the rest are whole.
fn read_command(text: &str, c: &ChannelCtx) -> Option<Command> {
    if let Some(body) = text.strip_prefix('/') {
        let end = body.find(|ch: char| !(ch.is_alphanumeric() || ch == '_')).unwrap_or(body.len());
        if end > 0 {
            let name = lower(&body[..end]);
            if !SLASH.contains(&name.as_str()) {
                return Some(Command::Unknown(body[..end].to_owned()));
            }
            let name = if name == "start" { "help".to_owned() } else { name };
            return Some(Command::Named { name, arg: body[end..].trim().to_owned() });
        }
    }
    let letters = text.chars().take_while(char::is_ascii_alphabetic).count();
    if letters == 0 {
        return None;
    }
    let name = lower(&text[..letters]);
    let tail = text[letters..].strip_prefix(['?', '.', '!']).unwrap_or(&text[letters..]);
    if !tail.is_empty() && !tail.starts_with(char::is_whitespace) {
        return None;
    }
    let tail = tail.trim();
    if (LISTS.contains(&name.as_str()) || name == "stop" || name == "done") && tail.is_empty() {
        return Some(Command::Named { name, arg: String::new() });
    }
    // "models laptop": a list for a place, if that's a place; else it's a sentence
    let place = tail.strip_prefix("on ").unwrap_or(tail).trim();
    if name == "models" && !place.is_empty() && c.machines.iter().any(|m| lower(&m.name).starts_with(&lower(place))) {
        return Some(Command::Named { name, arg: place.to_owned() });
    }
    None
}

/// A router's reading of a message (wisp Grid, which knows computers and nothing else): `on <name>` first,
/// after an optional `/new`, whole names only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    /// to this computer, with the message as it should reach it (`on <name>` gone)
    To { machine: String, text: String },
    /// the name fits several computers
    Ambiguous(Vec<Problem>),
}

/// `None`: not this router's message (the box's own). "cloud" and "here" aren't computers.
pub fn parse_route(text: &str, computers: &[MachineView]) -> Option<Route> {
    let whole = text.trim();
    if starts_colon(whole) {
        return None;
    }
    let mut machines = computers.to_vec();
    if !machines.iter().any(|m| lower(&m.name) == "cloud") {
        machines.push(MachineView { id: String::new(), name: "cloud".into(), usable: true, ..MachineView::default() });
    }
    let c = ChannelCtx { exact: true, machines, ..ChannelCtx::default() };
    let cmd = read_command(whole, &c);
    let (src, slash) = match &cmd {
        None => (whole.to_owned(), false),
        Some(Command::Named { name, arg }) if name == "new" => (arg.clone(), true),
        Some(_) => return None,
    };
    let t = token(&src);
    if t.low != "on" {
        return None;
    }
    let mut o = Opts::default();
    let step = read_option(&t, &src, &mut o, &c, 0);
    if let Some(p) = o.problems.first() {
        return (p.kind == "ambiguous").then(|| Route::Ambiguous(o.problems.clone()));
    }
    let step = step.filter(|s| !s.stop)?;
    let machine = o.machine.filter(|id| computers.iter().any(|m| m.id == *id))?;
    let said = format!("{}{}", if step.colon { ": " } else { "" }, step.rest).trim().to_owned();
    if drop_colon(&said).trim().is_empty() {
        return None; // nothing to do there: not a task, and the box can say so
    }
    Some(Route::To { machine, text: if slash { format!("/new {said}") } else { said } })
}

fn nothing(command: Option<String>, arg: String, prompt: String, problems: Vec<Problem>) -> Parsed {
    Parsed { command, arg, prompt, problems, ..Parsed::default() }
}

/// `text` (through [`strip_formatting`]) → what it asks for. `problems`: why it can't start, each with its
/// choices; `notes`: what the first reply should mention; `prompt`: the words left.
pub fn parse_message(text: &str, c: &ChannelCtx) -> Parsed {
    let mut src = text.trim().to_owned();
    // a leading `:`: the message exactly as written
    if starts_colon(&src) {
        return nothing(None, String::new(), drop_colon(&src).trim().to_owned(), Vec::new());
    }
    let cmd = read_command(&src, c);
    let mut command = None;
    match cmd {
        // /goal, /side in a thread: words for the agent's task, as a follow-up
        Some(Command::Unknown(_)) if c.thread.is_some() => return nothing(None, String::new(), src, Vec::new()),
        Some(Command::Unknown(u)) => {
            let p = Problem { kind: "unknown".into(), text: format!("There’s no /{u} here. Send /help, or start with “:” to send it as written."), choices: Vec::new() };
            return nothing(None, String::new(), String::new(), vec![p]);
        }
        Some(Command::Named { name, arg }) if name != "new" => {
            let prompt = if name == "btw" { arg.clone() } else { String::new() };
            return nothing(Some(name), arg, prompt, Vec::new());
        }
        Some(Command::Named { name, arg }) => {
            command = Some(name);
            src = arg;
        }
        None => {}
    }
    let mut o = Opts::default();
    let mut rest = src;
    let mut count = 0;
    while !rest.is_empty() {
        let r = rest.clone();
        let t = token(&r);
        if t.word.is_empty() && t.colon {
            let after = t.after.to_owned();
            rest = after;
            break;
        }
        let Some(st) = read_option(&t, &r, &mut o, c, count) else { break };
        rest = st.rest;
        if st.stop {
            break;
        }
        let colon = st.colon || starts_colon(&rest);
        if colon {
            rest = drop_colon(&rest).trim().to_owned();
            break;
        }
        count += 1;
    }
    if o.problems.is_empty() {
        resolve::resolve(&mut o, c);
    }
    let prompt = rest.trim().to_owned();
    // a member named further in joins as a delegate, as in the launcher
    let further: Vec<_> = crew_mentions(&prompt, &c.crew).all.into_iter().filter(|m| o.crew.as_ref().is_none_or(|x| x.id != m.id) && !o.tagged.iter().any(|x| x.id == m.id)).collect();
    let mut tagged = o.tagged;
    tagged.extend(further);
    Parsed { command, arg: String::new(), crew: o.crew, tagged, project: o.project, machine: o.machine, agent: o.agent, model: o.model, effort: o.effort, mode: o.mode, prompt, problems: o.problems, notes: o.notes }
}
