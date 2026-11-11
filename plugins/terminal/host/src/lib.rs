//! wisp.terminal: terminals inside wisp (v1 server/pty.js, routes/workspace.js `/sessions/:id/shell`,
//! routes/sessions.js `/sessions/:id/term`). A terminal is a program on a PTY from the proc service,
//! one per task and kind (the task's shell, its take over). Its state follows the flow of plan §4.6.3
//! (`wisp_terminal_core::flow`): a STOP while it starts cancels the start, a slow start says so, an
//! ended one never reopens its dead screen. Its output is kept (the last 1 MB, so a page that opens
//! late sees the screen) and streamed to every page that watches it as v1's event stream; numbered
//! keys from a page go in in order.

mod registry;

use std::sync::{Arc, OnceLock};

use serde_json::json;
use wisp_kernel::http::{Request, Response, Route};
use wisp_kernel::{Ctx, Manifest, Plugin, Result, Setup, WireError};
use wisp_proc::Proc;
use wisp_terminal_api::commands as c;
use wisp_terminal_api::{ShellInfo, TermKind, TerminalApps};

use registry::Registry;

type Slot = Arc<OnceLock<Arc<Registry>>>;

fn reg(slot: &Slot) -> Result<Arc<Registry>> {
    slot.get().cloned().ok_or_else(|| WireError::unavailable("wisp.terminal is starting"))
}

/// A task's shell: in its worktree when it has one, else its folder (v1 `shellDir`).
async fn task_dir(ctx: &Ctx, call: &wisp_kernel::Call, id: &str) -> Result<(String, String)> {
    let s = ctx.run_json(call, "runtime.get", json!({ "id": id })).await?;
    let wt = s.pointer("/ext/wisp.worktrees/path").and_then(|v| v.as_str()).unwrap_or("").to_owned();
    let cwd = s["cwd"].as_str().unwrap_or("").to_owned();
    let home = std::env::var("HOME").unwrap_or_default();
    let f = wisp_terminal_core::folder::task_folder(&wt, &cwd, &home, &|p| std::path::Path::new(p).is_dir());
    Ok((f.dir, s["agent"].as_str().unwrap_or("").to_owned()))
}

fn kind_of(req: &Request) -> TermKind {
    if req.path.ends_with("/term") { TermKind::Takeover } else { TermKind::Shell }
}

fn routes(s: &mut Setup, slot: &Slot) {
    for (method, pattern, summary) in [
        ("GET", "/sessions/:id/shell", "The task's shell, as an event stream (hello, data, exit)"),
        ("GET", "/sessions/:id/term", "The task's take over terminal, as an event stream"),
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
    for pattern in ["/sessions/:id/shell", "/sessions/:id/term"] {
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
                Box::pin(async move { Response::ok(json!({ "ok": reg(&sl)?.close(kind_of(&req), req.param("id").unwrap_or_default()).await })) })
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
                let out = start_shell(&ctx, &call, &r, &id, b["cols"].as_f64(), b["rows"].as_f64(), b["restart"].as_bool().unwrap_or(false)).await?;
                Response::ok(out)
            })
        }),
    });
}

async fn start_shell(ctx: &Ctx, call: &wisp_kernel::Call, r: &Registry, id: &str, cols: Option<f64>, rows: Option<f64>, restart: bool) -> Result<wisp_terminal_api::ShellStarted> {
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
    let _ = ctx.run_json(&ctx.root_call(), "telemetry.track", json!({ "event": "shell", "props": { "agent": agent } })).await;
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
    TerminalApps { terminals: wisp_terminal_core::apps::terminals_here(&l), default_terminal: wisp_terminal_core::apps::default_terminal(platform).to_owned() }
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
                let _ = ctx.run_json(&ctx.root_call(), "telemetry.track", json!({ "event": "takeover", "props": { "terminal": "wisp", "machine": false } })).await;
            }
            Ok(out)
        });
        on!(s, slot, c::Get, |r, ctx, call, a| Ok(r.info(a.kind, &a.id)));
        on!(s, slot, c::Close, |r, ctx, call, a| {
            let ok = r.close(a.kind, &a.id).await;
            if ok {
                // hung up: forgotten, and whoever owns the task hears it ended
                ctx.emit(&call, &wisp_terminal_api::Changed { kind: a.kind, id: a.id.clone(), state: wisp_terminal_api::TermState::Ended, code: None, gone: true });
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
            Ok(ShellInfo { supported: !cfg!(windows), open: r.live(TermKind::Shell, &a.id), app: !a.via_proxy && cfg!(target_os = "macos"), name: wisp_terminal_core::folder::shell_name(shell.as_deref()) })
        });
        s.command::<c::Apps, _, _>(|_ctx, _call, _a| async move { Ok(apps_here(std::env::consts::OS, &|k| std::env::var(k).ok())) });
        routes(s, &slot);
        let start = slot;
        s.on_start(move |ctx| async move {
            let proc = ctx.service::<Proc>()?.as_ref().clone();
            let _ = start.set(Arc::new(Registry::new(proc)));
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
    fn manifest_is_valid() {
        assert_eq!(TerminalPlugin.manifest().id, "wisp.terminal");
    }
}
