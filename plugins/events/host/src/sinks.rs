//! Sinks (ADR-0044, `events.sink@1`): durable events forwarded somewhere else, each sink configured in the
//! `events.sinks` setting (`[{ name, kind, url, match, secret }]`). One durable subscription (`sinks`) feeds
//! them all, so a restart or wisp being off loses nothing.
//!
//! - **Tries:** each event gets a try, then one per wait in `backoffMs` (1 s, 5 s, 30 s by default).
//! - **Pause:** after `pauseAfter` events in a row that failed every try (5 by default) the sink pauses:
//!   it takes nothing more until `events.resume`, and its status says why.
//! - **The webhook** (`kind: webhook`): a POST of the event as `wisp events tail --json` shows it, with
//!   `x-wisp-event` (its type), `x-wisp-delivery` (its seq) and, with a secret, `x-wisp-signature:
//!   sha256=<hex HMAC-SHA256 of the body>` (GitHub's scheme, so receivers already know how to check it).
use std::sync::Arc;
use std::time::Duration;

use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::Sha256;
use wisp_events_api::{self as api, EventSink, SINK, SinkConfig};
use wisp_kernel::{BoxFuture, Ctx, EventEnvelope, Result, Setup, WireError};
use wisp_store::Row;

const DEFAULT_BACKOFF: [u64; 3] = [1_000, 5_000, 30_000];
const DEFAULT_PAUSE: u32 = 5;

/// How a sink is doing (`events.sinksStatus`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SinkState {
    pub name: String,
    /// events in a row that failed every try
    pub failures: u32,
    pub paused: bool,
    #[serde(default)]
    pub last_error: String,
    pub delivered: u64,
}

/// `sha256=<hex>` of `body` under `secret`.
pub fn signature(secret: &str, body: &[u8]) -> String {
    let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(secret.as_bytes()) else { return String::new() };
    mac.update(body);
    let out = mac.finalize().into_bytes();
    let mut hex = String::with_capacity(71);
    hex.push_str("sha256=");
    for b in out {
        hex.push(char::from(b"0123456789abcdef"[usize::from(b >> 4)]));
        hex.push(char::from(b"0123456789abcdef"[usize::from(b & 15)]));
    }
    hex
}

struct Webhook(Ctx);

impl EventSink for Webhook {
    fn kind(&self) -> &'static str {
        "webhook"
    }
    fn send(&self, cfg: SinkConfig, event: Value, secret: Option<String>) -> BoxFuture<'static, Result<()>> {
        let ctx = self.0.clone();
        Box::pin(async move {
            if !(cfg.url.starts_with("https://") || cfg.url.starts_with("http://")) {
                return Err(WireError::invalid(format!("{}: url must be http(s)", cfg.name)));
            }
            let body = serde_json::to_vec(&event).map_err(|e| WireError::internal(e.to_string()))?;
            let mut headers = vec![
                ("content-type".to_owned(), "application/json".to_owned()),
                ("x-wisp-event".to_owned(), event["type"].as_str().unwrap_or_default().to_owned()),
                ("x-wisp-delivery".to_owned(), event["seq"].to_string()),
            ];
            if let Some(s) = secret.filter(|s| !s.is_empty()) {
                headers.push(("x-wisp-signature".to_owned(), signature(&s, &body)));
            }
            let net = wisp_kernel::services::net(&ctx)?;
            let r = net
                .fetch(wisp_kernel::services::NetRequest { method: "POST".into(), url: cfg.url.clone(), headers, body, timeout_ms: 10_000 })
                .await?;
            if (200..300).contains(&r.status) { Ok(()) } else { Err(WireError::unavailable(format!("{} answered {}", cfg.name, r.status))) }
        })
    }
}

fn store(ctx: &Ctx) -> Result<wisp_store::Store> {
    Ok(ctx.service::<wisp_store::Store>()?.as_ref().clone())
}

fn configs(ctx: &Ctx) -> Vec<SinkConfig> {
    ctx.setting(api::SINKS).and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default()
}

async fn state_of(ctx: &Ctx, name: &str) -> SinkState {
    let id = name.to_owned();
    let got = match store(ctx) {
        Ok(s) => s.read_async(move |r| r.get(crate::SINK_STATE.kind, id.as_str())).await.ok().flatten(),
        Err(_) => None,
    };
    got.and_then(|r| r.get("body").cloned())
        .and_then(|b| serde_json::from_value(b).ok())
        .unwrap_or_else(|| SinkState { name: name.to_owned(), ..SinkState::default() })
}

async fn save(ctx: &Ctx, st: &SinkState) -> Result<()> {
    let mut row = Row::new();
    row.insert("id".into(), json!(st.name));
    row.insert("body".into(), serde_json::to_value(st).unwrap_or_default());
    store(ctx)?.write(move |w| w.upsert(crate::SINK_STATE.kind, row).map(|_| ())).await.map_err(|e| WireError::internal(e.to_string()))
}

/// One event to every sink that takes it.
async fn forward(ctx: &Ctx, e: &EventEnvelope) -> Result<()> {
    if e.ty == wisp_kernel::durable::GAP {
        return Ok(());
    }
    let sinks: Vec<Arc<dyn EventSink>> = ctx.contributions(&SINK);
    let event = json!({ "seq": e.durable_seq, "type": e.ty, "plugin": e.plugin, "subject": e.subject, "key": e.key, "cause": e.cause, "root": e.root, "at": e.at, "data": e.data() });
    for cfg in configs(ctx) {
        if !wisp_kernel::perm::glob(&cfg.matches, &e.ty) {
            continue;
        }
        let mut st = state_of(ctx, &cfg.name).await;
        if st.paused {
            continue;
        }
        let Some(sink) = sinks.iter().find(|s| s.kind() == cfg.kind) else {
            st.last_error = format!("no sink of kind {}", cfg.kind);
            save(ctx, &st).await?;
            continue;
        };
        let secret = match &cfg.secret {
            Some(n) => wisp_kernel::services::secrets(ctx)?.get(n).await?,
            None => None,
        };
        let waits = cfg.backoff_ms.clone().unwrap_or_else(|| DEFAULT_BACKOFF.to_vec());
        let mut last = String::new();
        let mut ok = false;
        for attempt in 0..=waits.len() {
            match sink.send(cfg.clone(), event.clone(), secret.clone()).await {
                Ok(()) => {
                    ok = true;
                    break;
                }
                Err(err) => last = err.message,
            }
            if let Some(w) = waits.get(attempt) {
                tokio::time::sleep(Duration::from_millis(*w)).await;
            }
        }
        if ok {
            st.failures = 0;
            st.delivered += 1;
            st.last_error.clear();
        } else {
            st.failures += 1;
            st.last_error = last;
            if st.failures >= cfg.pause_after.unwrap_or(DEFAULT_PAUSE) {
                st.paused = true;
                tracing::warn!(sink = %cfg.name, "event sink paused after {} failed events: {}", st.failures, st.last_error);
            }
        }
        save(ctx, &st).await?;
    }
    Ok(())
}

pub fn register(s: &mut Setup) {
    let hook: Arc<dyn EventSink> = Arc::new(Webhook(s.ctx()));
    s.contribute(&SINK, hook);
    s.on_durable_any("sinks", "*", |ctx, _call, e| async move { forward(&ctx, &e).await });
    s.command::<api::Sinks, _, _>(|ctx, _call, _a| async move {
        let mut out = Vec::new();
        for c in configs(&ctx) {
            let st = state_of(&ctx, &c.name).await;
            out.push(json!({ "name": c.name, "kind": c.kind, "match": c.matches, "url": c.url, "state": st }));
        }
        Ok(Value::Array(out))
    });
    s.command::<api::Resume, _, _>(|ctx, _call, a| async move {
        let mut st = state_of(&ctx, &a.name).await;
        st.paused = false;
        st.failures = 0;
        save(&ctx, &st).await?;
        Ok(serde_json::to_value(&st).unwrap_or_default())
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_signature_is_githubs_scheme() {
        // RFC 4231 test case 2's key and data
        assert_eq!(
            signature("Jefe", b"what do ya want for nothing?"),
            "sha256=5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }
}
