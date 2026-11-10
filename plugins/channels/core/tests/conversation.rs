//! v1 conversation.js through a stand-in channel and phone: a message is heard (triggers on `chat.message`,
//! ADR-0043), read by the grammar, and does what it asks: a task, a list, a refusal, a follow-up in its thread.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::unnecessary_literal_bound)]

use std::sync::Mutex;

use async_trait::async_trait;
use serde_json::{Value, json};
use wisp_channels_api::conversation::Conversation;
use wisp_channels_api::{ActArgs, ChannelCtx, Later, Mode, Parsed, Phone, ProjectView, RunOpts, SessionView, StartOpts, Started, ThreadCtx};
use wisp_channels_core::conversation::converse;
use wisp_kernel::Result;

#[derive(Default)]
struct FakePhone {
    log: Mutex<Vec<String>>,
}

impl FakePhone {
    fn note(&self, s: String) {
        self.log.lock().unwrap().push(s);
    }
    fn log(&self) -> Vec<String> {
        self.log.lock().unwrap().clone()
    }
}

#[async_trait]
impl Phone for FakePhone {
    async fn context(&self) -> Result<ChannelCtx> {
        Ok(ChannelCtx::default())
    }
    fn count(&self, kind: &str, detail: Option<&str>) {
        self.note(format!("count {kind} {}", detail.unwrap_or_default()));
    }
    fn on_grid(&self) -> bool {
        false
    }
    async fn grid_reply(&self, _t: &str, _x: &str) -> Result<()> {
        Ok(())
    }
    fn thread_saved(&self) {}
    fn heard(&self, channel: &str, sender: &str, text: &str) {
        self.note(format!("heard {channel} {sender} {text}"));
    }
    async fn thread_ctx(&self, _s: &str) -> Result<ThreadCtx> {
        Ok(ThreadCtx { agent: "claude".into(), machine: String::new() })
    }
    async fn start_parsed(&self, p: &Parsed, o: &StartOpts) -> Result<Started> {
        self.note(format!("start {} in {} cap {:?}", p.prompt, p.project.as_ref().map_or("-", |x| x.name.as_str()), o.cap));
        Ok(Started { ack: "▶ started".into(), ..Started::default() })
    }
    async fn stop(&self, s: &str) -> Result<String> {
        self.note(format!("stop {s}"));
        Ok("Stopped.".into())
    }
    async fn status(&self, _s: &str) -> Result<String> {
        Ok("running".into())
    }
    async fn run(&self, s: &str, p: &Parsed, _o: &RunOpts, _l: Option<Later>) -> Result<String> {
        self.note(format!("run {s} {}", p.prompt));
        Ok("✓ sent".into())
    }
    async fn mention(&self, _s: &str, p: &Parsed, o: &StartOpts) -> Result<Started> {
        self.start_parsed(p, o).await
    }
    async fn launch(&self, _p: &ProjectView, _x: &str) -> Result<Option<SessionView>> {
        Ok(None)
    }
    async fn act(&self, _a: &ActArgs) -> Result<String> {
        Ok("Marked done.".into())
    }
    async fn projects(&self) -> Result<Vec<ProjectView>> {
        Ok(Vec::new())
    }
    async fn session(&self, _id: &str) -> Result<Option<SessionView>> {
        Ok(None)
    }
    async fn sessions(&self) -> Result<Vec<SessionView>> {
        Ok(Vec::new())
    }
}

struct Chat<'a> {
    phone: &'a FakePhone,
    ctx: ChannelCtx,
    said: Mutex<Vec<String>>,
}

#[async_trait]
impl Conversation for Chat<'_> {
    fn phone(&self) -> &dyn Phone {
        self.phone
    }
    fn ctx(&self) -> &ChannelCtx {
        &self.ctx
    }
    fn channel(&self) -> &str {
        "test"
    }
    fn name(&self) -> &str {
        "Ana"
    }
    fn sender(&self) -> &str {
        "u1"
    }
    fn cap(&self) -> Mode {
        Mode::Edits
    }
    fn approvals(&self) -> bool {
        false
    }
    fn no_thread(&self) -> &str {
        "Reply to the task’s message to do that."
    }
    async fn say(&self, text: String) -> Result<Value> {
        self.said.lock().unwrap().push(text);
        Ok(json!({}))
    }
}

fn chat(phone: &FakePhone) -> Chat<'_> {
    let api = ProjectView { id: "p1".into(), name: "api".into(), path: "/work/api".into(), ..ProjectView::default() };
    Chat { phone, ctx: ChannelCtx { projects: vec![api.clone()], default_project: Some(api), ..ChannelCtx::default() }, said: Mutex::default() }
}

#[tokio::test]
async fn a_message_through_the_door_is_heard_by_triggers_and_starts_its_task() {
    let phone = FakePhone::default();
    let c = chat(&phone);
    converse(&c, "in api plan: fix the login", None, None).await.unwrap();
    let log = phone.log();
    assert_eq!(log[0], "heard test u1 in api plan: fix the login", "chat.message hears it first, as typed");
    assert_eq!(log[1], "start fix the login in api cap Some(Edits)");
    assert_eq!(c.said.lock().unwrap().as_slice(), ["▶ started"]);
}

#[tokio::test]
async fn a_list_a_refusal_and_full_auto_past_the_cap_start_nothing() {
    let phone = FakePhone::default();
    let c = chat(&phone);
    converse(&c, "projects", None, None).await.unwrap();
    converse(&c, "in nowhere: fix it", None, None).await.unwrap();
    converse(&c, "full auto: deploy it", None, None).await.unwrap();
    let said = c.said.lock().unwrap().clone();
    assert!(said[0].starts_with("Projects:\n• api  ← default"), "{}", said[0]);
    assert!(said[1].starts_with("No project “nowhere”.") && said[1].ends_with("Nothing started. Start with “:” to send it as written."), "{}", said[1]);
    assert!(said[2].ends_with("Nothing started."), "past this chat's cap: {}", said[2]);
    assert!(!phone.log().iter().any(|l| l.starts_with("start ")), "{:?}", phone.log());
    assert!(phone.log().contains(&"count list projects".to_owned()) && phone.log().contains(&"count refused no-match".to_owned()));
}

#[tokio::test]
async fn in_a_tasks_thread_a_message_follows_up_and_stop_stops_it() {
    let phone = FakePhone::default();
    let c = chat(&phone);
    converse(&c, "also fix the signup", Some("t1"), None).await.unwrap();
    converse(&c, "stop", Some("t1"), None).await.unwrap();
    converse(&c, "stop", None, None).await.unwrap();
    let log = phone.log();
    assert!(log.contains(&"run t1 also fix the signup".to_owned()) && log.contains(&"stop t1".to_owned()), "{log:?}");
    assert_eq!(c.said.lock().unwrap().last().unwrap(), "Reply to the task’s message to do that.", "stop out of a thread");
}
