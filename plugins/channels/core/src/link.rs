//! `link <code>` in a private message: how a person becomes an allowed sender. A code links one
//! person, and guessing changes it: a new code after 5 wrong guesses, at most 50 wrong guesses a day
//! from everyone and 5 from any one sender (by a hash of who, so the config holds no ids of
//! strangers). The day's count lives in the channel's config, so a cloud wisp that sleeps keeps it.
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::sign::same;

/// wrong codes before the code changes
pub const LINK_TRIES: u32 = 5;
/// wrong codes a day, from everyone: past them, nobody links until tomorrow
pub const LINK_DAY: u32 = 50;
/// wrong codes a day, from one sender: so it takes many to use up the day
pub const LINK_EACH: u32 = 5;

pub const ALREADY: &str = "You’re already linked.";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LinkGuess {
    /// `YYYY-MM-DD`, UTC
    pub day: String,
    /// wrong since the code last changed
    pub wrong: u32,
    /// wrong today
    pub spent: u32,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub by: BTreeMap<String, u32>,
}

/// The parts of a channel's config linking reads and writes (`senders`, `linkCode`, `linkGuess`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkCfg {
    #[serde(default)]
    pub senders: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link_guess: Option<LinkGuess>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Linked {
    /// say [`ALREADY`]
    Already,
    /// over a limit: silence, the right code too, or guessing goes on
    Silent,
    /// say "That isn’t the code…"; `new_code`: the code changed (Settings should look again)
    Wrong { new_code: bool },
    /// linked: say the channel's line, count it, Settings should look again
    Done,
}

impl Linked {
    /// What the config change needs: saved (`Wrong`, `Done`), and Settings told (`Done`, a new code).
    pub fn changed(&self) -> bool {
        matches!(self, Self::Done | Self::Wrong { new_code: true })
    }
    pub fn saves(&self) -> bool {
        matches!(self, Self::Done | Self::Wrong { .. })
    }
}

pub fn wrong_line(place: &str) -> String {
    format!("That isn’t the code. wisp shows it in {place}.")
}

/// Where a fresh code is drawn from: `hub.random_int(CODE_MIN, CODE_MAX)`, six digits.
pub const CODE_MIN: u32 = 100_000;
pub const CODE_MAX: u32 = 999_999;

/// The UTC day of `now_ms`, `YYYY-MM-DD` (civil-from-days, so no clock or calendar crate).
pub fn utc_day(now_ms: i64) -> String {
    let days = now_ms.div_euclid(86_400_000);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

/// One attempt. `who`: the hashed sender (`hash("link:<channel>:<user>")[..16]`); `fresh`: a new
/// code when one is needed. The caller checked its per-sender rate limit first.
pub fn attempt(cfg: &mut LinkCfg, user: &str, who: &str, code: Option<&str>, now_ms: i64, fresh: impl FnOnce() -> String) -> Linked {
    if cfg.senders.iter().any(|s| s == user) {
        return Linked::Already;
    }
    let day = utc_day(now_ms);
    let mut g = match cfg.link_guess.take() {
        Some(g) if g.day == day => g,
        prev => LinkGuess { day, wrong: prev.map_or(0, |p| p.wrong), spent: 0, by: BTreeMap::new() },
    };
    let theirs = g.by.get(who).copied().unwrap_or(0);
    if g.spent >= LINK_DAY || theirs >= LINK_EACH {
        cfg.link_guess = Some(g);
        return Linked::Silent;
    }
    let right = matches!((code, cfg.link_code.as_deref()), (Some(c), Some(want)) if !c.is_empty() && same(c, want));
    if !right {
        g.wrong += 1;
        g.spent += 1;
        g.by.insert(who.to_owned(), theirs + 1);
        let new_code = g.wrong >= LINK_TRIES;
        if new_code {
            g.wrong = 0;
            cfg.link_code = Some(fresh());
        }
        cfg.link_guess = Some(g);
        return Linked::Wrong { new_code };
    }
    g.wrong = 0;
    cfg.link_guess = Some(g);
    cfg.senders.push(user.to_owned());
    // one person, one code
    cfg.link_code = Some(fresh());
    Linked::Done
}
