//! wisp-ntfy: the ntfy transport for wisp.channels (v1 `channels/ntfy.js`). A notification posts to the
//! topic with up to 3 signed buttons; a tap makes the ntfy app POST the signed answer to `<topic>-reply`,
//! which this polls (every few seconds while it's on) and hands to the hub once, verified. The wire's
//! decisions are `wisp-ntfy-core`'s; every request goes through the hub's `Net`. Off unless a `channel`
//! resource with `transport: ntfy` is on (`routing: { server, topic }`, `token` for a protected topic).

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{Value, json};
use wisp_channels_api::views::{ActArgs, ActionKind, Msg, SessionView};
use wisp_channels_api::{ChannelHub, HttpRequest, Status, TRANSPORTS, Transport, TransportDef, TransportKind};
use wisp_kernel::{CancellationToken, Manifest, Plugin, Result, Setup, WireError};
use wisp_ntfy_core::{Ntfy, parse_poll, parse_tap, poll_url, publish_body};

/// How often replies are read while it's on.
const POLL_MS: u64 = 3000;

#[derive(Debug, Default)]
pub struct NtfyPlugin;

struct Def;
impl TransportDef for Def {
    fn name(&self) -> &'static str {
        "ntfy"
    }
    fn create(&self, hub: Arc<dyn ChannelHub>) -> Arc<dyn Transport> {
        Arc::new(NtfyTransport { hub })
    }
}

struct NtfyTransport {
    hub: Arc<dyn ChannelHub>,
}

impl NtfyTransport {
    fn cfg(&self) -> Ntfy {
        let mut v = self.hub.cfg("ntfy");
        // the channel resource says `enabled`; ntfy's own config reads the same key
        if v.get("enabled").is_none() {
            v["enabled"] = json!(false);
        }
        Ntfy::from_value(&v)
    }

    fn mark(&self, error: Option<String>) {
        self.hub.mark("ntfy", Status { ok: Some(error.is_none()), error, at: Some(self.hub.now_ms()), ..Status::default() });
    }

    /// One read of `<topic>-reply`: each new verified tap goes to the hub, then the cursor moves on.
    async fn poll_once(&self) {
        let mut cfg = self.cfg();
        let place = cfg.place();
        let mut cursor = cfg.cursor();
        if cursor.begin(self.hub.now_ms() / 1000) {
            cfg.keep(&cursor);
            self.hub.set_cfg("ntfy", json!({ "since": cfg.since, "seen": cfg.seen }));
        }
        let mut req = HttpRequest::get(poll_url(&place, cursor.since())).timeout(10_000);
        for (k, v) in place.headers() {
            req = req.header(&k, v);
        }
        let r = match self.hub.net().fetch(req).await {
            Ok(r) if r.ok() => r,
            Ok(r) => return self.mark(Some(format!("ntfy answered {}", r.status))),
            Err(e) => return self.mark(Some(e.to_string())),
        };
        let (msgs, bad) = parse_poll(&r.text());
        self.mark((bad > 0).then(|| format!("{bad} lines of the poll weren't ntfy's")));
        for m in msgs {
            if !cursor.first(&m.id) {
                continue;
            }
            if let Some(tap) = parse_tap(&m).filter(|t| self.hub.verify(t))
                && let Some(kind) = ActionKind::from_code(&tap.k)
            {
                let a = ActArgs {
                    session_id: tap.s.clone(),
                    kind: kind.into(),
                    reference: Some(tap.r.clone()),
                    index: Some(tap.i),
                    text: None,
                    approvals: false,
                };
                if let Err(e) = self.hub.act(&a).await {
                    self.hub.warn(&format!("ntfy: a tap on {} didn't act: {}", tap.s, e.message));
                }
            }
            cursor.handled(&m.id);
            cfg.keep(&cursor);
            self.hub.set_cfg("ntfy", json!({ "since": cfg.since, "seen": cfg.seen }));
        }
    }
}

#[async_trait]
impl Transport for NtfyTransport {
    fn name(&self) -> &'static str {
        "ntfy"
    }
    fn ready(&self) -> bool {
        self.cfg().ready()
    }
    fn kind(&self) -> TransportKind {
        TransportKind::Phone
    }
    async fn start(&self, stop: CancellationToken) {
        while !stop.is_cancelled() && self.ready() {
            self.poll_once().await;
            tokio::select! {
                () = stop.cancelled() => break,
                () = self.hub.sleep(POLL_MS) => {}
            }
        }
    }
    async fn publish(&self, msg: &Msg, s: Option<&SessionView>) -> Result<()> {
        let cfg = self.cfg();
        if !cfg.ready() {
            return Err(WireError::unavailable("ntfy is off or has no topic"));
        }
        let place = cfg.place();
        let hub = self.hub.clone();
        let sign = move |sid: &str, a: &wisp_channels_api::views::Action| hub.sign(sid, a.kind, &a.reference, a.index);
        let body = publish_body(&place, msg, s.map(|s| s.id.as_str()), &sign);
        let mut req = HttpRequest::post_json(place.server.clone(), &body).timeout(10_000);
        for (k, v) in place.headers() {
            req = req.header(&k, v);
        }
        let r = self.hub.net().fetch(req).await.map_err(|e| WireError::unavailable(format!("ntfy: {e}")))?;
        if r.ok() { Ok(()) } else { Err(WireError::unavailable(format!("ntfy answered {}: {}", r.status, r.text()))) }
    }
    fn view(&self) -> Option<Value> {
        Some(self.cfg().view())
    }
}

impl Plugin for NtfyPlugin {
    fn manifest(&self) -> Manifest {
        Manifest::embedded(include_str!("../wisp-plugin.json"))
    }

    fn setup(&self, s: &mut Setup) -> Result<()> {
        let d: Arc<dyn TransportDef> = Arc::new(Def);
        s.contribute(&TRANSPORTS, d);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_is_valid() {
        assert_eq!(NtfyPlugin.manifest().id, "wisp.ntfy");
    }
}
