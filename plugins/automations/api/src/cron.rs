//! Cron, read and run (v1 server/triggers.js:45-114): a 5-field cron in local time, whether a minute
//! matches it, and the next minute it fires. Pure: time comes in as ms since the epoch and the local
//! time zone as a [`Zone`], so crew check-ins and scheduled triggers share it and tests pin both.
//!
//! These live in the api crate (not core) on purpose: wisp.crew's host reuses them, and a host may
//! depend on another plugin's api crate only.

use std::fmt;

use crate::words::to_cron;

const MINUTE: i64 = 60_000;
const HOUR: i64 = 60 * MINUTE;
const DAY: i64 = 24 * HOUR;
/// `nextRun` looks this far ahead, then gives up (v1 triggers.js:105).
const HORIZON: i64 = 366 * DAY;

/// The local time zone: how far local time is ahead of UTC at an instant. The host provides the
/// machine's; tests use [`FixedOffset`].
pub trait Zone: Send + Sync {
    fn offset_ms(&self, utc_ms: i64) -> i64;
}

/// UTC.
#[derive(Debug, Clone, Copy, Default)]
pub struct Utc;
impl Zone for Utc {
    fn offset_ms(&self, _utc_ms: i64) -> i64 {
        0
    }
}

/// A zone with no daylight saving: local = UTC + the offset (ms).
#[derive(Debug, Clone, Copy, Default)]
pub struct FixedOffset(pub i64);
impl Zone for FixedOffset {
    fn offset_ms(&self, _utc_ms: i64) -> i64 {
        self.0
    }
}

/// Why a schedule was refused, in v1's words. Maps to `invalid` on the wire.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CronError(pub String);
impl fmt::Display for CronError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for CronError {}
impl From<CronError> for wisp_kernel::WireError {
    fn from(e: CronError) -> Self {
        Self::invalid(e.0)
    }
}

/// `@daily` and friends (v1 triggers.js:54).
pub const CRON_ALIASES: [(&str, &str); 5] = [("@hourly", "0 * * * *"), ("@daily", "0 0 * * *"), ("@weekly", "0 0 * * 0"), ("@monthly", "0 0 1 * *"), ("@weekdays", "0 9 * * 1-5")];

/// A parsed cron: one bit per allowed value of each field, and whether a day field was `*` (or `*/n`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Cron {
    minute: u64,
    hour: u32,
    dom: u32,
    month: u16,
    dow: u8,
    dom_any: bool,
    dow_any: bool,
}

const FIELDS: [(&str, u32, u32); 5] = [("minute", 0, 59), ("hour", 0, 23), ("dom", 1, 31), ("month", 1, 12), ("dow", 0, 6)];

fn bad(name: &str, piece: &str) -> CronError {
    CronError(format!("Bad {name} field: {piece}"))
}

fn num(s: &str) -> Option<u32> {
    (!s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())).then(|| s.parse().unwrap_or(u32::MAX))
}

// One comma-separated field → the values it allows, as a bit set.
fn read_field(name: &str, lo: u32, hi: u32, part: &str) -> Result<u64, CronError> {
    let mut set = 0u64;
    for piece in part.split(',') {
        let (range, step) = match piece.split_once('/') {
            Some((r, s)) => (r, Some(num(s).ok_or_else(|| bad(name, piece))?)),
            None => (piece, None),
        };
        let (mut a, mut b) = if range == "*" {
            (lo, hi)
        } else if let Some((x, y)) = range.split_once('-') {
            (num(x).ok_or_else(|| bad(name, piece))?, num(y).ok_or_else(|| bad(name, piece))?)
        } else {
            let a = num(range).ok_or_else(|| bad(name, piece))?;
            (a, if step.is_some() { hi } else { a })
        };
        if name == "dow" && b == 7 {
            // 7 is Sunday too. v1 read a bare `7` as every day (a became 0..6); it means Sunday only.
            set |= 1;
            if a == 7 {
                continue;
            }
            b = 6;
        }
        if name == "dow" && a == 7 {
            a = 0;
        }
        let step = step.unwrap_or(1);
        if a < lo || b > hi || a > b || step < 1 {
            return Err(bad(name, piece));
        }
        let mut v = a;
        while v <= b {
            set |= 1 << v;
            v += step;
        }
    }
    Ok(set)
}

/// A cron (or an alias such as `@daily`) → its fields, or why it isn't one.
pub fn parse_cron(expr: &str) -> Result<Cron, CronError> {
    let said = expr.trim();
    let src = CRON_ALIASES.iter().find(|(a, _)| *a == said).map_or(said, |(_, c)| c);
    let parts: Vec<&str> = src.split_whitespace().collect();
    if parts.len() != 5 {
        return Err(CronError("A schedule needs 5 fields: minute hour day-of-month month day-of-week".into()));
    }
    let mut sets = [0u64; 5];
    for (i, (name, lo, hi)) in FIELDS.iter().enumerate() {
        sets[i] = read_field(name, *lo, *hi, parts[i])?;
    }
    let any = |p: &str| p == "*" || p.starts_with("*/");
    // Each set fits its field's width: minutes < 60 bits, hours < 24, days < 32, months < 13, dow < 7.
    Ok(Cron {
        minute: sets[0],
        hour: u32::try_from(sets[1]).unwrap_or(0),
        dom: u32::try_from(sets[2]).unwrap_or(0),
        month: u16::try_from(sets[3]).unwrap_or(0),
        dow: u8::try_from(sets[4]).unwrap_or(0),
        dom_any: any(parts[2]),
        dow_any: any(parts[4]),
    })
}

/// Local calendar fields of one instant.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Local {
    pub year: i64,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    /// 0 = Sunday
    pub weekday: u32,
}

// Howard Hinnant's civil_from_days: days since 1970-01-01 → (year, month, day).
fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, u32::try_from(m).unwrap_or(1), u32::try_from(d).unwrap_or(1))
}

// days_from_civil: (year, month, day) → days since 1970-01-01.
fn days_from(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let m = i64::from(m);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + i64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The local calendar fields of `local_ms` (UTC ms already shifted by the zone's offset).
pub fn local_fields(local_ms: i64) -> Local {
    let days = local_ms.div_euclid(DAY);
    let rem = local_ms.rem_euclid(DAY);
    let (year, month, day) = civil(days);
    Local {
        year,
        month,
        day,
        hour: u32::try_from(rem / HOUR).unwrap_or(0),
        minute: u32::try_from(rem % HOUR / MINUTE).unwrap_or(0),
        weekday: u32::try_from((days + 4).rem_euclid(7)).unwrap_or(0),
    }
}

impl Cron {
    fn month_ok(&self, l: &Local) -> bool {
        self.month & (1 << l.month) != 0
    }
    // Classic cron: when both day fields are restricted, either one matching is enough.
    fn day_ok(&self, l: &Local) -> bool {
        let dom = self.dom & (1 << l.day) != 0;
        let dow = self.dow & (1 << l.weekday) != 0;
        if !self.dom_any && !self.dow_any { dom || dow } else { dom && dow }
    }
    fn hour_ok(&self, l: &Local) -> bool {
        self.hour & (1 << l.hour) != 0
    }
    fn minute_ok(&self, l: &Local) -> bool {
        self.minute & (1 << l.minute) != 0
    }
    fn local_matches(&self, l: &Local) -> bool {
        self.minute_ok(l) && self.hour_ok(l) && self.month_ok(l) && self.day_ok(l)
    }
}

/// Does the cron fire in the (local) minute `utc_ms` falls in?
pub fn matches(c: &Cron, utc_ms: i64, zone: &dyn Zone) -> bool {
    c.local_matches(&local_fields(utc_ms + zone.offset_ms(utc_ms)))
}

// A local wall time back to UTC: the offset at the guessed instant, which is right outside the hour
// a daylight-saving change moves.
fn to_utc(local: i64, zone: &dyn Zone) -> i64 {
    let guess = local - zone.offset_ms(local);
    local - zone.offset_ms(guess)
}

/// The next matching minute after `from` (ms), looking a year ahead; `None` if it never matches.
pub fn next_run(c: &Cron, from: i64, zone: &dyn Zone) -> Option<i64> {
    let local_from = from + zone.offset_ms(from);
    let end = local_from + HORIZON;
    let mut at = local_from.div_euclid(MINUTE) * MINUTE + MINUTE;
    while at < end {
        let lf = local_fields(at);
        if !c.month_ok(&lf) {
            let (y, m) = if lf.month == 12 { (lf.year + 1, 1) } else { (lf.year, lf.month + 1) };
            at = days_from(y, m, 1) * DAY;
        } else if !c.day_ok(&lf) {
            at = at.div_euclid(DAY) * DAY + DAY;
        } else if !c.hour_ok(&lf) {
            at = at.div_euclid(HOUR) * HOUR + HOUR;
        } else if c.minute_ok(&lf) {
            let utc = to_utc(at, zone);
            if utc > from {
                return Some(utc);
            }
            at += MINUTE;
        } else {
            at += MINUTE;
        }
    }
    None
}

/// A schedule as the user (or an agent) wrote it → a checked cron. `""` stays `""` (no schedule).
pub fn read_schedule(text: &str) -> Result<String, CronError> {
    let said = text.trim();
    if said.is_empty() {
        return Ok(String::new());
    }
    let Some(cron) = to_cron(said) else {
        let short: String = said.chars().take(60).collect();
        return Err(CronError(format!("Couldn’t read “{short}” as a schedule. Try “every monday”, “8am every weekday” or “every 30 min”.")));
    };
    parse_cron(&cron)?;
    Ok(cron)
}

/// Local wall time → UTC ms, for tests and callers that build instants from a date.
pub fn local_to_utc(year: i64, month: u32, day: u32, hour: u32, minute: u32, zone: &dyn Zone) -> i64 {
    to_utc(days_from(year, month, day) * DAY + i64::from(hour) * HOUR + i64::from(minute) * MINUTE, zone)
}
