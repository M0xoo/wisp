//! Task features (v1 router.js:56-75) and telling limits apart (router.js:178-217): a coarse kind of
//! task the router learns per, a size bucket, and whether a run's error is the harness being
//! unavailable (a usage window, a rate limit, too many devices, no capacity) rather than the model
//! getting the task wrong.

use std::sync::OnceLock;

use regex::Regex;
use wisp_router_api::{Limit, LimitKind, LimitScope, Window};

const MINUTE: i64 = 60_000;
const HOUR: i64 = 60 * MINUTE;
const DAY: i64 = 24 * HOUR;
/// A Codex 429 while its plan has room: a one-minute pause (v1 router.js:198).
pub const BLIP_MS: i64 = MINUTE;
/// The longest any limit cools an arm: a stated reset further away than this is capped.
pub const MAX_COOL_MS: i64 = 6 * HOUR;

const RULES: [(&str, &str); 7] = [
    ("release", r"(?i)\b(release|bump(ed)? (the )?version|publish|changelog for|tag v?\d)"),
    ("docs", r"(?i)\b(readme|docs?|documentation|typos?|comment(s)? in|jsdoc|docstring)\b"),
    ("test", r"(?i)\b(tests?|coverage|flaky|spec(s)?|e2e|unit test)\b"),
    ("bug", r"(?i)\b(fix|bug|broken|crash(es|ing)?|error|exception|fails?|failing|regression|doesn'?t work|not working|wrong|issue)\b"),
    ("ui", r"(?i)\b(ui|ux|button|css|layout|style|styling|color|colour|dark mode|dialog|modal|popup|screen|page|responsive|icon|animation|card|sidebar|toolbar)\b"),
    ("refactor", r"(?i)\b(refactor|clean ?up|rename|simplif(y|ies)|extract|reorgani[sz]e|dedupe|split)\b"),
    ("question", r"(?i)^(how|why|what|where|when|which|can|could|should|is|are|does|do)\b.*\?\s*$|\b(explain|investigate|look into|research|compare)\b"),
];
const FILES: &str = r"[A-Za-z0-9_./-]+\.(js|ts|tsx|jsx|py|go|rs|rb|java|css|html|md|json|ya?ml)\b";
const DEVICE: &str = r"(?i)\b(?:devices?|device[- ]session) limit|too many (?:devices|active sessions|concurrent sessions|sessions (?:are )?(?:active|open|signed in))|(?:maximum|max) (?:number of )?(?:devices|active sessions|concurrent sessions)|signed in on too many|concurrent session limit";
const USAGE: &str = r"(?i)usage_limit_reached|session limit|usage limit|limit reached|resets \d|quota|exceeded your|insufficient (credit|balance|quota)|balance exhausted|payment required|\b402\b|billing";
const CAPACITY: &str = r"(?i)model is at capacity|capacity unavailable";
const RATE: &str = r"(?i)rate[- ]?limit|too many requests|\b429\b|overloaded|\b529\b|try again in a few minutes";
const RESET: &str = r"(?i)resets?(?: at)? (\d{1,2})(?::(\d{2}))?\s*(am|pm)?";

struct Patterns {
    rules: Vec<(&'static str, Regex)>,
    files: Option<Regex>,
    device: Option<Regex>,
    usage: Option<Regex>,
    capacity: Option<Regex>,
    rate: Option<Regex>,
    reset: Option<Regex>,
}

/// Compiled once. The patterns are constants (a test checks each compiles), so `None` never happens
/// in a build that passed its tests; it would only make that check say "no match".
fn pats() -> &'static Patterns {
    static P: OnceLock<Patterns> = OnceLock::new();
    P.get_or_init(|| Patterns {
        rules: RULES.iter().filter_map(|(k, re)| Regex::new(re).ok().map(|r| (*k, r))).collect(),
        files: Regex::new(FILES).ok(),
        device: Regex::new(DEVICE).ok(),
        usage: Regex::new(USAGE).ok(),
        capacity: Regex::new(CAPACITY).ok(),
        rate: Regex::new(RATE).ok(),
        reset: Regex::new(RESET).ok(),
    })
}

/// Every pattern compiled (the property tests assert it).
pub fn patterns_ok() -> bool {
    let p = pats();
    p.rules.len() == RULES.len() && [&p.files, &p.device, &p.usage, &p.capacity, &p.rate, &p.reset].iter().all(|r| r.is_some())
}

fn hit(re: Option<&Regex>, t: &str) -> bool {
    re.is_some_and(|r| r.is_match(t))
}

/// `{type, size}`: the kind of task (first rule that matches, else `feature`) and S / M / L.
pub fn task(prompt: &str, attachments: u32) -> (&'static str, &'static str) {
    let p = pats();
    let kind = p.rules.iter().find(|(_, re)| re.is_match(prompt)).map_or("feature", |(k, _)| *k);
    let files = p.files.as_ref().map_or(0, |r| r.find_iter(prompt).count());
    // v1 counts UTF-16 units (String.length)
    let len = prompt.encode_utf16().count();
    #[allow(clippy::cast_precision_loss)]
    let score = len as f64 / 400.0 + files as f64 + f64::from(attachments);
    let size = if score < 1.0 {
        "S"
    } else if score < 4.0 {
        "M"
    } else {
        "L"
    };
    (kind, size)
}

/// "resets 9pm" / "resets at 21:00" → ms until then (today, else tomorrow) plus a minute, at most
/// 6 h. `offset_min`: the user's offset from UTC, so "9pm" is their 9 pm.
fn reset_in(t: &str, now: i64, offset_min: i32) -> Option<i64> {
    let c = pats().reset.as_ref()?.captures(t)?;
    let hour: i64 = c.get(1)?.as_str().parse().ok()?;
    let min: i64 = c.get(2).and_then(|m| m.as_str().parse().ok()).unwrap_or(0);
    let h = match c.get(3).map(|m| m.as_str().to_ascii_lowercase()) {
        Some(ap) => hour % 12 + if ap == "pm" { 12 } else { 0 },
        None => hour,
    };
    let local = now + i64::from(offset_min) * MINUTE;
    let mut at = local.div_euclid(DAY) * DAY + h * HOUR + min * MINUTE;
    if at <= local {
        at += DAY;
    }
    Some((at - local + MINUTE).min(MAX_COOL_MS))
}

/// An error that says the harness can't run right now; `None` otherwise (v1 `infraError`).
pub fn infra_error(t: &str, now: i64, offset_min: i32) -> Option<Limit> {
    let p = pats();
    let lim = |scope, ms, kind| Some(Limit { scope, ms, kind, blip: None });
    // Too many devices or sessions signed in (Codex): nothing to wait for, the user closes one
    // elsewhere. Checked before "session limit", which is Claude's usage window (router.js:183).
    if hit(p.device.as_ref(), t) {
        return lim(LimitScope::Agent, 15 * MINUTE, Some(LimitKind::Device));
    }
    if hit(p.usage.as_ref(), t) {
        return lim(LimitScope::Agent, reset_in(t, now, offset_min).unwrap_or(HOUR), None);
    }
    // a model the provider has no room for right now (openai/codex#59045): that model rests
    if hit(p.capacity.as_ref(), t) {
        return lim(LimitScope::Arm, 10 * MINUTE, Some(LimitKind::Capacity));
    }
    if hit(p.rate.as_ref(), t) {
        return lim(LimitScope::Arm, 10 * MINUTE, None);
    }
    None
}

/// v1 `limitOf`: a Codex 429 while every known window of the account is below 99.5% is a hiccup
/// (openai/codex#57084), a one-minute pause, not the 10 minutes a real rate limit rests the arm.
pub fn limit_of(t: &str, agent: &str, windows: &[Window], now: i64, offset_min: i32) -> Option<Limit> {
    let limit = infra_error(t, now, offset_min)?;
    if limit.scope != LimitScope::Arm || limit.kind.is_some() || agent != "codex" {
        return Some(limit);
    }
    let known: Vec<f64> = windows.iter().filter_map(|w| w.used.filter(|u| u.is_finite())).collect();
    if known.is_empty() || known.iter().any(|u| *u >= 0.995) {
        return Some(limit);
    }
    Some(Limit { ms: BLIP_MS, blip: Some(true), ..limit })
}
