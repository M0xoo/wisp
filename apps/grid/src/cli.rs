//! `wisp-grid …` (v1 grid/cli.js, the parts ported so far):
//!
//! - `wisp-grid dev [--port N] [--data DIR] [--wisp PATH] [--idle-ms N]`: a grid on this machine for
//!   development, with `auth.dev` on (sign in by handle at `/auth/dev`) and boxes as `wisp serve`
//!   processes. Prints its URL, runs until Ctrl-C.
//!
//! `serve` (a real grid, with providers and Caddy in front) waits for `auth/providers` and the container
//! driver to be ported; until then it says so.
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
            match crate::edge::dev(&data, port, bin, Vec::new(), idle).await {
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
        Some("serve") => {
            eprintln!("  ✗ wisp-grid serve: a production grid (providers, containers) isn't ported to v2 yet; use wisp-grid dev");
            1
        }
        _ => {
            eprintln!("wisp-grid dev [--port N] [--data DIR] [--wisp PATH] [--idle-ms N]");
            2
        }
    }
}
