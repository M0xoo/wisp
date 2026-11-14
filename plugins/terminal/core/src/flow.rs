//! The terminal flow (plan §4.6.3) as a pure transition table, run on the server for every terminal.
//! An event a state doesn't take changes nothing, so a late event (output from a start that was
//! cancelled, a second STOP) can't put a terminal somewhere impossible.
//!
//! One addition to the plan's table: EXIT while starting. A program that ends before printing anything
//! (`false`, a shell that can't read its rc) ends the start; with code 127 it never ran, which is FAIL.

use wisp_terminal_api::TermState;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FlowEvent {
    /// open: a fresh terminal (never the dead screen of the last one, #432)
    Start,
    /// its first output
    Ready,
    /// `SLOW_MS` without output (#440)
    Slow,
    /// it never ran (a missing program, nothing to run, exit 127 before any output)
    Fail,
    /// closed by the user: a start in progress is cancelled, never raced (#435)
    Stop,
    /// the program ended on its own
    Exit,
    /// the program ended after a STOP
    Done,
}

pub const STATES: [TermState; 7] =
    [TermState::Idle, TermState::Starting, TermState::Slow, TermState::Running, TermState::Stopping, TermState::Ended, TermState::Failed];
pub const EVENTS: [FlowEvent; 7] =
    [FlowEvent::Start, FlowEvent::Ready, FlowEvent::Slow, FlowEvent::Fail, FlowEvent::Stop, FlowEvent::Exit, FlowEvent::Done];

/// "a slow start says so" (#440): no output this long after START.
pub const SLOW_MS: u64 = 8000;

/// The state `e` leads to from `s`, or `None` when `s` doesn't take `e`.
pub fn next(s: TermState, e: FlowEvent) -> Option<TermState> {
    use FlowEvent as E;
    use TermState as S;
    Some(match (s, e) {
        // ended and failed start fresh: the dead screen is never reopened (#432)
        (S::Idle | S::Ended | S::Failed, E::Start) => S::Starting,
        (S::Starting | S::Slow, E::Ready) => S::Running,
        (S::Starting, E::Slow) => S::Slow,
        (S::Starting | S::Slow, E::Fail) => S::Failed,
        (S::Starting | S::Slow | S::Running, E::Stop) => S::Stopping,
        (S::Starting | S::Slow | S::Running, E::Exit) | (S::Stopping, E::Done | E::Exit) => S::Ended,
        _ => return None,
    })
}

/// The next state; an event the state doesn't take changes nothing.
pub fn step(s: TermState, e: FlowEvent) -> TermState {
    next(s, e).unwrap_or(s)
}

/// What a program's end means where it is: DONE after a STOP; FAIL for 127 before it ran (no output
/// yet: a missing program); EXIT otherwise.
pub fn exit_event(s: TermState, code: i32) -> FlowEvent {
    match s {
        TermState::Stopping => FlowEvent::Done,
        TermState::Starting | TermState::Slow if code == 127 => FlowEvent::Fail,
        _ => FlowEvent::Exit,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use FlowEvent as E;
    use TermState as S;
    use std::collections::{HashMap, VecDeque};

    /// The plan's table, written out once more by hand: the model the implementation is checked against.
    fn model(s: S, e: E) -> Option<S> {
        let row: &[(E, S)] = match s {
            S::Starting => &[(E::Ready, S::Running), (E::Slow, S::Slow), (E::Fail, S::Failed), (E::Stop, S::Stopping), (E::Exit, S::Ended)],
            S::Slow => &[(E::Ready, S::Running), (E::Fail, S::Failed), (E::Stop, S::Stopping), (E::Exit, S::Ended)],
            S::Running => &[(E::Exit, S::Ended), (E::Stop, S::Stopping)],
            S::Stopping => &[(E::Done, S::Ended), (E::Exit, S::Ended)],
            S::Idle | S::Ended | S::Failed => &[(E::Start, S::Starting)],
        };
        row.iter().find(|(x, _)| *x == e).map(|(_, to)| *to)
    }

    #[test]
    fn every_state_takes_only_the_events_of_its_row() {
        for s in STATES {
            for e in EVENTS {
                assert_eq!(next(s, e), model(s, e), "{s:?} --{e:?}");
                assert_eq!(step(s, e), model(s, e).unwrap_or(s));
            }
        }
    }

    #[test]
    fn every_state_is_reachable_and_can_start_again() {
        let mut paths: HashMap<S, Vec<E>> = HashMap::from([(S::Idle, Vec::new())]);
        let mut queue = VecDeque::from([S::Idle]);
        while let Some(s) = queue.pop_front() {
            for e in EVENTS {
                let n = step(s, e);
                if !paths.contains_key(&n) {
                    let mut p = paths.get(&s).cloned().unwrap_or_default();
                    p.push(e);
                    paths.insert(n, p);
                    queue.push_back(n);
                }
            }
        }
        for s in STATES {
            let path = paths.get(&s).unwrap_or_else(|| panic!("no path to {s:?}"));
            assert_eq!(path.iter().fold(S::Idle, |x, e| step(x, *e)), s, "the path replays to {s:?}");
            // from anywhere, STOP / DONE / EXIT then START gets a terminal starting again
            let again = [E::Stop, E::Done, E::Exit, E::Start].iter().fold(s, |x, e| step(x, *e));
            assert_eq!(again, S::Starting, "{s:?} can start again");
        }
    }

    #[test]
    fn a_stop_while_starting_cancels_the_start() {
        for from in [S::Starting, S::Slow] {
            let s = step(from, E::Stop);
            assert_eq!(s, S::Stopping);
            assert_eq!(step(s, E::Ready), S::Stopping, "late output of the cancelled start (#435)");
            assert_eq!(step(s, E::Start), S::Stopping, "a start can't race the stop");
            assert_eq!(step(s, E::Done), S::Ended);
        }
    }

    #[test]
    fn ended_and_failed_never_reopen_the_dead_screen() {
        for s in [S::Ended, S::Failed] {
            assert!(s.over() && !s.live());
            for e in EVENTS {
                assert_eq!(step(s, e), if e == E::Start { S::Starting } else { s }, "{s:?} --{e:?} (#432)");
            }
        }
        assert_eq!(step(S::Starting, E::Slow), S::Slow, "a slow start says so (#440)");
        assert_eq!(step(S::Running, E::Slow), S::Running);
    }

    #[test]
    fn exit_codes_read_where_the_terminal_is() {
        assert_eq!(exit_event(S::Starting, 127), E::Fail, "127 before any output: it never ran");
        assert_eq!(exit_event(S::Slow, 127), E::Fail);
        assert_eq!(exit_event(S::Running, 127), E::Exit, "it ran and then said 127");
        assert_eq!(exit_event(S::Starting, 1), E::Exit);
        assert_eq!(exit_event(S::Stopping, 127), E::Done);
        assert_eq!(step(S::Starting, exit_event(S::Starting, 0)), S::Ended);
    }

    /// Random walks: whatever arrives, a terminal is only ever in a state the table can reach, a live
    /// one always has a way to end, and START never leaves `stopping` (#435).
    #[test]
    fn random_walks_stay_in_the_table() {
        let mut rng = crate::testrand::Rng::new(0x7e57_f10e);
        for _ in 0..2000 {
            let mut s = S::Idle;
            for _ in 0..40 {
                let e = EVENTS[rng.below(EVENTS.len())];
                let n = step(s, e);
                assert!(n == s || model(s, e) == Some(n));
                if s == S::Stopping {
                    assert_ne!(n, S::Starting);
                    assert_ne!(n, S::Running);
                }
                s = n;
            }
        }
    }
}
