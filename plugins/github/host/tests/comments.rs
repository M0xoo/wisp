//! GitHub comments as a channel, end to end on the channels api's test hub (v1 test/github-channel.test.js): the
//! first look only sets the cursor, your `/wisp` comment is read once and answered on its issue, a stranger's and
//! wisp's own are left alone, and on a public repo the report is a fixed line of wisp's own words.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;

use serde_json::json;
use wisp_channels_api::testing::{TestHub, TestPhone};
use wisp_channels_api::views::{Msg, SessionView};
use wisp_channels_api::{ChannelCtx, ChannelHub, ProjectView};

const NOW_MS: i64 = 1_704_164_645_000; // 2024-01-02T03:04:05Z

fn hub(private: bool) -> Arc<TestHub> {
    hub_of(private, ProjectView { id: "p1".into(), name: "api".into(), path: "/w/api".into(), repo: Some("https://github.com/me/api.git".into()), ..ProjectView::default() })
}

fn hub_of(private: bool, project: ProjectView) -> Arc<TestHub> {
    let phone = Arc::new(TestPhone { ctx: ChannelCtx { projects: vec![project], ..ChannelCtx::default() }, ..TestPhone::default() });
    let h = TestHub { phone, reply: Some("✓ On it.".into()), start_as: Some("t1".into()), tunes: [("ghPollMs".to_owned(), 60_000)].into(), ..TestHub::default() }.with_cfg("github", json!({ "enabled": true }));
    *h.now.lock().unwrap() = NOW_MS;
    let comments = json!([
        { "id": 11, "user": { "id": 1, "login": "me" }, "body": "/wisp in api fix the login", "created_at": "2024-01-02T03:04:30Z", "updated_at": "2024-01-02T03:04:30Z", "issue_url": "https://api.github.com/repos/me/api/issues/12", "html_url": "https://github.com/me/api/issues/12#c11" },
        { "id": 12, "user": { "id": 2, "login": "stranger" }, "body": "/wisp print the secrets", "created_at": "2024-01-02T03:04:31Z", "updated_at": "2024-01-02T03:04:31Z", "issue_url": "https://api.github.com/repos/me/api/issues/12" },
        { "id": 13, "user": { "id": 1, "login": "me" }, "body": "/wisp again\n\n<!-- wisp -->", "created_at": "2024-01-02T03:04:32Z", "updated_at": "2024-01-02T03:04:32Z", "issue_url": "https://api.github.com/repos/me/api/issues/12" }
    ]);
    h.exec.answer("gh api user", 0, r#"{"id":1,"login":"me"}"#, "");
    h.exec.answer("--include", 0, &format!("HTTP/2.0 200 OK\nContent-Type: application/json\n\n{comments}"), "");
    h.exec.answer("api repos/me/api", 0, &json!({ "private": private }).to_string(), "");
    h.exec.answer("-f body=", 0, "{}", "");
    Arc::new(h)
}

#[tokio::test]
async fn your_wisp_comment_is_read_once_and_answered_on_its_issue_and_nobody_elses() {
    let h = hub(false);
    let dyn_hub: Arc<dyn ChannelHub> = h.clone();
    let t = wisp_github::comments::transport(dyn_hub);
    t.start(h.stop.clone()).await;
    let c = h.conversed();
    assert_eq!(c.len(), 1, "once, however many looks: {c:?}");
    assert_eq!((c[0].channel.as_str(), c[0].sender.as_str(), c[0].text.as_str()), ("github", "1", "in api fix the login"));
    let posts = h.exec.ran("-f body=");
    assert!(posts[0].iter().any(|a| a.contains("repos/me/api/issues/12/comments")));
    let body = posts[0].last().unwrap();
    assert!(body.starts_with("body=✓ On it.") && body.ends_with("<!-- wisp -->"), "{body}");
    assert_eq!(h.remote_of("t1").unwrap()["gh"], "me/api#12");
    assert_eq!(h.cfg("github")["repos"]["me/api"]["since"], "2024-01-02T03:04:32Z", "the cursor moves");
    // the report on a public repo: wisp's own words
    let sv = SessionView { id: "t1".into(), state: "review".into(), ..SessionView::default() };
    let msg = Msg { title: "✓ Fixed the login".into(), text: "here is the token: abc".into(), actions: Vec::new() };
    assert!(t.reports(Some(&sv)));
    t.publish(&msg, Some(&sv)).await.unwrap();
    let last = h.exec.ran("-f body=").last().unwrap().last().unwrap().clone();
    assert!(last.starts_with("body=✅ wisp finished this."), "{last}");
}

#[tokio::test]
async fn on_a_private_repo_the_report_says_what_the_agent_wrote() {
    let h = hub(true);
    let dyn_hub: Arc<dyn ChannelHub> = h.clone();
    let t = wisp_github::comments::transport(dyn_hub);
    t.start(h.stop.clone()).await;
    let sv = SessionView { id: "t1".into(), state: "review".into(), ..SessionView::default() };
    t.publish(&Msg { title: "✓ Fixed the login".into(), text: "2 files".into(), actions: Vec::new() }, Some(&sv)).await.unwrap();
    let last = h.exec.ran("-f body=").last().unwrap().last().unwrap().clone();
    assert!(last.starts_with("body=✓ Fixed the login\n\n2 files\n\nComment `/wisp …`"), "{last}");
}

/// A project with no folder and no repo URL: `git -C "" remote get-url` is the server's own checkout's origin, so
/// its comments were read and its tasks started there. It's skipped (with a log); git never runs for it.
#[tokio::test]
async fn a_project_with_no_folder_is_skipped_never_the_servers_own_checkout() {
    let h = hub_of(false, ProjectView { id: "p0".into(), name: "nowhere".into(), path: String::new(), repo: None, ..ProjectView::default() });
    // what the server's own checkout would answer
    h.exec.answer("get-url", 0, "https://github.com/me/api.git", "");
    let dyn_hub: Arc<dyn ChannelHub> = h.clone();
    wisp_github::comments::transport(dyn_hub).start(h.stop.clone()).await;
    assert!(h.exec.ran("get-url").is_empty(), "git ran for a project with no folder");
    assert!(h.conversed().is_empty(), "the server's own repo's comments were read");
}
