//! A schedule in words ("every monday", "8am every weekday", "every 15 min between 9 and 6") to a
//! 5-field cron (v1 web/js/schedule.js:45-178). A phrase with a word it doesn't know is refused rather
//! than guessed; a cron typed as-is passes through.
//!
//! The reading is v1's: each pattern, in order, cuts what it understood out of the text, and anything
//! left over that isn't filler refuses the whole phrase. JS's `(?= |$)` lookahead becomes a trailing
//! `(?P<la> |$)` group that is matched but not cut.

use std::sync::LazyLock;

use regex::{Captures, Regex};

pub const DAY_NAMES: [&str; 7] = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
];
const ALIASES: [&str; 5] = ["@hourly", "@daily", "@weekly", "@monthly", "@weekdays"];
// Words that carry no meaning of their own once the rest is read.
const FILLER: [&str; 31] = [
    "every", "each", "on", "at", "in", "the", "and", "a", "an", "of", "run", "runs", "check",
    "checks", "please", "o", "clock", "o'clock", "around", "about", "only", "per", "once", "from",
    "to", "until", "till", "through", "thru", "between", "during",
];

const DAY: &str = r"(sun|mon|tue|wed|thu|fri|sat)[a-z]*";
const CLOCK: &str = r"(\d{1,2})(?:[:.h](\d{2}))?\s*(am|pm)?";

fn re(src: &str) -> Option<Regex> {
    Regex::new(src).ok()
}

struct Patterns {
    every: Option<Regex>,
    hourly: Option<Regex>,
    past: Option<Regex>,
    work_hours: Option<Regex>,
    between: Option<Regex>,
    weekdays: Option<Regex>,
    weekends: Option<Regex>,
    day_range: Option<Regex>,
    day: Option<Regex>,
    daily: Option<Regex>,
    nth: Option<Regex>,
    monthly: Option<Regex>,
    weekly: Option<Regex>,
    at: Option<Regex>,
    part: Option<Regex>,
    and: Option<Regex>,
    is_day: Option<Regex>,
}

static P: LazyLock<Patterns> = LazyLock::new(|| Patterns {
    every: re(
        r" (?:every|each) (?:(\d+|other|half an?|half|quarter|a) )?(minutes?|mins?|m|hours?|hrs?|h)\b(?: (?:past|after) the hour)?",
    ),
    hourly: re(r" (?:hourly|every hour on the hour)\b"),
    past: re(r" (\d{1,2}) (?:minutes? )?past the hour\b"),
    work_hours: re(r" (?:during )?(?:work|working|office|business) hours\b"),
    between: re(&format!(
        r" (?:between|from) {CLOCK} (?:and|to|until|till|-) {CLOCK}\b"
    )),
    weekdays: re(
        r" (?:every |each |on )?(?:weekdays?|work ?days?|working days?|business days?|mon(?:day)?s? ?(?:-|to|through|thru) ?fri(?:day)?s?)\b",
    ),
    weekends: re(r" (?:every |each |on |at )?(?:the )?weekends?\b"),
    day_range: re(&format!(
        r" ({DAY}) ?(?:-|to|through|thru|until) ?({DAY})\b"
    )),
    day: re(&format!(r" {DAY}\b")),
    daily: re(
        r" (?:every day|each day|daily|nightly|everyday|(?:once )?(?:a|per) day|every night|every morning|every evening|every afternoon)\b",
    ),
    nth: re(
        r" (?:every |each |on )?(?:the )?(first|1st|last|\d{1,2}(?:st|nd|rd|th)?) (?:day )?of (?:the |each |every )?month\b",
    ),
    monthly: re(r" (?:every month|each month|monthly|(?:once )?(?:a|per) month)\b"),
    weekly: re(r" (?:every week|each week|weekly|(?:once )?(?:a|per) week)\b"),
    at: re(&format!(r" (?:at |@ ?)?{CLOCK}(?P<la> |$)")),
    part: re(
        r" (?:in the |at |every )?(morning|mornings|noon|midday|lunchtime|afternoons?|evenings?|nights?|tonight|midnight)\b",
    ),
    and: re(r" (?:and|&) (\d{1,2})(?P<la> |$)"),
    is_day: re(
        r"^(?:(?:sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)|(?:sun|mon|tues|wednes|thurs|fri|satur)days?)$",
    ),
});

fn part_of_day(w: &str) -> Option<u32> {
    Some(match w {
        "morning" | "mornings" => 9,
        "noon" | "midday" | "lunchtime" => 12,
        "afternoon" | "afternoons" => 14,
        "evening" | "evenings" => 18,
        "night" | "nights" | "tonight" => 21,
        "midnight" => 0,
        _ => return None,
    })
}

/// What the words said so far, and what is left of them.
#[derive(Default)]
struct Read {
    s: String,
    /// a fixed minute, `*` or `*/n`
    minute: Option<String>,
    /// `*` or `*/n` for "every n hours"
    hour: Option<String>,
    /// [from, to) for "between 9 and 6"
    hours: Option<(u32, u32)>,
    times: Vec<(u32, u32)>,
    dow: Option<Vec<u32>>,
    dom: Option<u32>,
    bad: bool,
}

/// What a pattern's reader made of one match: cut it out, or leave the words where they were.
#[derive(PartialEq, Eq)]
enum Keep {
    Cut,
    Leave,
}

// Each match is cut out of `r.s` (replaced by one space), unless `f` leaves it. The `la` group, when
// the pattern has one, is looked at but stays in the text for the next match (JS's lookahead).
fn take(r: &mut Read, re: Option<&Regex>, mut f: impl FnMut(&mut Read, &Captures) -> Keep) {
    let Some(re) = re else {
        r.bad = true;
        return;
    };
    let s = std::mem::take(&mut r.s);
    let mut out = String::with_capacity(s.len());
    let mut pos = 0;
    while pos <= s.len() {
        let Some(caps) = re.captures_at(&s, pos) else {
            break;
        };
        let Some(whole) = caps.get(0) else { break };
        let end = caps.name("la").map_or(whole.end(), |la| la.start());
        out.push_str(&s[pos..whole.start()]);
        if f(r, &caps) == Keep::Cut {
            out.push(' ');
        } else {
            out.push_str(&s[whole.start()..end]);
        }
        if end == pos {
            break;
        }
        pos = end;
    }
    out.push_str(s.get(pos..).unwrap_or(""));
    r.s = out;
}

fn g<'a>(c: &'a Captures, i: usize) -> Option<&'a str> {
    c.get(i).map(|m| m.as_str()).filter(|s| !s.is_empty())
}

fn n(s: Option<&str>) -> u32 {
    s.and_then(|x| x.parse().ok()).unwrap_or(0)
}

/// A clock reading → (hour, minute) in 24 h, or `None` when it isn't one.
fn clock(h: u32, mm: u32, ap: Option<&str>) -> Option<(u32, u32)> {
    let mut hh = h;
    if let Some(ap) = ap {
        if !(1..=12).contains(&hh) {
            return None;
        }
        hh = hh % 12 + if ap.starts_with('p') { 12 } else { 0 };
    }
    (hh <= 23 && mm <= 59).then_some((hh, mm))
}

fn is_day(w: &str) -> bool {
    P.is_day.as_ref().is_some_and(|re| re.is_match(w))
}

fn day_index(w: &str) -> u32 {
    let p: String = w.chars().take(3).collect::<String>().to_lowercase();
    DAY_NAMES
        .iter()
        .position(|d| d.starts_with(&p))
        .and_then(|i| u32::try_from(i).ok())
        .unwrap_or(0)
}

fn day_range(a: u32, b: u32) -> Vec<u32> {
    if a <= b {
        (a..=b).collect()
    } else {
        (a..=6).chain(0..=b).collect()
    }
}

/// `[1,2,3,4,5]` → `"1-5"`: what a person would write, and what cron words read back.
pub fn compact(nums: &[u32]) -> String {
    let mut s: Vec<u32> = nums.to_vec();
    s.sort_unstable();
    s.dedup();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i < s.len() {
        let mut j = i;
        while j + 1 < s.len() && s[j + 1] == s[j] + 1 {
            j += 1;
        }
        out.push(match j - i {
            0 => s[i].to_string(),
            1 => format!("{},{}", s[i], s[j]),
            _ => format!("{}-{}", s[i], s[j]),
        });
        i = j + 1;
    }
    out.join(",")
}

// How often: every n minutes / hours, hourly, every half hour.
fn read_every(r: &mut Read) {
    take(r, P.every.as_ref(), |r, m| {
        let word = g(m, 1).unwrap_or("1");
        let unit_h = g(m, 2).is_some_and(|u| u.starts_with('h'));
        let k = match word {
            "other" => Some(2),
            w if w.starts_with("half") => unit_h.then_some(30),
            "quarter" => unit_h.then_some(15),
            "a" => Some(1),
            w => w.parse::<u32>().ok(),
        };
        let Some(k) = k.filter(|k| *k > 0) else {
            r.bad = true;
            return Keep::Cut;
        };
        if unit_h && (word.starts_with("half") || word == "quarter") {
            r.minute = Some(format!("*/{k}"));
        } else if unit_h {
            if k > 23 {
                r.bad = true;
            }
            r.hour = Some(if k == 1 { "*".into() } else { format!("*/{k}") });
            r.minute.get_or_insert_with(|| "0".into());
        } else {
            if k > 59 {
                r.bad = true;
            }
            r.minute = Some(if k == 1 { "*".into() } else { format!("*/{k}") });
        }
        Keep::Cut
    });
    take(r, P.hourly.as_ref(), |r, _| {
        r.hour = Some("*".into());
        r.minute.get_or_insert_with(|| "0".into());
        Keep::Cut
    });
    take(r, P.past.as_ref(), |r, m| {
        let k = n(g(m, 1));
        if k > 59 {
            r.bad = true;
        }
        r.minute = Some(k.to_string());
        r.hour.get_or_insert_with(|| "*".into());
        Keep::Cut
    });
}

// Within which hours: "between 9 and 6", "from 9am to 5pm", "during work hours".
fn read_within(r: &mut Read) {
    take(r, P.work_hours.as_ref(), |r, _| {
        r.hours = Some((9, 18));
        Keep::Cut
    });
    take(r, P.between.as_ref(), |r, m| {
        let (h1, h2) = (n(g(m, 1)), n(g(m, 4)));
        // "9 to 5pm": the start takes am when it's the earlier hour of the morning.
        let ap1 = g(m, 3).or_else(|| (g(m, 6).is_some() && h1 <= 12 && h1 > h2).then_some("am"));
        let start = clock(h1, n(g(m, 2)), ap1);
        let mut stop = clock(h2, n(g(m, 5)), g(m, 6));
        // "between 9 and 6": the end is after the start, so 6 is 18:00.
        if let (Some(from), Some(to)) = (start, stop)
            && g(m, 6).is_none()
            && to.0 <= from.0
            && to.0 < 12
        {
            stop = Some((to.0 + 12, to.1));
        }
        match (start, stop) {
            (Some(from), Some(to)) if to.0 > from.0 => {
                r.hours = Some((from.0, to.0 + u32::from(to.1 > 0)))
            }
            _ => r.bad = true,
        }
        Keep::Cut
    });
}

fn add_days(r: &mut Read, days: impl IntoIterator<Item = u32>) {
    r.dow.get_or_insert_with(Vec::new).extend(days);
}

// Which days.
fn read_days(r: &mut Read) {
    take(r, P.weekdays.as_ref(), |r, _| {
        r.dow = Some(vec![1, 2, 3, 4, 5]);
        Keep::Cut
    });
    take(r, P.weekends.as_ref(), |r, _| {
        r.dow = Some(vec![0, 6]);
        Keep::Cut
    });
    take(r, P.day_range.as_ref(), |r, m| {
        let (a, b) = (g(m, 1).unwrap_or(""), g(m, 3).unwrap_or(""));
        if !is_day(a) || !is_day(b) {
            return Keep::Leave;
        }
        add_days(r, day_range(day_index(a), day_index(b)));
        Keep::Cut
    });
    take(r, P.day.as_ref(), |r, m| {
        if !is_day(g(m, 0).unwrap_or("").trim()) {
            return Keep::Leave;
        }
        add_days(r, [day_index(g(m, 1).unwrap_or(""))]);
        Keep::Cut
    });
    take(r, P.daily.as_ref(), |r, m| {
        let all = g(m, 0).unwrap_or("");
        if let Some(h) = ["morning", "evening", "afternoon", "night"]
            .iter()
            .find(|p| all.contains(*p))
            .and_then(|p| part_of_day(p))
        {
            r.times.push((h, 0));
        }
        r.dow.get_or_insert_with(Vec::new);
        Keep::Cut
    });
    read_month(r);
    take(r, P.weekly.as_ref(), |r, _| {
        r.dow.get_or_insert_with(|| vec![1]);
        Keep::Cut
    });
}

fn read_month(r: &mut Read) {
    take(r, P.nth.as_ref(), |r, m| {
        let w = g(m, 1).unwrap_or("");
        let k = match w {
            "last" => 0, // cron has no "last day"
            "first" => 1,
            _ => n(Some(w.trim_end_matches(|c: char| c.is_ascii_alphabetic()))),
        };
        if (1..=31).contains(&k) {
            r.dom = Some(k);
        } else {
            r.bad = true;
        }
        Keep::Cut
    });
    take(r, P.monthly.as_ref(), |r, _| {
        r.dom.get_or_insert(1);
        Keep::Cut
    });
}

// What time: "8am", "at 9", "17:30", "9am and 5pm", "noon", "in the morning".
fn read_times(r: &mut Read) {
    take(r, P.at.as_ref(), |r, m| {
        // A bare number only counts after "at" ("at 9"), or with a colon ("17:30"), or am/pm.
        let all = g(m, 0).unwrap_or("").trim_start();
        if !(all.starts_with("at") || all.starts_with('@'))
            && g(m, 2).is_none()
            && g(m, 3).is_none()
        {
            return Keep::Leave;
        }
        match clock(n(g(m, 1)), n(g(m, 2)), g(m, 3)) {
            Some(t) => r.times.push(t),
            None => r.bad = true,
        }
        Keep::Cut
    });
    take(r, P.part.as_ref(), |r, m| {
        r.times
            .push((g(m, 1).and_then(part_of_day).unwrap_or(9), 0));
        Keep::Cut
    });
    take(r, P.and.as_ref(), |r, m| {
        // "at 9 and 5": the second time takes the first's half of the day only when it makes sense.
        let Some(&(prev, _)) = r.times.last() else {
            return Keep::Leave;
        };
        let k = n(g(m, 1));
        let ap = (k <= 12).then_some(if prev >= 12 || k < prev { "pm" } else { "am" });
        match clock(k, 0, ap) {
            Some(t) => r.times.push(t),
            None => r.bad = true,
        }
        Keep::Cut
    });
}

// What was read → the minute and hour fields, or None when they don't make one cron line.
fn minute_hour(r: &Read) -> Option<(String, String)> {
    if let Some(first) = r.times.first() {
        if r.minute.is_some() || r.hour.is_some() {
            return None; // "every 15 min at 9am"
        }
        if r.times.iter().any(|t| t.1 != first.1) {
            return None; // 9:00 and 17:30 isn't one cron line
        }
        let hours: Vec<u32> = r.times.iter().map(|t| t.0).collect();
        return Some((first.1.to_string(), compact(&hours)));
    }
    if r.minute.is_some() || r.hour.is_some() {
        let mut h = r.hour.clone().unwrap_or_else(|| "*".into());
        if let Some((a, b)) = r.hours {
            h = if h == "*" {
                format!("{a}-{}", b - 1)
            } else {
                format!("{a}-{}/{}", b - 1, h.get(2..).unwrap_or(""))
            };
        }
        return Some((r.minute.clone().unwrap_or_else(|| "0".into()), h));
    }
    if r.hours.is_some() {
        return None; // "during work hours", but how often?
    }
    Some(("0".into(), "9".into())) // a day with no time: the morning
}

fn is_cron(raw: &str) -> bool {
    let parts: Vec<&str> = raw.split_whitespace().collect();
    parts.len() == 5
        && parts.iter().all(|p| {
            p.bytes()
                .all(|b| b.is_ascii_digit() || b"*,/-".contains(&b))
        })
}

// Lower case, curly quotes made straight, punctuation that ends a word dropped, spaces collapsed.
fn normalise(raw: &str) -> String {
    let lower: Vec<char> = raw
        .to_lowercase()
        .chars()
        .map(|c| if c == '’' || c == '`' { '\'' } else { c })
        .collect();
    let mut out = String::with_capacity(lower.len() + 2);
    let mut i = 0;
    while i < lower.len() {
        let mut j = i;
        while j < lower.len() && ",;.!?".contains(lower[j]) {
            j += 1;
        }
        if j > i {
            let ends = j == lower.len() || lower[j].is_whitespace();
            if ends {
                out.push(' ');
            } else {
                out.extend(&lower[i..j]);
            }
            i = j;
        } else {
            out.push(lower[i]);
            i += 1;
        }
    }
    format!(" {} ", out.split_whitespace().collect::<Vec<_>>().join(" "))
}

/// Words → a cron string, or `None` when the words aren't a schedule it can read.
pub fn to_cron(text: &str) -> Option<String> {
    let raw = text.trim();
    if raw.is_empty() {
        return None;
    }
    if ALIASES.contains(&raw) || is_cron(raw) {
        return Some(raw.to_owned());
    }
    let mut r = Read {
        s: normalise(raw),
        ..Read::default()
    };
    read_every(&mut r);
    read_within(&mut r);
    read_days(&mut r);
    read_times(&mut r);
    let left =
        r.s.split(' ')
            .any(|w| !w.is_empty() && !FILLER.contains(&w));
    let said = r.minute.is_some()
        || r.hour.is_some()
        || r.hours.is_some()
        || !r.times.is_empty()
        || r.dow.is_some()
        || r.dom.is_some();
    if r.bad || left || !said {
        return None;
    }
    let (m, h) = minute_hour(&r)?;
    let dow = match &r.dow {
        Some(d) if !d.is_empty() && d.len() < 7 => compact(d),
        _ => "*".into(),
    };
    let dom = r.dom.map_or_else(|| "*".into(), |d| d.to_string());
    Some(format!("{m} {h} {dom} * {dow}"))
}
