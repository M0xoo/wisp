//! v1 test/grid.test.js's route cases on the module: who may route, the place read first, a thread and its
//! follow-ups, a report only from the computer the message went to, and a webhook's secret.

use std::sync::Mutex;

use super::*;
use crate::clock::ManualClock;

#[derive(Default)]
struct FakeTelegram {
    calls: Mutex<Vec<(String, Value)>>,
    next_id: Mutex<i64>,
}

#[async_trait::async_trait]
impl Telegram for FakeTelegram {
    async fn call(&self, _bot: &str, method: &str, body: Value) -> std::result::Result<Value, String> {
        self.calls.lock().unwrap().push((method.into(), body));
        let mut n = self.next_id.lock().unwrap();
        *n += 1;
        Ok(match method {
            "getMe" => json!({ "username": "piabot" }),
            "sendMessage" => json!({ "message_id": 1000 + *n }),
            _ => json!(true),
        })
    }
}

struct FakeComputers(Mutex<Vec<(String, Value)>>, (u16, Value));

#[async_trait::async_trait]
impl Computers for FakeComputers {
    async fn routed(&self, computer: &str, body: Value) -> std::result::Result<Option<(u16, Value)>, String> {
        self.0.lock().unwrap().push((computer.into(), body));
        Ok(Some(self.1.clone()))
    }
}

struct World {
    r: Routes,
    tg: Arc<FakeTelegram>,
    pcs: Arc<FakeComputers>,
    user: UserRow,
    laptop: ComputerRow,
}

fn world(answer: (u16, Value)) -> World {
    let db = Arc::new(Db::memory().unwrap());
    db.with(|c| {
        c.execute("INSERT INTO users (id, handle, created_at) VALUES ('u1', 'pia', 0)", [])?;
        c.execute("INSERT INTO devices (id, user_id, name, token_hash, created_at) VALUES ('d1', 'u1', 'laptop', 'h', 0)", [])?;
        c.execute(
            "INSERT INTO computers (id, user_id, device_id, name, label, created_at) VALUES ('c1', 'u1', 'd1', 'laptop', 'laptop--pia', 0)",
            [],
        )
    })
    .unwrap();
    let user = UserRow { id: "u1".into(), handle: "pia".into(), email: None, name: None, avatar: None, created_at: 0, disabled: 0 };
    let laptop = ComputerRow {
        id: "c1".into(),
        user_id: "u1".into(),
        device_id: "d1".into(),
        name: "laptop".into(),
        label: "laptop--pia".into(),
        created_at: 0,
        last_seen_at: None,
    };
    let tg = Arc::new(FakeTelegram::default());
    let pcs = Arc::new(FakeComputers(Mutex::default(), answer));
    let secrets = Arc::new(Secrets::for_test(db.clone(), [3; 32]).unwrap());
    let r = Routes {
        db,
        clock: ManualClock::new(1_000_000),
        secrets: Some(secrets),
        telegram: tg.clone(),
        computers: pcs.clone(),
        public_url: "https://grid.test".into(),
        on: true,
    };
    World { r, tg, pcs, user, laptop }
}

fn msg(text: &str, from: i64, chat_type: &str) -> Value {
    json!({ "update_id": 77, "message": { "message_id": 5, "date": 1, "text": text, "chat": { "id": from, "type": chat_type }, "from": { "id": from, "first_name": "Pia" } } })
}

#[tokio::test]
async fn the_bot_is_set_with_a_webhook_of_the_grids_own_and_a_bad_token_or_sender_is_refused() {
    let w = world((200, json!({})));
    assert!(w.r.set(&w.user, "nope", "1").await.is_err());
    assert!(w.r.set(&w.user, "123:abc", "@pia").await.unwrap_err().to_string().contains("numbers"));
    assert_eq!(w.r.set(&w.user, "123:abc", "42, 43 42").await.unwrap(), "piabot");
    let calls = w.tg.calls.lock().unwrap().clone();
    let hook = &calls.iter().find(|c| c.0 == "setWebhook").unwrap().1;
    assert!(hook["url"].as_str().unwrap().starts_with("https://grid.test/_route/"));
    let tok = hook["url"].as_str().unwrap().rsplit('/').next().unwrap();
    let secret = hook["secret_token"].as_str().unwrap();
    assert!(matches!(w.r.check(tok, secret).unwrap(), Some(Ok((ref u, ref b))) if u == "u1" && b.senders == ["42", "43"]));
    assert!(matches!(w.r.check(tok, "wrong").unwrap(), Some(Err(()))), "a bad secret");
    assert!(w.r.check("other", secret).unwrap().is_none());
    assert_eq!(w.r.view("u1").unwrap(), json!({ "set": true, "bot": "piabot", "senders": ["42", "43"] }), "never the token or the secret");
}

#[tokio::test]
async fn on_laptop_goes_to_that_computer_and_its_answer_back_to_the_chat() {
    let w = world((200, json!({ "reply": "▶ api · Plan" })));
    w.r.set(&w.user, "123:abc", "42").await.unwrap();
    let b = w.r.bot_of("u1").unwrap().unwrap();
    let pcs = [w.laptop.clone()];
    let next = w.r.take(&w.user, &b, &msg("on laptop fix the login", 42, "private"), &pcs, &|_| true).unwrap().unwrap();
    let Next::Forward { computer, ref body, .. } = next.clone() else { panic!("{next:?}") };
    assert_eq!((computer.as_str(), body["text"].as_str(), body["follow"].as_bool()), ("c1", Some("fix the login"), Some(false)));
    w.r.run("u1", &b, next, "laptop").await.unwrap();
    let said =
        w.tg.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|c| c.0 == "sendMessage")
            .map(|c| c.1["text"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>();
    assert_eq!(said, ["▶ api · Plan"]);
    // a reply in the chat to what the grid said there is a follow-up, to the same computer
    let sent_id =
        w.tg.calls.lock().unwrap().iter().rev().find(|c| c.0 == "sendMessage").map(|_| 1000 + *w.tg.next_id.lock().unwrap()).unwrap();
    let mut follow = msg("also the signup", 42, "private");
    follow["update_id"] = json!(78);
    follow["message"]["reply_to_message"] = json!({ "message_id": sent_id });
    let next = w.r.take(&w.user, &b, &follow, &pcs, &|_| true).unwrap().unwrap();
    assert!(matches!(next, Next::Forward { ref computer, ref body, .. } if computer == "c1" && body["follow"] == json!(true)), "{next:?}");
    assert_eq!(w.pcs.0.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn only_a_listed_person_in_a_private_chat_may_route_and_anything_else_gets_a_line() {
    let w = world((200, json!({})));
    w.r.set(&w.user, "123:abc", "42").await.unwrap();
    let b = w.r.bot_of("u1").unwrap().unwrap();
    let pcs = [w.laptop.clone()];
    assert_eq!(w.r.take(&w.user, &b, &msg("on laptop fix it", 99, "private"), &pcs, &|_| true).unwrap(), None, "a stranger: nothing");
    assert_eq!(w.r.take(&w.user, &b, &msg("on laptop fix it", 42, "group"), &pcs, &|_| true).unwrap(), None, "a group: nothing");
    let mut fwd = msg("on laptop fix it", 42, "private");
    fwd["message"]["forward_date"] = json!(1);
    assert_eq!(w.r.take(&w.user, &b, &fwd, &pcs, &|_| true).unwrap(), None, "a forward's words are someone else's");
    let other = w.r.take(&w.user, &b, &msg("fix it", 42, "private"), &pcs, &|_| true).unwrap();
    assert!(matches!(other, Some(Next::Say { ref text, .. }) if text.contains("on laptop fix the login")), "{other:?}");
    assert_eq!(w.r.take(&w.user, &b, &msg("on laptop fix it", 42, "private"), &pcs, &|_| false).unwrap(), None, "a retry stops at its key");
}

#[tokio::test]
async fn a_report_reaches_the_threads_chat_only_from_the_computer_it_went_to() {
    let w = world((200, json!({})));
    w.r.set(&w.user, "123:abc", "42").await.unwrap();
    let b = w.r.bot_of("u1").unwrap().unwrap();
    let next = w.r.take(&w.user, &b, &msg("on laptop fix it", 42, "private"), std::slice::from_ref(&w.laptop), &|_| true).unwrap().unwrap();
    let Next::Forward { body, .. } = next else { panic!() };
    let thread = body["thread"].as_str().unwrap().to_owned();
    w.r.reply(&w.user, &w.laptop, &thread, "Done: login fixed").await.unwrap();
    assert!(w.tg.calls.lock().unwrap().iter().any(|c| c.1["text"] == "Done: login fixed" && c.1["chat_id"] == "42"));
    let other = ComputerRow { id: "c2".into(), ..w.laptop.clone() };
    assert!(w.r.reply(&w.user, &other, &thread, "x").await.is_err(), "another computer");
    assert!(w.r.reply(&w.user, &w.laptop, "forged.sig", "x").await.is_err(), "a forged thread");
}

#[test]
fn a_bot_token_and_senders_are_checked() {
    assert!(bot_token_ok("123456:ABC-DEF_g") && !bot_token_ok("abc:def") && !bot_token_ok("123:"));
    assert_eq!(senders_of("1, 2 2").unwrap(), ["1", "2"]);
    assert!(senders_of("").is_err() && senders_of(&(0..21).map(|i| i.to_string()).collect::<Vec<_>>().join(",")).is_err());
}
