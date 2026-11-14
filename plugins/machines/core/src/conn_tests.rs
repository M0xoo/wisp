use wisp_machines_api::{PeerState, StepStatus};

use super::*;
use crate::bootstrap::STEPS;

fn ssh() -> Conn {
    Conn::start("ab12cd", STEPS, false, false, None)
}

fn online(c: &mut Conn) {
    c.online("me@devbox", Vec::new(), None, Some("2.0.0".into()), Some(42), 2, 1_000);
}

#[test]
fn a_fresh_attempt_runs_the_first_step() {
    let c = ssh();
    assert_eq!(c.status.state, PeerState::Connecting);
    assert_eq!(c.status.steps[0].status, StepStatus::Run);
    assert!(c.status.steps[1..].iter().all(|s| s.status == StepStatus::Pending));
}

#[test]
fn a_step_done_starts_the_next() {
    let mut c = ssh();
    let first = c.status.steps[0].id.clone();
    assert!(c.step(&first, StepStatus::Done, None));
    assert_eq!(c.status.steps[1].status, StepStatus::Run);
    assert!(!c.step("nope", StepStatus::Done, None));
}

#[test]
fn a_first_connect_that_fails_stops() {
    let mut c = ssh();
    c.stderr("ssh: connect to host devbox port 22: Connection refused\n");
    assert_eq!(c.closed(Some(255), "me@devbox"), Next::Nothing);
    assert_eq!(c.status.state, PeerState::Error);
    assert!(c.status.error.contains("Connection refused"));
}

#[test]
fn once_it_worked_it_retries_with_backoff() {
    let mut c = ssh();
    online(&mut c);
    assert_eq!(c.status.state, PeerState::Online);
    let mut waits = Vec::new();
    for _ in 0..7 {
        let Next::RetryIn(ms) = c.closed(Some(255), "me@devbox") else { panic!("expected a retry") };
        waits.push(ms);
        c = Conn::start("ab12cd", STEPS, false, true, Some(&c));
    }
    assert_eq!(waits, [2_000, 5_000, 15_000, 30_000, 60_000, 60_000, 60_000]);
}

#[test]
fn wisp_fail_gives_up() {
    let mut c = ssh();
    online(&mut c);
    let next = c.line(&BootLine::Fail { id: WISP.into(), message: "unsupported arch".into() });
    assert_eq!(next, Next::HangUp);
    assert!(c.give_up);
    c.status.state = PeerState::Online;
    assert_eq!(c.closed(Some(1), "me@devbox"), Next::Nothing);
    assert_eq!(c.status.state, PeerState::Error);
}

#[test]
fn the_first_error_wins() {
    let mut c = ssh();
    assert_eq!(c.fail("first", None, false), Next::HangUp);
    assert_eq!(c.fail("second", None, false), Next::Nothing);
    assert_eq!(c.status.error, "first");
}

#[test]
fn disconnect_by_hand_never_reconnects() {
    let mut c = ssh();
    online(&mut c);
    assert_eq!(c.disconnect(true), Next::HangUp);
    assert_eq!(c.closed(None, "me@devbox"), Next::Nothing);
    assert_eq!(c.status.state, PeerState::Off);
}

#[test]
fn a_grid_box_that_sleeps_is_watched_and_wakes_on_request() {
    let mut c = Conn::start("g1", GRID_STEPS, true, false, None);
    assert!(c.wakes());
    online(&mut c);
    assert!(!c.wakes());
    assert_eq!(c.stream_lost(), Next::WatchIn(GRID_WATCH_MS));
    assert_eq!(c.status.state, PeerState::Asleep);
    assert!(c.wakes());
}

#[test]
fn an_ssh_stream_lost_hangs_up() {
    let mut c = ssh();
    online(&mut c);
    assert_eq!(c.stream_lost(), Next::HangUp);
    assert_eq!(c.status.error, "wisp stopped answering there.");
}

#[test]
fn the_log_keeps_its_tail() {
    let mut c = ssh();
    for i in 0..(MAX_LOG + 5) {
        c.push_log(&format!("line {i}"));
    }
    assert_eq!(c.log.len(), MAX_LOG);
    assert_eq!(c.view_log().len(), VIEW_LOG);
    assert_eq!(c.log[0], "line 5");
}

#[test]
fn wake_answers() {
    assert_eq!(wake_answer(Some(503), "", true), WakeAnswer::Asleep);
    assert!(matches!(wake_answer(Some(401), "", false), WakeAnswer::SignedOut(_)));
    assert_eq!(wake_answer(Some(503), "", false), WakeAnswer::Again("Starting…".into()));
    assert_eq!(refuse("devbox", PeerState::Asleep, true, false, true), None);
    assert!(refuse("mac", PeerState::Asleep, true, true, true).is_some());
}
