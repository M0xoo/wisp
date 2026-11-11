//! v1 test/grid.test.js's inbox cases, on the module: held while the box sleeps, woken and delivered in order, a
//! retry stopped by its key, a 4xx finished, caps counted, a live check only to a box that's up, wakes earned.

use std::sync::atomic::{AtomicU32, Ordering};

use super::*;
use crate::clock::ManualClock;

struct FakeBoxes {
    up: Mutex<bool>,
    starts: AtomicU32,
    cold: Mutex<Vec<bool>>,
}

impl Boxes for FakeBoxes {
    fn state(&self, _u: &str) -> BoxState {
        if *self.up.lock().unwrap() { BoxState::Running } else { BoxState::Stopped }
    }
    fn port(&self, _u: &str) -> Option<u16> {
        self.up.lock().unwrap().then_some(9)
    }
    fn begin(&self, _u: &str) -> Busy {
        Busy::new(|| {})
    }
    fn ensure<'a>(&'a self, _user: &'a BoxUser, wake: bool) -> futures::future::BoxFuture<'a, Result<Running>> {
        self.starts.fetch_add(1, Ordering::SeqCst);
        self.cold.lock().unwrap().push(wake);
        *self.up.lock().unwrap() = true;
        Box::pin(async { Ok(Running { port: 9 }) })
    }
    fn secret(&self, _u: &str) -> Option<String> {
        self.up.lock().unwrap().then(|| "s".to_owned())
    }
}

/// The box's answers, in order (the last one repeats), and what it got.
struct FakeBox {
    answers: Mutex<Vec<u16>>,
    got: Mutex<Vec<Delivery>>,
}

#[async_trait::async_trait]
impl Deliver for FakeBox {
    async fn deliver(&self, _port: u16, _secret: &str, d: &Delivery, _t: u64) -> std::result::Result<(u16, Value), String> {
        self.got.lock().unwrap().push(d.clone());
        let mut a = self.answers.lock().unwrap();
        let s = if a.len() > 1 { a.remove(0) } else { a[0] };
        Ok((s, json!({ "challenge": "c" })))
    }
}

struct World {
    inbox: Inbox,
    boxes: Arc<FakeBoxes>,
    the_box: Arc<FakeBox>,
    clock: Arc<ManualClock>,
    user: UserRow,
}

fn world(answers: Vec<u16>, opts: Opts) -> World {
    let db = Arc::new(Db::memory().unwrap());
    db.with(|c| c.execute("INSERT INTO users (id, handle, created_at) VALUES ('u1', 'pia', 0)", [])).unwrap();
    let user = UserRow { id: "u1".into(), handle: "pia".into(), email: None, name: None, avatar: None, created_at: 0, disabled: 0 };
    let secrets = Arc::new(Secrets::for_test(db.clone(), [7; 32]).unwrap());
    let boxes = Arc::new(FakeBoxes { up: Mutex::new(false), starts: AtomicU32::new(0), cold: Mutex::default() });
    let the_box = Arc::new(FakeBox { answers: Mutex::new(answers), got: Mutex::default() });
    let clock = ManualClock::new(1_000_000);
    let inbox = Inbox::new(db, clock.clone(), Some(secrets), boxes.clone(), the_box.clone(), Opts { enabled: true, ..opts }, Arc::new(|h: &str| format!("https://{h}.grid.test")));
    World { inbox, boxes, the_box, clock, user }
}

fn tg(update: i64) -> Vec<u8> {
    json!({ "update_id": update, "message": { "text": "hi" } }).to_string().into_bytes()
}

fn secret_header() -> Vec<(String, String)> {
    vec![("X-Telegram-Bot-Api-Secret-Token".into(), "abc".into()), ("cookie".into(), "nope".into())]
}

#[tokio::test]
async fn a_message_to_a_sleeping_box_is_held_then_woken_and_delivered_in_order() {
    let w = world(vec![200], Opts::default());
    let url = w.inbox.url_for(&w.user, "telegram").unwrap();
    let t = url["url"].as_str().unwrap().rsplit('/').next().unwrap().to_owned();
    assert!(url["url"].as_str().unwrap().starts_with("https://pia.grid.test/_in/"));
    assert_eq!(w.inbox.by_token(&t).unwrap(), Some(("u1".into(), "telegram".into())));
    assert_eq!(w.inbox.url_for(&w.user, "telegram").unwrap()["url"], url["url"], "asking again gives the same URL");
    for n in [1, 2] {
        assert_eq!(w.inbox.accept(&w.user, "telegram", &secret_header(), Some(&tg(n))).await.unwrap(), None);
    }
    assert_eq!(w.inbox.drain(&w.user).await.unwrap(), None);
    let got = w.the_box.got.lock().unwrap().clone();
    assert_eq!(got.len(), 2);
    assert!(got[0].body.windows(13).any(|x| x == b"\"update_id\":1"), "in order");
    assert_eq!(got[0].headers, vec![("x-telegram-bot-api-secret-token".to_owned(), "abc".to_owned())], "only the headers the box checks: no cookie");
    assert_eq!(w.boxes.starts.load(Ordering::SeqCst), 1, "woken once");
}

#[tokio::test]
async fn a_senders_retry_is_one_row_and_a_refusal_from_the_box_is_finished() {
    let w = world(vec![401], Opts::default());
    for _ in 0..3 {
        w.inbox.accept(&w.user, "telegram", &secret_header(), Some(&tg(5))).await.unwrap();
    }
    w.inbox.drain(&w.user).await.unwrap();
    assert_eq!(w.the_box.got.lock().unwrap().len(), 1, "one row for the retries; a 4xx isn't tried again");
    assert_eq!(w.inbox.waiting().unwrap(), Vec::<String>::new());
}

#[tokio::test]
async fn a_box_that_fails_is_retried_with_backoff_and_nothing_passes_it() {
    let w = world(vec![500, 200], Opts::default());
    w.inbox.accept(&w.user, "telegram", &secret_header(), Some(&tg(1))).await.unwrap();
    w.inbox.accept(&w.user, "telegram", &secret_header(), Some(&tg(2))).await.unwrap();
    assert_eq!(w.inbox.drain(&w.user).await.unwrap(), Some(2000), "the first backs off");
    assert_eq!(w.the_box.got.lock().unwrap().len(), 1, "the second waits behind it");
    assert_eq!(w.inbox.drain(&w.user).await.unwrap(), Some(2000), "not yet");
    w.clock.advance(2000);
    assert_eq!(w.inbox.drain(&w.user).await.unwrap(), None);
    assert_eq!(w.the_box.got.lock().unwrap().len(), 3);
}

#[tokio::test]
async fn over_the_caps_a_message_is_dropped_counted_and_the_box_told() {
    let w = world(vec![200], Opts { max_rows: 1, ..Opts::default() });
    w.inbox.url_for(&w.user, "telegram").unwrap();
    w.inbox.accept(&w.user, "telegram", &secret_header(), Some(&tg(1))).await.unwrap();
    w.inbox.accept(&w.user, "telegram", &secret_header(), Some(&tg(2))).await.unwrap();
    w.inbox.accept(&w.user, "telegram", &secret_header(), None).await.unwrap();
    w.inbox.drain(&w.user).await.unwrap();
    assert_eq!(w.the_box.got.lock().unwrap()[0].dropped, 2, "the box is told what was lost");
    assert_eq!(w.inbox.url_for(&w.user, "telegram").unwrap()["dropped"], 0, "and the count starts again");
}

#[tokio::test]
async fn a_live_check_reaches_only_a_box_that_is_up_and_never_wakes_one() {
    let w = world(vec![200], Opts::default());
    let check = json!({ "type": "url_verification", "challenge": "c" }).to_string().into_bytes();
    let asleep = w.inbox.accept(&w.user, "slack", &[], Some(&check)).await.unwrap().unwrap();
    assert_eq!(asleep.0, 503);
    assert_eq!(w.boxes.starts.load(Ordering::SeqCst), 0, "never woken for it");
    *w.boxes.up.lock().unwrap() = true;
    let up = w.inbox.accept(&w.user, "slack", &[], Some(&check)).await.unwrap().unwrap();
    assert_eq!((up.0, up.1["challenge"].as_str()), (200, Some("c")));
    let edit = json!({ "event": { "type": "message", "subtype": "message_changed" } }).to_string().into_bytes();
    w.inbox.accept(&w.user, "slack", &[], Some(&edit)).await.unwrap();
    assert_eq!(w.inbox.waiting().unwrap(), Vec::<String>::new(), "an edit isn't held: no box acts on it");
}

#[tokio::test]
async fn wakes_are_earned_after_strikes_the_next_is_a_scheduled_one_behind_a_gap() {
    let w = world(vec![401], Opts { wake_strikes: 2, ..Opts::default() });
    for n in 0..2 {
        w.inbox.accept(&w.user, "telegram", &secret_header(), Some(&tg(n))).await.unwrap();
        w.inbox.drain(&w.user).await.unwrap();
        *w.boxes.up.lock().unwrap() = false; // it went back to sleep: nothing it accepted kept it up
    }
    w.inbox.accept(&w.user, "telegram", &secret_header(), Some(&tg(9))).await.unwrap();
    assert_eq!(w.inbox.drain(&w.user).await.unwrap(), Some(10 * 60_000), "two strikes: it waits the gap");
    w.clock.advance(10 * 60_000);
    w.inbox.drain(&w.user).await.unwrap();
    assert_eq!(*w.boxes.cold.lock().unwrap(), vec![false, false, true], "the third is a scheduled wake");
}

#[test]
fn a_held_message_past_its_hour_is_gone_and_counted() {
    let w = world(vec![200], Opts::default());
    w.inbox.url_for(&w.user, "telegram").unwrap();
    w.inbox.hold(&w.user, channel("telegram").unwrap(), &tg(1), &[], false, &json!({ "update_id": 1 })).unwrap();
    w.clock.advance(TTL_MS + 1);
    assert_eq!(w.inbox.sweep().unwrap(), 1);
    assert_eq!(w.inbox.waiting().unwrap(), Vec::<String>::new());
    assert_eq!(w.inbox.url_for(&w.user, "telegram").unwrap()["dropped"], 1);
}

/// Discord wants an answer in three seconds and a box may be asleep: `/wisp` and a press are held and answered at
/// once ("thinking", "seen"); a ping and a keystroke go live to a box that's up; anything else isn't held.
#[tokio::test]
async fn discords_slash_and_press_are_answered_at_once_and_held_and_a_keystroke_goes_live() {
    let w = world(vec![200], Opts::default());
    let ix = |t: i64, id: &str| json!({ "type": t, "id": id }).to_string().into_bytes();
    let heads = vec![("x-signature-ed25519".to_owned(), "ab".to_owned()), ("x-signature-timestamp".to_owned(), "1".to_owned())];
    assert_eq!(w.inbox.accept(&w.user, "discord", &heads, Some(&ix(2, "11"))).await.unwrap(), Some((200, json!({ "type": 5 }))));
    assert_eq!(w.inbox.accept(&w.user, "discord", &heads, Some(&ix(3, "12"))).await.unwrap(), Some((200, json!({ "type": 6 }))));
    assert_eq!(w.inbox.accept(&w.user, "discord", &heads, Some(&ix(4, "13"))).await.unwrap().unwrap().0, 503, "a keystroke never wakes a box");
    assert_eq!(w.inbox.accept(&w.user, "discord", &heads, Some(&ix(9, "14"))).await.unwrap(), None);
    assert_eq!(w.inbox.waiting().unwrap(), vec!["u1".to_owned()]);
    assert_eq!(w.inbox.drain(&w.user).await.unwrap(), None);
    let got = w.the_box.got.lock().unwrap().clone();
    assert_eq!(got.len(), 2, "the slash and the press, not the rest");
    assert_eq!(got[0].headers.len(), 2, "with the signature the box checks");
}
