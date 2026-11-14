//! wisp.terminal: terminals inside wisp (v1 server/pty.js, routes/workspace.js `/sessions/:id/shell`,
//! routes/sessions.js `/sessions/:id/term`). A terminal is a program on a PTY from the proc service,
//! one per task and kind (the task's shell, its take over). Its state follows the flow of plan §4.6.3
//! (`wisp_terminal_core::flow`): a STOP while it starts cancels the start, a slow start says so, an
//! ended one never reopens its dead screen. Its output is kept (the last 1 MB, so a page that opens
//! late sees the screen) and streamed to every page that watches it as v1's event stream; numbered
//! keys from a page go in in order.

mod proxy;
mod registry;

use std::sync::{Arc, OnceLock};

use serde_json::json;
use wisp_kernel::http::{Request, Response, Route};
use wisp_kernel::{Ctx, Manifest, Plugin, Result, Setup, WireError};
use wisp_proc::Proc;
use wisp_runtime_api::SessionId;
use wisp_runtime_api::commands as rt;
use wisp_telemetry_api as tel;
use wisp_terminal_api::commands as c;
use wisp_terminal_api::{ShellInfo, TermKind, TerminalApps};

use registry::Registry;

type Slot = Arc<OnceLock<Arc<Registry>>>;

fn reg(slot: &Slot) -> Result<Arc<Registry>> {
    slot.get().cloned().ok_or_else(|| WireError::unavailable("wisp.terminal is starting"))
}

/// `telemetry.track`: a usage event this plugin owns; logged when refused (it only reports).
async fn track(ctx: &Ctx, event: &str, props: serde_json::Value) {
    let props = match props {
        serde_json::Value::Object(m) => m,
        _ => serde_json::Map::new(),
    };
    if let Err(err) = ctx.run::<tel::Track>(&ctx.root_call(), tel::TrackArgs { event: event.into(), props }).await {
        tracing::warn!(error = %err.message, event, "terminal: telemetry.track");
    }
}

/// A task's shell: in its worktree when it has one, else its folder (v1 `shellDir`).
async fn task_dir(ctx: &Ctx, call: &wisp_kernel::Call, id: &str) -> Result<(String, String)> {
    let s = ctx.run::<rt::Get>(call, rt::IdArgs { id: SessionId(id.to_owned()) }).await?;
    let wt = s.ext_of("wisp.worktrees").get("path").and_then(|v| v.as_str()).unwrap_or("").to_owned();
    let cwd = s.cwd.clone();
    let home = std::env::var("HOME").unwrap_or_default();
    let dir = shell_dir(&wt, &cwd, &home).map_err(|e| WireError::invalid(format!("task {id} has no folder to open a shell in ({e})")))?;
    Ok((dir, s.agent))
}

/// The worktree, else the folder, else home; none of them (no folder and no `$HOME`) is no folder, never the
/// server's own (`""` would read its `package.json` and start the shell there).
fn shell_dir(wt: &str, cwd: &str, home: &str) -> std::result::Result<String, wisp_runtime_api::paths::NoFolder> {
    let full = |p: &str| wisp_runtime_api::paths::Folder::of(p).is_ok() && std::path::Path::new(p).is_dir();
    let f = wisp_terminal_core::folder::task_folder(wt, cwd, home, &full);
    wisp_runtime_api::paths::Folder::of(&f.dir).map(|d| d.to_string())
}

fn kind_of(req: &Request) -> TermKind {
    if req.path.ends_with("/term") {
        TermKind::Takeover
    } else if req.path.ends_with("/run") {
        TermKind::Run
    } else {
        TermKind::Shell
    }
}

/// A file in the task's folder, if it's there (the command to guess from).
async fn read_in(dir: &str, name: &str) -> Option<String> {
    tokio::fs::read_to_string(std::path::Path::new(dir).join(name)).await.ok()
}

/// The side panel's Preview before it runs: whether it runs, its port, its folder, a command to start from.
async fn run_info(ctx: &Ctx, call: &wisp_kernel::Call, r: &Registry, id: &str) -> Result<wisp_terminal_api::RunInfo> {
    let (dir, _) = task_dir(ctx, call, id).await?;
    let wt = read_in(&dir, ".wisp/worktree.json").await;
    let pkg = read_in(&dir, "package.json").await;
    let mut locks = Vec::new();
    for f in ["pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock"] {
        if tokio::fs::try_exists(std::path::Path::new(&dir).join(f)).await.unwrap_or(false) {
            locks.push(f);
        }
    }
    let guess = wisp_terminal_core::run::guess(wt.as_deref(), pkg.as_deref(), &|f| locks.contains(&f));
    let open = r.live(TermKind::Run, id);
    let proxy = (open && r.proxies.running(id)).then(|| wisp_terminal_core::pick::proxy_port_for(id));
    Ok(wisp_terminal_api::RunInfo { open, port: wisp_terminal_core::run::port_for(id), dir, guess, proxy })
}

/// Opens `argv` (a login shell when empty) in `cwd` in the terminal app Settings names (v1 POST /sessions/:id/open-shell,
/// routes/workspace.js openTerminal): the platform's plan from `wisp_terminal_core::plan`, each program started on its
/// own (never killed with wisp). Refused where no desktop is here: through a proxy, on a wisp Grid box, headless Linux.
async fn open_app(ctx: &Ctx, a: &c::OpenAppArgs) -> Result<c::Done> {
    use wisp_terminal_core::apps;
    let proc = ctx.service::<Proc>()?.as_ref().clone();
    let platform = apps::platform_name(std::env::consts::OS);
    let mut found: Vec<String> = Vec::new();
    for bin in apps::LINUX_ORDER.iter().copied().chain(["wt", "cmux"]) {
        if proc.which(bin, None).await.is_some() {
            found.push(bin.to_owned());
        }
    }
    let terminal = apps::chosen_app(ctx.setting("terminal").and_then(|v| v.as_str().map(str::to_owned)).as_deref());
    let custom = ctx.setting("terminal.command").and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default();
    let launches = plan_here(platform, &found, a, &terminal, &custom)?;
    let mut waited = 0;
    for x in launches {
        if x.after_ms > waited {
            tokio::time::sleep(std::time::Duration::from_millis(x.after_ms - waited)).await;
            waited = x.after_ms;
        }
        let opts = wisp_proc::SpawnOpts { cwd: Some(x.cwd.clone().into()), verbatim: x.verbatim, ..wisp_proc::SpawnOpts::default() };
        proc.spawn_detached(&x.bin, &x.args, opts).map_err(|e| WireError::invalid(format!("Couldn't open {terminal}: {e}")))?;
    }
    Ok(c::Done { ok: true })
}

/// The programs to start (sync: the lookups are plain closures, not held across an await).
fn plan_here(
    platform: &str,
    found: &[String],
    a: &c::OpenAppArgs,
    terminal: &str,
    custom: &str,
) -> Result<Vec<wisp_terminal_core::plan::Launch>> {
    use wisp_terminal_core::apps;
    let env = |k: &str| std::env::var(k).ok();
    let has = |b: &str| found.iter().any(|f| f == b);
    let exists = |p: &str| std::path::Path::new(p).exists();
    let l = apps::Lookups { platform, env: &env, has: &has, exists: &exists };
    if a.via_proxy || !apps::app_here(&l, a.via_proxy) {
        return Err(WireError::conflict("No terminal app on this computer for you here: open the Shell tab instead."));
    }
    // "" or a relative folder (`src`) would be the server's own folder's
    if wisp_runtime_api::paths::Folder::of(&a.cwd).is_err() || !std::path::Path::new(&a.cwd).is_dir() {
        return Err(WireError::invalid("That folder isn't on this computer."));
    }
    let argv =
        if a.argv.is_empty() { wisp_terminal_core::folder::shell_argv(std::env::var("SHELL").ok().as_deref()) } else { a.argv.clone() };
    let plan =
        wisp_terminal_core::plan::terminal_plan(wisp_terminal_core::plan::PlanArgs { cwd: &a.cwd, argv: &argv, terminal, custom }, &l)
            .map_err(|e| WireError::invalid(e.to_string()))?;
    Ok(wisp_terminal_core::plan::schedule(&plan, &a.cwd))
}

/// Runs the task's app in its folder on a PTY, `PORT` set (v1 POST /sessions/:id/run).
/// Whether the task's app is running, on its row (`ext["wisp.terminal"].run`): the row menu's Run app / Stop app (v1
/// panel.js runLabel) reads it. Best effort: a task that's gone has no row to mark.
pub(crate) async fn mark_run(ctx: &Ctx, call: &wisp_kernel::Call, id: &str, running: bool) {
    let port = wisp_terminal_core::run::port_for(id);
    let value = json!({ "run": { "running": running, "port": port } });
    // set-ext: whole the slot holds only `run`, set from the app's state now, never read back and merged
    let a = rt::SetExtArgs { id: SessionId(id.to_owned()), plugin: "wisp.terminal".into(), value, expect: None };
    if let Err(err) = ctx.run::<rt::SetExt>(call, a).await {
        tracing::warn!(error = %err.message, task = id, "terminal: runtime.setExt");
    }
}

async fn start_run(ctx: &Ctx, call: &wisp_kernel::Call, r: &Arc<Registry>, a: &c::RunStartArgs) -> Result<wisp_terminal_api::RunStarted> {
    let port = wisp_terminal_core::run::port_for(&a.id);
    if a.command.trim().is_empty() {
        return Err(WireError::invalid("Say what runs the app (npm run dev, …)."));
    }
    if cfg!(windows) {
        return Err(WireError::invalid(
            "Preview runs the app under a POSIX shell: it needs macOS or Linux on the computer the task runs on.",
        ));
    }
    if r.live(TermKind::Run, &a.id) && !a.restart {
        let proxy = r.proxies.running(&a.id).then(|| wisp_terminal_core::pick::proxy_port_for(&a.id));
        return Ok(wisp_terminal_api::RunStarted { ok: true, started: false, port, dir: String::new(), proxy });
    }
    if a.restart {
        r.close(TermKind::Run, &a.id).await;
    }
    let (dir, _) = task_dir(ctx, call, &a.id).await?;
    let mut argv = wisp_terminal_core::folder::shell_argv(std::env::var("SHELL").ok().as_deref());
    argv.truncate(1);
    argv.extend(["-lc".to_owned(), wisp_terminal_core::run::script(&a.command, port)]);
    // marked before it starts: an app that exits at once clears it after, never before (no stale "running")
    mark_run(ctx, call, &a.id, true).await;
    r.open(ctx, &c::OpenArgs { kind: TermKind::Run, id: a.id.clone(), argv, cwd: dir.clone(), cols: a.cols, rows: a.rows, tui: false });
    // Preview's proxy (ADR-0049): to the port the app prints, else its PORT; weak, so the registry isn't kept by it
    let weak = Arc::downgrade(r);
    let id = a.id.clone();
    let target: proxy::Target = Arc::new(move || weak.upgrade().and_then(|r| r.local_port(TermKind::Run, &id)).unwrap_or(port));
    let proxy = r.proxies.start(&a.id, target, &r.scope).await.then(|| wisp_terminal_core::pick::proxy_port_for(&a.id));
    Ok(wisp_terminal_api::RunStarted { ok: true, started: true, port, dir, proxy })
}

fn routes(s: &mut Setup, slot: &Slot) {
    for (method, pattern, summary) in [
        ("GET", "/sessions/:id/shell", "The task's shell, as an event stream (hello, data, exit)"),
        ("GET", "/sessions/:id/term", "The task's take over terminal, as an event stream"),
        ("GET", "/sessions/:id/run", "The task's running app's output (Preview), as an event stream"),
    ] {
        let sl = slot.clone();
        s.route(Route {
            method,
            pattern,
            permission: "terminal:read",
            doc: true,
            summary,
            raw: false,
            max_body: None,
            handler: Arc::new(move |_ctx, _call, req| {
                let sl = sl.clone();
                Box::pin(async move { Ok(reg(&sl)?.attach(kind_of(&req), req.param("id").unwrap_or_default())) })
            }),
        });
    }
    for pattern in ["/sessions/:id/shell", "/sessions/:id/term", "/sessions/:id/run"] {
        let sl = slot.clone();
        s.route(Route {
            method: "DELETE",
            pattern,
            permission: "terminal:close",
            doc: true,
            summary: "Hang the task's terminal up",
            raw: false,
            max_body: None,
            handler: Arc::new(move |_ctx, _call, req| {
                let sl = sl.clone();
                Box::pin(
                    async move { Response::ok(json!({ "ok": reg(&sl)?.close(kind_of(&req), req.param("id").unwrap_or_default()).await })) },
                )
            }),
        });
    }
    let sl = slot.clone();
    s.route(Route {
        method: "POST",
        pattern: "/sessions/:id/shell",
        permission: "terminal:shell",
        doc: true,
        summary: "Start the task's shell, or type into it and resize it (v1 body: data, seq, from, cols, rows, restart)",
        raw: false,
        max_body: None,
        handler: Arc::new(move |ctx, call, req| {
            let sl = sl.clone();
            Box::pin(async move {
                let id = req.param("id").unwrap_or_default().to_owned();
                let b: serde_json::Value = if req.body.is_empty() { json!({}) } else { req.json()? };
                let r = reg(&sl)?;
                if let Some(data) = b["data"].as_str() {
                    let order = wisp_terminal_api::InputOrder { seq: b["seq"].as_i64(), from: b["from"].as_str().map(str::to_owned) };
                    if !r.input(TermKind::Shell, &id, data, &order, &ctx) {
                        return Err(WireError::not_found("The shell has ended."));
                    }
                    r.resize(TermKind::Shell, &id, b["cols"].as_f64(), b["rows"].as_f64());
                    return Response::ok(json!({ "ok": true }));
                }
                let out =
                    start_shell(&ctx, &call, &r, &id, b["cols"].as_f64(), b["rows"].as_f64(), b["restart"].as_bool().unwrap_or(false))
                        .await?;
                Response::ok(out)
            })
        }),
    });
}

async fn start_shell(
    ctx: &Ctx,
    call: &wisp_kernel::Call,
    r: &Registry,
    id: &str,
    cols: Option<f64>,
    rows: Option<f64>,
    restart: bool,
) -> Result<wisp_terminal_api::ShellStarted> {
    if r.live(TermKind::Shell, id) && !restart {
        r.resize(TermKind::Shell, id, cols, rows);
        return Ok(wisp_terminal_api::ShellStarted { ok: true, started: false, dir: None, gone: None });
    }
    if cfg!(windows) {
        return Err(WireError::invalid("A shell inside wisp needs macOS or Linux on the computer the task runs on."));
    }
    if restart {
        r.close(TermKind::Shell, id).await;
    }
    let (dir, agent) = task_dir(ctx, call, id).await?;
    let argv = wisp_terminal_core::folder::shell_argv(std::env::var("SHELL").ok().as_deref());
    r.open(ctx, &c::OpenArgs { kind: TermKind::Shell, id: id.to_owned(), argv, cwd: dir.clone(), cols, rows, tui: false });
    track(ctx, "shell", json!({ "agent": agent })).await;
    Ok(wisp_terminal_api::ShellStarted { ok: true, started: true, dir: Some(dir), gone: Some(false) })
}

macro_rules! on {
    ($s:ident, $slot:ident, $C:ty, |$r:ident, $ctx:ident, $call:ident, $a:ident| $body:expr) => {{
        let slot = $slot.clone();
        $s.command::<$C, _, _>(move |$ctx, $call, $a| {
            let slot = slot.clone();
            async move {
                let $r = reg(&slot)?;
                let _ = (&$call, &$ctx);
                $body
            }
        });
    }};
}

/// Settings → General's Take over in list for this computer (`terminal.apps`): the platform's terminal apps, only
/// "In wisp" on a wisp Grid box (no desktop there), and the default a fresh setting starts with.
fn apps_here(os: &str, env: &dyn Fn(&str) -> Option<String>) -> TerminalApps {
    let platform = wisp_terminal_core::apps::platform_name(os);
    let l = wisp_terminal_core::apps::Lookups { platform, env, has: &|_| false, exists: &|_| false };
    TerminalApps {
        terminals: wisp_terminal_core::apps::terminals_here(&l),
        default_terminal: wisp_terminal_core::apps::default_terminal(platform).to_owned(),
    }
}

#[derive(Debug, Default)]
pub struct TerminalPlugin;

impl Plugin for TerminalPlugin {
    fn manifest(&self) -> Manifest {
        Manifest::embedded(include_str!("../wisp-plugin.json"))
    }

    fn setup(&self, s: &mut Setup) -> Result<()> {
        let slot: Slot = Arc::new(OnceLock::new());
        on!(s, slot, c::Open, |r, ctx, call, a| {
            let out = r.open(&ctx, &a);
            if a.kind == TermKind::Takeover {
                // v1 proxy.js / takeover: the harness opened in wisp's own terminal (Open in <harness>)
                track(&ctx, "takeover", json!({ "terminal": "wisp", "machine": false })).await;
            }
            Ok(out)
        });
        on!(s, slot, c::Get, |r, ctx, call, a| Ok(r.info(a.kind, &a.id)));
        on!(s, slot, c::Close, |r, ctx, call, a| {
            let ok = r.close(a.kind, &a.id).await;
            if a.kind == TermKind::Run {
                r.proxies.stop(&a.id); // the app stopped: so does its proxy
                mark_run(&ctx, &call, &a.id, false).await;
            }
            if ok {
                // hung up: forgotten, and whoever owns the task hears it ended
                ctx.emit(
                    &call,
                    &wisp_terminal_api::Changed {
                        kind: a.kind,
                        id: a.id.clone(),
                        state: wisp_terminal_api::TermState::Ended,
                        code: None,
                        gone: true,
                    },
                );
            }
            Ok(c::Done { ok })
        });
        on!(s, slot, c::Input, |r, ctx, call, a| {
            let mut ok = true;
            if let Some(d) = a.data.as_deref() {
                ok = r.input(a.kind, &a.id, d, &wisp_terminal_api::InputOrder { seq: a.seq, from: a.from.clone() }, &ctx);
            }
            Ok(c::Done { ok: r.resize(a.kind, &a.id, a.cols, a.rows) || ok })
        });
        on!(s, slot, c::ShellStart, |r, ctx, call, a| start_shell(&ctx, &call, &r, &a.id, a.cols, a.rows, a.restart).await);
        on!(s, slot, c::ShellInfoOf, |r, ctx, call, a| {
            let shell = std::env::var("SHELL").ok();
            Ok(ShellInfo {
                supported: !cfg!(windows),
                open: r.live(TermKind::Shell, &a.id),
                app: !a.via_proxy && cfg!(target_os = "macos"),
                name: wisp_terminal_core::folder::shell_name(shell.as_deref()),
            })
        });
        s.command::<c::OpenApp, _, _>(|ctx, _call, a| async move { open_app(&ctx, &a).await });
        on!(s, slot, c::RunStart, |r, ctx, call, a| start_run(&ctx, &call, &r, &a).await);
        on!(s, slot, c::RunInfoOf, |r, ctx, call, a| run_info(&ctx, &call, &r, &a.id).await);
        s.command::<c::Apps, _, _>(|_ctx, _call, _a| async move { Ok(apps_here(std::env::consts::OS, &|k| std::env::var(k).ok())) });
        routes(s, &slot);
        let start = slot;
        s.on_start(move |ctx| async move {
            let proc = ctx.service::<Proc>()?.as_ref().clone();
            let _ = start.set(Arc::new(Registry::new(proc, ctx.scope().clone())));
            Ok(())
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_lists_this_computers_terminal_apps_and_only_in_wisp_on_a_grid_box() {
        let mac = apps_here("macos", &|_| None);
        let ids: Vec<&str> = mac.terminals.iter().map(|t| t.id.as_str()).collect();
        assert!(ids.contains(&"terminal") && ids.contains(&"iterm") && ids.contains(&"wisp"), "{ids:?}");
        assert_eq!(mac.default_terminal, "wisp");
        let win = apps_here("windows", &|_| None);
        assert!(win.terminals.iter().any(|t| t.id == "wt") && !win.terminals.iter().any(|t| t.id == "wisp"));
        assert_eq!(win.default_terminal, "auto");
        let grid = apps_here("linux", &|k| (k == "WISP_GRID_URL").then(|| "https://grid.example".to_owned()));
        assert_eq!(grid.terminals.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), ["wisp"]);
    }

    #[test]
    fn open_in_terminal_app_plans_the_chosen_app_in_the_folder_and_refuses_a_missing_one_or_a_proxy() {
        let dir = std::env::temp_dir();
        let cwd = dir.to_string_lossy().into_owned();
        let a = c::OpenAppArgs { cwd: cwd.clone(), argv: vec!["claude".into(), "--resume".into(), "x1".into()], via_proxy: false };
        let got = plan_here("darwin", &[], &a, "terminal", "").unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].bin, "osascript");
        assert!(
            got[0].args[1].contains("tell application \"Terminal\"") && got[0].args[1].contains("'claude' '--resume' 'x1'"),
            "{:?}",
            got[0].args
        );
        assert!(
            plan_here("darwin", &[], &c::OpenAppArgs { via_proxy: true, ..a.clone() }, "terminal", "").is_err(),
            "through a proxy there's no app for you"
        );
        assert!(
            plan_here("darwin", &[], &c::OpenAppArgs { cwd: format!("{cwd}/no-such-folder-wisp"), ..a.clone() }, "terminal", "").is_err()
        );
        // the test runs in the crate's folder, which has a `src`: a relative folder is never it
        for bad in ["", "src", "."] {
            assert!(plan_here("darwin", &[], &c::OpenAppArgs { cwd: bad.into(), ..a.clone() }, "terminal", "").is_err(), "{bad:?}");
        }
        let empty = plan_here("darwin", &[], &c::OpenAppArgs { argv: vec![], ..a }, "terminal", "").unwrap();
        assert!(empty[0].args[1].contains("'-l'"), "no command: a login shell in the folder");
    }

    #[test]
    fn manifest_is_valid() {
        assert_eq!(TerminalPlugin.manifest().id, "wisp.terminal");
    }

    /// A task's shell is never started in the server's own folder: no folder and no `$HOME` is refused, and a
    /// relative worktree or folder (`src`, which is in the crate's folder the test runs in) is skipped.
    #[test]
    fn a_tasks_shell_folder_is_never_the_servers_own() {
        let home = std::env::temp_dir().to_string_lossy().into_owned();
        assert_eq!(shell_dir("", "", &home).unwrap(), home);
        assert_eq!(shell_dir("src", "src", &home).unwrap(), home, "relative: home, not the server's src");
        assert_eq!(shell_dir("", &home, "").unwrap(), home);
        assert!(shell_dir("", "", "").is_err(), "nothing: refused");
        assert!(shell_dir("src", "", "").is_err());
    }
}
