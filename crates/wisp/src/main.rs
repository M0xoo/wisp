//! `wisp`: the one binary (ADR-0013). Parses the command line, then starts only what the command
//! needs: a scripted command talks to the running wisp, `serve` (and the default with nothing
//! running) runs the kernel and the edge here.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

mod args;
mod client;
mod commands;
mod desktop;
mod extras;
mod groups;
mod plugin_cmd;
mod scripted;
mod serve;
mod services;
mod settings_store;

use std::path::{Path, PathBuf};

use args::{Action, Parsed};
use client::{CliError, Client, Result};
use scripted::say;
use serde_json::{Value, json};

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let user_home = services::user_home().unwrap_or_else(|| PathBuf::from("."));
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let parsed = match args::parse(&argv, std::env::var("WISP_PORT").ok().as_deref(), &user_home, &cwd) {
        Ok(p) => p,
        Err(e) => die(&e.to_string()),
    };
    match parsed.action {
        Action::Version => return say(serve::VERSION),
        Action::Help => return say(args::HELP),
        Action::Run => {}
    }
    init_tracing();
    let rt = match tokio::runtime::Builder::new_multi_thread().worker_threads(worker_threads()).enable_all().build() {
        Ok(rt) => rt,
        Err(e) => die(&format!("runtime: {e}")),
    };
    let code = rt.block_on(run(parsed, &user_home, &cwd));
    rt.shutdown_timeout(std::time::Duration::from_secs(2));
    std::process::exit(code);
}

/// A dev tool shares the machine: a few workers are plenty (the blocking pool does compression).
fn worker_threads() -> usize {
    std::thread::available_parallelism().map_or(2, |n| n.get().clamp(2, 4))
}

fn init_tracing() {
    let filter = tracing_subscriber::EnvFilter::try_from_env("WISP_LOG").unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn"));
    let _ = tracing_subscriber::fmt().with_env_filter(filter).with_writer(std::io::stderr).try_init();
}

fn die(msg: &str) -> ! {
    eprintln!("  ✗ {msg}");
    std::process::exit(1)
}

async fn run(p: Parsed, user_home: &Path, cwd: &Path) -> i32 {
    match dispatch(&p, user_home, cwd).await {
        Ok(code) => code,
        Err(e) => {
            eprintln!("  ✗ {e}");
            1
        }
    }
}

async fn dispatch(p: &Parsed, user_home: &Path, cwd: &Path) -> Result<i32> {
    let home = services::home(std::env::var("WISP_HOME").ok().as_deref(), Some(user_home.to_owned()));
    let f = &p.flags;
    let cwd_s = f.cwd.clone().unwrap_or_else(|| cwd.to_owned()).display().to_string();
    // scripted commands go to the advertised wisp unless --port was given
    let port = if f.port_given { f.port } else { client::discover(&home).unwrap_or(f.port) };
    let rest = p.words.get(1..).unwrap_or_default();
    match p.command {
        Some("grid") => return extras::grid(&p.argv),
        Some("mcp") => extras::mcp()?,
        Some("skill") => extras::skill(p.words.get(1).map(String::as_str), f, user_home, cwd)?,
        Some("serve") => serve_here(&home, f.port, f.host.as_deref(), false, None).await?,
        Some("import") => extras::import(&home, f).await?,
        Some("desktop") => desktop(&home, f.port, true).await?,
        Some("plugin" | "plugins" | "spell" | "spells") if rest.first().map(String::as_str) == Some("new") => {
            let name = scripted::need(rest.get(1), "a plugin name")?;
            let dir = plugin_cmd::new_plugin(&home, name)?;
            say(&format!("  ✓ {}\n    edit wisp-plugin.json, then: wisp plugin enable user.{}", dir.display(), dir.file_name().map(|n| n.to_string_lossy()).unwrap_or_default()));
        }
        Some("add") => add(&home, port, p.words.get(1), cwd).await?,
        Some(cmd) => commands::run(p, cmd, rest, &cwd_s, port).await?,
        None if !p.words.is_empty() && (f.json || f.wait || !f.tries.is_empty()) => commands::run(p, "launch", &p.words, &cwd_s, port).await?,
        None if !p.words.is_empty() => launch_and_open(p, &home, port, &cwd_s).await?,
        None => open(&home, f.port, f.open, f.browser).await?,
    }
    Ok(0)
}

/// Runs wisp here until a signal; `open`: then show it in the browser at `path`.
async fn serve_here(home: &Path, port: u16, host: Option<&str>, open: bool, path: Option<&str>) -> Result<()> {
    let r = serve::boot(home, port, host).await?;
    let url = r.server.url();
    tracing::info!("listening at {url} after {} ms", r.started.elapsed().as_millis());
    eprintln!("\n  ◌ wisp is floating at {url}\n");
    if open {
        serve::open_url(&format!("{url}{}", path.unwrap_or("/")));
    }
    serve::until_signal(r).await;
    Ok(())
}

/// `wisp`: focus the running one, else the desktop window, else serve here and open a tab.
async fn open(home: &Path, port: u16, open: bool, browser: bool) -> Result<()> {
    let c = Client::new(port);
    if c.ping().await {
        if open {
            serve::open_url(&format!("{}/", c.url));
        }
        eprintln!("\n  ◌ wisp is open at {}\n", c.url);
        return Ok(());
    }
    if open && !browser && desktop(home, port, false).await.is_ok() {
        return Ok(());
    }
    serve_here(home, port, None, open, None).await
}

async fn desktop(home: &Path, port: u16, strict: bool) -> Result<()> {
    match desktop::shell(home, serve::VERSION).await {
        Ok(exe) => {
            desktop::launch(&exe, port)?;
            eprintln!("\n  ◌ wisp is open\n");
            Ok(())
        }
        Err(why) if strict => Err(CliError::said(desktop::no_app_line(&why))),
        Err(why) => {
            eprintln!("{}", desktop::no_app_line(&why));
            Err(CliError::said(why))
        }
    }
}

/// A repo URL is cloned by the server; a folder is added as it is.
async fn add(_home: &Path, port: u16, what: Option<&String>, cwd: &Path) -> Result<()> {
    let c = Client::connect(port, true).await?;
    let w = what.map_or("", String::as_str);
    let lower = w.to_ascii_lowercase();
    let url = ["https:", "http:", "ssh:", "git:", "git@", "github.com/", "www.github.com/"].iter().any(|p| lower.starts_with(p));
    let body = if url {
        eprintln!("  ◌ cloning {w}…");
        json!({"repo": w})
    } else {
        json!({"path": args::expand(if w.is_empty() { "." } else { w }, cwd, cwd).display().to_string()})
    };
    let p = c.post("/projects", body).await?;
    say(&format!("  ✓ project added: {}  ({})", p.get("name").and_then(Value::as_str).unwrap_or(""), p.get("path").and_then(Value::as_str).unwrap_or("")));
    Ok(())
}

/// `wisp "task"`: launched on the running wisp (one starts if none answers), then shown.
async fn launch_and_open(p: &Parsed, _home: &Path, port: u16, cwd: &str) -> Result<()> {
    let c = Client::connect(port, true).await?;
    let body = scripted::launch_body(&c, &p.flags, p.words.join(" "), cwd, None).await?;
    let s = c.post("/sessions", body).await?;
    say(&format!("  ◌ launched: {}", s.get("title").and_then(Value::as_str).unwrap_or("")));
    if p.flags.open {
        serve::open_url(&format!("{}/#/s/{}", c.url, s.get("id").and_then(Value::as_str).unwrap_or("")));
    }
    Ok(())
}
