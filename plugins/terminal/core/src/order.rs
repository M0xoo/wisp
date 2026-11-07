//! Numbered input (v1 Terms.input). A page sends keys without waiting for the last send to answer (each
//! round trip to a cloud computer would hold up the next key): numbered (`seq`, counted per page:
//! `from`), they may arrive out of order and go in in order. A gap (a send that failed) is skipped
//! `GAP_MS` after the last key that came. At most `MAX_SENDERS` pages are remembered; the one heard of
//! first is forgotten first.
//!
//! Sans-IO: time comes in as `now` (ms) and what is ready to type comes back out; the host types it and
//! wakes `tick` at `deadline()`.

use std::collections::BTreeMap;

pub const GAP_MS: i64 = 1000;
pub const MAX_SENDERS: usize = 8;

#[derive(Debug, Default)]
struct Sender {
    from: String,
    next: i64,
    held: BTreeMap<i64, String>,
    /// when its gap is skipped; `None` while nothing is held
    due: Option<i64>,
}

impl Sender {
    /// Everything that can go in now; `skip` jumps a gap first.
    fn flush(&mut self, skip: bool, now: i64, out: &mut Vec<String>) {
        if skip && let Some((&first, _)) = self.held.first_key_value() {
            self.next = first;
        }
        while let Some(d) = self.held.remove(&self.next) {
            out.push(d);
            self.next += 1;
        }
        self.due = (!self.held.is_empty()).then_some(now + GAP_MS);
    }
}

#[derive(Debug, Default)]
pub struct InputOrder {
    /// in the order they were first heard of (≤ MAX_SENDERS: a Vec beats a map)
    senders: Vec<Sender>,
}

impl InputOrder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Key `seq` from page `from`. Returns what goes in now, in order (a resend returns nothing).
    pub fn put(&mut self, data: String, seq: i64, from: &str, now: i64) -> Vec<String> {
        let i = match self.senders.iter().position(|s| s.from == from) {
            Some(i) => i,
            None => {
                if self.senders.len() >= MAX_SENDERS {
                    self.senders.remove(0);
                }
                self.senders.push(Sender { from: from.to_owned(), ..Sender::default() });
                self.senders.len() - 1
            }
        };
        let mut out = Vec::new();
        let Some(q) = self.senders.get_mut(i) else { return out };
        if seq < q.next {
            return out; // sent again
        }
        q.held.insert(seq, data);
        q.flush(false, now, &mut out);
        out
    }

    /// The gaps that waited long enough are skipped: what goes in now.
    pub fn tick(&mut self, now: i64) -> Vec<String> {
        let mut out = Vec::new();
        for q in &mut self.senders {
            if q.due.is_some_and(|d| d <= now) {
                q.flush(true, now, &mut out);
            }
        }
        out
    }

    /// When `tick` next has something to do.
    pub fn deadline(&self) -> Option<i64> {
        self.senders.iter().filter_map(|s| s.due).min()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn typed(o: &mut InputOrder, data: &str, seq: i64, from: &str, now: i64, into: &mut Vec<String>) {
        into.extend(o.put(data.to_owned(), seq, from, now));
    }

    // v1 test/pty.test.js "Terms: numbered input goes in in order, a gap is skipped" (the order part).
    #[test]
    fn in_order_a_resend_once_and_a_gap_skipped_after_a_second() {
        let mut o = InputOrder::new();
        let mut t = Vec::new();
        typed(&mut o, "b", 1, "p1", 0, &mut t);
        typed(&mut o, "Z", 0, "p2", 0, &mut t);
        assert_eq!(t, ["Z"], "b waits for 0");
        typed(&mut o, "a", 0, "p1", 0, &mut t);
        typed(&mut o, "a", 0, "p1", 0, &mut t);
        assert_eq!(t, ["Z", "a", "b"], "in order, a resend once");
        typed(&mut o, "d", 3, "p1", 10, &mut t);
        assert_eq!(o.deadline(), Some(10 + GAP_MS));
        t.extend(o.tick(10 + GAP_MS - 1));
        assert_eq!(t.last().map(String::as_str), Some("b"));
        t.extend(o.tick(10 + GAP_MS));
        assert_eq!(t.last().map(String::as_str), Some("d"), "seq 2 never came: d goes in after a second");
        assert_eq!(o.deadline(), None, "nothing held, no timer");
        typed(&mut o, "late 2", 2, "p1", 2000, &mut t);
        assert_eq!(t.last().map(String::as_str), Some("d"), "the skipped key is dropped when it comes after all");
    }

    #[test]
    fn each_new_key_moves_the_gap_on() {
        let mut o = InputOrder::new();
        assert!(o.put("c".into(), 2, "p", 0).is_empty());
        assert!(o.put("d".into(), 3, "p", 900).is_empty());
        assert!(o.tick(1000).is_empty(), "the second key restarted the wait");
        assert_eq!(o.tick(1900), ["c", "d"], "0 and 1 skipped, then in order");
    }

    // v1/TS "nine pages typing: the oldest page's numbering is forgotten, the rest keep theirs".
    #[test]
    fn nine_pages_the_oldest_is_forgotten() {
        let mut o = InputOrder::new();
        let mut t = Vec::new();
        for p in 0..9 {
            typed(&mut o, &format!("p{p}"), 0, &format!("page{p}"), 0, &mut t);
        }
        typed(&mut o, "again", 0, "page0", 0, &mut t); // forgotten: its 0 counts as new
        typed(&mut o, "dup", 0, "page8", 0, &mut t); // remembered: a resend
        assert_eq!(&t[t.len() - 2..], ["p8", "again"]);
    }

    #[test]
    fn a_negative_seq_is_a_resend() {
        let mut o = InputOrder::new();
        assert!(o.put("x".into(), -1, "p", 0).is_empty());
        assert_eq!(o.put("y".into(), 0, "p", 0), ["y"]);
    }

    /// Property: whatever order a page's keys arrive in (with resends), each goes in exactly once and in
    /// order, as long as none is missing; a missing one only ever costs a skip, never a reorder.
    #[test]
    fn shuffled_keys_go_in_once_in_order() {
        let mut rng = crate::testrand::Rng::new(42);
        for _ in 0..500 {
            let n = 1 + rng.below(30);
            let missing = if rng.below(3) == 0 { Some(rng.below(n)) } else { None };
            let mut sends: Vec<usize> = (0..n).filter(|i| Some(*i) != missing).collect();
            for _ in 0..rng.below(5) {
                sends.push(rng.below(n));
            }
            rng.shuffle(&mut sends);
            let (mut o, mut out, mut now) = (InputOrder::new(), Vec::new(), 0);
            for i in sends.iter().filter(|i| Some(**i) != missing) {
                now += 1;
                out.extend(o.put(i.to_string(), i64::try_from(*i).unwrap_or(0), "page", now));
            }
            out.extend(o.tick(now + GAP_MS));
            let got: Vec<usize> = out.iter().filter_map(|s| s.parse().ok()).collect();
            let want: Vec<usize> = (0..n).filter(|i| Some(*i) != missing).collect();
            if missing.is_none() {
                assert_eq!(got, want);
            } else {
                assert!(got.windows(2).all(|w| w[0] < w[1]), "in order: {got:?}");
                assert!(got.iter().all(|g| want.contains(g)));
            }
        }
    }
}
