//! Subagents (v1 server/subagents.js): a team the user picks at launch (any harness, model and
//! thinking level each) that the lead agent hands work to through wisp's `delegate` tool. These are
//! the roster's normal form and what the lead and its delegates are told.
//!
//! size-ok: v1 subagents.js's rules and their tests

use serde::{Deserialize, Serialize};
use serde_json::Value;
use wisp_runtime_api::model::TurnStatus;

use super::text::{Re, clip, head16, trim};

/// parallel copies of one row
pub const MAX_COPIES: u32 = 5;
const MAX_USE: usize = 300;
static EFFORT: Re = Re::new(r"^[A-Za-z0-9_-]{1,20}$");
/// 'here' (this computer) or a machine id
static PLACE: Re = Re::new(r"^[A-Za-z0-9_-]{1,40}$");
static CREW_ID: Re = Re::new(r"^[a-z0-9]{6,40}$");

/// One row of a lead's team.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub name: String,
    /// a harness id, or 'auto' (wisp picks when it gets its first task)
    pub agent: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub effort: String,
    /// the user's note on when to pick this one
    #[serde(default, rename = "use")]
    pub use_for: String,
    #[serde(default = "one")]
    pub count: u32,
    /// a member of the user's crew: its id
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub crew: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub label: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub role: String,
    /// where it runs: '' with the lead, 'here' or a machine id
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub machine: String,
    /// that place's name
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub place: String,
    /// the wisp that sent this task runs the member, not this one
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub upstream: bool,
}

fn one() -> u32 {
    1
}

/// v1 `slug`: lower case, runs of anything else as '-', at most 24 characters.
fn slug(s: &str) -> String {
    let mut out = String::new();
    for c in s.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').chars().take(24).collect()
}

/// `String(v || '')`
fn js_str(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) if n.as_f64().is_some_and(|f| f != 0.0) => n.to_string(),
        Value::Bool(true) => "true".to_owned(),
        _ => String::new(),
    }
}

/// `String(v).replace(/\s+/g, ' ').trim().slice(0, n)`
fn line(v: &Value, n: usize) -> String {
    head16(&clip(&js_str(v), usize::MAX), n).to_owned()
}

/// `Math.min(MAX_COPIES, Math.max(1, Math.floor(Number(v)) || 1))`
fn count_of(v: &Value) -> u32 {
    let n = match v {
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) if trim(s).is_empty() => 0.0,
        Value::String(s) => trim(s).parse().unwrap_or(f64::NAN),
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Null => 0.0,
        _ => f64::NAN,
    }
    .floor();
    if n.is_nan() || n < 1.0 {
        return 1;
    }
    if n >= f64::from(MAX_COPIES) {
        MAX_COPIES
    } else {
        (1..MAX_COPIES)
            .rev()
            .find(|&c| f64::from(c) <= n)
            .unwrap_or(1)
    }
}

fn unique(base: &str, taken: &mut Vec<String>) -> String {
    let mut name = base.to_owned();
    let mut i = 2;
    while taken.contains(&name) {
        name = format!("{base}-{i}");
        i += 1;
    }
    taken.push(name.clone());
    name
}

/// `[{ name?, agent, model?, effort?, use?, count?, machine?, place?, crew? }]` → a clean roster with
/// unique names (codex, codex-2, …). `known(id)`: a harness wisp has. Err: an unknown harness.
pub fn normalize_team(list: &Value, known: &dyn Fn(&str) -> bool) -> Result<Vec<Member>, String> {
    let Some(rows) = list.as_array() else {
        return Ok(Vec::new());
    };
    let mut taken: Vec<String> = Vec::new();
    let mut out = Vec::with_capacity(rows.len());
    for m in rows {
        let crew = js_str(&m["crew"]);
        let upstream = m["upstream"] == Value::Bool(true);
        if CREW_ID.is_match(&crew) {
            let base = slug(&js_str(&m["name"]));
            let name = unique(if base.is_empty() { "crew" } else { &base }, &mut taken);
            let agent = m["agent"]
                .as_str()
                .filter(|a| known(a) && *a != "wisp")
                .unwrap_or("auto")
                .to_owned();
            let label = line(&m["label"], 24);
            let label = if label.is_empty() {
                name.clone()
            } else {
                label
            };
            out.push(Member {
                label,
                role: line(&m["role"], 60),
                agent,
                use_for: line(&m["use"], MAX_USE),
                count: 1,
                crew,
                upstream,
                name,
                ..Member::default()
            });
            continue;
        }
        let agent = js_str(&m["agent"]);
        if (!known(&agent) && agent != "auto") || agent == "wisp" {
            return Err(format!("unknown subagent harness: {agent}"));
        }
        let base = slug(&js_str(&m["name"]));
        let name = unique(if base.is_empty() { &agent } else { &base }, &mut taken);
        let machine = js_str(&m["machine"]);
        let machine = if PLACE.is_match(&machine) {
            machine
        } else {
            String::new()
        };
        let effort = js_str(&m["effort"]);
        out.push(Member {
            name,
            model: m["model"]
                .as_str()
                .map(|s| head16(s, 120).to_owned())
                .unwrap_or_default(),
            effort: if EFFORT.is_match(&effort) {
                effort
            } else {
                String::new()
            },
            use_for: line(&m["use"], MAX_USE),
            count: count_of(&m["count"]),
            place: if machine.is_empty() {
                String::new()
            } else {
                line(&m["place"], 40)
            },
            upstream: upstream && !machine.is_empty(),
            machine,
            agent,
            ..Member::default()
        });
    }
    Ok(out)
}

/// The sessions a member runs as: itself, or one per copy (`#` can't appear in a name, so no clashes).
pub fn copies(m: &Member) -> Vec<String> {
    if m.count > 1 {
        (1..=m.count).map(|i| format!("{}#{i}", m.name)).collect()
    } else {
        vec![m.name.clone()]
    }
}

/// How the lead hears of a member. `harness(id)`: a harness's display name.
fn who(m: &Member, harness: &dyn Fn(&str) -> Option<String>) -> String {
    if !m.crew.is_empty() {
        let label = if m.label.is_empty() {
            &m.name
        } else {
            &m.label
        };
        let role = if m.role.is_empty() {
            String::new()
        } else {
            format!(", {}", m.role)
        };
        return format!(
            "{label}{role}, a member of the user's crew: a long-lived agent with its own folder, harness and memory. It works in its own folder, not yours (its edits stay there), and remembers past jobs"
        );
    }
    let mut s = if m.agent == "auto" {
        "Auto (wisp picks the harness and model for the first task you give it)".to_owned()
    } else {
        let name = harness(&m.agent)
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| m.agent.clone());
        let model = if m.model.is_empty() {
            "default model".to_owned()
        } else {
            m.model.clone()
        };
        let effort = if m.effort.is_empty() {
            String::new()
        } else {
            format!("{} thinking", m.effort)
        };
        super::text::join_some(&[name, model, effort], " · ")
    };
    if !m.machine.is_empty() {
        s.push_str(" · on ");
        s.push_str(if m.place.is_empty() {
            "another machine"
        } else {
            &m.place
        });
    }
    s
}

/// For a lead with delegates on other machines: what reaches them and what doesn't.
pub const AWAY_LEAD: &str = "- A subagent \"on\" another machine works there, on a copy of your folder as it is when you delegate. Its changes are applied to your folder when it finishes (the report says if they didn't apply cleanly). It doesn't see edits made meanwhile, so give it work that doesn't overlap.
- wisp carries your folder over itself: its commits, uncommitted edits and new files. Don't commit or push to hand it work. What stays behind: git-ignored files (`.env`, `node_modules`, build output), anything outside your folder, attachments and your local servers. If your folder isn't a git repo, none of it goes.
- Its folder has another path there. Name files by their path inside your folder (`src/app.ts`), never by absolute paths of this computer, and paste in the prompt anything it needs that stays behind (a config value, a log excerpt, a file from elsewhere).";

/// Added for a delegate running on another computer than its lead (relay).
pub const AWAY_SUBAGENT: &str = "
- You run on another computer than the lead, in a copy of its folder. An absolute path from the
  lead's computer may not exist here: find the file by its path inside the folder. Your changes
  go back to the lead as a patch when you finish, so don't commit or push them.";

/// Replaces the `ask_user` guidance for a subagent's own system prompt.
pub const SUBAGENT_ASK: &str =
    "- You are a subagent: a lead agent delegated this task to you and will read your presentation.
  You cannot ask the user anything. Make the call yourself, note the assumption in a \"callout\"
  block, and finish. Don't commit unless the task says to.";

/// Appended to the lead's system prompt. `tool`: how its harness names the delegate tool.
pub fn team_note(
    team: &[Member],
    harness: &dyn Fn(&str) -> Option<String>,
    tool: Option<&str>,
) -> String {
    let Some(tool) = tool.filter(|t| !t.is_empty() && !team.is_empty()) else {
        return String::new();
    };
    let rows: Vec<String> = team
        .iter()
        .map(|m| {
            let n = if m.count > 1 {
                let c: Vec<String> = copies(m).iter().map(|c| format!("`{c}`")).collect();
                format!(" ×{} (copies {})", m.count, c.join(", "))
            } else {
                String::new()
            };
            let use_for = if m.use_for.is_empty() {
                String::new()
            } else {
                format!(". Use it for: {}", m.use_for)
            };
            format!("- `{}`{n}: {}{use_for}", m.name, who(m, harness))
        })
        .collect();
    let multi = team.iter().find(|m| m.count > 1).map_or_else(String::new, |m| {
        format!("- A subagent with ×N has N identical copies that run at once. Put several tasks for `{}` in one delegate call and each goes to a free copy; name a copy (`{}`) to continue that copy's conversation.\n", m.name, copies(m).get(1).cloned().unwrap_or_default())
    });
    let away = if team.iter().any(|m| !m.machine.is_empty()) {
        format!("\n{AWAY_LEAD}")
    } else {
        String::new()
    };
    format!(
        "\n\n## Subagents

The user gave you a team of subagents, each a separate coding agent running on its own harness and model:

{}

Hand them work with the `delegate` tool ({tool}): pass one or more tasks, `{{ \"subagent\": \"<name>\", \"prompt\": \"…\" }}`. Tasks in one call run in parallel and the call returns when all of them finish, with each subagent's report and the files it changed. With `wait: false` it returns at once; collect the reports later with `subagent_results`. Delegating to the same subagent again continues its conversation, so it remembers earlier tasks.

{multi}- Subagents work in your folder and see each other's edits. Give parallel subagents separate files or concerns.{away}
- Brief them like a colleague: goal, files, constraints, how to verify. They cannot see your conversation or ask the user.
- Follow the user's \"use it for\" notes when you pick a subagent: send each kind of work to the one meant for it.
- These are your subagents for this session. Whenever you would spawn a subagent, sub-task or helper agent (your harness's built-in Task/Agent tool included), use `delegate` instead: don't use built-in subagents.
- Delegate when the user's request calls for it or when the work splits cleanly; you stay responsible for the result. Review what they changed before you report.
- Your presentation covers the whole task; wisp shows each subagent's report next to it, so don't repeat them in full.",
        rows.join("\n")
    )
}

/// Told to a lead whose follow-up arrived while delegates were still on its earlier tasks:
/// `(name, id)` of each.
pub fn still_working_note(list: &[(String, String)]) -> String {
    let who: Vec<String> = list
        .iter()
        .map(|(name, id)| format!("{name} (id {id})"))
        .collect();
    format!(
        "Subagents you delegated to before this message are still on it, or done and not yet read: {}. Their edits land in your folder. Collect their reports with `subagent_results` (no ids needed) when you need them; don't delegate that work again.",
        who.join(", ")
    )
}

/// Heads the follow-up wisp sends a lead whose turn ended before its delegates finished.
pub const REPORTS_BACK: &str = "Subagents you delegated to earlier have finished. Review their work below and carry on with the task.";

/// What the lead gets back for one delegation. `status`: the delegate's turn's, None when its session
/// is gone. `report`: its blocks as markdown. `files`: the files it changed.
pub fn delegation_report(
    m: &Member,
    status: Option<TurnStatus>,
    report: &str,
    files: &[String],
    harness: &dyn Fn(&str) -> Option<String>,
) -> String {
    let word = match status {
        None => "gone",
        Some(TurnStatus::Running) => "running",
        Some(TurnStatus::Done) => "done",
        Some(TurnStatus::Error) => "error",
        Some(TurnStatus::Held) => "held",
        Some(TurnStatus::Stopped) => "stopped",
    };
    let head = format!("### {} ({}) — {word}", m.name, who(m, harness));
    match status {
        None => format!("{head}\n\nThe subagent session is gone."),
        Some(TurnStatus::Running) => {
            format!("{head}\n\nStill working. Call subagent_results to wait for it.")
        }
        Some(_) => {
            let report = trim(report);
            let files = if files.is_empty() {
                String::new()
            } else {
                let f: Vec<String> = files.iter().map(|f| format!("`{f}`")).collect();
                format!("\n\nFiles it changed: {}", f.join(", "))
            };
            format!(
                "{head}\n\n{}{files}",
                if report.is_empty() {
                    "_No report._"
                } else {
                    report
                }
            )
        }
    }
}

#[cfg(test)]
mod tests {

    /// v1 (F-comp-34): a team of eight is eight; nothing caps delegates at six.
    #[test]
    fn eight_delegates_stay_eight_no_cap_at_six_v1_no_team_cap() {
        let rows: Vec<serde_json::Value> = (0..8).map(|i| serde_json::json!({ "agent": if i % 2 == 0 { "claude" } else { "codex" } })).collect();
        let team = normalize_team(&serde_json::Value::Array(rows), &|_| true).unwrap_or_default();
        assert_eq!(team.len(), 8);
        let names: std::collections::BTreeSet<&str> = team.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(names.len(), 8, "each its own name: {names:?}");
    }

    use super::*;
    use serde_json::json;

    #[test]
    fn small_helpers_match_v1() {
        assert_eq!(slug("  Researcher Bot!! "), "researcher-bot");
        assert_eq!(slug("ÀB"), "b");
        assert_eq!(count_of(&json!(3)), 3);
        assert_eq!(count_of(&json!("4")), 4);
        assert_eq!(count_of(&json!(9)), MAX_COPIES);
        assert_eq!(count_of(&json!(2.7)), 2);
        assert_eq!(count_of(&json!(-2)), 1);
        assert_eq!(count_of(&json!(null)), 1);
        assert_eq!(count_of(&json!("x")), 1);
        assert!(
            [&EFFORT, &PLACE, &CREW_ID]
                .iter()
                .all(|r| r.get().is_some())
        );
    }
}
