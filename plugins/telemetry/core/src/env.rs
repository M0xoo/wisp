//! Who may send (v1 server/telemetry.js, unchanged). Usage stats are off when any of: no API key,
//! `DO_NOT_TRACK=1`, `WISP_TELEMETRY=0`, `CI`, or the Settings switch (`telemetry: "off"`). Feedback is
//! different: the user hands it to us on purpose, so only `WISP_FEEDBACK=0` stops it (a sink with no key sends nothing: the `PostHog` sink's rule, ADR-0021).

use std::collections::BTreeMap;

/// `PostHog` project API key: write-only, safe to ship in the client.
pub const FLUSH_MS: u64 = 15_000;
pub const MAX_QUEUE: usize = 50;
pub const TIMEOUT_MS: u64 = 3000;
pub const FEEDBACK_MAX: usize = 4000;
pub const OUTBOX_MAX: usize = 100;
pub const PENDING_MAX: usize = 200;

/// The environment variables that matter, read once at start. A missing key is `None`; an empty one is
/// `Some("")`.
pub type Env = BTreeMap<String, String>;

fn get<'a>(env: &'a Env, k: &str) -> Option<&'a str> {
    env.get(k).map(String::as_str)
}

fn off_word(v: &str) -> bool {
    matches!(v.to_ascii_lowercase().as_str(), "0" | "false" | "no" | "off")
}

/// v1 `truthy`: set, non-empty and not 0/false/no/off.
pub fn truthy(v: Option<&str>) -> bool {
    v.is_some_and(|v| !v.is_empty() && !off_word(v))
}

/// v1 `falsy`: 0/false/no/off (unset is not falsy).
pub fn falsy(v: Option<&str>) -> bool {
    v.is_some_and(off_word)
}

/// Usage stats are off (v1 `envDisabled`, less its "no key": the key is the `PostHog` sink's, ADR-0021).
pub fn env_disabled(env: &Env) -> bool {
    truthy(get(env, "DO_NOT_TRACK")) || falsy(get(env, "WISP_TELEMETRY")) || truthy(get(env, "CI"))
}

pub fn feedback_available(env: &Env) -> bool {
    !falsy(get(env, "WISP_FEEDBACK"))
}

/// Which shell wisp runs in, as v1 reported it.
pub fn shell_of(env: &Env) -> &'static str {
    if get(env, "WISP_DESKTOP") == Some("tauri") {
        "tauri"
    } else if get(env, "WISP_GRID_URL").is_some_and(|v| !v.is_empty()) {
        "grid"
    } else {
        "browser"
    }
}

/// The Settings switch: anything but "off" (unset included) is on.
pub fn setting_on(value: Option<&serde_json::Value>) -> bool {
    value.and_then(serde_json::Value::as_str) != Some("off")
}

/// The first-run line the edge prints once it listens.
pub const NOTICE: &str = "wisp sends anonymous usage stats and error reports (no prompts, paths or code). Opt out: Settings, or WISP_TELEMETRY=0 / DO_NOT_TRACK=1.";
