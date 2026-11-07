//! Times: `{at}` or `{in: minutes}` → a time checked against the limits (v1 later.js:32-43), ISO-8601
//! parsing (v1 used `Date.parse`), and "14:32" / "yesterday 14:32" / "Mon 14:32" (v1 later.js clock).
//!
//! Local time is a fixed offset in minutes (`tz`) the host passes in: core has no clock and no zone
//! database. An ISO time with `Z` or an offset needs none; one without is read in `tz`, as v1's
//! `Date.parse` read it in the machine's zone.

use serde_json::Value;
use wisp_later_api::{MAX_MS, MIN_MS, When};

use crate::{Result, bad};

const DAY_MS: i64 = 86_400_000;
const DAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/// Days since 1970-01-01 of a proleptic Gregorian date (H. Hinnant's `days_from_civil`).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn num(s: &str) -> Option<i64> {
    (!s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
        .then(|| s.parse().ok())
        .flatten()
}

/// `±HH:MM`, `±HHMM`, `±HH` → minutes east of UTC.
fn offset(s: &str) -> Option<i64> {
    let sign = match s.as_bytes().first()? {
        b'+' => 1,
        b'-' => -1,
        _ => return None,
    };
    let digits: String = s[1..].chars().filter(|c| *c != ':').collect();
    let (h, m) = match digits.len() {
        2 => (num(&digits)?, 0),
        4 => (num(&digits[..2])?, num(&digits[2..])?),
        _ => return None,
    };
    (h <= 23 && m <= 59).then_some(sign * (h * 60 + m))
}

/// `2026-10-25`, `2026-10-25T14:00`, `…:30`, `….250`, then `Z` or an offset (else `tz`) → ms.
pub fn parse_iso(s: &str, tz: i32) -> Option<i64> {
    let s = s.trim();
    let (date, rest) = s.split_at(s.find(['T', 't', ' ']).unwrap_or(s.len()));
    let mut ymd = date.splitn(3, '-');
    let (y, m, d) = (num(ymd.next()?)?, num(ymd.next()?)?, num(ymd.next()?)?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || date.len() != 10 {
        return None;
    }
    let day = days_from_civil(y, m, d);
    if rest.is_empty() {
        return Some(day * DAY_MS); // a date alone is UTC midnight, as Date.parse reads it
    }
    let rest = &rest[1..];
    let zone_at = rest.find(['Z', 'z', '+', '-']).unwrap_or(rest.len());
    let (clock, zone) = rest.split_at(zone_at);
    let (hms, frac) = clock.split_once('.').unwrap_or((clock, ""));
    let mut parts = hms.split(':');
    let h = num(parts.next()?)?;
    let mi = num(parts.next()?)?;
    let sec = parts.next().map_or(Some(0), num)?;
    if parts.next().is_some() || h > 23 || mi > 59 || sec > 59 {
        return None;
    }
    let ms = if frac.is_empty() {
        0
    } else {
        num(&format!("{frac:0<3}")[..3])?
    };
    let off = match zone {
        "" => i64::from(tz),
        "Z" | "z" => 0,
        z => offset(z)?,
    };
    Some(day * DAY_MS + (h * 3600 + mi * 60 + sec) * 1000 + ms - off * 60_000)
}

/// JS `Number(x)` for what a body may carry: a number, or a numeric string.
fn number(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) if s.trim().is_empty() => Some(0.0),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
    .filter(|f: &f64| f.is_finite())
}

#[allow(clippy::cast_possible_truncation)] // a time in ms fits an i64; non-finite values were refused
fn round(f: f64) -> i64 {
    f.round() as i64
}

/// `{at}` or `{in: minutes}` → a time from now, at least a minute ahead and at most `max` (v1 whenOf).
#[allow(clippy::cast_precision_loss)] // ms since the epoch are exact in an f64 until the year 287396
pub fn when_of(w: &When, now: i64, max: i64, tz: i32) -> Result<i64> {
    let at = match w.at.as_ref() {
        Some(Value::String(s)) if !s.trim().is_empty() => parse_iso(s, tz).map(|t| t as f64),
        None | Some(Value::Null) | Some(Value::String(_)) => w
            .in_min
            .as_ref()
            .filter(|v| !v.is_null())
            .and_then(number)
            .map(|m| now as f64 + m * 60_000.0),
        Some(v) => number(v),
    };
    let Some(at) = at.filter(|f| f.is_finite()) else {
        return Err(bad("Say when: at (a time) or in (minutes)."));
    };
    let at = round(at);
    if at < now + MIN_MS - 1000 {
        return Err(bad("Pick a time at least a minute from now."));
    }
    if at > now + max {
        return Err(bad(format!(
            "Pick a time within {}.",
            if max == MAX_MS { "a month" } else { "a week" }
        )));
    }
    Ok(at)
}

fn hm(t: i64, tz: i32) -> (i64, String) {
    let local = t + i64::from(tz) * 60_000;
    let day = local.div_euclid(DAY_MS);
    let mins = local.rem_euclid(DAY_MS) / 60_000;
    (day, format!("{:02}:{:02}", mins / 60, mins % 60))
}

/// "14:32" today, "yesterday 14:32", "Mon 14:32" further: in what wisp writes on a reminder.
pub fn clock(t: i64, now: i64, tz: i32) -> String {
    let (day, hm) = hm(t, tz);
    let today = (now + i64::from(tz) * 60_000).div_euclid(DAY_MS);
    if day == today {
        hm
    } else if day == today - 1 {
        format!("yesterday {hm}")
    } else {
        format!("{} {hm}", weekday(day))
    }
}

fn weekday(day: i64) -> &'static str {
    // 1970-01-01 was a Thursday; `rem_euclid` keeps the index in 0..7
    DAYS[usize::try_from((day + 4).rem_euclid(7)).unwrap_or(0)]
}

/// "Sun 14:30": how the agent is told when its follow-up goes (v1 internal.js `when`).
pub fn short(t: i64, tz: i32) -> String {
    let (day, hm) = hm(t, tz);
    format!("{} {hm}", weekday(day))
}
