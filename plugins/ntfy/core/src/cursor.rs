//! Where reading `<topic>-reply` stopped, so a tap sent while wisp was down (or its box asleep)
//! still lands, and one already handled doesn't land twice. `since` is the last message's id, or at
//! first the time in seconds. ntfy sends the messages of since's own second again and leaves dropping
//! them to the client: going back to one would loop, and after a restart repeat it, so the last
//! `SEEN_KEPT` ids are kept with since. Both are written to config; the run's memory holds more.
use std::collections::{HashSet, VecDeque};

/// Taps of one second: a person's thumb doesn't get near this.
pub const SEEN_KEPT: usize = 20;
/// What one run remembers besides (v1 `Seen`'s 1000).
const RUN_MAX: usize = 1000;

#[derive(Debug, Clone, Default)]
pub struct Cursor {
    since: String,
    kept: Vec<String>,
    run: HashSet<String>,
    order: VecDeque<String>,
}

impl Cursor {
    /// From config. The kept ids count as seen.
    pub fn new(since: String, kept: Vec<String>) -> Self {
        let mut c = Self { since, kept: Vec::new(), run: HashSet::new(), order: VecDeque::new() };
        let start = kept.len().saturating_sub(SEEN_KEPT);
        for id in &kept[start..] {
            c.remember(id);
        }
        c.kept = kept[start..].to_vec();
        c
    }

    /// A first start reads from now, and says so at once (saved before any tap comes), so the next
    /// start misses nothing after it. → true when the caller must save.
    pub fn begin(&mut self, now_s: i64) -> bool {
        if !self.since.is_empty() {
            return false;
        }
        self.since = now_s.to_string();
        true
    }

    pub fn since(&self) -> &str {
        &self.since
    }

    pub fn kept(&self) -> &[String] {
        &self.kept
    }

    /// True the first time this id comes by (in this run or the last `SEEN_KEPT` handled). An empty
    /// id is never a repeat: there's nothing to know it by.
    pub fn first(&mut self, id: &str) -> bool {
        id.is_empty() || self.remember(id)
    }

    /// After the tap was handled: since moves to it, and it joins the kept ids. Handling first means a
    /// crash in between repeats a tap (which only says it was already answered) rather than losing it.
    pub fn handled(&mut self, id: &str) {
        if id.is_empty() {
            return;
        }
        self.kept.retain(|k| k != id);
        self.kept.push(id.to_owned());
        if self.kept.len() > SEEN_KEPT {
            let cut = self.kept.len() - SEEN_KEPT;
            self.kept.drain(..cut);
        }
        id.clone_into(&mut self.since);
    }

    fn remember(&mut self, id: &str) -> bool {
        if !self.run.insert(id.to_owned()) {
            return false;
        }
        self.order.push_back(id.to_owned());
        if self.order.len() > RUN_MAX
            && let Some(old) = self.order.pop_front()
        {
            self.run.remove(&old);
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_first_start_keeps_its_place() {
        let mut c = Cursor::default();
        assert!(c.begin(1_700_000_000));
        assert_eq!(c.since(), "1700000000");
        assert!(!c.begin(1_800_000_000), "a place already kept stays");
    }

    #[test]
    fn a_repeat_acts_once_and_does_not_move_the_place_back() {
        let mut c = Cursor::new("100".into(), vec![]);
        for id in ["m1", "m2"] {
            assert!(c.first(id));
            c.handled(id);
        }
        // ntfy sends m1 and m2 again: their second is since's own
        assert!(!c.first("m1"));
        assert!(!c.first("m2"));
        assert_eq!(c.since(), "m2");
    }

    #[test]
    fn handled_ids_survive_a_restart() {
        let mut one = Cursor::new(String::new(), vec![]);
        one.begin(5);
        assert!(one.first("m1"));
        one.handled("m1");
        let mut two = Cursor::new(one.since().to_owned(), one.kept().to_vec());
        assert!(!two.first("m1"), "already handled before the restart");
        assert!(two.first("m2"));
    }

    #[test]
    fn only_the_last_20_are_kept() {
        let mut c = Cursor::default();
        for i in 0..30 {
            let id = format!("m{i}");
            c.first(&id);
            c.handled(&id);
        }
        assert_eq!(c.kept().len(), SEEN_KEPT);
        assert_eq!(c.kept()[0], "m10");
        let mut back = Cursor::new(c.since().into(), c.kept().to_vec());
        assert!(back.first("m9"), "fell out: a restart forgets it");
        assert!(!back.first("m29"));
    }

    #[test]
    fn empty_ids_are_never_repeats() {
        let mut c = Cursor::default();
        assert!(c.first(""));
        assert!(c.first(""));
        c.handled("");
        assert!(c.kept().is_empty());
    }

    /// Property (model-based): against a plain model (every id ever handled, the newest 20 kept),
    /// across random restarts a handled id never acts again while it is in the kept window.
    #[test]
    fn property_never_twice_within_the_window() {
        let mut x: u64 = 0x1234_5678_9ABC_DEF1;
        let mut c = Cursor::default();
        let mut window: VecDeque<String> = VecDeque::new();
        for _ in 0..20_000 {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            if x % 37 == 0 {
                c = Cursor::new(c.since().into(), c.kept().to_vec());
                continue;
            }
            let id = format!("m{}", x % 60);
            let fresh = c.first(&id);
            if window.contains(&id) {
                assert!(!fresh, "{id} acted twice");
            }
            if fresh {
                c.handled(&id);
                window.retain(|w| w != &id);
                window.push_back(id);
                if window.len() > SEEN_KEPT {
                    window.pop_front();
                }
            }
            assert_eq!(c.kept().iter().cloned().collect::<VecDeque<_>>(), window);
        }
    }
}
