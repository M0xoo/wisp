//! Linking: only the chat that sends the code wisp shows in Settings gets attached, and guessing
//! is slow. A wrong code counts against the day (50 for everyone) and the sender (5 each, by a hash
//! of who, so one stranger can't spend everyone's day); 5 wrong in a row and the code changes. The
//! counts live in the config (`linkGuess`), as a cloud box forgets the rest each time it sleeps.
//! The same rule set as v1 `conversation.js` `Linking`, applied to Telegram (which v1 left
//! unlimited). Its own copy: a transport depends on `wisp-channels-api` only (ADR-0003).
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;

pub const LINK_TRIES: u32 = 5;
pub const LINK_DAY: u32 = 50;
pub const LINK_EACH: u32 = 5;

/// `telegram.linkGuess`: the day's wrong codes.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Guess {
    #[serde(default)]
    pub day: String,
    /// wrong in a row since the code last changed
    #[serde(default)]
    pub wrong: u32,
    /// wrong today, from everyone
    #[serde(default)]
    pub spent: u32,
    /// wrong today, by hashed sender
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub by: BTreeMap<String, u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkOutcome {
    /// the right code from a sender with guesses left: attach this chat, clear the code
    Linked,
    /// a wrong code; `rotate`: the code must change now
    Wrong { rotate: bool },
    /// past the day's or the sender's guesses: nothing happens, not even for the right code
    Spent,
}

/// What a message offers as a code: `/start <code>`, `/link <code>` or the bare code. Telegram's own
/// `/start` (a first open of the bot) and chatter offer nothing, and aren't counted.
pub fn links_it(text: &str) -> Option<&str> {
    let t = text.trim();
    let arg = ["/start", "/link"].iter().find_map(|p| {
        t.strip_prefix(p)
            .filter(|r| r.is_empty() || r.starts_with(char::is_whitespace))
    });
    match arg {
        Some(r) => Some(r.trim()).filter(|r| !r.is_empty()),
        None => (t.len() == 6 && t.bytes().all(|b| b.is_ascii_digit())).then_some(t),
    }
}

/// The day's guess book over one code.
#[derive(Debug)]
pub struct LinkBook<'a> {
    pub guess: &'a mut Guess,
    pub code: &'a str,
}

impl LinkBook<'_> {
    /// One attempt. `who`: a hash of the sender, `today`: `YYYY-MM-DD`.
    pub fn attempt(&mut self, tried: &str, who: &str, today: &str) -> LinkOutcome {
        if self.guess.day != today {
            // A new day keeps the run of wrong codes (the code hasn't changed), not the spending.
            *self.guess = Guess {
                day: today.to_owned(),
                wrong: self.guess.wrong,
                spent: 0,
                by: BTreeMap::new(),
            };
        }
        let theirs = self.guess.by.get(who).copied().unwrap_or(0);
        if self.guess.spent >= LINK_DAY || theirs >= LINK_EACH {
            return LinkOutcome::Spent;
        }
        if !self.code.is_empty() && bool::from(tried.as_bytes().ct_eq(self.code.as_bytes())) {
            self.guess.wrong = 0;
            return LinkOutcome::Linked;
        }
        self.guess.wrong += 1;
        self.guess.spent += 1;
        self.guess.by.insert(who.to_owned(), theirs + 1);
        let rotate = self.guess.wrong >= LINK_TRIES;
        if rotate {
            self.guess.wrong = 0;
        }
        LinkOutcome::Wrong { rotate }
    }
}

/// `YYYY-MM-DD` (UTC) of a time in ms: the guess book's day.
pub fn day_of(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    // Howard Hinnant's days-to-civil.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_counts_as_a_code() {
        assert_eq!(links_it("/start 123456"), Some("123456"));
        assert_eq!(links_it("  /link   abc "), Some("abc"));
        assert_eq!(links_it("123456"), Some("123456"));
        assert_eq!(links_it("/start"), None, "Telegram's own first open");
        assert_eq!(links_it("/started 1"), None);
        assert_eq!(links_it("hello"), None);
        assert_eq!(links_it("1234567"), None);
    }

    #[test]
    fn right_code_links_and_resets_the_run() {
        let mut g = Guess::default();
        let mut b = LinkBook {
            guess: &mut g,
            code: "424242",
        };
        assert_eq!(
            b.attempt("111111", "a", "2026-11-08"),
            LinkOutcome::Wrong { rotate: false }
        );
        assert_eq!(b.attempt("424242", "a", "2026-11-08"), LinkOutcome::Linked);
        assert_eq!(g.wrong, 0);
        assert_eq!(g.spent, 1, "the day still counts it");
    }

    #[test]
    fn five_wrong_in_a_row_change_the_code() {
        let mut g = Guess::default();
        let mut b = LinkBook {
            guess: &mut g,
            code: "424242",
        };
        for i in 0..4 {
            assert_eq!(
                b.attempt("0", &format!("s{i}"), "d"),
                LinkOutcome::Wrong { rotate: false }
            );
        }
        assert_eq!(
            b.attempt("0", "s9", "d"),
            LinkOutcome::Wrong { rotate: true }
        );
        assert_eq!(g.wrong, 0);
    }

    #[test]
    fn five_per_sender_then_even_the_right_code_does_nothing() {
        let mut g = Guess::default();
        let mut b = LinkBook {
            guess: &mut g,
            code: "424242",
        };
        for _ in 0..5 {
            assert!(matches!(
                b.attempt("0", "x", "d"),
                LinkOutcome::Wrong { .. }
            ));
        }
        assert_eq!(
            b.attempt("424242", "x", "d"),
            LinkOutcome::Spent,
            "else guessing goes on"
        );
        assert_eq!(
            b.attempt("424242", "y", "d"),
            LinkOutcome::Linked,
            "someone else still can"
        );
    }

    #[test]
    fn fifty_a_day_from_everyone_then_tomorrow() {
        let mut g = Guess::default();
        let mut b = LinkBook {
            guess: &mut g,
            code: "424242",
        };
        for i in 0..50 {
            assert!(matches!(
                b.attempt("0", &format!("s{}", i / 4), "d1"),
                LinkOutcome::Wrong { .. }
            ));
        }
        assert_eq!(b.attempt("424242", "new", "d1"), LinkOutcome::Spent);
        assert_eq!(b.attempt("424242", "new", "d2"), LinkOutcome::Linked);
    }

    #[test]
    fn the_book_survives_a_restart() {
        let mut g = Guess::default();
        LinkBook {
            guess: &mut g,
            code: "1",
        }
        .attempt("2", "h", "d");
        let back: Guess = serde_json::from_value(serde_json::to_value(&g).unwrap()).unwrap();
        assert_eq!(back, g);
    }

    #[test]
    fn days() {
        assert_eq!(day_of(0), "1970-01-01");
        assert_eq!(day_of(1_794_441_600_000), "2026-11-12");
        assert_eq!(day_of(951_782_400_000), "2000-02-29");
        assert_eq!(day_of(-1), "1969-12-31");
    }
}
