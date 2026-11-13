//! The grid's side of a computer's tunnel (ADR-0010): a computer that dials again replaces its old tunnel,
//! and requests go to the new one.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::time::{Duration, Instant};

use bytes::Bytes;
use http_body_util::Full;
use hyper_util::rt::{TokioExecutor, TokioIo};
use wisp_grid::accounts::Poll;

/// A computer holding a tunnel that answers every request with `who`. Resolves when it's up.
async fn computer(port: u16, id: &str, token: &str, who: &'static str) -> tokio::task::JoinHandle<()> {
    let c = reqwest::Client::builder().http1_only().no_proxy().resolve("wisp.localhost", ([127, 0, 0, 1], port).into()).build().unwrap();
    let r = c
        .get(format!("http://wisp.localhost:{port}/api/computers/{id}/tunnel"))
        .header("connection", "Upgrade")
        .header("upgrade", "wisp-tunnel")
        .bearer_auth(token)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 101);
    let up = r.upgrade().await.unwrap();
    tokio::spawn(async move {
        let svc = hyper::service::service_fn(move |_req| async move {
            Ok::<_, std::convert::Infallible>(http::Response::new(Full::new(Bytes::from_static(who.as_bytes()))))
        });
        let _ = hyper::server::conn::http2::Builder::new(TokioExecutor::new()).serve_connection(TokioIo::new(up), svc).await;
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn a_new_tunnel_for_the_same_computer_wins() {
    let dir = std::env::temp_dir().join(format!("wisp-grid-tunnel-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let (g, port, stop) = wisp_grid::edge::dev(&dir, 0, "wisp".into(), Vec::new(), 600_000).await.unwrap();
    let ada = g.accounts.dev_user("ada").unwrap();
    let code = g.accounts.device_code("studio").unwrap();
    g.accounts.decide(code["user_code"].as_str().unwrap(), &ada.id, true).unwrap();
    let Poll::Token { token, .. } = g.accounts.poll(code["device_code"].as_str().unwrap()).unwrap() else { panic!("no token") };
    let (_, dev) = g.accounts.device(&token).unwrap().unwrap();
    let c = g.accounts.add_computer(&ada, &dev, "studio").unwrap();
    let ask = |label: String| {
        let token = token.clone();
        async move {
            let w = reqwest::Client::builder()
                .no_proxy()
                .resolve(&format!("{label}.wisp.localhost"), ([127, 0, 0, 1], port).into())
                .build()
                .unwrap();
            let r = w.get(format!("http://{label}.wisp.localhost:{port}/")).bearer_auth(token).send().await.unwrap();
            (r.status().as_u16(), r.text().await.unwrap())
        }
    };
    assert_eq!(ask(c.label.clone()).await.0, 503, "offline before it dials");
    let first = computer(port, &c.id, &token, "one").await;
    let at = Instant::now();
    while !g.tunnels.online(&c.id) {
        assert!(at.elapsed() < Duration::from_secs(5));
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(ask(c.label.clone()).await, (200, "one".to_owned()));
    let _second = computer(port, &c.id, &token, "two").await;
    let at = Instant::now();
    loop {
        if ask(c.label.clone()).await == (200, "two".to_owned()) {
            break;
        }
        assert!(at.elapsed() < Duration::from_secs(5), "the new tunnel never took over");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(g.tunnels.count(), 1);
    // a device that isn't this computer's can't hold its tunnel
    let other =
        reqwest::Client::builder().http1_only().no_proxy().resolve("wisp.localhost", ([127, 0, 0, 1], port).into()).build().unwrap();
    let r = other
        .get(format!("http://wisp.localhost:{port}/api/computers/{}/tunnel", c.id))
        .header("connection", "Upgrade")
        .header("upgrade", "wisp-tunnel")
        .bearer_auth("wgd_nope")
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 401);
    first.abort();
    stop.cancel();
    let _ = std::fs::remove_dir_all(&dir);
}
