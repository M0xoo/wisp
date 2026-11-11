//! `wisp-grid …` (v1 grid/cli.js, the parts ported so far):
//!
//! - `wisp-grid dev [--port N] [--data DIR] [--wisp PATH] [--idle-ms N]`: a grid on this machine for
//!   development, with `auth.dev` on (sign in by handle at `/auth/dev`) and boxes as `wisp serve`
//!   processes. Prints its URL, runs until Ctrl-C.
//!
//! - `wisp-grid serve [--data DIR]`: a real grid from `<data>/grid.json` (or `GRID_DATA`), behind Caddy: sign-in
//!   with its providers (GitHub, Google, OIDC), boxes as containers through boxd (`hostd.driver: "container"`,
//!   `hostd.container.boxd`: boxd's socket) or as processes here (`"process"`). Runs until SIGTERM or Ctrl-C.
use std::path::PathBuf;

/// The flag's value: `--port 8080` or `--port=8080`.
fn flag(args: &[String], name: &str) -> Option<String> {
    let eq = format!("{name}=");
    args.iter().enumerate().find_map(|(i, a)| if a == name { args.get(i + 1).cloned() } else { a.strip_prefix(&eq).map(str::to_owned) })
}

fn wisp_beside() -> PathBuf {
    let name = if cfg!(windows) { "wisp.exe" } else { "wisp" };
    std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.join(name))).filter(|p| p.is_file()).unwrap_or_else(|| PathBuf::from(name))
}

pub async fn main(args: Vec<String>) -> i32 {
    match args.first().map(String::as_str) {
        Some("dev") => {
            let port = flag(&args, "--port").and_then(|p| p.parse().ok()).unwrap_or(8080);
            let data = flag(&args, "--data").map_or_else(|| PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".wisp-grid-dev"), PathBuf::from);
            let bin = flag(&args, "--wisp").map_or_else(wisp_beside, PathBuf::from);
            let idle = flag(&args, "--idle-ms").and_then(|p| p.parse().ok()).unwrap_or(120_000);
            if let Err(e) = std::fs::create_dir_all(&data) {
                eprintln!("  ✗ {}: {e}", data.display());
                return 1;
            }
            // dev only: a fake harness and the web bundle for the boxes too, when set here
            let pass: Vec<(String, String)> = ["WISP_CLAUDE_BIN", "WISP_CODEX_BIN", "WISP_WEB_DIR"].iter().filter_map(|k| std::env::var(k).ok().map(|v| ((*k).to_owned(), v))).collect();
            match crate::edge::dev(&data, port, bin, pass, idle).await {
                Ok((grid, port, stop)) => {
                    eprintln!("\n  ◌ wisp Grid (dev) at http://wisp.localhost:{port}  ·  sign in at /auth/dev\n    sign in from wisp: wisp cloud signin http://wisp.localhost:{port}\n");
                    let _ = tokio::signal::ctrl_c().await;
                    stop.cancel();
                    grid.boxes.close_all().await;
                    0
                }
                Err(e) => {
                    eprintln!("  ✗ {e}");
                    1
                }
            }
        }
        Some("serve") => match serve(flag(&args, "--data").map(PathBuf::from)).await {
            Ok(()) => 0,
            Err(e) => {
                eprintln!("  ✗ wisp-grid serve: {e}");
                1
            }
        },
        _ => {
            eprintln!("wisp-grid dev [--port N] [--data DIR] [--wisp PATH] [--idle-ms N]\nwisp-grid serve [--data DIR]");
            2
        }
    }
}

/// The hostd options from the config: the container driver when it says so.
pub fn box_options(cfg: &crate::config::GridConfig) -> crate::Result<crate::hostd::ProcessOptions> {
    let h = &cfg.hostd;
    let boxd = match h.driver.as_str() {
        "container" => Some(h.container.as_ref().and_then(crate::boxd::Driver::of).ok_or_else(|| crate::GridError::Config("hostd.container.boxd: boxd's socket (the container driver runs boxes through wisp-grid-boxd).".into()))?),
        "process" => None,
        other => return Err(crate::GridError::Config(format!("hostd.driver: process or container (not {other})."))),
    };
    let url_cfg = cfg.clone();
    Ok(crate::hostd::ProcessOptions {
        bin: h.wisp_bin.as_ref().map_or_else(wisp_beside, PathBuf::from),
        data: cfg.data_dir.clone(),
        idle_ms: h.idle_ms,
        check_ms: h.check_ms,
        start_ms: h.start_ms,
        max_running: usize::try_from(h.max_running).unwrap_or(1).max(1),
        // the grid itself, for what a box asks of it (its channels' URLs, mail replies): v1 hostd.js `WISP_GRID_URL`
        env: std::iter::once(("WISP_GRID_URL".to_owned(), cfg.public_url.clone())).chain(h.env.iter().map(|(k, v)| (k.clone(), v.clone()))).collect(),
        url_of: std::sync::Arc::new(move |handle| url_cfg.instance_url(handle)),
        boxd,
    })
}

async fn serve(data: Option<PathBuf>) -> crate::Result<()> {
    let cfg = crate::config::load(crate::config::LoadOptions { data_dir: data, ..crate::config::LoadOptions::default() })?;
    let clock = crate::clock::system();
    let db = std::sync::Arc::new(crate::db::Db::open(&cfg.data_dir, clock.now_ms())?);
    let boxes = crate::hostd::ProcessHost::new(box_options(&cfg)?, clock.clone());
    let at = format!("{}:{}", cfg.listen.host, cfg.listen.port);
    let listener = tokio::net::TcpListener::bind(&at).await.map_err(|e| crate::bad(format!("can't listen on {at}: {e}"), 500))?;
    let providers: Vec<String> = cfg.auth.providers.keys().cloned().collect();
    eprintln!("  ◌ wisp Grid at {} (listening on {at}) · sign-in: {} · boxes: {}", cfg.public_url, if providers.is_empty() { "none set up (auth.providers)".to_owned() } else { providers.join(", ") }, cfg.hostd.driver);
    let grid = crate::edge::Grid::new(cfg, db, clock, boxes);
    let stop = tokio_util::sync::CancellationToken::new();
    let server = tokio::spawn(crate::edge::serve(grid.clone(), listener, stop.clone()));
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).map_err(|e| crate::bad(e.to_string(), 500))?;
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = term.recv() => {}
    }
    eprintln!("  ◌ stopping every box…");
    stop.cancel();
    grid.boxes.close_all().await;
    let _ = server.await;
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn serve_runs_boxes_through_boxd_when_the_config_says_container() {
        let dir = std::env::temp_dir().join(format!("wisp-grid-cli-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cfg = |hostd: serde_json::Value| crate::config::for_test(&dir, serde_json::json!({ "domain": "grid.test", "hostd": hostd }));
        let o = box_options(&cfg(serde_json::json!({ "driver": "container", "container": { "boxd": "/run/wisp-grid/box.sock", "memory": "2g" } })).unwrap()).unwrap();
        let d = o.boxd.unwrap();
        assert_eq!((d.socket.to_str(), d.limits["memory"].as_str()), (Some("/run/wisp-grid/box.sock"), Some("2g")));
        let e = cfg(serde_json::json!({ "driver": "container", "container": {} })).map_err(|e| e.to_string()).and_then(|c| box_options(&c).map(|_| ()).map_err(|e| e.to_string())).unwrap_err();
        assert!(e.contains("boxd"), "{e}");
        assert!(box_options(&cfg(serde_json::json!({ "driver": "process" })).unwrap()).unwrap().boxd.is_none());
    }
}
