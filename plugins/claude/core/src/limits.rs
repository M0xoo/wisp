//! Claude's `rate_limit_event.rate_limit_info` → the `limits` event (v1 server/budget.js claudeLimits):
//! how much of the account's 5-hour and weekly windows is gone. `{ status, rateLimitType, utilization,
//! resetsAt (s), unifiedWindows: { five_hour: { utilization, resetsAt } }, isUsingOverage }`.
//! overage: this run is billed as extra usage, past the plan. rateLimitType "overage" is the
//! extra-usage allowance, not a plan window: never a row.

use serde_json::{Map, Value};
use wisp_harness_kit::js::num;
use wisp_harness_kit::{LimitWindow, Limits};

use crate::line::RateLimitInfo;

const H: f64 = 3_600_000.0;

/// How long each window is when the CLI doesn't say (v1 budget.js WINDOWS).
fn window_ms(id: &str) -> Option<f64> {
    match id {
        "five_hour" => Some(5.0 * H),
        "seven_day" | "seven_day_opus" | "seven_day_sonnet" => Some(7.0 * 24.0 * H),
        _ => None,
    }
}

/// seconds or ms → ms; None for anything that isn't a positive number
fn to_ms(v: &Value) -> Option<f64> {
    num(v)
        .filter(|x| *x > 0.0)
        .map(|x| if x < 1e12 { x * 1000.0 } else { x })
}

fn add(windows: &mut Vec<LimitWindow>, id: &Value, resets_at: &Value, used: Option<f64>) {
    let Some(id) = id.as_str().filter(|s| !s.is_empty()) else {
        return;
    };
    let Some(u) = used.filter(|u| u.is_finite()) else {
        return;
    };
    if id == "overage" || windows.iter().any(|w| w.id == id) {
        return;
    }
    windows.push(LimitWindow {
        id: id.to_owned(),
        used: u.clamp(0.0, 1.0),
        resets_at: to_ms(resets_at),
        ms: window_ms(id),
        extra: Map::new(),
    });
}

pub fn claude_limits(info: &RateLimitInfo) -> Option<Limits> {
    let mut windows = Vec::new();
    let overage = info.is_using_overage == Value::Bool(true);
    for (id, w) in &info.unified_windows.0 {
        if w.is_object() {
            add(
                &mut windows,
                &Value::String(id.clone()),
                &w["resetsAt"],
                num(&w["utilization"]),
            );
        }
    }
    // Every window the plan has (window changes): an event with only rateLimitType names one.
    let complete = !windows.is_empty();
    let rejected = info.status.as_str() == Some("rejected");
    let utilization = info.utilization.as_ref().and_then(num);
    // A refusal without a number is a full window.
    let used = utilization.or(if rejected { Some(1.0) } else { None });
    add(&mut windows, &info.rate_limit_type, &info.resets_at, used);
    if windows.is_empty() {
        return overage.then(|| Limits {
            overage: Some(true),
            ..Limits::default()
        });
    }
    let rejected = (rejected && info.rate_limit_type.as_str() != Some("overage"))
        .then(|| Value::String(wisp_harness_kit::js::str(&info.rate_limit_type)));
    Some(Limits {
        windows,
        complete: complete.then_some(true),
        rejected,
        overage: overage.then_some(true),
        ..Limits::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limits(json: &str) -> Option<Value> {
        let info: RateLimitInfo = serde_json::from_str(json).ok()?;
        claude_limits(&info).map(|l| serde_json::to_value(l).unwrap_or(Value::Null))
    }

    #[test]
    fn windows_in_order_with_their_lengths() {
        let v = limits(
            r#"{"unifiedWindows":{"seven_day":{"utilization":0.5,"resetsAt":1700000000},"five_hour":{"utilization":1.4}},"rateLimitType":"five_hour","utilization":0.2}"#,
        );
        let v = v.unwrap_or_default();
        assert_eq!(v["windows"][0]["id"], "seven_day");
        assert_eq!(v["windows"][0]["resetsAt"], 1_700_000_000_000.0);
        assert_eq!(v["windows"][1]["used"], 1.0);
        assert_eq!(v["windows"][1]["ms"], 5.0 * H);
        assert_eq!(
            v["windows"].as_array().map(Vec::len),
            Some(2),
            "rateLimitType's window is already there"
        );
        assert_eq!(v["complete"], true);
    }

    #[test]
    fn a_refusal_without_a_number_is_full() {
        let v = limits(r#"{"status":"rejected","rateLimitType":"seven_day"}"#).unwrap_or_default();
        assert_eq!(
            (
                v["windows"][0]["used"].as_f64(),
                v["rejected"].as_str(),
                v.get("complete")
            ),
            (Some(1.0), Some("seven_day"), None)
        );
    }

    #[test]
    fn overage_is_never_a_row() {
        assert_eq!(
            limits(r#"{"rateLimitType":"overage","utilization":0.3}"#),
            None
        );
        assert_eq!(
            limits(r#"{"rateLimitType":"overage","isUsingOverage":true}"#),
            Some(serde_json::json!({"windows": [], "overage": true}))
        );
    }
}
