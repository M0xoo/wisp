//! wisp.termctx (ADR-0023): the built-in terminals' read commands as `termctx.source@1` contributions,
//! `termctx.sources` (what the CLI runs, where the terminal is), and `terminal.failed`, a polled trigger source over
//! the opt-in shell hook's log (`<home>/term/<tty>.jsonl`): a command that exits non-zero in a tracked shell is an
//! event. No hook, no file, no events.

use std::collections::BTreeMap;
use std::sync::Arc;

use serde_json::{Value, json};
use wisp_automations_api::{Polled, SourceOn, TriggerEvent, TriggerSource};
use wisp_kernel::{BoxFuture, Ctx, Manifest, Plugin, Result, Setup, WireError};
use wisp_termctx_api::{Reader, SOURCE, Sources, TermSource};
use wisp_termctx_core as core;

#[derive(Debug, Default)]
pub struct TermctxPlugin;

struct Builtin(core::Source);

impl TermSource for Builtin {
    fn id(&self) -> &str {
        self.0.id
    }
    fn label(&self) -> &str {
        self.0.label
    }
    fn argv(&self, env: &BTreeMap<String, String>, lines: usize) -> Option<Vec<String>> {
        let m: std::collections::HashMap<String, String> = env.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        core::read_argv(self.0.id, &m, lines)
    }
}

/// The sources that are this terminal, in order, with their read commands.
pub fn readers(sources: &[Arc<dyn TermSource>], env: &BTreeMap<String, String>, lines: usize) -> Vec<Reader> {
    let env: BTreeMap<String, String> =
        env.iter().filter(|(k, _)| wisp_termctx_api::ENV_KEYS.contains(&k.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect();
    let n = if lines == 0 { core::LINES } else { lines.min(5_000) };
    sources.iter().filter_map(|s| s.argv(&env, n).map(|argv| Reader { id: s.id().to_owned(), label: s.label().to_owned(), argv })).collect()
}

/// `terminal.failed`: each tracked terminal's log, read from its cursor.
struct Failed(Ctx);

async fn poll(ctx: Ctx, spec: Value, cursor: Value) -> Result<Polled> {
    let dir = wisp_kernel::services::paths(&ctx)?.join("term");
    let now = ctx.clock()?.now_ms();
    let project = spec.get("project").and_then(Value::as_str).unwrap_or_default().to_owned();
    // no hook: nothing to watch, not a failure
    let Ok(mut rd) = tokio::fs::read_dir(&dir).await else { return Ok(Polled { events: Vec::new(), cursor, retry_at: None }) };
    let mut cur = cursor;
    let mut events = Vec::new();
    while let Ok(Some(e)) = rd.next_entry().await {
        let name = e.file_name().to_string_lossy().into_owned();
        let Some(tty) = name.strip_suffix(".jsonl") else { continue };
        let Ok(text) = tokio::fs::read_to_string(e.path()).await else { continue };
        let (evs, next) = core::failed_since(&core::parse_log(&text, now), &cur, tty);
        cur = next;
        for v in evs {
            let cwd = v.pointer("/payload/cwd").and_then(Value::as_str).unwrap_or_default();
            if !(project.is_empty() || cwd == project || cwd.starts_with(&format!("{}/", project.trim_end_matches('/')))) {
                continue;
            }
            events.push(TriggerEvent {
                on: "terminal.failed".into(),
                key: v["key"].as_str().unwrap_or_default().to_owned(),
                at: v["at"].as_i64().unwrap_or(now),
                summary: v["summary"].as_str().unwrap_or_default().to_owned(),
                payload: v["payload"].clone(),
                ..TriggerEvent::default()
            });
        }
    }
    Ok(Polled { events, cursor: cur, retry_at: None })
}

impl TriggerSource for Failed {
    fn plugin(&self) -> &'static str {
        wisp_termctx_api::PLUGIN_ID
    }
    fn ons(&self) -> Vec<SourceOn> {
        vec![SourceOn {
            on: "terminal.failed".into(),
            title: "A command failed in a tracked terminal".into(),
            fields: json!({ "type": "object", "properties": { "project": { "type": "string" }, "match": { "type": "object" } } }),
            mode: "poll".into(),
            every: Some(1),
        }]
    }
    fn poll(&self, _on: &str, spec: &Value, cursor: Value) -> BoxFuture<'static, Result<Polled>> {
        Box::pin(poll(self.0.clone(), spec.clone(), cursor))
    }
}

impl Plugin for TermctxPlugin {
    fn manifest(&self) -> Manifest {
        Manifest::embedded(include_str!("../wisp-plugin.json"))
    }

    fn setup(&self, s: &mut Setup) -> Result<()> {
        for src in core::SOURCES {
            let t: Arc<dyn TermSource> = Arc::new(Builtin(src));
            s.contribute(&SOURCE, t);
        }
        let f: Arc<dyn TriggerSource> = Arc::new(Failed(s.ctx()));
        s.contribute(&wisp_automations_api::SOURCE, f);
        s.command::<Sources, _, _>(|ctx, _call, a| async move {
            let all = ctx.contributions(&SOURCE);
            if all.is_empty() {
                return Err(WireError::unavailable("no terminal sources"));
            }
            Ok(readers(&all, &a.env, a.lines))
        });
        Ok(())
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn manifest_is_valid() {
        if let Err(e) = Manifest::parse(include_str!("../wisp-plugin.json")) {
            panic!("{}", e.message);
        }
        assert_eq!(TermctxPlugin.manifest().id, wisp_termctx_api::PLUGIN_ID);
    }

    #[test]
    fn readers_see_only_the_terminal_variables() {
        let all: Vec<Arc<dyn TermSource>> = core::SOURCES.iter().map(|s| Arc::new(Builtin(*s)) as Arc<dyn TermSource>).collect();
        let env: BTreeMap<String, String> = [("TMUX", "x"), ("TMUX_PANE", "%1"), ("AWS_SECRET_ACCESS_KEY", "nope")]
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        let r = readers(&all, &env, 0);
        assert_eq!(r.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), ["tmux"]);
        assert!(r[0].argv.contains(&"-200".to_owned()), "200 lines unless said");
        assert!(!r.iter().flat_map(|x| &x.argv).any(|a| a.contains("nope")));
    }
}
