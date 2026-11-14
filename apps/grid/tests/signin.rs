//! Sign-in with GitHub through the grid's own routes, against a fake GitHub: out with state + PKCE, back with a
//! code, in with a session; a callback without the browser's state cookie is refused.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::{Arc, Mutex};

use bytes::Bytes;
use http_body_util::{BodyExt as _, Full};
use hyper_util::rt::TokioIo;
use serde_json::json;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

/// A GitHub that hands out a token for any code with a verifier, and says the user is #4242 `ada`.
async fn fake_github(seen: Arc<Mutex<Vec<String>>>) -> u16 {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((sock, _)) = l.accept().await else { return };
            let seen = seen.clone();
            tokio::spawn(async move {
                let svc = hyper::service::service_fn(move |req: http::Request<hyper::body::Incoming>| {
                    let seen = seen.clone();
                    async move {
                        let path = req.uri().path().to_owned();
                        let body = req
                            .into_body()
                            .collect()
                            .await
                            .map(|b| String::from_utf8_lossy(&b.to_bytes()).into_owned())
                            .unwrap_or_default();
                        seen.lock().unwrap().push(format!("{path} {body}"));
                        let v = match path.as_str() {
                            "/login/oauth/access_token" if body.contains("code_verifier") => json!({ "access_token": "gho_test" }),
                            "/login/oauth/access_token" => json!({ "error": "bad_verification_code" }),
                            "/user" => json!({ "id": 4242, "login": "ada", "name": "Ada" }),
                            "/user/emails" => json!([{ "email": "ada@example.com", "primary": true, "verified": true }]),
                            _ => json!({ "message": "Not Found" }),
                        };
                        Ok::<_, std::convert::Infallible>(http::Response::new(Full::new(Bytes::from(v.to_string()))))
                    }
                });
                let _ = hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(sock), svc).await;
            });
        }
    });
    port
}

#[tokio::test(flavor = "multi_thread")]
async fn github_sign_in_through_the_routes() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let gh = fake_github(seen.clone()).await;
    let dir = std::env::temp_dir().join(format!("wisp-grid-signin-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let base = format!("http://127.0.0.1:{gh}");
    let cfg = wisp_grid::config::for_test(&dir, json!({ "domain": "wisp.localhost", "listen": { "host": "127.0.0.1", "port": port }, "auth": { "providers": { "github": { "clientId": "cid", "clientSecret": "csecret", "authBase": base, "apiBase": base } } } })).unwrap();
    let clock = wisp_grid::clock::system();
    let db = Arc::new(wisp_grid::db::Db::open(&dir, clock.now_ms()).unwrap());
    let url_cfg = cfg.clone();
    let boxes = wisp_grid::hostd::ProcessHost::new(
        wisp_grid::hostd::ProcessOptions {
            bin: "wisp".into(),
            data: dir.clone(),
            idle_ms: 60_000,
            check_ms: 1000,
            start_ms: 30_000,
            max_running: 1,
            env: Vec::new(),
            url_of: Arc::new(move |h| url_cfg.instance_url(h)),
            boxd: None,
        },
        clock.clone(),
    );
    let grid = wisp_grid::edge::Grid::new(cfg, db, clock, boxes);
    let stop = CancellationToken::new();
    tokio::spawn(wisp_grid::edge::serve(grid.clone(), listener, stop.clone()));
    let c = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .resolve("wisp.localhost", ([127, 0, 0, 1], port).into())
        .build()
        .unwrap();
    let root = format!("http://wisp.localhost:{port}");

    // out to GitHub, with state and PKCE, and the state in a cookie
    let r = c.get(format!("{root}/auth/github/start?return=/gallery")).send().await.unwrap();
    assert_eq!(r.status(), 302);
    let to = url::Url::parse(r.headers()["location"].to_str().unwrap()).unwrap();
    assert!(to.as_str().starts_with(&format!("{base}/login/oauth/authorize")), "{to}");
    let q: std::collections::HashMap<String, String> = to.query_pairs().into_owned().collect();
    assert_eq!(q["code_challenge_method"], "S256");
    let flow_cookie = r
        .headers()
        .get_all("set-cookie")
        .iter()
        .map(|v| v.to_str().unwrap().to_owned())
        .find(|c| c.starts_with("wisp_grid_oauth="))
        .unwrap();
    let flow = flow_cookie.split(';').next().unwrap().to_owned();

    // back without the cookie (another browser): refused, nothing signed in
    let r = c.get(format!("{root}/auth/github/callback?code=abc&state={}", q["state"])).send().await.unwrap();
    assert_eq!(r.status(), 400);
    assert!(!r.headers().get_all("set-cookie").iter().any(|v| v.to_str().unwrap().starts_with("wisp_grid=")));

    // back with it: a session, and the way to where it was going; the verifier went with the code
    let f = c.get(format!("{root}/auth/github/start?return=/gallery")).send().await.unwrap();
    let to = url::Url::parse(f.headers()["location"].to_str().unwrap()).unwrap();
    let state = to.query_pairs().find(|(k, _)| k == "state").unwrap().1.into_owned();
    let flow = f
        .headers()
        .get_all("set-cookie")
        .iter()
        .map(|v| v.to_str().unwrap().to_owned())
        .find(|c| c.starts_with("wisp_grid_oauth="))
        .map_or(flow, |c| c.split(';').next().unwrap().to_owned());
    let r = c.get(format!("{root}/auth/github/callback?code=abc&state={state}")).header("cookie", &flow).send().await.unwrap();
    assert_eq!(r.status(), 302, "{:?}", r.text().await);
    assert_eq!(r.headers()["location"], "/gallery");
    let session = r
        .headers()
        .get_all("set-cookie")
        .iter()
        .map(|v| v.to_str().unwrap().to_owned())
        .find(|c| c.starts_with("wisp_grid="))
        .expect("a session");
    assert!(seen.lock().unwrap().iter().any(|s| s.starts_with("/login/oauth/access_token") && s.contains("code_verifier")));
    let ada = grid.accounts.user_by_handle("ada").unwrap().expect("ada was made");
    assert_eq!(ada.email.as_deref(), Some("ada@example.com"));

    // the same state again: used up
    let again = c.get(format!("{root}/auth/github/callback?code=abc&state={state}")).header("cookie", &flow).send().await.unwrap();
    assert_eq!(again.status(), 400);

    // signed in, /signin goes straight on
    let r = c.get(format!("{root}/signin?return=/gallery")).header("cookie", session.split(';').next().unwrap()).send().await.unwrap();
    assert_eq!((r.status().as_u16(), r.headers()["location"].to_str().unwrap()), (302, "/gallery"));
    stop.cancel();
}
