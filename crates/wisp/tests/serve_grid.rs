//! Two wisps and a local grid (`wisp-grid dev`, in this process), end to end (ADR-0010, 0038, 0041): sign
//! in through the device flow, share a setup to wisp Cloud, import it on the other wisp, update it (update
//! available), its page without wisp, a grid:// module source, revoke; then a computer's tunnel reached
//! with `--on`, previews behind their setting, a box's credential refused, and a cloud box asleep, left
//! asleep by a passive request and woken by a command.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::too_many_lines, clippy::many_single_char_names)]

mod common;

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use common::{Api, ended, start_with, temp};
use serde_json::{Value, json};

struct Grid {
    port: u16,
    url: String,
    _stop: tokio_util_stop::Stop,
    _g: std::sync::Arc<wisp_grid::edge::Grid>,
}

mod tokio_util_stop {
    /// Stops the grid when the test ends.
    pub struct Stop(pub Box<dyn FnOnce() + Send>);
    impl Drop for Stop {
        fn drop(&mut self) {
            let f = std::mem::replace(&mut self.0, Box::new(|| {}));
            f();
        }
    }
}

async fn grid(dir: &Path) -> Grid {
    let data = dir.join("grid");
    std::fs::create_dir_all(&data).unwrap();
    let (g, port, stop) = wisp_grid::edge::dev(
        &data,
        0,
        PathBuf::from(env!("CARGO_BIN_EXE_wisp")),
        vec![("WISP_WEB_DIR".into(), dir.join("no-web").display().to_string())],
        600_000,
    )
    .await
    .unwrap();
    Grid { port, url: format!("http://wisp.localhost:{port}"), _stop: tokio_util_stop::Stop(Box::new(move || stop.cancel())), _g: g }
}

/// A client that finds every `*.wisp.localhost` on the grid's port, as a browser would.
fn browser(port: u16, names: &[&str]) -> reqwest::Client {
    let mut b = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).no_proxy();
    for n in names {
        b = b.resolve(n, SocketAddr::from(([127, 0, 0, 1], port)));
    }
    b.build().unwrap()
}

/// A person signed in to the grid in their browser approves `code`.
async fn approve(g: &Grid, handle: &str, code: &str, allow: bool) {
    let b = browser(g.port, &["wisp.localhost"]);
    let r = b.get(format!("{}/auth/dev?handle={handle}", g.url)).send().await.unwrap();
    let cookie = r.headers().get("set-cookie").unwrap().to_str().unwrap().split(';').next().unwrap().to_owned();
    let page = b.get(format!("{}/activate?code={code}", g.url)).header("cookie", &cookie).send().await.unwrap().text().await.unwrap();
    let csrf = page.split("name=\"csrf\" value=\"").nth(1).unwrap().split('"').next().unwrap().to_owned();
    let r = b
        .post(format!("{}/activate", g.url))
        .header("cookie", &cookie)
        .json(&json!({ "csrf": csrf, "code": code, "answer": if allow { "allow" } else { "deny" } }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200, "{}", r.text().await.unwrap());
}

/// `wisp` signs in to the grid as `handle`.
async fn sign_in(api: &Api, g: &Grid, handle: &str) -> Value {
    let f = api.cmd("grid-client.signin", json!({ "grid": g.url })).await;
    assert_eq!(f["state"], "waiting", "{f}");
    approve(g, handle, f["userCode"].as_str().unwrap(), true).await;
    let at = Instant::now();
    loop {
        let s = api.cmd("grid-client.signinStatus", json!({ "id": f["id"] })).await;
        if s["state"] != "waiting" {
            assert_eq!(s["state"], "done", "{s}");
            return s;
        }
        assert!(at.elapsed() < Duration::from_secs(30), "{s}");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// The test's own device token for `handle` (as another wisp of theirs would hold).
async fn device_token(g: &Grid, handle: &str) -> String {
    let b = browser(g.port, &["wisp.localhost"]);
    let c: Value =
        b.post(format!("{}/api/device/code", g.url)).json(&json!({ "name": "test" })).send().await.unwrap().json().await.unwrap();
    approve(g, handle, c["user_code"].as_str().unwrap(), true).await;
    tokio::time::sleep(Duration::from_millis(5_100)).await;
    let t: Value = b
        .post(format!("{}/api/device/token", g.url))
        .json(&json!({ "device_code": c["device_code"] }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    t["token"].as_str().unwrap_or_else(|| panic!("{t}")).to_owned()
}

fn wisp(dir: &Path, cwd: &Path, args: &[&str]) -> (i32, String, String) {
    let o = Command::new(env!("CARGO_BIN_EXE_wisp"))
        .args(args)
        .env("WISP_HOME", dir.join("home"))
        .env("NO_COLOR", "1")
        .current_dir(cwd)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).into_owned(), String::from_utf8_lossy(&o.stderr).into_owned())
}

fn api(port: u16) -> Api {
    Api { http: reqwest::Client::new(), port, n: 0.into() }
}

async fn agent_model(api: &Api, name: &str) -> Option<String> {
    let all = api.cmd("resources.export", json!({ "kinds": ["agent"] })).await;
    all.as_array().into_iter().flatten().find(|r| r["name"] == name).and_then(|r| r["spec"]["model"].as_str().map(str::to_owned))
}

#[tokio::test(flavor = "multi_thread")]
async fn sign_in_share_import_and_update_through_wisp_cloud() {
    let root = temp("serve-grid-share");
    let g = grid(&root).await;
    let (da, db) = (root.join("a"), root.join("b"));
    for d in [&da, &db] {
        std::fs::create_dir_all(d.join("proj")).unwrap();
    }
    let (sa, pa) = start_with(&da, &[]);
    let (sb, pb) = start_with(&db, &[]);
    let (a, b) = (api(pa), api(pb));

    // not_signed_in_offers_sign_in_or_a_file: nothing goes, and it says how
    let (code, _, err) = wisp(&db, &db.join("proj"), &["share", "agent.reviewer", "--to", "cloud", "--yes"]);
    assert_eq!(code, 1);
    assert!(err.contains("wisp cloud signin") && err.contains("--to file"), "{err}");

    // device_sign_in (the client's side): code, browser approval, token, the cloud box as a machine
    let s = sign_in(&a, &g, "ada").await;
    assert_eq!(s["handle"], "ada");
    let st = a.cmd("grid-client.status", json!({})).await;
    assert_eq!((st["signedIn"].clone(), st["grid"].clone()), (json!(true), json!(g.url)));
    let m = a.cmd("machines.get", json!({ "id": st["machine"] })).await;
    assert_eq!((m["transport"].clone(), m["name"].clone()), (json!("grid"), json!("Cloud")));
    assert!(!std::fs::read_to_string(da.join("home/wisp.db")).unwrap_or_default().contains("wgd_"), "the token isn't in the store");
    // a_denied_sign_in_stops
    let f = b.cmd("grid-client.signin", json!({ "grid": g.url })).await;
    approve(&g, "bo", f["userCode"].as_str().unwrap(), false).await;
    let at = Instant::now();
    loop {
        let s = b.cmd("grid-client.signinStatus", json!({ "id": f["id"] })).await;
        if s["state"] != "waiting" {
            assert_eq!(s["state"], "denied", "{s}");
            break;
        }
        assert!(at.elapsed() < Duration::from_secs(30));
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    sign_in(&b, &g, "bo").await;

    // share a setup (a_share_goes_only_after_the_scrub: what goes is the export, secrets as references)
    let r = a
        .try_cmd(
            "resources.apply",
            json!({ "resources": [{ "kind": "agent", "name": "reviewer", "spec": { "harness": "claude", "model": "opus" } }] }),
        )
        .await;
    assert_eq!(r["ok"], true, "{r}");
    let (code, out, err) = wisp(&da, &da.join("proj"), &["share", "agent.reviewer", "--to", "cloud", "--yes", "--publish"]);
    assert_eq!(code, 0, "{out}{err}");
    let link = out.split_whitespace().find(|w| w.contains("/s/")).unwrap_or_else(|| panic!("{out}")).to_owned();
    assert!(out.contains("v1") && out.contains("grid://ada/reviewer"), "{out}");

    // a_share_page_works_without_wisp
    let web = browser(g.port, &["wisp.localhost"]);
    let page = web.get(&link).send().await.unwrap();
    assert_eq!(page.status(), 200);
    let html = page.text().await.unwrap();
    assert!(html.contains("reviewer") && html.contains("wisp open") && html.contains("opus"), "{html}");
    // the_gallery_lists_only_what_was_published
    let gal: Value = web.get(format!("{}/api/gallery?q=reviewer", g.url)).send().await.unwrap().json().await.unwrap();
    assert_eq!(gal.as_array().unwrap().len(), 1, "{gal}");

    // import it on the other wisp: the plan, then applied
    let (code, out, err) = wisp(&db, &db.join("proj"), &["open", &link, "--yes"]);
    assert_eq!(code, 0, "{out}{err}");
    assert!(out.contains("✓ signed") && out.contains("agent/reviewer") || out.contains("reviewer"), "{out}");
    assert_eq!(agent_model(&b, "reviewer").await.as_deref(), Some("opus"));

    // sharing_again_is_a_new_version + an_import_sees_update_available
    let (code, out, _) = wisp(&da, &da.join("proj"), &["share", "agent.reviewer", "--to", "cloud", "--yes"]);
    assert!(code == 0 && out.contains("v1"), "the same content is the same version: {out}");
    a.cmd(
        "resources.apply",
        json!({ "resources": [{ "kind": "agent", "name": "reviewer", "spec": { "harness": "claude", "model": "sonnet" } }] }),
    )
    .await;
    let (code, out, err) = wisp(&da, &da.join("proj"), &["share", "agent.reviewer", "--to", "cloud", "--yes"]);
    assert!(code == 0 && out.contains("v2"), "{out}{err}");
    let (_, out, _) = wisp(&db, &db.join("proj"), &["shares", "--updates"]);
    assert!(out.contains("v1 → v2"), "{out}");
    // ref_pins_a_version
    let f = b.cmd("grid-client.fetch", json!({ "link": format!("{link}?ref=v1") })).await;
    assert_eq!((f["version"].clone(), f["latest"].clone(), f["verified"].clone()), (json!(1), json!(2), json!(true)));
    let (code, out, err) = wisp(&db, &db.join("proj"), &["open", &link, "--yes"]);
    assert_eq!(code, 0, "{out}{err}");
    assert_eq!(agent_model(&b, "reviewer").await.as_deref(), Some("sonnet"));
    let (_, out, _) = wisp(&db, &db.join("proj"), &["shares", "--updates"]);
    assert!(out.contains("up to date"), "{out}");

    // a_grid_source_is_pinned_in_the_lock
    let w = db.join("proj/.wisp");
    std::fs::create_dir_all(&w).unwrap();
    std::fs::write(w.join("wisp.yml"), "modules:\n  review:\n    source: grid://ada/reviewer?ref=v1\n").unwrap();
    let (code, out, err) = wisp(&db, &db.join("proj"), &["init"]);
    assert_eq!(code, 0, "{out}{err}");
    let lock = std::fs::read_to_string(w.join("lock.yml")).unwrap();
    assert!(lock.contains("grid://ada/reviewer") && lock.contains("version: 1"), "{lock}");
    assert!(std::fs::read_to_string(w.join("modules/review/wisp.yml")).unwrap().contains("opus"));

    // wisp_shares_lists_mine + views_and_imports_are_counted (bo's, not ada's own)
    let (_, out, _) = wisp(&da, &da.join("proj"), &["shares", "--json"]);
    let mine: Value = serde_json::from_str(out.trim()).unwrap();
    let s0 = &mine[0];
    assert_eq!((s0["kind"].clone(), s0["version"].clone(), s0["access"]["kind"].clone()), (json!("setup"), json!(2), json!("anyone")));
    assert!(s0["imports"].as_i64().unwrap() >= 2 && s0["views"].as_i64().unwrap() >= 1, "{s0}");

    // a_share_goes_only_after_the_scrub: a task's link carries the preview's scrubbed, signed bundle
    let secret = "sk-ant-abcdefghijklmnopqrstuvwx0123";
    let made = a.cmd("runtime.create", json!({ "prompt": format!("fix the add bug, the key is {secret}"), "cwd": da.join("proj"), "agent": "claude", "worktree": false })).await;
    let tid = made["id"].as_str().unwrap().to_owned();
    a.until(&tid, "the turn ends", |t| t.last().is_some_and(ended)).await;
    let (code, out, err) = wisp(&da, &da.join("proj"), &["share", &tid, "--to", "cloud", "--level", "report", "--yes"]);
    assert_eq!(code, 0, "{out}{err}");
    let tlink = out.split_whitespace().find(|w| w.contains("/s/")).unwrap_or_else(|| panic!("{out}")).to_owned();
    let got = b.cmd("grid-client.fetch", json!({ "link": tlink })).await;
    assert_eq!((got["card"]["kind"].clone(), got["verified"].clone()), (json!("task"), json!(true)));
    let text = got["content"].to_string();
    assert!(!text.contains(secret) && text.contains("fix the add bug"), "{text}");
    let tpage = web.get(&tlink).send().await.unwrap().text().await.unwrap();
    assert!(!tpage.contains(secret) && tpage.contains("fix the add bug"), "the page shows the scrubbed ask");

    // share_access (people): bo may, someone not signed in may not
    a.cmd("grid-client.access", json!({ "id": s0["id"], "access": { "kind": "people", "people": ["bo"] } })).await;
    assert_eq!(b.cmd("grid-client.fetch", json!({ "link": link })).await["version"], 2);
    assert_eq!(web.get(format!("{}/api/shares/{}", g.url, s0["id"].as_str().unwrap())).send().await.unwrap().status(), 403);
    // an_expired_or_revoked_link_is_gone
    let (code, _, _) = wisp(&da, &da.join("proj"), &["shares", "--revoke", s0["id"].as_str().unwrap()]);
    assert_eq!(code, 0);
    assert_eq!(web.get(&link).send().await.unwrap().status(), 410);
    let gone = b.try_cmd("grid-client.fetch", json!({ "link": link })).await;
    assert!(gone.to_string().contains("revoked"), "{gone}");
    drop((sa, sb, g));
}

/// F-share-3 (ADR-0038): a task shared from its Share… dialog (`share.create`), shared again, then Stop sharing
/// (`share.stop`): sharing again keeps the one link live (the grid answers the same link, a new version, and it isn't
/// taken back), and after Stop sharing the link answers 410 on its page and to a fetch, and the task no longer lists it.
#[tokio::test(flavor = "multi_thread")]
async fn stop_sharing_a_task_stops_its_link() {
    let root = temp("serve-grid-stop");
    let g = grid(&root).await;
    let da = root.join("a");
    std::fs::create_dir_all(da.join("proj")).unwrap();
    let (sa, pa) = start_with(&da, &[]);
    let a = api(pa);
    sign_in(&a, &g, "ada").await;
    let made =
        a.cmd("runtime.create", json!({ "prompt": "fix the add bug", "cwd": da.join("proj"), "agent": "claude", "worktree": false })).await;
    let tid = made["id"].as_str().unwrap().to_owned();
    a.until(&tid, "the turn ends", |t| t.last().is_some_and(ended)).await;
    let web = browser(g.port, &["wisp.localhost"]);

    let first = a.cmd("share.create", json!({ "session": tid })).await;
    let url = first["url"].as_str().unwrap_or_else(|| panic!("{first}")).to_owned();
    assert_eq!(web.get(&url).send().await.unwrap().status(), 200, "{url}");
    let kept = a.cmd("runtime.get", json!({ "id": tid })).await["ext"]["wisp.share"].clone();
    assert_eq!(kept["url"], json!(url), "{kept}");

    // Share again: the same link, still live (taking the replaced link back never takes back the one just made)
    let again = a.cmd("share.create", json!({ "session": tid, "work": true })).await;
    assert_eq!(again["url"], json!(url), "{again}");
    assert_eq!(web.get(&url).send().await.unwrap().status(), 200, "sharing again keeps the link working");

    // Stop sharing: the link stops working, and the task forgets it
    let stopped = a.cmd("share.stop", json!({ "session": tid })).await;
    assert_eq!(stopped["ok"], true, "{stopped}");
    assert_eq!(web.get(&url).send().await.unwrap().status(), 410, "the page of a stopped share is gone");
    let id = kept["id"].as_str().unwrap();
    assert_eq!(web.get(format!("{}/api/shares/{id}", g.url)).send().await.unwrap().status(), 410, "and its api");
    // (the sharer's own signed-in fetch still reads it: the grid's owner check comes first, as My shares needs)
    let t = a.cmd("runtime.get", json!({ "id": tid })).await;
    assert!(t["ext"].get("wisp.share").is_none_or(Value::is_null), "the task no longer lists the link: {t}");
    let twice = a.try_cmd("share.stop", json!({ "session": tid })).await;
    assert!(twice.to_string().contains("isn't shared"), "{twice}");
    drop((sa, g));
}

/// A tiny page on `port`, answering "hello".
async fn page_on() -> u16 {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((mut s, _)) = l.accept().await else { return };
            tokio::spawn(async move {
                use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
                let mut buf = [0u8; 4096];
                let _ = s.read(&mut buf).await;
                let _ = s
                    .write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 5\r\nconnection: close\r\n\r\nhello")
                    .await;
            });
        }
    });
    port
}

#[tokio::test(flavor = "multi_thread")]
async fn a_computer_and_a_box_through_the_grid() {
    let root = temp("serve-grid-reach");
    let g = grid(&root).await;
    let (da, db) = (root.join("a"), root.join("b"));
    for d in [&da, &db] {
        std::fs::create_dir_all(d.join("proj")).unwrap();
        std::fs::write(d.join("proj/math.js"), "export const add = (a, b) => a - b;\n").unwrap();
    }
    let (sa, pa) = start_with(&da, &[]);
    let (sb, pb) = start_with(&db, &[]);
    let (a, b) = (api(pa), api(pb));
    sign_in(&a, &g, "ada").await;
    // this computer on the grid, its tunnel up
    let c = a.cmd("grid-client.computer", json!({ "on": true, "name": "studio" })).await;
    assert_eq!(c["label"], "studio--ada", "{c}");
    let at = Instant::now();
    while a.cmd("grid-client.status", json!({})).await["computer"]["state"] != "online" {
        assert!(at.elapsed() < Duration::from_secs(20), "the tunnel never came up");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let made =
        a.cmd("runtime.create", json!({ "prompt": "fix the add bug", "cwd": da.join("proj"), "agent": "claude", "worktree": false })).await;
    let id = made["id"].as_str().unwrap().to_owned();
    a.until(&id, "the turn ends", |t| t.last().is_some_and(ended)).await;

    // the other wisp, the same person: the computer shows up as a grid-tunnel machine and connects
    sign_in(&b, &g, "ada").await;
    let at = Instant::now();
    loop {
        let list = b.cmd("machines.list", json!({})).await;
        let studio = list.as_array().unwrap().iter().find(|p| p["name"] == "studio").cloned();
        if studio.as_ref().is_some_and(|p| p["state"] == "online") {
            assert_eq!(studio.unwrap()["transport"], "grid-tunnel");
            break;
        }
        assert!(at.elapsed() < Duration::from_secs(30), "{list}");
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    // on_runs_a_command_on_that_peer: the task is studio's, through the tunnel
    let (code, out, err) = wisp(&db, &db.join("proj"), &["--on", "studio", "runtime", "get", "--id", &id, "--json"]);
    assert_eq!(code, 0, "{out}{err}");
    assert!(out.contains("fix the add bug") && err.contains("on studio"), "{out}{err}");
    let (code, _, err) = wisp(&db, &db.join("proj"), &["--on", "nowhere", "runtime", "get", "--id", &id]);
    assert!(code != 0 && err.contains("no machine nowhere") && err.contains("studio"), "{err}");

    // previews_pass_only_when_the_setting_is_on
    let token = device_token(&g, "ada").await;
    let p = page_on().await;
    let host = format!("p{p}--studio--ada.wisp.localhost");
    let web = browser(g.port, &[host.as_str(), "studio--ada.wisp.localhost", "ada.wisp.localhost"]);
    let url = format!("http://{host}:{}/", g.port);
    let r = web.get(&url).bearer_auth(&token).send().await.unwrap();
    assert_eq!(r.status(), 403);
    assert!(r.text().await.unwrap().contains("Show local pages in previews"));
    a.cmd("settings.set", json!({ "key": "grid-client.previews", "value": true })).await;
    let r = web.get(&url).bearer_auth(&token).send().await.unwrap();
    assert_eq!((r.status().as_u16(), r.text().await.unwrap()), (200, "hello".to_owned()));
    // a_box_never_gets_a_laptop_token (the grid's side): a Box credential whose secret isn't the running box's proves
    // nobody, so it gets no further than Sign in first (401); a verified box is refused by the trust table (403:
    // apps/grid/tests/box_reach.rs). Either way it reaches no computer.
    let r = web
        .get(format!("http://studio--ada.wisp.localhost:{}/api/health", g.port))
        .header("authorization", "Box ada x")
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 401);
    assert!(r.text().await.unwrap().contains("Sign in first"));
    let r = web.get(format!("http://studio--ada.wisp.localhost:{}/api/health", g.port)).bearer_auth(&token).send().await.unwrap();
    assert_eq!(r.status(), 200);

    // the cloud box: asleep, and a passive request leaves it so
    let boxu = format!("http://ada.wisp.localhost:{}", g.port);
    let state = |w: reqwest::Client, t: String, u: String| async move {
        w.get(format!("{u}/_grid/state")).bearer_auth(t).send().await.unwrap().json::<Value>().await.unwrap()["state"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    assert_eq!(state(web.clone(), token.clone(), boxu.clone()).await, "stopped");
    let r = web.get(format!("{boxu}/api/health")).bearer_auth(&token).header("x-wisp-passive", "1").send().await.unwrap();
    assert_eq!(r.status(), 503);
    assert_eq!(state(web.clone(), token.clone(), boxu.clone()).await, "stopped", "a_passive_request_never_wakes_a_box");
    // a_real_request_wakes_a_sleeping_box: a command, from the other wisp, --on the cloud box
    let (code, out, err) = wisp(&db, &db.join("proj"), &["--on", "Cloud", "runtime", "list", "--json"]);
    assert_eq!(code, 0, "{out}{err}");
    assert_eq!(state(web.clone(), token.clone(), boxu.clone()).await, "running");
    // a_box_never_gets_a_laptop_token (the wisp's side): the box refuses to be a computer
    let r: Value = web
        .post(format!("{boxu}/api/cmd"))
        .bearer_auth(&token)
        .header("idempotency-key", "k1")
        .json(&json!({ "cmd": "grid-client.computer", "args": { "on": true } }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_ne!(r["ok"], true, "{r}");
    assert!(r.to_string().contains("laptop token") || r.to_string().contains("grid box"), "{r}");
    // grid_deploy_applies_a_formula_to_a_box: the cloud box by default
    std::fs::write(db.join("proj/box.wisp.yml"), "wisp: 1\nagents:\n  - name: boxer\n    harness: claude\n    model: opus\n").unwrap();
    let (code, out, err) = wisp(&db, &db.join("proj"), &["grid", "deploy", "-f", "box.wisp.yml", "--yes"]);
    assert_eq!(code, 0, "{out}{err}");
    let (code, out, err) = wisp(&db, &db.join("proj"), &["--on", "Cloud", "export", "agents"]);
    assert!(code == 0 && out.contains("boxer"), "{out}{err}");
    let (_, out, _) = wisp(&db, &db.join("proj"), &["export", "agents"]);
    assert!(!out.contains("boxer"), "applied on the box, not here: {out}");
    let r = web.post(format!("{boxu}/_grid/stop")).bearer_auth(&token).send().await.unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(state(web.clone(), token.clone(), boxu.clone()).await, "stopped");

    // off: the tunnel goes, and the computer is offline to the others
    a.cmd("grid-client.computer", json!({ "on": false })).await;
    let at = Instant::now();
    loop {
        let r = web.get(format!("http://studio--ada.wisp.localhost:{}/api/health", g.port)).bearer_auth(&token).send().await.unwrap();
        if r.status() == 503 {
            break;
        }
        assert!(at.elapsed() < Duration::from_secs(10), "still reached");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    drop((sa, sb, g));
}

/// F-stuff-6 against a grid: an app in My Stuff published from wisp is at a link anyone opens, its page and script
/// served; its `.env`, a secrets file and its source map never reach the link; Update keeps the link; Unpublish takes
/// it down.
#[tokio::test(flavor = "multi_thread")]
async fn a_published_app_is_at_its_grid_link_without_its_secrets_or_source_maps() {
    let root = temp("serve-grid-publish");
    let g = grid(&root).await;
    let d = root.join("a");
    let app = d.join("proj/board");
    std::fs::create_dir_all(app.join("config")).unwrap();
    std::fs::write(app.join("index.html"), "<!doctype html><title>Board</title><script src=\"app.js\"></script>").unwrap();
    std::fs::write(app.join("app.js"), "console.log('board')\n//# sourceMappingURL=app.js.map").unwrap();
    std::fs::write(app.join("app.js.map"), r#"{"version":3,"sources":["src/secret-logic.ts"]}"#).unwrap();
    std::fs::write(app.join(".env"), "API_KEY=sk-live-123").unwrap();
    std::fs::write(app.join("config/secrets.json"), r#"{"token":"t0p"}"#).unwrap();
    let (s, p) = start_with(&d, &[]);
    let a = api(p);

    // not signed in: it says how
    let it = a.cmd("stuff.save", json!({ "app": app })).await;
    let id = it["id"].as_str().unwrap().to_owned();
    let no = a.try_cmd("stuff.publish", json!({ "id": id })).await;
    assert_eq!(no["ok"], false, "{no}");
    assert_eq!(a.cmd("stuff.targets", json!({})).await, json!([]), "nowhere to publish yet");

    sign_in(&a, &g, "ada").await;
    let t = a.cmd("stuff.targets", json!({})).await;
    assert_eq!(t[0]["handle"], "ada", "{t}");
    let done = a.cmd("stuff.publish", json!({ "id": id })).await;
    let link = done["published"]["url"].as_str().unwrap_or_else(|| panic!("{done}")).to_owned();
    let host = link.split("//").nth(1).unwrap().split([':', '/']).next().unwrap().to_owned();
    let web = browser(g.port, &[host.as_str()]);
    let get = |path: &str| {
        let (web, url) = (web.clone(), format!("{}{path}", link.trim_end_matches('/')));
        async move {
            let r = web.get(url).send().await.unwrap();
            (r.status().as_u16(), r.text().await.unwrap())
        }
    };
    let (code, html) = get("/").await;
    assert_eq!(code, 200, "{html}");
    assert!(html.contains("<title>Board</title>"), "{html}");
    assert_eq!(get("/app.js").await.0, 200);
    for private in ["/.env", "/app.js.map", "/config/secrets.json"] {
        let (code, body) = get(private).await;
        assert_ne!(code, 200, "{private} reached the public link: {body}");
        assert!(!body.contains("sk-live-123") && !body.contains("t0p") && !body.contains("secret-logic"), "{private}: {body}");
    }

    // Update the public link: the same link, the new page
    std::fs::write(app.join("index.html"), "<!doctype html><title>Board 2</title>").unwrap();
    a.cmd("stuff.save", json!({ "app": app, "replace": id })).await;
    let again = a.cmd("stuff.publish", json!({ "id": id })).await;
    assert_eq!(again["published"]["url"], link.as_str(), "an update keeps its link");
    assert!(get("/").await.1.contains("Board 2"));

    // Unpublish: the link is gone, the app stays in My Stuff
    let off = a.cmd("stuff.unpublish", json!({ "id": id })).await;
    assert!(off["published"].is_null(), "{off}");
    assert_ne!(get("/").await.0, 200);
    assert_eq!(a.cmd("stuff.get", json!({ "id": id })).await["id"], id.as_str());
    drop(s);
}
