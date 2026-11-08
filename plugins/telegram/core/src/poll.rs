//! Where reading stopped. Polled, it's `getUpdates`' offset: memory that outlives the loop's
//! restarts (every settings change restarts it), or Telegram would hand back updates already handled
//! and a /new would start twice. Hooked, it's the last update ids, kept with the webhook in config:
//! a box forgets everything when it sleeps, and only a retry repeats an update.
use serde::{Deserialize, Serialize};

/// `getUpdates`' offset. A new token is another bot with its own counter: start it over.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Offset {
    next: i64,
    token_mark: u64,
}

impl Offset {
    /// The offset to ask with.
    pub fn next(&self) -> i64 {
        self.next
    }

    /// True the first time an update comes by: moves past it.
    pub fn accept(&mut self, update_id: i64) -> bool {
        if update_id < self.next {
            return false;
        }
        self.next = update_id.saturating_add(1);
        true
    }

    /// The bot whose counter this is (a cheap hash of its token): another one starts at 0.
    pub fn for_bot(&mut self, token: &str) {
        let mark = fnv(token);
        if mark != self.token_mark {
            *self = Self {
                next: 0,
                token_mark: mark,
            };
        }
    }
}

fn fnv(s: &str) -> u64 {
    s.bytes().fold(0xcbf2_9ce4_8422_2325, |h, b| {
        (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3)
    })
}

/// v1 `SEEN_UPDATES`.
pub const SEEN_UPDATES: usize = 100;

/// The webhook's last update ids, newest last. Serialised as a plain array in `telegram.hook.seen`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct HookSeen(pub Vec<i64>);

impl HookSeen {
    pub fn has(&self, id: i64) -> bool {
        self.0.contains(&id)
    }
    /// True the first time; keeps the newest `SEEN_UPDATES`.
    pub fn first(&mut self, id: i64) -> bool {
        if self.has(id) {
            return false;
        }
        self.0.push(id);
        if self.0.len() > SEEN_UPDATES {
            let cut = self.0.len() - SEEN_UPDATES;
            self.0.drain(..cut);
        }
        true
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::assert_is_empty)]
mod tests {
    use super::*;

    #[test]
    fn offset_moves_forward_only() {
        let mut o = Offset::default();
        o.for_bot("t1");
        assert!(o.accept(10));
        assert_eq!(o.next(), 11);
        assert!(!o.accept(10), "handed back: already handled");
        assert!(!o.accept(3));
        assert!(o.accept(12));
        o.for_bot("t1");
        assert_eq!(
            o.next(),
            13,
            "the same bot keeps its place across restarts of the loop"
        );
        o.for_bot("t2");
        assert_eq!(o.next(), 0, "another bot, another counter");
    }

    #[test]
    fn hook_seen_keeps_100_and_round_trips() {
        let mut s = HookSeen::default();
        for i in 0..150 {
            assert!(s.first(i));
        }
        assert_eq!(s.0.len(), SEEN_UPDATES);
        assert!(!s.first(149));
        assert!(s.first(10), "fell out of the ring");
        let back: HookSeen = serde_json::from_value(serde_json::to_value(&s).unwrap()).unwrap();
        assert_eq!(back, s);
    }

    /// Property: whatever order updates arrive in, each id is accepted at most once, and every
    /// accepted id is above the ones before it.
    #[test]
    fn property_offset_never_accepts_twice() {
        let mut x: u64 = 88_172_645_463_325_252;
        let mut o = Offset::default();
        let mut taken = std::collections::BTreeSet::new();
        let mut last = -1;
        for _ in 0..10_000 {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            let id = i64::try_from(x % 500).unwrap();
            if o.accept(id) {
                assert!(taken.insert(id));
                assert!(id > last);
                last = id;
            }
        }
    }
}
