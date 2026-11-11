//! The grid's signed-in pages and their forms through the grid's own routes (`edge_pages.rs`): home and account
//! for a signed-in person, a form with a stale CSRF token refused, one with the page's token done, sign-out
//! dropping the session, and the pages sending a signed-out browser to sign in.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;

use serde_json::json;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

const FORM: &str = "application/x-www-form-urlencoded";

fn csrf_in(page: &str) -> String {
    let at = page.find(r#"name="csrf" value=""#).expect("a form with its token");
    page[at + r#"name="csrf" value=""#.len()..].split('"').next().unwrap().to_owned()
}

struct Rig {
    c: reqwest::Client,
    root: String,
    stop: CancellationToken,
    dir: std::path::PathBuf,
}

async fn rig(name: &str, extra: serde_json::Value) -> Rig {
    let dir = std::env::temp_dir().join(format!("wisp-grid-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let mut file = json!({ "domain": "wisp.localhost", "listen": { "host": "127.0.0.1", "port": port }, "auth": { "dev": true } });
    if let (Some(f), Some(e)) = (file.as_object_mut(), extra.as_object()) {
        f.extend(e.clone());
    }
    let cfg = wisp_grid::config::for_test(&dir, file).unwrap();
    let clock = wisp_grid::clock::system();
    let db = Arc::new(wisp_grid::db::Db::open(&dir, clock.now_ms()).unwrap());
    let url_cfg = cfg.clone();
    let boxes = wisp_grid::hostd::ProcessHost::new(wisp_grid::hostd::ProcessOptions { bin: "wisp".into(), data: dir.clone(), idle_ms: 60_000, check_ms: 1000, start_ms: 30_000, max_running: 1, env: Vec::new(), url_of: Arc::new(move |h| url_cfg.instance_url(h)), boxd: None }, clock.clone());
    let grid = wisp_grid::edge::Grid::new(cfg, db, clock, boxes);
    let stop = CancellationToken::new();
    tokio::spawn(wisp_grid::edge::serve(grid.clone(), listener, stop.clone()));
    let c = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).resolve("wisp.localhost", ([127, 0, 0, 1], port).into()).build().unwrap();
    Rig { c, root: format!("http://wisp.localhost:{port}"), stop, dir }
}

/// Signs in by handle (dev): the session cookie.
async fn sign_in(r: &Rig, handle: &str) -> String {
    let res = r.c.get(format!("{}/auth/dev?handle={handle}&next=/", r.root)).send().await.unwrap();
    assert_eq!(res.status(), 302);
    let session = res.headers().get_all("set-cookie").iter().map(|v| v.to_str().unwrap().to_owned()).find(|c| c.starts_with("wisp_grid=")).unwrap();
    session.split(';').next().unwrap().to_owned()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_signed_in_person_sees_home_and_account_and_their_forms_work() {
    let rig = rig("pages", json!({})).await;
    let (c, root) = (&rig.c, &rig.root);
    // signed out: the public page, and account sends you to sign in
    let r = c.get(format!("{root}/")).send().await.unwrap();
    assert_eq!(r.status(), 200);
    assert!(r.text().await.unwrap().contains("Share and reach your wisps"));
    let r = c.get(format!("{root}/account")).send().await.unwrap();
    assert_eq!(r.status(), 302);
    assert!(r.headers()["location"].to_str().unwrap().starts_with("/signin"));

    // signed in (dev): home says hi, account lists how you sign in and offers sign-out
    let cookie = sign_in(&rig, "ada").await;
    let home = c.get(format!("{root}/")).header("cookie", &cookie).send().await.unwrap();
    assert_eq!(home.status(), 200);
    let home = home.text().await.unwrap();
    assert!(home.contains("Hi ada"), "{home}");
    let account = c.get(format!("{root}/account")).header("cookie", &cookie).send().await.unwrap().text().await.unwrap();
    assert!(account.contains("Signed-in devices") && account.contains("Sign out everywhere"), "{account}");
    // this grid routes no channels: no Telegram section
    assert!(!account.contains("Telegram to your computers"));
    let csrf = csrf_in(&account);

    // a stale form is refused; deleting with the wrong handle says what to type
    let r = c.post(format!("{root}/signout")).header("cookie", &cookie).header("content-type", FORM).body("csrf=stale").send().await.unwrap();
    assert_eq!(r.status(), 403);
    let r = c.post(format!("{root}/account/delete")).header("cookie", &cookie).header("content-type", FORM).body(format!("csrf={csrf}&confirm=bob")).send().await.unwrap();
    assert_eq!(r.status(), 302);
    assert!(r.headers()["location"].to_str().unwrap().starts_with("/account?m=Type%20ada"), "{:?}", r.headers()["location"]);
    // the cloud wisp asleep already: Sleep says so
    let r = c.post(format!("{root}/instance/stop")).header("cookie", &cookie).header("content-type", FORM).body(format!("csrf={csrf}")).send().await.unwrap();
    assert_eq!(r.status(), 302);
    assert!(r.headers()["location"].to_str().unwrap().contains("already%20asleep"));

    // sign out: the session goes and its cookie is cleared; the pages send you to sign in again
    let r = c.post(format!("{root}/signout")).header("cookie", &cookie).header("content-type", FORM).body(format!("csrf={csrf}")).send().await.unwrap();
    assert_eq!(r.status(), 302);
    assert!(r.headers().get_all("set-cookie").iter().any(|v| v.to_str().unwrap().starts_with("wisp_grid=;") && v.to_str().unwrap().contains("Max-Age=0")));
    let r = c.get(format!("{root}/account")).header("cookie", &cookie).send().await.unwrap();
    assert_eq!(r.status(), 302);
    rig.stop.cancel();
    let _ = std::fs::remove_dir_all(&rig.dir);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_account_page_offers_the_telegram_routing_form_and_says_what_was_wrong() {
    let rig = rig("route", json!({ "channels": { "enabled": true, "route": true } })).await;
    let (c, root) = (&rig.c, &rig.root);
    let cookie = sign_in(&rig, "ada").await;
    let account = c.get(format!("{root}/account")).header("cookie", &cookie).send().await.unwrap().text().await.unwrap();
    assert!(account.contains("Telegram to your computers") && account.contains(r#"action="/channels/route""#) && account.contains("Who may send"), "{account}");
    let csrf = csrf_in(&account);
    // not a bot token: back to the form with BotFather's shape, nothing kept
    let r = c.post(format!("{root}/channels/route")).header("cookie", &cookie).header("content-type", FORM).body(format!("csrf={csrf}&token=nope&senders=4242")).send().await.unwrap();
    assert_eq!(r.status(), 302);
    let to = r.headers()["location"].to_str().unwrap().to_owned();
    assert!(to.starts_with("/account?m=") && to.contains("BotFather") && to.ends_with("&tone=bad"), "{to}");
    rig.stop.cancel();
    let _ = std::fs::remove_dir_all(&rig.dir);
}
