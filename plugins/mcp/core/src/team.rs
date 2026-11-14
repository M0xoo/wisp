//! `delegate`, the one tool whose definition depends on the session: its description names the team the
//! user picked and its `subagent` enum lists them (v1 mcp-ask.js `TEAM_TOOLS`). Written as text in v1's
//! key order; `tools-ask-team.json` and `tools-ask-default.json` hold it to v1's bytes.

use wisp_mcp_api::TeamEntry;

use crate::rpc::quote;

const HEAD: &str = "Hand tasks to your subagents (separate coding agents the user picked, each on its own harness and model). Tasks in one call run in parallel in your working folder. By default the call waits until every task finishes and returns each report plus the files it changed; wait=false returns delegation ids at once. Delegating to a subagent again continues its conversation.";
const USE_THIS: &str = " Use this instead of any built-in subagent or task tool.";
const MID: &str = " A task can name a subagent of the team, or create one on the fly: agent (a harness), with model, effort and machine (to run it on one of the user's machines; wisp_available lists harnesses and machines) and a name; pass that name again to continue it. Create them when the user asks for subagents (\"have codex review it\", \"run the tests on my devbox\") or when parallel work on other harnesses pays off. A subagent on another machine gets a copy of your folder (wisp carries it: no commit or push needed): name files by their path in the folder, not absolute paths, and paste in what stays behind (git-ignored files, files outside the folder).";
const SUBAGENT_WORDS: &str = "A subagent of the team. A name with copies (×N) goes to a free copy; name a copy (x#2) to continue it.";
// The task's other fields, after `subagent`: the same for every session.
const TASK_PROPS: &str = r#""agent":{"type":"string","enum":["auto","claude","codex","opencode","cursor","antigravity","grok","copilot"],"description":"Or a new subagent on this harness (auto: wisp picks harness and model)."},"model":{"type":"string","description":"With agent: its model id. Default: the harness default."},"effort":{"type":"string","description":"With agent: thinking level, e.g. low | medium | high."},"machine":{"type":"string","description":"With agent: run it on this machine (id or name from wisp_available). Default: this computer."},"name":{"type":"string","description":"With agent: a short name for it (\"reviewer\"). Pass the same name later to continue that subagent."},"use":{"type":"string","description":"With agent: what it is for, shown to the user."},"prompt":{"type":"string","description":"The task, briefed like a colleague: goal, files, constraints, how to verify. It cannot see your conversation."}"#;
const TAIL: &str = r#"},"required":["prompt"]}},"wait":{"type":"boolean","description":"Wait for all tasks to finish (default true)."}},"required":["tasks"]}}"#;

/// One roster line: `- x ×2 (parallel copies x#1, x#2): claude · default model · on devbox — use for: …`.
fn roster_line(m: &TeamEntry) -> String {
    let copies = if m.count > 1 { format!(" ×{} (parallel copies {})", m.count, m.copies.join(", ")) } else { String::new() };
    let mut parts: Vec<String> = Vec::with_capacity(4);
    if !m.agent.is_empty() {
        parts.push(m.agent.clone());
    }
    parts.push(m.model.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| "default model".into()));
    if let Some(e) = m.effort.as_deref().filter(|s| !s.is_empty()) {
        parts.push(format!("{e} thinking"));
    }
    if let Some(p) = m.place.as_deref().filter(|s| !s.is_empty()) {
        parts.push(format!("on {p}"));
    }
    let use_for = m.use_for.as_deref().filter(|s| !s.is_empty()).map(|u| format!(" — use for: {u}")).unwrap_or_default();
    format!("- {}{copies}: {}{use_for}", m.name, parts.join(" · "))
}

fn description(team: &[TeamEntry]) -> String {
    let mut d = String::from(HEAD);
    if team.is_empty() {
        d.push_str(MID);
        d.push_str("\n\nNo team yet.");
        return d;
    }
    d.push_str(USE_THIS);
    d.push_str(MID);
    d.push_str("\n\nThe team:\n");
    d.push_str(&team.iter().map(roster_line).collect::<Vec<_>>().join("\n"));
    d
}

/// The names `subagent` takes: each member, and each copy of one with copies.
fn names(team: &[TeamEntry]) -> Vec<&str> {
    team.iter()
        .flat_map(|m| std::iter::once(m.name.as_str()).chain(m.copies.iter().map(String::as_str).filter(move |_| m.count > 1)))
        .collect()
}

/// `delegate`'s definition for this team, as JSON text.
pub fn delegate(team: &[TeamEntry]) -> String {
    use std::fmt::Write as _;
    let mut s = String::with_capacity(4096);
    s.push_str("{\"name\":\"delegate\",\"description\":");
    s.push_str(&quote(&description(team)));
    s.push_str(
        r#","inputSchema":{"type":"object","properties":{"tasks":{"type":"array","minItems":1,"items":{"type":"object","properties":{"#,
    );
    if !team.is_empty() {
        let list = names(team).iter().map(|n| quote(n)).collect::<Vec<_>>().join(",");
        let _ = write!(s, "\"subagent\":{{\"type\":\"string\",\"enum\":[{list}],\"description\":{}}},", quote(SUBAGENT_WORDS));
    }
    s.push_str(TASK_PROPS);
    s.push_str(TAIL);
    s
}
