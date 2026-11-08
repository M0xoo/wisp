//! wisp.posthog: wisp.telemetry's batches to `PostHog`, over its plain HTTP batch API (v1
//! server/telemetry.js `postBatch`, 3 s budget, a failure dropped). One `telemetry.sink@1`; turning
//! this plugin off leaves the pipeline and every other sink as they are (ADR-0021).

use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use wisp_kernel::{BoxFuture, Manifest, Plugin, Result, Setup};
use wisp_posthog_core::{Env, batch_body, batch_url};
use wisp_telemetry_api::{SINK, Sink};

struct PostHog {
    env: Env,
    http: reqwest::Client,
}

impl Sink for PostHog {
    fn id(&self) -> &'static str {
        "posthog"
    }

    fn send(&self, batch: Vec<Value>) -> BoxFuture<'static, bool> {
        let (url, body, http) = (batch_url(&self.env), batch_body(&self.env, &batch), self.http.clone());
        Box::pin(async move {
            let Some(body) = body else { return false };
            matches!(http.post(url).header("content-type", "application/json").body(body).send().await, Ok(r) if r.status().is_success())
        })
    }
}

#[derive(Debug, Default)]
pub struct PostHogPlugin;

impl Plugin for PostHogPlugin {
    fn manifest(&self) -> Manifest {
        Manifest::embedded(include_str!("../wisp-plugin.json"))
    }

    fn setup(&self, s: &mut Setup) -> Result<()> {
        let env: Env = ["WISP_POSTHOG_KEY", "WISP_POSTHOG_HOST"].iter().filter_map(|k| std::env::var(k).ok().map(|v| ((*k).to_owned(), v))).collect();
        let http = reqwest::Client::builder().timeout(Duration::from_millis(3000)).build().unwrap_or_default();
        s.contribute(&SINK, Arc::new(PostHog { env, http }) as Arc<dyn Sink>);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_is_valid() {
        assert_eq!(PostHogPlugin.manifest().id, "wisp.posthog");
    }
}
