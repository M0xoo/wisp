//! What an agent reads of the user's tasks (v1 routes/internal.js `/internal/sessions/:id`,
//! `/internal/session/:id`, `sessionLine`, `sessionText`): plain text it can quote. A capped agent
//! reads only its own task and the ones under it (the kernel's scope lets an `agent:session` read any).

use wisp_runtime_api::commands::{AgentSessionArgs, AgentSessionsArgs, AgentText, ListArgs};
use wisp_runtime_api::model::{Summary, TurnStatus};

use crate::error::Result;
use crate::runtime::Runtime;

/// v1 `age`: "5m ago", "3h ago", "2d ago" (Math.round of minutes, hours, days).
fn age(now: i64, t: i64) -> String {
    let round = |x: i64, d: i64| (x + d / 2).div_euclid(d);
    let m = round(now - t, 60_000);
    if m < 1 {
        "just now".into()
    } else if m < 60 {
        format!("{m}m ago")
    } else if m < 48 * 60 {
        format!("{}h ago", round(m, 60))
    } else {
        format!("{}d ago", round(m, 1440))
    }
}

fn clip(s: &str, n: usize) -> String {
    let t: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.chars().count() > n { format!("{}…", t.chars().take(n - 1).collect::<String>()) } else { t }
}

/// The state's wire name (`review`, `running`, …).
fn state(s: wisp_runtime_api::model::SessionState) -> String {
    serde_json::to_value(s).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default()
}

fn project(cwd: &str) -> &str {
    cwd.rsplit(['/', '\\']).find(|s| !s.is_empty()).unwrap_or(cwd)
}

fn line(x: &Summary, now: i64) -> String {
    let model = if x.model.is_empty() { String::new() } else { format!(" ({})", x.model) };
    let tail = if state(x.state) == "running" && !x.live.is_empty() { format!(": {}", x.live) } else if x.preview.is_empty() { String::new() } else { format!(": {}", clip(&x.preview, 160)) };
    format!("- `{}` **{}** — {}{}, {}{model}, {}, {}{tail}", x.id, x.title, if x.archived { "archived, " } else { "" }, state(x.state), x.agent, project(&x.cwd), age(now, x.updated_at))
}

impl Runtime {
    /// A capped agent's reads stay in its own tree (v1 read its project; the lead chose own task + children).
    async fn capped_sees(&self, asking: &str, id: &str, capped: bool) -> bool {
        !capped || self.under(id, asking).await
    }

    #[allow(clippy::cast_possible_truncation, clippy::cast_precision_loss)]
    pub async fn agent_sessions(&self, a: &AgentSessionsArgs, capped: bool) -> Result<AgentText> {
        let me = self.get(&a.session).await?;
        let now = self.now();
        let states: Option<Vec<String>> = a.state.as_ref().map(|s| s.split(',').map(|x| x.trim().to_owned()).collect());
        let words: Vec<String> = a.query.as_deref().unwrap_or("").to_lowercase().split_whitespace().map(|w| w.trim_start_matches('#').to_owned()).collect();
        let mut all = Vec::new();
        for x in self.list(&ListArgs::default()) {
            let parent = me.parent_id.as_ref().map(|p| p.0.as_str());
            if x.id.0 == a.session || x.parent_id.is_some() || x.agent == "wisp" || Some(x.id.0.as_str()) == parent {
                continue;
            }
            if (!a.archived.unwrap_or(false) && x.archived) || states.as_ref().is_some_and(|s| !s.iter().any(|st| *st == state(x.state))) {
                continue;
            }
            let hay = format!("{} {}", x.title, x.preview).to_lowercase();
            if !words.iter().all(|w| hay.contains(w.as_str())) || !self.capped_sees(&a.session, &x.id.0, capped).await {
                continue;
            }
            all.push(x);
        }
        all.sort_by_key(|x| std::cmp::Reverse(x.updated_at));
        let n = a.limit.unwrap_or(20).clamp(1, 100) as usize;
        let list: Vec<String> = all.iter().take(n).map(|x| line(x, now)).collect();
        let text = if list.is_empty() {
            "No tasks match.".to_owned()
        } else {
            let more = if all.len() > list.len() { format!(", the newest {}", list.len()) } else { String::new() };
            format!("{} task{}{more}. Read one with wisp_session; show one in your answer with a task block.\n\n{}", all.len(), if all.len() == 1 { "" } else { "s" }, list.join("\n"))
        };
        Ok(AgentText { text: Some(text), error: None })
    }

    pub async fn agent_session(&self, a: &AgentSessionArgs, capped: bool) -> Result<AgentText> {
        let id = a.of.trim().trim_start_matches("wisp:");
        let missing = || AgentText { text: Some(format!("No wisp task `{id}` on this computer. It may have been deleted, or it ran on another machine. List tasks with wisp_sessions.")), error: None };
        let Ok(x) = self.get(id).await else { return Ok(missing()) };
        if !self.capped_sees(&a.session, id, capped).await {
            return Ok(AgentText { text: Some("Refused: this task was started with a mode cap, so it reads only its own task and the ones under it.".into()), error: None });
        }
        let turns = self.turns(id, None, None).await?;
        let now = self.now();
        let model = if x.model.is_empty() { String::new() } else { format!(" ({})", x.model) };
        let mut out = vec![format!("# {}", x.title), format!("Task `{}` · {}{} · {}{model} · project {} · updated {}", x.id, if x.archived { "archived · " } else { "" }, state(x.state), x.agent, project(&x.cwd), age(now, x.updated_at)), format!("Folder: `{}`", x.cwd)];
        let asks: Vec<String> = turns
            .iter()
            .enumerate()
            .map(|(i, t)| {
                let note = match t.status {
                    TurnStatus::Running => " _(running)_",
                    TurnStatus::Error => " _(failed)_",
                    TurnStatus::Stopped => " _(stopped)_",
                    _ => "",
                };
                format!("{}. {}{note}", i + 1, clip(&t.prompt, 300))
            })
            .collect();
        let pick = a.turn.filter(|n| *n > 0).map_or_else(|| turns.last(), |n| turns.get(n as usize - 1));
        let Some(t) = pick else {
            out.extend([String::new(), format!("Turn {} doesn't exist; this task has {}.", a.turn.unwrap_or(0), turns.len()), String::new(), "## Requests".into()]);
            out.extend(asks);
            return Ok(AgentText { text: Some(out.join("\n")), error: None });
        };
        let i = turns.iter().position(|x| x.id == t.id).unwrap_or(0);
        out.extend([String::new(), format!("## Turn {} of {}", i + 1, turns.len()), format!("Asked: {}", clip(&t.prompt, 600)), String::new()]);
        out.push(t.text.clone().unwrap_or_else(|| "(no answer yet)".into()));
        out.extend([String::new(), "## Requests".into()]);
        out.extend(asks);
        Ok(AgentText { text: Some(out.join("\n")), error: None })
    }
}
