//! Task and My Stuff mentions in a prompt (v1 server/mentions.js `agentPrompt`): `@[Title](wisp:<id>)` points at
//! another task, `@[Logo](stuff:<id>)` at something in My Stuff. The agent gets `@Title (wisp task <id>)` and a note
//! on each task (how to read it with `wisp_session`, or its latest report inline for a run that can't take wisp's
//! tools), and what `runtime.prompt@1` expansions add (My Stuff's paths and text, by the stuff plugin).

use wisp_runtime_api::harness::HarnessInfo;
use wisp_runtime_api::model::{Session, Turn};
use wisp_runtime_core::blocks::render::Context;
use wisp_runtime_core::prompt::mentions::{MentionedTask, agent_prompt, mentions_in, stuff_in};

use crate::runtime::Runtime;

/// How this harness names wisp's `wisp_session` tool (beside its ask tool), or None without wisp's tools.
pub fn session_tool(info: &HarnessInfo) -> Option<String> {
    info.ask_tool
        .as_deref()
        .map(|a| a.rsplit_once("ask_user").map_or_else(|| "wisp_session".to_owned(), |(pre, _)| format!("{pre}wisp_session")))
}

impl Runtime {
    /// The things from My Stuff the prompt points at (v1 `stuffNote`): each as `stuff.describe` says it (its path,
    /// a doc's text), so the agent can use it, or save a new version with `wisp_save` when it has the tool.
    async fn stuff_note(&self, found: &[wisp_runtime_core::prompt::mentions::Mention], tools: bool) -> String {
        let mut lines = Vec::new();
        for m in found {
            let text = match crate::calls::run::<wisp_stuff_api::commands::Describe>(
                &*self.host,
                wisp_stuff_api::commands::Id { id: m.id.clone() },
            )
            .await
            {
                Ok(t) => t.map(|t| t.text),
                Err(err) => {
                    tracing::warn!(error = %err.message, stuff = %m.id, "runtime: stuff.describe");
                    None
                }
            };
            lines.push(text.unwrap_or_else(|| format!("- `{}` ({}): no longer in My Stuff.", m.id, m.title)));
        }
        let how = if tools {
            "Use them from these paths. To change one for the user, save the new version with wisp_save and its id."
        } else {
            "Use them from these paths; leave the copies there as they are."
        };
        format!("\n\n<wisp-stuff>\nThe user points at things they kept in My Stuff. {how}\n{}\n</wisp-stuff>", lines.join("\n"))
    }

    /// A turn's prompt with its mentions expanded (unchanged when it mentions nothing).
    pub(crate) async fn with_mentions(&self, s: &Session, t: &Turn, info: &HarnessInfo) -> String {
        let (tasks, stuff) = (mentions_in(&t.prompt), stuff_in(&t.prompt));
        if tasks.is_empty() && stuff.is_empty() {
            return t.prompt.clone();
        }
        let tool = session_tool(info);
        let mut found = Vec::new();
        for m in tasks.iter().filter(|m| m.id != s.id.0) {
            let Ok(x) = self.repo.session(&m.id).await else { continue };
            let turns = self.repo.turns(&m.id, None, None).await.unwrap_or_default();
            // the report goes in only for a run without wisp's tools
            let report = if tool.is_none() {
                turns
                    .iter()
                    .rev()
                    .find_map(|t| t.presentation.as_ref())
                    .map(|p| {
                        wisp_runtime_core::blocks::blocks_to_markdown(&p.blocks, &Context { changes: &[], approval: None, summary: None })
                    })
                    .unwrap_or_default()
            } else {
                String::new()
            };
            let folder = x
                .ext
                .get("wisp.worktrees")
                .and_then(|w| w.get("path"))
                .and_then(serde_json::Value::as_str)
                .map_or_else(|| x.cwd.clone(), str::to_owned);
            found.push(MentionedTask {
                id: x.id.0.clone(),
                title: x.title.clone(),
                state: serde_json::to_value(x.state).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default(),
                agent: x.agent.clone(),
                turns: turns.len(),
                folder,
                report,
            });
        }
        let mut extra: String = self.host.prompt_parts().iter().map(|p| p.expand(&t.prompt, s, tool.is_some())).collect();
        if !stuff.is_empty() {
            extra.push_str(&self.stuff_note(&stuff, tool.is_some()).await);
        }
        agent_prompt(&t.prompt, &found, tool.as_deref(), &s.id.0, &extra)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_session_tool_sits_beside_the_ask_tool() {
        let mut info = HarnessInfo { ask_tool: Some("mcp__wisp__ask_user".into()), ..HarnessInfo::default() };
        assert_eq!(session_tool(&info).as_deref(), Some("mcp__wisp__wisp_session"));
        info.ask_tool = None;
        assert_eq!(session_tool(&info), None, "no wisp tools: reports go inline");
    }
}
