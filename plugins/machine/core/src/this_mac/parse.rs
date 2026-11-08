//! One parser per source (v1 machine.js "parsing (pure)"). Each takes whatever text the program
//! printed, however broken, and never panics: a line it can't read is skipped.

use std::collections::HashMap;

use serde_json::Value;

use super::COMMAND_MAX;

/// One process, as one tick of `ps` (or `Win32_Process`) shows it.
#[derive(Debug, Clone, PartialEq)]
pub struct Proc {
    pub pid: u32,
    pub ppid: u32,
    /// bytes: RSS, or `phys_footprint` on macOS once the host has read it
    pub rss: u64,
    /// percent of one core
    pub cpu: f64,
    /// when it started, ms since the epoch
    pub since: i64,
    /// cut before its environment, at most `COMMAND_MAX` characters
    pub command: String,
    /// `WISP_TASK` from its environment (macOS `ps -E`)
    pub task: Option<String>,
    /// Windows: kernel + user time in 100 ns units (the CPU share comes from two ticks)
    pub time: u64,
}

/// `ps` etime, `[[dd-]hh:]mm:ss`, as ms; 0 for anything else.
pub fn parse_etime(s: &str) -> i64 {
    etime(s.trim()).unwrap_or(0)
}

fn digits(s: &str) -> Option<i64> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

fn etime(s: &str) -> Option<i64> {
    let (days, rest) = match s.split_once('-') {
        Some((d, r)) => (digits(d)?, r),
        None => (0, s),
    };
    let parts: Vec<&str> = rest.split(':').collect();
    let (h, m, sec) = match parts.as_slice() {
        [m, s] => (0, digits(m)?, digits(s)?),
        [h, m, s] => (digits(h)?, digits(m)?, digits(s)?),
        _ => return None,
    };
    let hours = days.checked_mul(24)?.checked_add(h)?;
    let mins = hours.checked_mul(60)?.checked_add(m)?;
    mins.checked_mul(60)?.checked_add(sec)?.checked_mul(1000)
}

/// The environment macOS's `ps -E` puts after a command: from the first ` NAME=`. An argument shaped
/// like that cuts the command early, never late, so no env value reaches the page.
pub fn cut_env(s: &str) -> &str {
    for (i, c) in s.char_indices() {
        if c.is_whitespace() && starts_assignment(&s[i + c.len_utf8()..]) {
            return s[..i].trim();
        }
    }
    s.trim()
}

/// `[A-Za-z_][A-Za-z0-9_]*=` at the start of `s`.
fn starts_assignment(s: &str) -> bool {
    let b = s.as_bytes();
    if !b
        .first()
        .is_some_and(|c| c.is_ascii_alphabetic() || *c == b'_')
    {
        return false;
    }
    let n = b
        .iter()
        .take_while(|c| c.is_ascii_alphanumeric() || **c == b'_')
        .count();
    b.get(n) == Some(&b'=')
}

/// `WISP_TASK=<id>` as a whole word of the line: 1 to 64 of `[A-Za-z0-9_-]`.
pub fn tag_in(s: &str) -> Option<&str> {
    const KEY: &str = "WISP_TASK=";
    let mut from = 0;
    while let Some(off) = s.get(from..).and_then(|r| r.find(KEY)) {
        let at = from + off;
        from = at + KEY.len();
        let before_ok = s[..at].chars().next_back().is_none_or(char::is_whitespace);
        let rest = &s[from..];
        let n = rest
            .bytes()
            .take_while(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
            .count();
        let after_ok = rest[n..].chars().next().is_none_or(char::is_whitespace);
        if before_ok && (1..=64).contains(&n) && after_ok {
            return Some(&rest[..n]);
        }
    }
    None
}

fn cap(s: &str) -> String {
    match s.char_indices().nth(COMMAND_MAX) {
        Some((i, _)) => s[..i].to_owned(),
        None => s.to_owned(),
    }
}

/// Splits off the first whitespace-separated word; `None` when there is none.
fn word(s: &str) -> Option<(&str, &str)> {
    let s = s.trim_start();
    if s.is_empty() {
        return None;
    }
    let end = s.find(char::is_whitespace).unwrap_or(s.len());
    Some((&s[..end], &s[end..]))
}

/// `ps -o pid=,ppid=,rss=,%cpu=,etime=,command=` (macOS, Linux). `env`: the commands carry their
/// environment (`ps -E`): the tag is read from it and the rest cut away.
pub fn parse_ps(text: &str, now: i64, env: bool) -> Vec<Proc> {
    text.split('\n')
        .filter_map(|line| ps_line(line.trim_end_matches('\r'), now, env))
        .collect()
}

fn ps_line(line: &str, now: i64, env: bool) -> Option<Proc> {
    let (pid, r) = word(line)?;
    let (ppid, r) = word(r)?;
    let (rss, r) = word(r)?;
    let (cpu, r) = word(r)?;
    let (etime, r) = word(r)?;
    // the command is separated by whitespace, and may be empty
    if !r.starts_with(char::is_whitespace) {
        return None;
    }
    if !cpu.bytes().all(|b| b.is_ascii_digit() || b == b'.') {
        return None;
    }
    let rest = r.trim_start();
    let task = if env {
        tag_in(rest).map(str::to_owned)
    } else {
        None
    };
    let command = if env { cut_env(rest) } else { rest.trim() };
    Some(Proc {
        pid: u32::try_from(digits(pid)?).ok()?,
        ppid: u32::try_from(digits(ppid)?).ok()?,
        rss: u64::try_from(digits(rss)?).ok()?.saturating_mul(1024),
        cpu: cpu.parse().unwrap_or(0.0),
        since: now.saturating_sub(parse_etime(etime)),
        command: cap(command),
        task,
        time: 0,
    })
}

/// Windows: `Get-CimInstance Win32_Process` as JSON (one object when there's one process). `T` is kernel
/// + user time in 100 ns units, `S` the start in ms.
pub const WIN_PS: &str = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,@{n='T';e={[int64]$_.KernelModeTime+[int64]$_.UserModeTime}},@{n='S';e={if($_.CreationDate){([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}else{0}}},CommandLine | ConvertTo-Json -Compress";

fn num(v: Option<&Value>) -> f64 {
    v.map_or(0.0, super::js_number)
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)] // clamped to the target's range first
fn as_u64(n: f64) -> u64 {
    if n.is_finite() && n > 0.0 {
        n.min(u64::MAX as f64) as u64
    } else {
        0
    }
}

/// Weekdays from 1970-01-01, a Thursday.
const DAYS: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];

pub fn parse_win(text: &str, now: i64) -> Vec<Proc> {
    let Ok(j) = serde_json::from_str::<Value>(text) else {
        return Vec::new();
    };
    let list = match j {
        Value::Array(a) => a,
        other => vec![other],
    };
    list.iter().filter_map(|p| win_proc(p, now)).collect()
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)] // checked whole and in range
fn win_proc(p: &Value, now: i64) -> Option<Proc> {
    let id = p.get("ProcessId")?.as_f64()?;
    if id.fract() != 0.0 || !(0.0..=f64::from(u32::MAX)).contains(&id) {
        return None;
    }
    let ppid = num(p.get("ParentProcessId"));
    let start = num(p.get("S"));
    let command = match p.get("CommandLine") {
        Some(Value::String(s)) => s.as_str(),
        _ => "",
    };
    Some(Proc {
        pid: id as u32,
        ppid: u32::try_from(as_u64(ppid)).unwrap_or(0),
        rss: as_u64(num(p.get("WorkingSetSize"))),
        cpu: 0.0,
        time: as_u64(num(p.get("T"))),
        since: if start.is_finite() && start != 0.0 {
            start as i64
        } else {
            now
        },
        command: cap(command),
        task: None,
    })
}

/// `<pid> <bytes>` lines (the old perl reader's output): pids whose footprint read, bytes > 0.
pub fn parse_footprints(text: &str) -> HashMap<u32, u64> {
    let mut out = HashMap::new();
    for line in text.split('\n') {
        let Some((a, b)) = line.trim().split_once(' ') else {
            continue;
        };
        if let (Some(pid), Some(bytes)) = (
            digits(a).and_then(|n| u32::try_from(n).ok()),
            digits(b).and_then(|n| u64::try_from(n).ok()),
        ) && bytes > 0
        {
            out.insert(pid, bytes);
        }
    }
    out
}

/// What a group of left-behind processes is called: the program and the script or subcommand before
/// the first flag (`node …/bin/wisp.js`, `npm run dev`), so three test servers on three ports are one line.
pub fn command_key(command: &str) -> String {
    let lead: Vec<&str> = command
        .split_whitespace()
        .take_while(|w| !w.starts_with('-'))
        .take(3)
        .collect();
    if lead.is_empty() {
        command.chars().take(80).collect()
    } else {
        lead.join(" ")
    }
}

/// `/proc/<pid>/environ`: NUL-separated.
pub fn tag_in_environ(text: &str) -> Option<String> {
    text.split('\0')
        .find_map(|x| x.strip_prefix("WISP_TASK="))
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Battery {
    pub pct: u32,
    /// on the charger
    pub charging: bool,
}

/// `pmset -g batt`, or `None` on a Mac without a battery.
pub fn parse_batt(text: &str) -> Option<Battery> {
    let mut from = 0;
    while let Some(off) = text.get(from..).and_then(|r| r.find("InternalBattery")) {
        let start = from + off + "InternalBattery".len();
        from = start;
        let line = text[start..].split('\n').next().unwrap_or_default();
        if let Some(pct) = first_percent(line) {
            return Some(Battery {
                pct,
                charging: !text.contains("'Battery Power'"),
            });
        }
    }
    None
}

/// The first 1–3 digits followed by `%` (v1's lazy `[^\n]*?(\d{1,3})%`).
fn first_percent(line: &str) -> Option<u32> {
    let b = line.as_bytes();
    for i in 0..b.len() {
        for len in (1..=3).rev() {
            let Some(d) = b.get(i..i + len) else { continue };
            if d.iter().all(u8::is_ascii_digit) && b.get(i + len) == Some(&b'%') {
                return line[i..i + len].parse().ok();
            }
        }
    }
    None
}

/// `sysctl -n vm.loadavg` (`{ 1.23 1.45 1.67 }`) or `/proc/loadavg` (`1.23 1.45 1.67 2/345 6789`):
/// the 1-minute load.
pub fn parse_loadavg(text: &str) -> Option<f64> {
    let n: f64 = text
        .trim()
        .trim_start_matches('{')
        .split_whitespace()
        .next()?
        .parse()
        .ok()?;
    (n.is_finite() && n >= 0.0).then_some(n)
}

/// `date +%z` (`+0200`, `-0530`) or PowerShell's `zzz` (`+02:00`): the local offset from UTC in ms.
pub fn parse_tz_offset(text: &str) -> Option<i64> {
    let t = text.trim().replace(':', "");
    let (sign, rest) = match t.as_bytes().first()? {
        b'+' => (1, &t[1..]),
        b'-' => (-1, &t[1..]),
        _ => return None,
    };
    if rest.len() != 4 || !rest.is_ascii() {
        return None;
    }
    let (h, m) = (digits(&rest[..2])?, digits(&rest[2..])?);
    (h <= 14 && m < 60).then_some(sign * (h * 60 + m) * 60_000)
}

const DAY_MS: i64 = 86_400_000;

/// "20:00" today, "tomorrow 08:00", else "Mon 08:00", in the local time `tz` (ms from UTC) gives.
pub fn until_text(at: i64, now: i64, tz: i64) -> String {
    let local = at.saturating_add(tz);
    let mins = local.rem_euclid(DAY_MS) / 60_000;
    let hm = format!("{:02}:{:02}", mins / 60, mins % 60);
    let day = |t: i64| t.saturating_add(tz).div_euclid(DAY_MS);
    if day(at) == day(now) {
        return hm;
    }
    if day(at) == day(now.saturating_add(DAY_MS)) {
        return format!("tomorrow {hm}");
    }
    let wd = usize::try_from(day(at).rem_euclid(7)).unwrap_or(0);
    format!("{} {hm}", DAYS[wd % 7])
}
