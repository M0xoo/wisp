//! What each CLI says of its usage windows, as the one report shape budget records (v1
//! server/budget.js:118-220: claudeLimits, codexLimits, codexLive, codexBanked, bankedAt, bankedDue).

use serde_json::{Map, Value};
use wisp_budget_api::{Banked, BankedCredit, LimitWindow, LimitsReport};

use crate::windows::{H, MIN, known_ms};

type Obj = Map<String, Value>;

fn obj(v: Option<&Value>) -> Option<&Obj> {
    v.and_then(Value::as_object)
}

fn fin(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64).filter(|x| x.is_finite())
}

fn clamp(n: f64) -> f64 {
    n.clamp(0.0, 1.0)
}

/// Seconds or ms → ms (budget.js:89): a value under 1e12 is seconds.
#[allow(clippy::cast_possible_truncation)]
pub fn to_ms(v: Option<&Value>) -> Option<i64> {
    let s = fin(v).filter(|s| *s > 0.0)?;
    Some(if s < 1e12 { (s * 1000.0).round() as i64 } else { s.round() as i64 })
}

/// JS `!!v`: what v1 tests as present.
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// JS `Number(v)`: numbers and numeric strings; null and "" are 0; anything else is NaN (None).
fn js_number(v: Option<&Value>) -> Option<f64> {
    match v? {
        Value::Null => Some(0.0),
        Value::Number(n) => n.as_f64(),
        Value::String(s) if s.trim().is_empty() => Some(0.0),
        Value::String(s) => s.trim().parse::<f64>().ok(),
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        _ => None,
    }
}

/// Claude's `rate_limit_event.rate_limit_info` → a report (budget.js:122-138). A refusal without a
/// number is a full window; `rateLimitType: 'overage'` (the extra-usage allowance) is never a window;
/// `isUsingOverage: true` marks the run past the plan even with no windows (edge case Top-10 #3).
pub fn claude_limits(info: &Value) -> Option<LimitsReport> {
    let info = info.as_object()?;
    let mut windows: Vec<LimitWindow> = Vec::new();
    let overage = info.get("isUsingOverage") == Some(&Value::Bool(true));
    let add = |windows: &mut Vec<LimitWindow>, id: Option<&Value>, w: &Obj, used: Option<f64>| {
        let Some(id) = id.and_then(Value::as_str).filter(|i| !i.is_empty() && *i != "overage") else { return };
        let Some(used) = used.filter(|u| u.is_finite()) else { return };
        if windows.iter().any(|x| x.id == id) {
            return;
        }
        windows.push(LimitWindow { id: id.to_owned(), used: clamp(used), resets_at: to_ms(w.get("resetsAt")), ms: known_ms(id), slot: None });
    };
    if let Some(unified) = obj(info.get("unifiedWindows")) {
        for (id, w) in unified {
            if let Some(w) = w.as_object() {
                add(&mut windows, Some(&Value::String(id.clone())), w, fin(w.get("utilization")));
            }
        }
    }
    // Every window the plan has: an event with only rateLimitType names one.
    let complete = !windows.is_empty();
    let rejected = info.get("status").and_then(Value::as_str) == Some("rejected");
    let used = fin(info.get("utilization")).or(if rejected { Some(1.0) } else { None });
    add(&mut windows, info.get("rateLimitType"), info, used);
    if windows.is_empty() {
        return overage.then(|| LimitsReport { overage, ..LimitsReport::default() });
    }
    let kind = info.get("rateLimitType");
    let rejected = (rejected && kind.and_then(Value::as_str) != Some("overage")).then(|| kind.and_then(Value::as_str).unwrap_or_default().to_owned());
    Some(LimitsReport { windows, complete, rejected, overage, ..LimitsReport::default() })
}

#[allow(clippy::cast_possible_truncation)]
fn codex_id(mins: f64) -> String {
    if mins == 300.0 {
        "five_hour".into()
    } else if mins == 10080.0 {
        "seven_day".into()
    } else if mins.fract() == 0.0 {
        format!("w{}m", mins as i64)
    } else {
        format!("w{mins}m")
    }
}

/// Codex's `rate_limits` (its session file) → a report (budget.js:142-160). Windows are named by
/// their length; `slot` keeps where each came from.
#[allow(clippy::cast_possible_truncation)]
pub fn codex_limits(rl: &Value, now: i64) -> Option<LimitsReport> {
    let rl = rl.as_object()?;
    let mut windows: Vec<LimitWindow> = Vec::new();
    for slot in ["primary", "secondary"] {
        let Some(w) = obj(rl.get(slot)) else { continue };
        let Some(pct) = fin(w.get("used_percent")) else { continue };
        let mins = js_number(w.get("window_minutes")).filter(|m| m.is_finite() && *m != 0.0).unwrap_or(0.0);
        if mins == 0.0 {
            continue;
        }
        let id = codex_id(mins);
        if windows.iter().any(|x| x.id == id) {
            continue;
        }
        let resets_at = to_ms(w.get("resets_at")).or_else(|| fin(w.get("resets_in_seconds")).map(|s| now + (s * 1000.0).round() as i64));
        windows.push(LimitWindow { id, used: clamp(pct / 100.0), resets_at, ms: Some((mins * 60_000.0).round() as i64), slot: Some(slot.to_owned()) });
    }
    // credits: the balance Codex bills past the plan's windows (a string in its snapshot).
    let credits = obj(rl.get("credits")).filter(|c| !truthy(c.get("unlimited"))).and_then(|c| js_number(c.get("balance"))).filter(|c| c.is_finite());
    let first = windows.first()?.id.clone();
    let full = windows.iter().find(|w| w.used >= 1.0).map(|w| w.id.clone());
    let rejected = (truthy(rl.get("rate_limit_reached_type")) || full.is_some()).then(|| full.unwrap_or(first));
    Some(LimitsReport { windows, complete: true, rejected, credits, ..LimitsReport::default() })
}

/// A clock a little off isn't a reset gone by (budget.js:168).
const FROZEN_SKEW_MS: i64 = 5 * MIN;

fn live_window(x: Option<&Value>) -> Value {
    match obj(x) {
        Some(x) if fin(x.get("usedPercent")).is_some() => serde_json::json!({
            "used_percent": x.get("usedPercent"),
            "window_minutes": x.get("windowDurationMins"),
            "resets_at": x.get("resetsAt"),
        }),
        _ => Value::Null,
    }
}

fn limits_of_live(rl: Option<&Value>, now: i64) -> Option<LimitsReport> {
    limits_of_obj(obj(rl)?, now)
}

fn limits_of_obj(rl: &Obj, now: i64) -> Option<LimitsReport> {
    let reached = rl.get("rateLimitReachedType").filter(|v| truthy(Some(v))).cloned().unwrap_or(Value::Null);
    codex_limits(&serde_json::json!({ "primary": live_window(rl.get("primary")), "secondary": live_window(rl.get("secondary")), "rate_limit_reached_type": reached }), now)
}

fn resets_of(rl: &Obj) -> Vec<i64> {
    ["primary", "secondary"].iter().filter_map(|s| obj(rl.get(*s)).and_then(|x| to_ms(x.get("resetsAt")))).collect()
}

fn frozen(rl: &Obj, now: i64) -> bool {
    resets_of(rl).iter().any(|at| *at < now - FROZEN_SKEW_MS)
}

/// A model's own bucket or premium: never the codex limit.
fn side(id: &str, rl: &Obj) -> bool {
    truthy(rl.get("normalModelSlug")) || id == "premium" || rl.get("limitId").and_then(Value::as_str) == Some("premium")
}

/// Codex's app-server answer to `account/rateLimits/read` → a report (budget.js:169-183). A live
/// answer never gives a reset that's already gone, so a `codex` entry with one is frozen (OpenAI moved
/// the limit to a new id) and the newest non-side bucket takes its place (edge case "budget" #6).
pub fn codex_live(res: &Value, now: i64) -> Option<LimitsReport> {
    let res = res.as_object()?;
    let by_id = obj(res.get("rateLimitsByLimitId"));
    let main = by_id.and_then(|b| b.get("codex"));
    let Some(limits) = limits_of_live(main, now) else { return limits_of_live(res.get("rateLimits"), now) };
    let Some(main) = obj(main) else { return Some(limits) };
    if !frozen(main, now) {
        return Some(limits);
    }
    let mut candidates: Vec<(&str, &Obj)> = Vec::new();
    if let Some(rl) = obj(res.get("rateLimits")) {
        candidates.push(("", rl));
    }
    for (id, rl) in by_id.into_iter().flatten() {
        if let Some(rl) = rl.as_object() {
            candidates.push((id.as_str(), rl));
        }
    }
    let mut next: Vec<(&str, &Obj)> = candidates.into_iter().filter(|(id, rl)| *id != "codex" && !side(id, rl) && !frozen(rl, now) && limits_of_obj(rl, now).is_some()).collect();
    let latest = |rl: &Obj| resets_of(rl).into_iter().max().unwrap_or(0).max(0);
    next.sort_by_key(|(_, rl)| std::cmp::Reverse(latest(rl)));
    match next.first() {
        Some((_, rl)) => limits_of_obj(rl, now),
        None => Some(limits),
    }
}

/// Banked resets (OpenAI's reset credits) from the same answer (budget.js:190-207): soonest first, at
/// most 20, or None when the answer doesn't say. Expired or no longer available credits don't count.
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
pub fn codex_banked(res: &Value, now: i64) -> Option<Banked> {
    let r = obj(res.as_object()?.get("rateLimitResetCredits"))?;
    let available = fin(r.get("availableCount"))?;
    let mut count = available.floor().max(0.0) as u64;
    let Some(list) = r.get("credits").and_then(Value::as_array) else { return Some(Banked { count, credits: None, at: None }) };
    let mut credits: Vec<BankedCredit> = Vec::new();
    for c in list {
        let Some(c) = c.as_object() else { continue };
        if truthy(c.get("status")) && c.get("status").and_then(Value::as_str) != Some("available") {
            continue;
        }
        let expires_at = to_ms(c.get("expiresAt"));
        if expires_at.is_some_and(|e| e <= now) {
            count = count.saturating_sub(1);
            continue;
        }
        let id = match c.get("id").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            Some(s) => s.chars().take(200).collect(),
            None => format!("at:{}", expires_at.map_or_else(|| "null".to_owned(), |e| e.to_string())),
        };
        credits.push(BankedCredit { id, expires_at });
    }
    credits.sort_by_key(|c| c.expires_at.unwrap_or(i64::MAX));
    let count = count.max(credits.len() as u64);
    credits.truncate(20);
    Some(Banked { count, credits: Some(credits), at: None })
}

/// What's left of a stored reading at `now`: credits that expired since drop out of the list and the
/// count; nothing left is None (budget.js:210).
pub fn banked_at(b: Option<&Banked>, now: i64) -> Option<Banked> {
    let b = b?;
    let Some(list) = &b.credits else { return (b.count > 0).then(|| b.clone()) };
    let credits: Vec<BankedCredit> = list.iter().filter(|c| c.expires_at.is_none_or(|e| e > now)).cloned().collect();
    let count = b.count.saturating_sub((list.len() - credits.len()) as u64);
    (count > 0).then(|| Banked { count, credits: Some(credits), at: b.at })
}

/// A banked reset's one phone note goes the day before it expires.
pub const BANKED_NOTE_MS: i64 = 24 * H;

/// The credits whose note is due now and hasn't gone (budget.js:220).
pub fn banked_due(b: Option<&Banked>, sent: &std::collections::BTreeMap<String, i64>, now: i64) -> Vec<BankedCredit> {
    banked_at(b, now)
        .and_then(|b| b.credits)
        .unwrap_or_default()
        .into_iter()
        .filter(|c| c.expires_at.is_some_and(|e| e - now <= BANKED_NOTE_MS) && !sent.contains_key(&c.id))
        .collect()
}

/// A `turn.limits` body (what a harness reported, already in report shape) read leniently: a field
/// of the wrong type is left out rather than failing the whole report.
#[allow(clippy::cast_possible_truncation)]
pub fn report_from_value(v: &Value) -> Option<LimitsReport> {
    let o = v.as_object()?;
    let windows = o.get("windows").and_then(Value::as_array).map(|ws| {
        ws.iter()
            .filter_map(|w| {
                let w = w.as_object()?;
                let id = w.get("id")?.as_str()?.to_owned();
                let used = fin(w.get("used"))?;
                let num = |k: &str| fin(w.get(k)).filter(|x| *x > 0.0).map(|x| x.round() as i64);
                Some(LimitWindow { id, used, resets_at: num("resetsAt"), ms: num("ms"), slot: w.get("slot").and_then(Value::as_str).map(str::to_owned) })
            })
            .collect()
    });
    let rejected = match o.get("rejected") {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Bool(true)) => Some(String::new()),
        _ => None,
    };
    let flag = |k: &str| o.get(k) == Some(&Value::Bool(true));
    let banked = o.get("banked").and_then(|b| serde_json::from_value::<Banked>(b.clone()).ok());
    Some(LimitsReport { windows: windows.unwrap_or_default(), complete: flag("complete"), rejected, overage: flag("overage"), credits: fin(o.get("credits")), read: flag("read"), banked })
}
