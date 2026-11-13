//! A 5-field cron (v1 server/triggers.js `parseCron`, `cronMatches`, `nextRun`), dependency-free so the
//! crew's schedule stays self-contained. Times are local: a [`Zone`] gives the offset at an instant.
//! Words ("every monday") are read by a [`Words`] the host fills (automations owns that grammar).

use crate::error::{Result, bad};

const MIN: i64 = 60_000;
const HOUR: i64 = 60 * MIN;
const DAY: i64 = 24 * HOUR;

/// The local time offset (minutes east of UTC) at an instant: the host's time zone.
pub trait Zone: Send + Sync {
    fn offset_min(&self, utc_ms: i64) -> i32;
}

/// UTC, the default until the host knows the machine's zone.
#[derive(Debug, Clone, Copy, Default)]
pub struct Utc;
impl Zone for Utc {
    fn offset_min(&self, _: i64) -> i32 {
        0
    }
}

/// A fixed offset, minutes east of UTC.
#[derive(Debug, Clone, Copy)]
pub struct Fixed(pub i32);
impl Zone for Fixed {
    fn offset_min(&self, _: i64) -> i32 {
        self.0
    }
}

/// Reads a schedule in words into a 5-field cron, or `None` when it can't.
pub trait Words: Send + Sync {
    fn to_cron(&self, said: &str) -> Option<String>;
}

/// No words: only a cron or one of its aliases reads (the default until automations exposes `toCron`).
#[derive(Debug, Clone, Copy, Default)]
pub struct CronOnly;
impl Words for CronOnly {
    fn to_cron(&self, said: &str) -> Option<String> {
        let s = alias(said).unwrap_or(said);
        (s.split_whitespace().count() == 5).then(|| s.to_owned())
    }
}

fn alias(s: &str) -> Option<&'static str> {
    Some(match s.trim() {
        "@hourly" => "0 * * * *",
        "@daily" => "0 0 * * *",
        "@weekly" => "0 0 * * 0",
        "@monthly" => "0 0 1 * *",
        "@weekdays" => "0 9 * * 1-5",
        _ => return None,
    })
}

/// A parsed cron: one bit per allowed value of each field.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cron {
    minute: u64,
    hour: u64,
    dom: u64,
    month: u64,
    dow: u64,
    dom_any: bool,
    dow_any: bool,
}

const FIELDS: [(&str, u32, u32); 5] = [("minute", 0, 59), ("hour", 0, 23), ("dom", 1, 31), ("month", 1, 12), ("dow", 0, 7)];

fn field(name: &str, lo: u32, hi: u32, part: &str) -> Result<u64> {
    let mut set = 0u64;
    for piece in part.split(',') {
        let wrong = || bad(format!("Bad {name} field: {piece}"));
        let (range, step) = match piece.split_once('/') {
            Some((r, s)) => (r, Some(s.parse::<u32>().map_err(|_| wrong())?)),
            None => (piece, None),
        };
        let num = |s: &str| {
            if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) { s.parse::<u32>().map_err(|_| wrong()) } else { Err(wrong()) }
        };
        // `*` and `n/step` run to the field's top; dow's top is Saturday (7 is only an alias for 0).
        let top = if name == "dow" { 6 } else { hi };
        let (a, b) = if range == "*" {
            (lo, top)
        } else if let Some((x, y)) = range.split_once('-') {
            (num(x)?, num(y)?)
        } else {
            let a = num(range)?;
            (a, if step.is_some() { top } else { a })
        };
        let step = step.unwrap_or(1);
        if a < lo || b > hi || a > b || step < 1 {
            return Err(wrong());
        }
        // Day-of-week 7 is Sunday too (v1 triggers.js:72-73).
        let mut v = a;
        while v <= b {
            set |= 1 << (if name == "dow" { v % 7 } else { v });
            v += step;
        }
    }
    Ok(set)
}

/// A cron expression (or `@hourly`, `@daily`, …) → a [`Cron`], or v1's sentence saying what's wrong.
pub fn parse(expr: &str) -> Result<Cron> {
    let src = alias(expr).unwrap_or_else(|| expr.trim());
    let parts: Vec<&str> = src.split_whitespace().collect();
    if parts.len() != 5 {
        return Err(bad("A schedule needs 5 fields: minute hour day-of-month month day-of-week"));
    }
    let mut sets = [0u64; 5];
    for (i, part) in parts.iter().enumerate() {
        let (name, lo, hi) = FIELDS[i];
        sets[i] = field(name, lo, hi, part)?;
    }
    let any = |p: &str| p == "*" || p.starts_with("*/");
    Ok(Cron { minute: sets[0], hour: sets[1], dom: sets[2], month: sets[3], dow: sets[4], dom_any: any(parts[2]), dow_any: any(parts[4]) })
}

/// A local calendar minute.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Civil {
    pub year: i64,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    /// 0 = Sunday
    pub dow: u32,
}

// Howard Hinnant's days_from_civil / civil_from_days: exact for the proleptic Gregorian calendar.
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = i64::from((m + 9) % 12);
    let doy = (153 * mp + 2) / 5 + i64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)] // each value is range-bounded above
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// The calendar minute of a local timestamp (ms, already shifted by the zone).
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)] // rem_euclid keeps these in range
pub fn civil(local_ms: i64) -> Civil {
    let days = local_ms.div_euclid(DAY);
    let rest = local_ms.rem_euclid(DAY);
    let (year, month, day) = civil_from_days(days);
    Civil { year, month, day, hour: (rest / HOUR) as u32, minute: ((rest % HOUR) / MIN) as u32, dow: (days + 4).rem_euclid(7) as u32 }
}

/// The local timestamp of a calendar date at 00:00 (for tests and the month jump).
pub fn local_ms(year: i64, month: u32, day: u32, hour: u32, minute: u32) -> i64 {
    days_from_civil(year, month, day) * DAY + i64::from(hour) * HOUR + i64::from(minute) * MIN
}

fn has(set: u64, v: u32) -> bool {
    set & (1 << v) != 0
}

impl Cron {
    /// Classic cron: when both day fields are restricted, either one matching is enough.
    fn day_matches(&self, c: &Civil) -> bool {
        let dom = has(self.dom, c.day);
        let dow = has(self.dow, c.dow);
        if !self.dom_any && !self.dow_any { dom || dow } else { dom && dow }
    }

    pub fn matches(&self, c: &Civil) -> bool {
        has(self.minute, c.minute) && has(self.hour, c.hour) && has(self.month, c.month) && self.day_matches(c)
    }

    /// Whether the minute holding `utc_ms` matches, in `zone`'s local time.
    pub fn matches_at(&self, utc_ms: i64, zone: &dyn Zone) -> bool {
        self.matches(&civil(utc_ms + i64::from(zone.offset_min(utc_ms)) * MIN))
    }

    /// The next matching minute strictly after `from`'s minute, within a year (v1 `nextRun`), or `None`.
    pub fn next_run(&self, from: i64, zone: &dyn Zone) -> Option<i64> {
        let off = i64::from(zone.offset_min(from)) * MIN;
        let start = from + off;
        let end = start + 366 * DAY;
        let mut l = start.div_euclid(MIN) * MIN + MIN;
        while l < end {
            let c = civil(l);
            if !has(self.month, c.month) {
                let (y, m) = if c.month == 12 { (c.year + 1, 1) } else { (c.year, c.month + 1) };
                l = local_ms(y, m, 1, 0, 0);
            } else if !self.day_matches(&c) {
                l = (l.div_euclid(DAY) + 1) * DAY;
            } else if !has(self.hour, c.hour) {
                l = (l.div_euclid(HOUR) + 1) * HOUR;
            } else if has(self.minute, c.minute) {
                // Back to UTC with the offset in force then (exact for a fixed zone).
                return Some(l - i64::from(zone.offset_min(l - off)) * MIN);
            } else {
                l += MIN;
            }
        }
        None
    }
}

/// A schedule as the user (or an agent) wrote it → a checked cron; '' stays '' (v1 `readSchedule`).
pub fn read_schedule(text: &str, words: &dyn Words) -> Result<String> {
    let said = text.trim();
    if said.is_empty() {
        return Ok(String::new());
    }
    let Some(cron) = words.to_cron(said).or_else(|| CronOnly.to_cron(said)) else {
        let shown = crate::text::clip(said, 60);
        return Err(bad(format!("Couldn’t read “{shown}” as a schedule. Try “every monday”, “8am every weekday” or “every 30 min”.")));
    };
    parse(&cron)?;
    Ok(cron)
}
