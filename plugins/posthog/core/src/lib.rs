//! wisp.posthog core (sans-IO): where and how wisp's telemetry batches reach `PostHog`, as v1 sent them
//! (server/telemetry.js `postBatch`): `POST <host>/batch/` with `{ api_key, batch }`. The only crate that
//! knows `PostHog` (ADR-0021).

use std::collections::BTreeMap;

use serde_json::{Value, json};

/// `PostHog` project API key: write-only, safe to ship in the client (v1's).
pub const DEFAULT_KEY: &str = "phc_wowwZkbP8e4zYuwT67JtX6oxdPwkMWL5kKnrUmYYXhcD";
pub const DEFAULT_HOST: &str = "https://us.i.posthog.com";

pub type Env = BTreeMap<String, String>;

/// The key, as v1 read it: `WISP_POSTHOG_KEY` wins, even empty (an empty one sends nothing).
pub fn key_of(env: &Env) -> &str {
    env.get("WISP_POSTHOG_KEY").map_or(DEFAULT_KEY, String::as_str)
}

pub fn host_of(env: &Env) -> String {
    let h = env.get("WISP_POSTHOG_HOST").map(String::as_str).filter(|h| !h.is_empty()).unwrap_or(DEFAULT_HOST);
    h.strip_suffix('/').unwrap_or(h).to_owned()
}

/// `PostHog`'s batch endpoint.
pub fn batch_url(env: &Env) -> String {
    format!("{}/batch/", host_of(env))
}

/// The request body; None with no key (nothing goes).
pub fn batch_body(env: &Env, batch: &[Value]) -> Option<Vec<u8>> {
    let key = key_of(env);
    (!key.is_empty()).then(|| serde_json::to_vec(&json!({ "api_key": key, "batch": batch })).unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e(kv: &[(&str, &str)]) -> Env {
        kv.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect()
    }

    #[test]
    fn v1s_endpoint_key_and_payload() {
        assert_eq!(host_of(&e(&[("WISP_POSTHOG_HOST", "https://eu.i.posthog.com/")])), "https://eu.i.posthog.com");
        assert_eq!(batch_url(&e(&[])), "https://us.i.posthog.com/batch/");
        let body: Value = serde_json::from_slice(&batch_body(&e(&[]), &[json!({ "event": "x" })]).unwrap_or_default()).unwrap_or_default();
        assert_eq!((body["api_key"].as_str(), body["batch"][0]["event"].as_str()), (Some(DEFAULT_KEY), Some("x")));
        assert_eq!(batch_body(&e(&[("WISP_POSTHOG_KEY", "")]), &[]), None, "no key: nothing goes (v1)");
    }
}
