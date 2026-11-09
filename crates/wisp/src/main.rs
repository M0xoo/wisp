//! `wisp`: the one binary (ADR-0013). Parses the command line, then starts only what the command
//! needs: a scripted command talks to the running wisp, `serve` (and the default with nothing
//! running) runs the kernel and the edge here.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

mod args;
mod attach;
mod cli;
mod client;
mod cloud_cli;
mod code;
mod commands;
mod desktop;
mod events_cli;
mod trigger_cli;
mod extras;
mod folder;
mod repo_cli;
mod groups;
mod history_cli;
mod plugin_cmd;
mod scripted;
mod serve;
mod services;
mod settings_store;
mod share_cli;
mod tasks_cli;
mod v1_formula;

use std::io::IsTerminal;
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
    // `--on <machine>`: every command from here runs on that peer (ADR-0041)
    if let Some(m) = &f.on {
        client::set_on(m);
    }
    let rest = p.words.get(1..).unwrap_or_default();
    // a task this terminal left running that finished, asks or failed: one line before anything else
    if !matches!(p.command, Some("serve" | "mcp" | "grid" | "desktop" | "completions")) && Client::new(port).ping().await {
        attach::notices(&Client::new(port), &home).await;
    }
    if let Some(code) = as_code(p, port, f.cwd.as_deref().unwrap_or(cwd), &home).await? {
        return Ok(code);
    }
    if let Some(code) = live(p, &home, port).await? {
        return Ok(code);
    }
    if f.help {
        say(args::HELP);
        return Ok(0);
    }
    match p.command {
        Some("grid") => return extras::grid(&p.argv),
        Some("mcp") => return repo_cli::mcp(&p.argv, cwd, port).await,
        Some("skill") => {
            extras::skill(p.words.get(1).map(String::as_str), f, user_home, cwd)?;
            if p.words.get(1).map(String::as_str) == Some("install") {
                return repo_cli::skill_install(&p.argv, cwd);
            }
        }
        Some("serve") => serve_here(&home, f.port, f.host.as_deref(), false, None).await?,
        Some("desktop") => desktop(&home, f.port, true).await?,
        Some("plugin" | "plugins") if rest.first().map(String::as_str) == Some("new") => {
            let name = scripted::need(rest.get(1), "a plugin name")?;
            let dir = plugin_cmd::new_plugin(&home, name)?;
            say(&format!("  ✓ {}\n    edit wisp-plugin.json, then: wisp plugin enable user.{}", dir.display(), dir.file_name().map(|n| n.to_string_lossy()).unwrap_or_default()));
        }
        Some("add") => add(&home, port, p.words.get(1), cwd).await?,
        Some(cmd) => commands::run(p, cmd, rest, &cwd_s, port).await?,
        None if !p.words.is_empty() && (f.json || f.wait || !f.tries.is_empty() || f.compare.is_some()) => commands::run(p, "launch", &p.words, &cwd_s, port).await?,
        None if !p.words.is_empty() => return launch_and_open(p, &home, port, &cwd_s).await,
        None => open(&home, f.port, f.open, f.browser).await?,
    }
    Ok(0)
}

/// Whether `word` could be a plugin's first word (`crew`, `runtime`, `grid-client`).
fn plugin_word(word: &str) -> bool {
    word.len() <= 32 && word.bytes().next().is_some_and(|b| b.is_ascii_lowercase()) && word.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
}

/// The commands that follow a topic or read the catalogue (ADR-0022); None: not one of them.
/// wisp as code (ADR-0026, ADR-0027): apply, diff, validate, schema, export; task spec/export/formula,
/// rerun, run -f, run <workflow|task>. None: the words aren't one of them.
async fn as_code(p: &Parsed, port: u16, cwd: &Path, home: &Path) -> Result<Option<i32>> {
    let words = &p.words;
    let Some(first) = words.first().map(String::as_str) else { return Ok(None) };
    if p.literal == args::Literal::Task {
        return Ok(None);
    }
    let start = p.argv.iter().position(|a| a == first).map_or(0, |i| i + 1);
    let o = code::opts(&p.argv[start.min(p.argv.len())..]);
    let o = code::Opts { json: o.json || p.flags.json, yes: o.yes || p.flags.yes, dry_run: o.dry_run || p.flags.dry_run, wait: o.wait || p.flags.wait, ..o };
    let connect = || Client::connect(port, true);
    let code = match first {
        "apply" | "diff" | "validate" | "plan" | "destroy" if !o.files.is_empty() || folder::folder(&o, cwd).is_some() => code::apply(&connect().await?, first, &o, cwd).await?,
        "init" if o.words.len() <= 1 => folder::init(cwd, &o)?,
        "track" if o.words.len() == 1 => repo_cli::track(&connect().await?, &o, cwd).await?,
        "untrack" if o.words.len() == 1 => repo_cli::untrack_cmd(Client::connect(port, false).await.ok().as_ref(), &o, cwd).await?,
        "blame" if o.words.len() == 1 => repo_cli::blame_any(Client::connect(port, false).await.ok().as_ref(), &o, cwd).await?,
        "log" if o.words.len() <= 1 => repo_cli::log(&p.argv, &o, cwd)?,
        "tasks" if p.argv.iter().any(|a| a == "--touching" || a == "--tracked") => repo_cli::log(&p.argv, &code::Opts { words: Vec::new(), ..o.clone() }, cwd)?,
        "ls" | "list" if p.argv.iter().any(|a| a == "--repo") => repo_cli::log(&p.argv, &code::Opts { words: Vec::new(), ..o.clone() }, cwd)?,
        "resume" if o.words.len() == 1 => repo_cli::resume(&connect().await?, &o, cwd).await?,
        "adopt" => repo_cli::adopt(&connect().await?, &p.argv, &o, cwd).await?,
        "fmt" if o.words.is_empty() => folder::fmt_cmd(&o, cwd)?,
        "workspace" => folder::workspace_cmd(&folder::folder(&o, cwd).unwrap_or_else(|| cwd.join(".wisp")), &o.words)?,
        "output" | "graph" | "mv" if folder::folder(&o, cwd).is_some() => {
            let c = connect().await?;
            let ks = code::kinds(&c).await?;
            let dir = folder::folder(&o, cwd).unwrap_or_default();
            let cfg = folder::config(&o, &ks, &dir)?;
            match first {
                "output" => folder::output(&cfg, &o),
                "graph" => folder::graph(&cfg),
                _ => match o.words.as_slice() {
                    [from, to] => {
                        let (stored, kind) = folder::stored_name(&cfg, from).ok_or_else(|| CliError::said(format!("{from} isn't declared here")))?;
                        if folder::stored_name(&cfg, to).is_some() {
                            return Err(CliError::said(format!("{to} is declared already")));
                        }
                        let new_name = format!("{}{}", stored.strip_suffix(from.split_once('.').map_or("", |(_, n)| n)).unwrap_or_default(), to.split_once('.').map_or("", |(_, n)| n));
                        let has = c.cmd("resources.export", serde_json::json!({ "kinds": [kind] })).await.is_ok_and(|l| l.as_array().is_some_and(|a| a.iter().any(|r| r["name"] == stored.as_str())));
                        if has {
                            c.cmd("resources.rename", serde_json::json!({ "kind": kind, "from": stored, "to": new_name })).await?;
                        }
                        let n = folder::mv(&dir, &cfg, from, to)?;
                        scripted::say(&format!("  ✓ {from} → {to} in {n} file{}{}", if n == 1 { "" } else { "s" }, if has { " and in wisp" } else { "" }));
                        0
                    }
                    _ => return Err(CliError::said("wisp mv <kind>.<name> <kind>.<new name>")),
                },
            }
        }
        "import" if o.words.len() == 1 && o.words[0].contains('.') && !o.words[0].contains('/') && !o.words[0].starts_with('.') => {
            let c = connect().await?;
            let ks = code::kinds(&c).await?;
            folder::import_address(&c, &ks, &folder::folder(&o, cwd).unwrap_or_else(|| cwd.join(".wisp")), &o.words[0]).await?
        }
        "schema" if o.words.is_empty() => code::schema(&connect().await?).await?,
        "export" if o.words.iter().any(|w| w.contains('.')) && o.words.iter().all(|w| !w.contains(' ')) => code::export_cmd(&connect().await?, &o).await?,
        "export" if o.words.iter().all(|w| w.bytes().all(|b| b.is_ascii_lowercase() || b == b'-')) => {
            let c = connect().await?;
            if !code::kind_words(&o.words, &code::kinds(&c).await?) {
                return Ok(None);
            }
            code::export_cmd(&c, &o).await?
        }
        "task" if matches!(o.words.first().map(String::as_str), Some("spec" | "export" | "formula" | "setup")) && o.words.len() >= 2 => tasks_cli::task(&connect().await?, &o).await?,
        "task" if o.words.first().map(String::as_str) == Some("history") && o.words.len() == 2 => history_cli::task_history(&connect().await?, &o.words[1], o.json).await?,
        "ls" | "list" if history_cli::wants_history(&o) && !p.flags.watch => history_cli::ls(&connect().await?, &o, cwd).await?,
        "history" if o.words.first().map(String::as_str) == Some("export") => history_cli::export(&connect().await?, &o, cwd).await?,
        "import" if o.words.len() <= 1 => history_cli::import(&connect().await?, &o, home).await?,
        "share" if o.words.len() == 1 && args::session_id(&o.words[0]) => share_cli::share(&connect().await?, &o, cwd).await?,
        "share" if o.words.len() == 1 && o.words[0].split_once('.').is_some_and(|(k, n)| !k.is_empty() && !n.is_empty() && !n.contains(' ')) => cloud_cli::share_setup(&connect().await?, &o).await?,
        "events" if matches!(o.words.first().map(String::as_str), None | Some("tail" | "why" | "retry" | "parked" | "ls")) => events_cli::run(&connect().await?, &p.argv, o.json).await?,
        "trigger" | "triggers" if matches!(o.words.first().map(String::as_str), None | Some("add" | "ls" | "list" | "rm" | "remove" | "fire" | "test" | "log" | "resume" | "approve" | "sources")) => trigger_cli::run(&connect().await?, p, first, &cwd.display().to_string()).await?,
        "crew" if matches!(o.words.first().map(String::as_str), Some("wake" | "graph")) => trigger_cli::run(&connect().await?, p, "crew", &cwd.display().to_string()).await?,
        "shares" if o.words.is_empty() => cloud_cli::shares(&connect().await?, &o).await?,
        "cloud" if o.words.len() <= 2 && matches!(o.words.first().map(String::as_str), None | Some("signin" | "login" | "signout" | "logout" | "status")) => cloud_cli::cloud(&connect().await?, &o).await?,
        "computer" if o.words.len() <= 1 && matches!(o.words.first().map(String::as_str), None | Some("on" | "off" | "status")) => cloud_cli::computer(&connect().await?, &o).await?,
        // `wisp grid deploy -f <file> [--on <box>]`: the formula applied on a box (the cloud box by default)
        "grid" if o.words.first().map(String::as_str) == Some("deploy") && !o.files.is_empty() => grid_deploy(port, p.flags.on.is_some(), o, cwd).await?,
        "open" if o.words.len() == 1 && cloud_cli::is_link(&o.words[0]) => cloud_cli::open_link(&connect().await?, &o, cwd).await?,
        "open" if o.words.len() == 1 && (o.words[0].ends_with(".wisp-task") || o.words[0].starts_with("http") || o.words[0].starts_with("gist:")) => share_cli::open(&connect().await?, &o, cwd).await?,
        "open" if o.words.len() == 1 => repo_cli::open_task(&connect().await?, &p.argv, &o, cwd).await?,
        "rerun" if (o.words.len() == 1 && args::session_id(&o.words[0])) || o.last.is_some() => {
            let o = code::Opts { words: std::iter::once("rerun".to_owned()).chain(o.words.clone()).collect(), ..o };
            tasks_cli::rerun(&connect().await?, &o, cwd).await?
        }
        "run" if !o.files.is_empty() => tasks_cli::run_file(&connect().await?, &o, cwd).await?,
        "run" if !o.formulas.is_empty() && !o.words.is_empty() => tasks_cli::run_overlay(&connect().await?, &o, cwd).await?,
        "run" if !o.words.is_empty() => match tasks_cli::run_named(&connect().await?, &o.words, &o).await? {
            Some(code) => code,
            None => return Ok(None),
        },
        _ => return Ok(None),
    };
    Ok(Some(code))
}

/// `wisp grid deploy -f <file> [--on <box>]`: the formula applied on a box (the cloud box by default).
async fn grid_deploy(port: u16, named: bool, o: code::Opts, cwd: &Path) -> Result<i32> {
    if !named {
        let status = Client::connect(port, true).await?.cmd("grid-client.status", json!({})).await?;
        let machine = status.get("machine").and_then(Value::as_str).unwrap_or_default();
        if machine.is_empty() {
            return Err(CliError::said("not signed in to wisp Cloud: wisp cloud signin (or name the box: --on <machine>)"));
        }
        client::set_on(machine);
    }
    let o = code::Opts { words: Vec::new(), ..o };
    code::apply(&Client::connect(port, true).await?, "apply", &o, cwd).await
}

async fn live(p: &Parsed, home: &Path, port: u16) -> Result<Option<i32>> {
    let f = &p.flags;
    let words = &p.words;
    let tty = std::io::stdin().is_terminal() && std::io::stdout().is_terminal();
    let code = match p.command {
        Some("attach") => {
            let c = Client::connect(port, true).await?;
            let id = scripted::need(words.get(1), "session id")?;
            attach::attach(&c, home, id, attach::Mode { interactive: tty, until_idle: !tty, fresh: false }).await?
        }
        Some("show") if f.watch => {
            let c = Client::connect(port, true).await?;
            let id = scripted::need(words.get(1), "session id")?;
            attach::attach(&c, home, id, attach::Mode { interactive: false, until_idle: true, fresh: false }).await?
        }
        Some("ls" | "list") if f.watch => attach::ls_watch(&Client::connect(port, true).await?, f.all).await?,
        Some("help") => {
            let c = Client::connect(port, true).await?;
            cli::help(&cli::catalogue(&c, home).await?, words)
        }
        Some("completions") => {
            let c = Client::connect(port, true).await?;
            cli::completions(&cli::catalogue(&c, home).await?, words.get(1))
        }
        // `wisp <plugin> <verb> …`: a command of the catalogue, else (it names none) a task
        None if p.literal != args::Literal::Task && words.first().is_some_and(|w| plugin_word(w)) && words.len() >= 2 => {
            let c = Client::connect(port, true).await?;
            let cat = cli::catalogue(&c, home).await?;
            match cli::generated(&c, &cat, words, &p.argv).await? {
                Some(code) => code,
                None => return Ok(None),
            }
        }
        _ => return Ok(None),
    };
    Ok(Some(code))
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

/// `wisp add [path|repo URL]`: a `project` resource (a URL is cloned here first, through git).
async fn add(_home: &Path, port: u16, what: Option<&String>, cwd: &Path) -> Result<()> {
    let c = Client::connect(port, true).await?;
    let w = what.map_or("", String::as_str);
    let lower = w.to_ascii_lowercase();
    let url = ["https:", "http:", "ssh:", "git:", "git@", "github.com/", "www.github.com/"].iter().any(|p| lower.starts_with(p));
    let path = if url {
        eprintln!("  ◌ cloning {w}…");
        let cloned = c.cmd("git.clone", json!({ "url": w, "parent": cwd.display().to_string() })).await?;
        cloned.get("dir").and_then(Value::as_str).unwrap_or_default().to_owned()
    } else {
        args::expand(if w.is_empty() { "." } else { w }, cwd, cwd).display().to_string()
    };
    let name = Path::new(&path).file_name().map_or_else(|| "project".into(), |n| n.to_string_lossy().to_lowercase().replace(' ', "-"));
    c.cmd("resources.apply", json!({ "resources": [{ "kind": "project", "name": name, "spec": { "path": path } }] })).await?;
    say(&format!("  ✓ project added: {name}  ({path})"));
    Ok(())
}

/// `wisp "task"`: launched on the running wisp (one starts if none answers). In a terminal it stays
/// attached (the run live, then a reply box); `-d`, or no terminal, returns with its id.
async fn launch_and_open(p: &Parsed, home: &Path, port: u16, cwd: &str) -> Result<i32> {
    let c = Client::connect(port, true).await?;
    let made = c.cmd("runtime.create", scripted::launch_args(&p.flags, &p.words.join(" "), cwd)).await?;
    let id = made.get("id").and_then(Value::as_str).unwrap_or("").to_owned();
    let title = c.cmd("runtime.get", json!({ "id": id })).await.ok().and_then(|t| t.get("title").and_then(Value::as_str).map(str::to_owned)).unwrap_or_default();
    let tty = std::io::stdin().is_terminal() && std::io::stdout().is_terminal();
    if tty && !p.flags.detach && !id.is_empty() {
        let st = cli::style();
        say(&format!("{} {}  {}", wisp_cli_core::term::paint(&st, wisp_cli_core::term::BLUE, "◌"), wisp_cli_core::term::bold(&st, &title), wisp_cli_core::term::dim(&st, &id)));
        return attach::attach(&c, home, &id, attach::Mode { interactive: true, until_idle: false, fresh: true }).await;
    }
    say(&format!("  ◌ launched: {title}  ({id})\n    wisp attach {id}"));
    attach::remember(home, &id, &title);
    Ok(0)
}
