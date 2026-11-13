//! A task's usage, all of it (v1 #785, TRY-16): the tokens its turns took, its share of the plan's usage
//! windows, how full its context is, and a lead's wisp subagents added in. The host folds each task's turns into
//! an [`Own`] (kept per turn, so a write refolds numbers, never rereads turns) and puts it on the list row; a lead's
//! row adds its subagents' ([`with_subs`]). Pure: no clock, no I/O.
//!
//! Two kinds of subagent count: the CLI's own, inside a turn (Claude Code's Agent calls: `stats.models` already
//! holds their tokens), and wisp's, which are tasks of their own (`parent_id`: the lead), summed here.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use wisp_runtime_api::model::{Turn, TurnStats, TurnStatus};

/// budget's slot on a turn: `{ plan: [{ agent, account, window, used }] }` (wisp.budget `keep_shares`), read as data.
const BUDGET: &str = "wisp.budget";

/// One turn's part, kept by the host per turn index.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TurnUsage {
    pub idx: u32,
    /// still running: its numbers aren't in yet, and it says nothing about the context
    pub running: bool,
    /// read (input, cache reads and writes) plus written, the CLI's own subagents' in
    pub tokens: u64,
    /// what the main thread wrote (`stats.outputTokens`): a turn that worked
    pub output: u64,
    /// how large the conversation was after it (0: it compacted); None: the harness didn't say
    pub context: Option<u64>,
    /// the main thread's model's window (0: not said)
    pub window: u64,
    /// its plan shares: (window, used, "agent account")
    pub plan: Vec<(String, f64, String)>,
    /// the harness's own subagents that ran inside it (`stats.subagents`)
    pub agents: Vec<Agents>,
}

/// The harness's own subagents of one type and model (Claude Code's Agent calls), summed over a task's turns: the
/// card's "Subagents in its turns" (v1 `inTurnAgents`). Their tokens are already in the task's.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Agents {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub model: String,
    pub calls: u64,
    #[serde(default)]
    pub output: u64,
}

/// How full the context is: `window` 0 when the harness doesn't say.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Context {
    pub tokens: u64,
    pub window: u64,
}

/// A task's own numbers.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Own {
    pub tokens: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<Context>,
    /// its share of each window, 0 to 1
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub plan: BTreeMap<String, f64>,
    /// the plans (agent account) its shares are of
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub plan_on: BTreeSet<String>,
    /// the harness's own subagents by type and model, most output first
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agents: Vec<Agents>,
}

/// A lead's wisp subagent: what it took. `same_plan` false: its share is of another plan's windows (another
/// harness or account), so the lead's line doesn't add it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubUsage {
    pub id: String,
    pub name: String,
    pub title: String,
    pub agent: String,
    pub tokens: u64,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub plan: BTreeMap<String, f64>,
    #[serde(default = "yes", skip_serializing_if = "is_yes")]
    pub same_plan: bool,
}

const fn yes() -> bool {
    true
}
#[allow(clippy::trivially_copy_pass_by_ref)] // serde's skip_serializing_if takes a reference
const fn is_yes(b: &bool) -> bool {
    *b
}

/// The task with its subagents: what the details line says.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Total {
    pub tokens: u64,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub plan: BTreeMap<String, f64>,
}

fn n(v: Option<&Value>) -> u64 {
    v.and_then(Value::as_f64).filter(|x| x.is_finite() && *x > 0.0).map_or(0, |x| {
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)] // finite, > 0: a token count
        let n = x.round() as u64;
        n
    })
}

/// What a turn read (cache reads and writes in) plus wrote. Claude's per-model counts hold its CLI subagents'
/// too, which usage can leave out: the larger of the two is the turn's (v1 `turnTokens`).
pub fn turn_tokens(st: &TurnStats) -> u64 {
    let read = st.input_tokens.unwrap_or(0) + st.cache_tokens.unwrap_or(0);
    let output = st.output_tokens.unwrap_or(0);
    let models = st.models.as_ref().map(|m| {
        m.values().fold((0, 0), |(r, o), x| {
            (r + n(x.get("input")) + n(x.get("cacheRead")) + n(x.get("cacheWrite")), o + n(x.get("output")))
        })
    });
    match models {
        Some((r, o)) if r + o > read + output => r + o,
        _ => read + output,
    }
}

/// A turn's part.
pub fn turn_usage(t: &Turn) -> TurnUsage {
    let tokens = t.stats.as_ref().map_or(0, turn_tokens);
    let plan = t
        .ext
        .get(BUDGET)
        .and_then(|b| b.get("plan"))
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|p| {
                    let used = p.get("used").and_then(Value::as_f64).filter(|x| x.is_finite() && *x > 0.0)?;
                    let window = p.get("window").and_then(Value::as_str).filter(|w| !w.is_empty())?;
                    let s = |k: &str| p.get(k).and_then(Value::as_str).filter(|x| !x.is_empty());
                    Some((window.to_owned(), used, plan_key(s("agent").unwrap_or(&t.agent), s("account"))))
                })
                .collect()
        })
        .unwrap_or_default();
    TurnUsage {
        idx: t.idx,
        running: t.status == TurnStatus::Running || t.stats.is_none(),
        tokens,
        output: t.stats.as_ref().and_then(|s| s.output_tokens).unwrap_or(0),
        context: t.stats.as_ref().and_then(|s| s.context_tokens),
        window: t.stats.as_ref().and_then(|s| s.context_window).unwrap_or(0),
        plan,
        agents: t.stats.as_ref().map_or_else(Vec::new, |s| {
            s.subagents
                .iter()
                .map(|x| Agents {
                    kind: if x.kind.is_empty() { "general".into() } else { x.kind.clone() },
                    model: x.model.clone(),
                    calls: u64::from(x.calls),
                    output: x.output,
                })
                .collect()
        }),
    }
}

/// The plan an agent and account share: "claude default".
pub fn plan_key(agent: &str, account: Option<&str>) -> String {
    format!("{agent} {}", account.filter(|a| !a.is_empty()).unwrap_or("default"))
}

/// How full the context is now, from the newest turn that measured it, or None. A compaction says 0: small again,
/// not unknown. A later turn that worked without a number (another harness, an old CLI) moved it on: None, never a
/// guess. The window is the model's: a turn that said none (a compaction) takes the one before (v1 `contextOf`).
pub fn context_of(turns: &[TurnUsage]) -> Option<Context> {
    for (i, t) in turns.iter().enumerate().rev() {
        if t.running {
            continue;
        }
        if let Some(tokens) = t.context {
            let window = turns[..=i].iter().rev().map(|x| x.window).find(|w| *w > 0).unwrap_or(0);
            return Some(Context { tokens, window });
        }
        if t.output > 0 {
            return None;
        }
    }
    None
}

/// Rounded to 1e-6: shares that add up don't print 0.060000000000000005.
fn tidy(x: f64) -> f64 {
    (x * 1e6).round() / 1e6
}

/// A task's own numbers, from its turns in order.
pub fn own_of(turns: &[TurnUsage]) -> Own {
    let mut plan: BTreeMap<String, f64> = BTreeMap::new();
    let mut plan_on = BTreeSet::new();
    for (w, used, on) in turns.iter().flat_map(|t| &t.plan) {
        *plan.entry(w.clone()).or_default() += used;
        plan_on.insert(on.clone());
    }
    for x in plan.values_mut() {
        *x = tidy(*x);
    }
    Own { tokens: turns.iter().map(|t| t.tokens).sum(), context: context_of(turns), plan, plan_on, agents: agents_of(turns) }
}

/// The harness's own subagents over every turn, by type and model, most output first (ties: more calls, then the
/// type, so the order never flickers).
pub fn agents_of(turns: &[TurnUsage]) -> Vec<Agents> {
    let mut by: BTreeMap<(String, String), Agents> = BTreeMap::new();
    for x in turns.iter().flat_map(|t| &t.agents) {
        let e = by.entry((x.kind.clone(), x.model.clone())).or_insert_with(|| Agents { kind: x.kind.clone(), model: x.model.clone(), ..Agents::default() });
        e.calls += x.calls;
        e.output += x.output;
    }
    let mut out: Vec<Agents> = by.into_values().collect();
    out.sort_by(|a, b| b.output.cmp(&a.output).then(b.calls.cmp(&a.calls)));
    out
}

/// A lead's wisp subagent's line, or None when it took nothing measured. Before the lead has a share of its own,
/// its plan is the one it runs on (`lead_on`).
pub fn sub_usage(lead: &Own, lead_on: &str, sub: (&str, &str, &str, &str), own: &Own) -> Option<SubUsage> {
    let (id, name, title, agent) = sub;
    if own.tokens == 0 && own.plan.is_empty() {
        return None;
    }
    let same_plan = own.plan_on.iter().all(|k| if lead.plan_on.is_empty() { k == lead_on } else { lead.plan_on.contains(k) });
    Some(SubUsage {
        id: id.to_owned(),
        // none: the page names it (its own words)
        name: [name, title].into_iter().find(|x| !x.is_empty()).unwrap_or_default().to_owned(),
        title: title.to_owned(),
        agent: agent.to_owned(),
        tokens: own.tokens,
        plan: own.plan.clone(),
        same_plan,
    })
}

/// The task and its subagents, summed: every token, and the plan share of the same plan only (Codex's weekly
/// isn't Claude's).
pub fn with_subs(own: &Own, subs: &[SubUsage]) -> Total {
    let mut plan = own.plan.clone();
    for (w, used) in subs.iter().filter(|s| s.same_plan).flat_map(|s| &s.plan) {
        *plan.entry(w.clone()).or_default() += used;
    }
    for x in plan.values_mut() {
        *x = tidy(*x);
    }
    Total { tokens: own.tokens + subs.iter().map(|s| s.tokens).sum::<u64>(), plan }
}
