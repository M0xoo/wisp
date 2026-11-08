//! Task, crew and My Stuff mentions (v1 server/mentions.js). The web app stores a task mention as
//! `@[Title](wisp:<id>)`; the agent gets `@Title (wisp task <id>)` plus a note on how to read it: the
//! `wisp_session` tool, or the task's report inline for runs that can't take wisp's MCP tools.

use super::text::{Re, plural, truncate};

static MENTION: Re = Re::new(r"@\[([^\]\n]{1,200})\]\(wisp:([a-z0-9]{6,40})\)");
static CREW: Re = Re::new(r"@\[([^\]\n]{1,200})\]\(crew:[a-z0-9]{6,40}\)");
static STUFF: Re = Re::new(r"@\[([^\]\n]{1,200})\]\(stuff:([a-z0-9]{6,40})\)");

/// characters of a mentioned task's report, when it goes in the prompt
const INLINE_MAX: usize = 8_000;

/// One mention: the id it points at and the title the prompt showed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mention {
    pub id: String,
    pub title: String,
}

fn found(re: &Re, text: &str) -> Vec<Mention> {
    let mut out: Vec<Mention> = Vec::new();
    let Some(r) = re.get() else { return out };
    for c in r.captures_iter(text) {
        let (Some(title), Some(id)) = (c.get(1), c.get(2)) else {
            continue;
        };
        // v1 kept each id once, at its first place, with its last title (a Map's set)
        match out.iter_mut().find(|m| m.id == id.as_str()) {
            Some(m) => title.as_str().clone_into(&mut m.title),
            None => out.push(Mention {
                id: id.as_str().to_owned(),
                title: title.as_str().to_owned(),
            }),
        }
    }
    out
}

/// The tasks a prompt mentions, each once.
pub fn mentions_in(text: &str) -> Vec<Mention> {
    found(&MENTION, text)
}

/// The My Stuff items a prompt mentions, each once.
pub fn stuff_in(text: &str) -> Vec<Mention> {
    found(&STUFF, text)
}

/// What a person reads: titles, no ids (session titles, notifications).
pub fn plain_mentions(text: &str) -> String {
    let t = MENTION.replace_all(text, "@${1}");
    let t = CREW.replace_all(&t, "@${1}");
    STUFF.replace_all(&t, "@${1}").into_owned()
}

/// What an agent reads in place of each mention.
pub fn text_mentions(text: &str) -> String {
    let t = MENTION.replace_all(text, "@${1} (wisp task ${2})");
    let t = CREW.replace_all(&t, "@${1}");
    STUFF
        .replace_all(&t, "@${1} (My Stuff item ${2})")
        .into_owned()
}

/// A mentioned task as the host found it in the store.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MentionedTask {
    pub id: String,
    pub title: String,
    /// its state ('running', 'review', …)
    pub state: String,
    pub agent: String,
    pub turns: usize,
    /// where it works (its worktree, else its folder)
    pub folder: String,
    /// its latest report as markdown (v1 `sessionToMarkdown`); only read for a run without wisp's tools
    pub report: String,
}

/// The prompt for an agent run (v1 `agentPrompt`). `tool`: how this harness names `wisp_session`, or
/// None when it has none (then each mentioned task's report goes in the prompt). `tasks`: the
/// mentioned tasks the host found (one it didn't is "not on this computer"). `own`: this task's id
/// (it gets no note about itself). `extra`: what `runtime.prompt@1` expansions add (My Stuff).
pub fn agent_prompt(
    prompt: &str,
    tasks: &[MentionedTask],
    tool: Option<&str>,
    own: &str,
    extra: &str,
) -> String {
    let found: Vec<Mention> = mentions_in(prompt)
        .into_iter()
        .filter(|m| m.id != own)
        .collect();
    let text = text_mentions(prompt);
    if found.is_empty() {
        return text + extra;
    }
    let task = |m: &Mention| tasks.iter().find(|t| t.id == m.id);
    let line = |m: &Mention| match task(m) {
        None => format!(
            "- `{}` ({}): not on this computer; it may have been deleted or run on another machine.",
            m.id, m.title
        ),
        Some(s) => format!(
            "- `{}` **{}**: {}, {}, {}, in `{}`",
            s.id,
            s.title,
            s.state,
            s.agent,
            plural(s.turns, "turn"),
            s.folder
        ),
    };
    let note = match tool.filter(|t| !t.is_empty()) {
        Some(tool) => format!(
            "The user mentions other wisp tasks. Read one with `wisp_session` ({tool}) before relying on it; `wisp_sessions` lists the rest.\n{}",
            found.iter().map(line).collect::<Vec<_>>().join("\n")
        ),
        None => format!(
            "The user mentions other wisp tasks. Their latest reports:\n\n{}",
            found
                .iter()
                .map(|m| match task(m) {
                    Some(s) => format!(
                        "### {} (`{}`)\n\n{}",
                        s.title,
                        s.id,
                        truncate(&s.report, INLINE_MAX)
                    ),
                    None => line(m),
                })
                .collect::<Vec<_>>()
                .join("\n\n")
        ),
    };
    format!("{text}\n\n<wisp-tasks>\n{note}\n</wisp-tasks>{extra}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_pattern_compiles() {
        for re in [&MENTION, &CREW, &STUFF] {
            assert!(re.get().is_some());
        }
    }
}
