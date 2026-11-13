//! The follow-up queue decider: v1 runner.js `reply`, `stop`, `sendQueued`, `mergeQueued`, `editQueued`,
//! `reorderQueue`, `unqueue` and `#reportBack`, and the e2e cases in v1 test/e2e.test.js ("queued
//! follow-ups can be changed and reordered", "Send now … interrupts the run", "stopping … marks the turn
//! stopped" with the queue held), plus a model-based check of the invariants.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use wisp_runtime_api::model::{Attachment, QueueItem};
use wisp_runtime_core::queue::{self, Decision, Incoming, Plan, Queue, ReportBack, Run, SendNow};

fn item(id: &str) -> QueueItem {
    QueueItem { id: id.into(), text: format!("text {id}"), ..QueueItem::default() }
}

fn by(id: &str, who: &str) -> QueueItem {
    QueueItem { by: Some(who.into()), ..item(id) }
}

fn inc(it: QueueItem) -> Incoming {
    Incoming { item: it, queue: false, has_extras: false, hold: false }
}

struct Task {
    items: Vec<QueueItem>,
    held: bool,
}

impl Task {
    fn new(ids: &[&str]) -> Self {
        Self { items: ids.iter().map(|i| item(i)).collect(), held: false }
    }
    fn q(&mut self) -> Queue<'_> {
        Queue { items: &mut self.items, held: &mut self.held }
    }
    fn ids(&self) -> Vec<&str> {
        self.items.iter().map(|q| q.id.as_str()).collect()
    }
    fn follow(&mut self, run: Run, asking: bool, last_held: bool, i: Incoming) -> Decision {
        queue::follow_up(&mut self.q(), run, asking, last_held, i)
    }
}

const RUNNING: Run = Run::Running { resumable: true };

#[test]
fn nothing_running_starts_a_turn_now() {
    let mut t = Task::new(&[]);
    let d = t.follow(Run::Idle, false, false, inc(item("a")));
    assert!(matches!(d.plan, Plan::Start(ref x) if x.id == "a"));
    assert_eq!(t.items, []);
}

#[test]
fn a_follow_up_while_running_interrupts_once_the_agent_has_a_conversation() {
    let mut t = Task::new(&[]);
    assert_eq!(t.follow(RUNNING, false, false, inc(item("a"))).plan, Plan::Interrupt);
    assert!(t.items[0].now);
}

#[test]
fn before_the_agent_reports_a_conversation_it_queues() {
    let mut t = Task::new(&[]);
    assert_eq!(t.follow(Run::Running { resumable: false }, false, false, inc(item("a"))).plan, Plan::Queued { ahead: 0 });
    assert!(!t.items[0].now);
}

#[test]
fn queue_true_waits_behind_what_is_queued() {
    let mut t = Task::new(&["x"]);
    let d = t.follow(RUNNING, false, false, Incoming { queue: true, ..inc(item("a")) });
    assert_eq!(d.plan, Plan::Queued { ahead: 1 });
    assert_eq!(t.ids(), ["x", "a"]);
}

#[test]
fn interrupting_follow_ups_keep_their_order_ahead_of_the_rest() {
    let mut t = Task::new(&["q1"]);
    t.follow(RUNNING, false, false, inc(item("n1")));
    t.follow(RUNNING, false, false, inc(item("n2")));
    assert_eq!(t.ids(), ["n1", "n2", "q1"]);
}

#[test]
fn a_lingering_cli_is_let_go_and_the_follow_up_goes_next() {
    let mut t = Task::new(&[]);
    assert!(t.follow(Run::Lingering, false, false, inc(item("a"))).release_linger);
    assert_eq!(t.ids(), ["a"]);
}

#[test]
fn a_plain_reply_answers_an_open_question_but_one_with_extras_does_not() {
    let mut t = Task::new(&[]);
    assert!(matches!(t.follow(RUNNING, true, false, inc(item("a"))).plan, Plan::Answer(_)));
    assert_eq!(t.follow(RUNNING, true, false, Incoming { has_extras: true, ..inc(item("b")) }).plan, Plan::Interrupt);
}

#[test]
fn a_held_turn_goes_first_and_what_you_send_queues_behind_it() {
    let mut t = Task::new(&[]);
    let d = t.follow(Run::Idle, false, true, inc(item("a")));
    assert!(d.release_held);
    assert_eq!(d.plan, Plan::Queued { ahead: 0 });
    let d = t.follow(RUNNING, false, true, inc(item("b")));
    assert!(d.release_held && matches!(d.plan, Plan::Queued { .. }), "never interrupts the held one");
}

#[test]
fn a_guarded_follow_up_is_held_when_nothing_runs() {
    let mut t = Task::new(&[]);
    assert!(matches!(t.follow(Run::Idle, false, false, Incoming { hold: true, ..inc(by("a", "later")) }).plan, Plan::Hold(_)));
    // a CLI only lingering with nothing queued is let go, so the hold holds
    let d = t.follow(Run::Lingering, false, false, Incoming { hold: true, ..inc(by("b", "later")) });
    assert!(matches!(d.plan, Plan::Hold(_)) && d.release_linger);
}

#[test]
fn a_stop_never_discards_the_queue_it_holds_it() {
    let mut t = Task::new(&["a", "b"]);
    assert!(queue::stop(&mut t.q(), RUNNING).stop_run);
    assert!(t.held);
    assert_eq!(t.ids(), ["a", "b"]);
    assert_eq!(queue::next_after_release(&mut t.q()), None, "nothing goes out by itself after a Stop");
    // your next message carries the queue on
    let d = t.follow(Run::Idle, false, false, inc(item("c")));
    assert!(!t.held && matches!(d.plan, Plan::Start(_)));
    assert_eq!(queue::next_after_release(&mut t.q()).unwrap().id, "a");
}

#[test]
fn a_stop_on_an_empty_queue_holds_nothing() {
    let mut t = Task::new(&[]);
    assert!(!queue::stop(&mut t.q(), Run::Idle).stop_run);
    assert!(!t.held);
}

#[test]
fn wisps_own_follow_up_does_not_release_a_held_queue_nor_does_compact() {
    let mut t = Task::new(&["a"]);
    queue::stop(&mut t.q(), Run::Idle);
    t.follow(RUNNING, false, false, inc(by("w", "wisp")));
    assert!(t.held);
    let d = t.follow(RUNNING, false, false, inc(by("c", "compact")));
    assert!(t.held);
    assert!(!d.cancel_after, "compact is housekeeping: what was going on carries on");
}

#[test]
fn send_now_interrupts_or_starts_or_goes_next() {
    let mut t = Task::new(&["a", "b"]);
    assert_eq!(queue::send_now(&mut t.q(), RUNNING, "b").unwrap(), (SendNow::Interrupt, true));
    assert_eq!(t.ids(), ["b", "a"]);
    let mut t = Task::new(&["a"]);
    assert!(matches!(queue::send_now(&mut t.q(), Run::Idle, "a").unwrap().0, SendNow::Start(_)));
    let mut t = Task::new(&["a", "b"]);
    assert_eq!(queue::send_now(&mut t.q(), Run::Running { resumable: false }, "b").unwrap().0, SendNow::Next);
    assert_eq!(t.ids(), ["b", "a"]);
    assert!(!t.items[0].now);
    assert_eq!(queue::send_now(&mut t.q(), Run::Lingering, "a").unwrap().0, SendNow::ReleaseLinger);
    assert!(queue::send_now(&mut t.q(), Run::Idle, "zz").is_none());
    let mut t = Task { items: vec![by("w", "wisp")], held: true };
    assert!(!queue::send_now(&mut t.q(), Run::Idle, "w").unwrap().1, "wisp's own doesn't cancel after-turn steps");
    assert!(!t.held, "Send now carries a held queue on");
}

#[test]
fn merge_combines_yours_in_queue_order_with_all_their_files() {
    let mut t = Task::new(&["a", "b", "c"]);
    t.items[1].attachments.push(Attachment { id: "f".into(), ..Attachment::default() });
    t.items[2] = by("c", "wisp");
    assert!(!queue::merge(&mut t.q(), &["a".into(), "c".into()]), "wisp's own item is not yours to merge");
    assert!(queue::merge(&mut t.q(), &["b".into(), "a".into()]));
    assert_eq!(t.ids(), ["a", "c"]);
    assert_eq!(t.items[0].text, "text a\n\ntext b");
    assert_eq!(t.items[0].attachments.len(), 1);
}

#[test]
fn edit_text_changes_only_yours() {
    let mut t = Task::new(&["a"]);
    t.items.push(by("w", "wisp"));
    assert!(queue::edit_text(&mut t.q(), "a", "new"));
    assert!(!queue::edit_text(&mut t.q(), "w", "new"));
    assert!(!queue::edit_text(&mut t.q(), "zz", "new"));
    assert_eq!(t.items[0].text, "new");
}

#[test]
fn reorder_skips_unknown_ids_and_keeps_the_left_out_at_the_end() {
    let mut t = Task::new(&["a", "b", "c", "d"]);
    assert!(queue::reorder(&mut t.q(), &["c".into(), "zz".into(), "a".into(), "c".into()]));
    assert_eq!(t.ids(), ["c", "a", "b", "d"]);
    assert!(!queue::reorder(&mut Task::new(&[]).q(), &["a".into()]));
}

#[test]
fn removing_the_last_item_lifts_the_hold() {
    let mut t = Task::new(&["a"]);
    queue::stop(&mut t.q(), Run::Idle);
    assert!(queue::remove(&mut t.q(), "a"));
    assert!(!t.held);
    assert!(!queue::remove(&mut t.q(), "a"));
}

#[test]
fn reports_back_merge_into_the_waiting_report_or_queue_or_start() {
    let report = |id: &str| QueueItem { reports: true, ..by(id, "wisp") };
    let mut t = Task::new(&[]);
    assert!(matches!(queue::report_back(&mut t.q(), Run::Idle, false, report("r"), "x"), ReportBack::Start(_)));
    assert_eq!(queue::report_back(&mut t.q(), Run::Idle, true, report("r"), "x"), ReportBack::Queued { release_linger: false });
    assert_eq!(queue::report_back(&mut t.q(), Run::Idle, true, report("r2"), "more"), ReportBack::Merged);
    assert_eq!(t.items.len(), 1);
    assert!(t.items[0].text.ends_with("\n\n---\n\nmore"));
    let mut t = Task::new(&[]);
    assert_eq!(queue::report_back(&mut t.q(), Run::Lingering, false, report("r"), "x"), ReportBack::Queued { release_linger: true });
}

/// Model-based: random operations never duplicate an id, a follow-up grows the queue exactly when it was
/// queued, and a held or emptied queue never yields an item.
#[test]
fn random_operations_keep_the_queue_sound() {
    let mut seed: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut rnd = |n: usize| {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        usize::try_from(seed % (n as u64)).unwrap()
    };
    let runs = [Run::Idle, Run::Lingering, RUNNING, Run::Running { resumable: false }];
    for _ in 0..200 {
        let mut t = Task::new(&[]);
        for n in 0..60 {
            let run = runs[rnd(4)];
            let before = t.items.len();
            match rnd(6) {
                0 | 1 => {
                    let d = t.follow(run, false, false, Incoming { queue: rnd(2) == 0, ..inc(item(&format!("i{n}"))) });
                    assert_eq!(t.items.len() == before + 1, matches!(d.plan, Plan::Queued { .. } | Plan::Interrupt), "{d:?}");
                }
                2 => {
                    queue::stop(&mut t.q(), run);
                }
                3 => {
                    let held = t.held;
                    let next = queue::next_after_release(&mut t.q());
                    assert!(!(held && next.is_some()), "a held queue yields nothing");
                }
                4 if !t.items.is_empty() => {
                    let id = t.items[rnd(t.items.len())].id.clone();
                    queue::send_now(&mut t.q(), run, &id).unwrap();
                }
                _ => {
                    let ids: Vec<String> = t.items.iter().rev().map(|q| q.id.clone()).collect();
                    queue::reorder(&mut t.q(), &ids);
                }
            }
            let mut ids = t.ids();
            ids.sort_unstable();
            ids.dedup();
            assert_eq!(ids.len(), t.items.len(), "duplicate id");
        }
    }
}
