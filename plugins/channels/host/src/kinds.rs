//! wisp.channels' resource kinds (ADR-0028): channels (Telegram, Slack, Discord, GitHub, email, ntfy)
//! and notifications (what notifies where). Acted on: applying a channel gives its transport its config
//! (`${secret:}` read, in memory only) and starts it when it's on (off by default), stops it when it's
//! off or gone; a notification sends its events to a channel or a webhook. A channel changes who may
//! start work, so it is sensitive.

use std::sync::{Arc, Mutex};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use wisp_kernel::{BoxFuture, Call, Ctx, Result, Setup};
use wisp_resources_api::{KindInfo, Op, OpKind, RESOURCE_KIND, Resource, ResourceKind, StoredKind, schema_of};

/// A channel: where people talk to wisp and hear back from it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelSpec {
    /// telegram | slack | discord | github | email | ntfy
    pub transport: String,
    /// off by default: nothing is received or sent until it's on
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// its bot token or key, as `${secret:NAME}`
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub token: String,
    /// who may speak to it (chat ids, user names, addresses)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allow: Vec<String>,
    /// the most a message may start: plan | edits (never auto)
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub cap: String,
    /// the transport's own settings (ntfy: `server`, `topic`; Slack: `appToken`…), merged into its
    /// config; where its tasks run (a project or machine), and thread rules
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub routing: Option<Value>,
}

/// What notifies where: events to a channel or a webhook (v1 `notify`, `drainWatch`, `webhookTriggers`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct NotificationSpec {
    /// events: `finished`, `asks`, `failed`, `limit`, `drain`, a trigger's name
    pub on: Vec<String>,
    /// a channel's name, or a webhook URL
    pub to: String,
    /// only for these projects (empty: every one)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub projects: Vec<String>,
}

pub type Notifications = Arc<Mutex<Vec<(String, NotificationSpec)>>>;
pub type Channels = Arc<Mutex<Vec<(String, ChannelSpec)>>>;

/// `${secret:NAME}` read from secrets (an unknown one stays as it is).
pub async fn reveal(ctx: &Ctx, text: &str) -> String {
    let mut out = text.to_owned();
    let Ok(secrets) = wisp_kernel::services::secrets(ctx) else { return out };
    while let Some(a) = out.find("${secret:") {
        let Some(b) = out[a..].find('}') else { break };
        let name = out[a + 9..a + b].to_owned();
        let Ok(Some(v)) = secrets.get(&name).await else { break };
        out.replace_range(a..=a + b, &v);
    }
    out
}

/// A `${secret:NAME}` value read from secrets; one that isn't there reads as nothing (never the reference itself,
/// which a transport would take for the token).
pub async fn reveal_or_empty(ctx: &Ctx, text: &str) -> String {
    let out = reveal(ctx, text).await;
    if out.contains("${secret:") { String::new() } else { out }
}

/// Re-reads the declared channels and notifications, then has the hub act on them.
pub type OnChange = Arc<dyn Fn() -> BoxFuture<'static, ()> + Send + Sync>;

struct Kind {
    inner: Arc<StoredKind>,
    after: OnChange,
}

impl ResourceKind for Kind {
    fn info(&self) -> KindInfo {
        self.inner.info()
    }
    fn read<'a>(&'a self, call: &'a Call) -> BoxFuture<'a, Result<Vec<Resource>>> {
        self.inner.read(call)
    }
    fn describe(&self, op: &Op) -> Option<String> {
        (self.inner.info.kind == "channel" && op.op != OpKind::Delete && op.spec.get("enabled") == Some(&Value::Bool(true))).then(|| {
            format!(
                "turns on the {} channel {}: messages there can start tasks",
                op.spec.get("transport").and_then(Value::as_str).unwrap_or("?"),
                op.name
            )
        })
    }
    fn apply<'a>(&'a self, call: &'a Call, op: &'a Op) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            self.inner.apply(call, op).await?;
            (self.after)().await;
            Ok(())
        })
    }
}

pub struct Kinds {
    pub channels: Arc<StoredKind>,
    pub notifications: Arc<StoredKind>,
}

/// Re-reads the declared channels and notifications. Returns the transports some channel names, read raw (a spec
/// that doesn't parse still names its transport), or `None` when the channels couldn't be read: neither is a sign
/// that a channel was removed.
pub async fn read(k: &Kinds, ch: &Channels, no: &Notifications) -> Option<Vec<String>> {
    let specs = k.channels.specs().await;
    let named = specs.as_ref().ok().map(|s| s.iter().filter_map(|(_, v)| Some(v.get("transport")?.as_str()?.to_owned())).collect());
    let c = specs.unwrap_or_default().into_iter().filter_map(|(n, v)| Some((n, serde_json::from_value(v).ok()?))).collect();
    let n = k
        .notifications
        .specs()
        .await
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(n, v)| Some((n, serde_json::from_value(v).ok()?)))
        .collect();
    *ch.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = c;
    *no.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = n;
    named
}

pub fn register(s: &mut Setup, after: &OnChange) -> Arc<Kinds> {
    let ctx = s.ctx();
    let channels = Arc::new(StoredKind::new(
        KindInfo::new("channel", "channels", "wisp.channels", schema_of::<ChannelSpec>()).order(40).sensitive(),
        ctx.clone(),
    ));
    let notifications = Arc::new(StoredKind::new(
        KindInfo::new("notification", "notifications", "wisp.channels", schema_of::<NotificationSpec>()).order(45),
        ctx,
    ));
    for inner in [channels.clone(), notifications.clone()] {
        let k: Arc<dyn ResourceKind> = Arc::new(Kind { inner, after: after.clone() });
        s.contribute(&RESOURCE_KIND, k);
    }
    Arc::new(Kinds { channels, notifications })
}

/// A re-read channel's config: what its transport kept for itself (Telegram's linked chat, a poll offset, a
/// webhook's secret) stays under the declared fields, so applying any channel doesn't unlink this one. Another
/// token is another bot: nothing kept about the old one carries over. `before`: the keys declared last time, so
/// one taken out of the declaration goes too (only what the transport wrote itself stays).
pub fn keep_over(kept: Value, declared: Value, before: &[String]) -> Value {
    let (Value::Object(mut out), Value::Object(d)) = (kept, declared.clone()) else { return declared };
    if ["token", "botToken"].iter().any(|k| out.get(*k) != d.get(*k)) {
        return declared;
    }
    out.retain(|k, _| !before.contains(k));
    out.extend(d);
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::keep_over;

    #[test]
    fn applying_a_channel_again_keeps_what_its_transport_kept_unless_its_token_changed() {
        let kept = json!({ "token": "t1", "enabled": true, "allow": ["y"], "chatId": 42, "offset": 9 });
        let before = ["token".to_owned(), "enabled".to_owned(), "allow".to_owned()];
        let again = keep_over(kept.clone(), json!({ "token": "t1", "enabled": true, "allow": ["x"] }), &before);
        assert_eq!((again["chatId"].as_i64(), again["offset"].as_i64(), again["allow"][0].as_str()), (Some(42), Some(9), Some("x")));
        let off = keep_over(kept.clone(), json!({ "token": "t1", "enabled": false }), &before);
        assert_eq!(off["enabled"], false, "what's declared wins");
        assert!(off.get("allow").is_none(), "a key taken out of the declaration goes");
        assert_eq!(off["chatId"], 42);
        let other = keep_over(kept, json!({ "token": "t2", "enabled": true }), &before);
        assert!(other.get("chatId").is_none(), "another bot: linked afresh");
        assert_eq!(keep_over(Value::Null, json!({ "token": "t" }), &[]), json!({ "token": "t" }));
    }
}
