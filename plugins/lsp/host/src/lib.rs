//! wisp.lsp: language intelligence for the side panel's editor (v1 server/lsp.js, routes/lsp.js). A
//! language server per task folder and language, started on the first question and spoken to over
//! stdio through the proc service; `wisp-lsp-core`'s `Client` does the protocol (framing, ids, the
//! server's own requests, versions, published diagnostics), this crate owns the pipe and the waiting.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::{Notify, oneshot};
use wisp_kernel::http::{Response, Route};
use wisp_kernel::{Call, Ctx, Manifest, Plugin, Result, Setup, WireError};
use wisp_lsp_api::{self as api, AskArgs, Hit, Installed, Lang, LspAnswer, Op};
use wisp_lsp_core::answer::{completion_items, hover_text, line_text, locate, locations, resolve_inside, valid_name};
use wisp_lsp_core::client::{Action, Client};
use wisp_lsp_core::edit::{apply_edits, workspace_edits};
use wisp_lsp_core::servers::{Search, find_server, install_plan, lang_id, lang_of, spec};
use wisp_lsp_core::url::file_url_to_path;
use wisp_proc::{ChildHandle, Proc, SpawnOpts};

/// How long one question waits for the server (a first one includes its start).
const ASK_MS: u64 = 15_000;
/// How long diagnostics wait to be published for the editor's copy.
const DIAG_MS: u64 = 3_000;

type Pending = HashMap<u64, oneshot::Sender<std::result::Result<Value, String>>>;

struct Server {
    name: &'static str,
    client: Mutex<Client>,
    handle: ChildHandle,
    pending: Mutex<Pending>,
    diags: Notify,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Server {
    fn send(&self, bytes: Vec<u8>) {
        let _ = self.handle.write(bytes);
    }

    async fn request(&self, method: &str, params: &Value) -> Result<Value> {
        let (id, bytes) = lock(&self.client).request(method, params);
        let (tx, rx) = oneshot::channel();
        lock(&self.pending).insert(id, tx);
        self.send(bytes);
        match tokio::time::timeout(Duration::from_millis(ASK_MS), rx).await {
            Ok(Ok(Ok(v))) => Ok(v),
            Ok(Ok(Err(m))) => Err(WireError::invalid(m)),
            _ => Err(WireError::unavailable(format!("{} didn't answer in time", self.name))),
        }
    }
}

struct State {
    proc: Proc,
    home: Option<PathBuf>,
    servers: Mutex<HashMap<(PathBuf, Lang), Arc<Server>>>,
    installing: Mutex<bool>,
}

type Slot = Arc<OnceLock<Arc<State>>>;

fn state(slot: &Slot) -> Result<Arc<State>> {
    slot.get().cloned().ok_or_else(|| WireError::unavailable("wisp.lsp is starting"))
}

impl State {
    /// The running server for (root, lang), or a fresh one, initialized.
    async fn server(&self, ctx: &Ctx, root: &Path, lang: Lang) -> Result<Option<Arc<Server>>> {
        let key = (root.to_owned(), lang);
        if let Some(s) = lock(&self.servers).get(&key).filter(|s| s.handle.running()) {
            return Ok(Some(s.clone()));
        }
        let search = Search { override_cmd: std::env::var(Search::override_var(lang)).ok(), path: std::env::var("PATH").ok(), windows: cfg!(windows) };
        let Some(cmd) = find_server(lang, root, self.home.as_deref(), &search, Path::is_file) else { return Ok(None) };
        let Some((prog, args)) = cmd.split_first() else { return Ok(None) };
        let child = self.proc.spawn(prog, args, SpawnOpts { cwd: Some(root.to_owned()), ..SpawnOpts::default() }).map_err(|e| WireError::invalid(e.to_string()))?;
        let (handle, mut rx) = child.split();
        let server = Arc::new(Server { name: spec(lang).name, client: Mutex::new(Client::new()), handle, pending: Mutex::new(HashMap::new()), diags: Notify::new() });
        let s2 = server.clone();
        ctx.spawn(async move {
            while let Some(o) = rx.recv().await {
                if o.stream != wisp_proc::Stream::Stdout {
                    continue;
                }
                let actions = lock(&s2.client).feed(&o.data);
                for a in actions {
                    match a {
                        Action::Reply { id, result } => {
                            if let Some(tx) = lock(&s2.pending).remove(&id) {
                                let _ = tx.send(result);
                            }
                        }
                        Action::Send(b) => s2.send(b),
                        Action::Diagnostics { .. } => s2.diags.notify_waiters(),
                    }
                }
            }
        });
        let (id, init) = lock(&server.client).initialize(root, std::process::id());
        let (tx, rx) = oneshot::channel();
        lock(&server.pending).insert(id, tx);
        server.send(init);
        match tokio::time::timeout(Duration::from_millis(ASK_MS), rx).await {
            Ok(Ok(Ok(_))) => {}
            _ => return Err(WireError::unavailable(format!("{} didn't start", server.name))),
        }
        server.send(Client::initialized());
        lock(&self.servers).insert(key, server.clone());
        Ok(Some(server))
    }
}

/// The folder the task's paths are relative to: its worktree, else its folder.
async fn root_of(ctx: &Ctx, call: &Call, id: &str) -> Result<PathBuf> {
    let s = ctx.run_json(call, "runtime.get", json!({ "id": id })).await?;
    let wt = s.pointer("/ext/wisp.worktrees/path").and_then(Value::as_str).filter(|p| Path::new(p).is_dir());
    Ok(PathBuf::from(wt.or_else(|| s["cwd"].as_str()).unwrap_or(".")))
}

/// Where a definition or references answer points, with each line's text.
async fn hits(root: &Path, res: &Value) -> Vec<Hit> {
    let mut out = Vec::new();
    for l in locations(res).into_iter().filter_map(|l| locate(root, l)) {
        let body = tokio::fs::read_to_string(&l.file).await.unwrap_or_default();
        out.push(Hit { path: l.path, line: l.line, col: l.col, text: line_text(&body, l.line_index) });
    }
    out
}

#[allow(clippy::too_many_lines)] // one arm per question, as v1's ask
async fn ask(ctx: &Ctx, call: &Call, st: &State, a: AskArgs) -> Result<LspAnswer> {
    let root = root_of(ctx, call, &a.id).await?;
    let r = &a.request;
    let file = resolve_inside(&root, &r.path).ok_or_else(|| WireError::invalid("That file is outside the task's folder."))?;
    let Some(lang) = lang_of(&file) else { return Ok(LspAnswer::NoServer { lsp: (), lang: None, install: None }) };
    let Some(server) = st.server(ctx, &root, lang).await? else {
        let s = spec(lang);
        return Ok(LspAnswer::NoServer { lsp: (), lang: Some(lang), install: (!s.npm.is_empty()).then(|| s.name.to_owned()) });
    };
    let name = server.name.to_owned();
    let text = match &r.text {
        Some(t) => t.clone(),
        None => tokio::fs::read_to_string(&file).await.unwrap_or_default(),
    };
    let (uri, sync) = lock(&server.client).sync(&file, lang_id(&file), &text);
    if let Some(b) = sync {
        server.send(b);
    }
    let pos = json!({ "textDocument": { "uri": uri }, "position": { "line": r.line() - 1, "character": r.col() - 1 } });
    Ok(match r.op {
        Op::Definition => {
            let res = server.request("textDocument/definition", &pos).await?;
            LspAnswer::Hits { lsp: name, hits: hits(&root, &res).await }
        }
        Op::References => {
            let mut p = pos.clone();
            p["context"] = json!({ "includeDeclaration": true });
            let res = server.request("textDocument/references", &p).await?;
            LspAnswer::Hits { lsp: name, hits: hits(&root, &res).await }
        }
        Op::Hover => {
            let res = server.request("textDocument/hover", &pos).await?;
            LspAnswer::Hover { lsp: name, hover: hover_text(&res) }
        }
        Op::Completion => {
            let res = server.request("textDocument/completion", &pos).await?;
            LspAnswer::Completion { lsp: name, items: completion_items(&res) }
        }
        Op::Diagnostics => {
            let key = wisp_lsp_core::url::uri_key(&uri);
            let fresh = |s: &Server| lock(&s.client).fresh_diagnostics(&key).map(<[_]>::to_vec);
            if fresh(&server).is_none() {
                let _ = tokio::time::timeout(Duration::from_millis(DIAG_MS), server.diags.notified()).await;
            }
            LspAnswer::Diagnostics { lsp: name, diagnostics: fresh(&server).unwrap_or_default() }
        }
        Op::Rename => {
            let new = r.new_name.clone().unwrap_or_default();
            if !valid_name(&new) {
                return Err(WireError::invalid("A new name is letters, digits, _ and $."));
            }
            let mut p = pos.clone();
            p["newName"] = json!(new);
            let res = server.request("textDocument/rename", &p).await?;
            let (mut files, mut count) = (Vec::new(), 0u32);
            for (url, edits) in workspace_edits(&res) {
                // only the task's own files are written
                let Some(path) = file_url_to_path(&url).filter(|p| p.starts_with(&root)) else { continue };
                let before = tokio::fs::read_to_string(&path).await.unwrap_or_default();
                tokio::fs::write(&path, apply_edits(&before, &edits)).await.map_err(|e| WireError::invalid(e.to_string()))?;
                count += u32::try_from(edits.len()).unwrap_or(0);
                files.push(wisp_lsp_core::answer::relative_inside(&root, &path).unwrap_or_default());
            }
            LspAnswer::Renamed { lsp: name, files, count }
        }
    })
}

#[derive(Debug, Default)]
pub struct LspPlugin;

impl Plugin for LspPlugin {
    fn manifest(&self) -> Manifest {
        Manifest::embedded(include_str!("../wisp-plugin.json"))
    }

    fn setup(&self, s: &mut Setup) -> Result<()> {
        let slot: Slot = Arc::new(OnceLock::new());
        let sl = slot.clone();
        s.command::<api::Ask, _, _>(move |ctx, call, a| {
            let sl = sl.clone();
            async move { ask(&ctx, &call, &*state(&sl)?, a).await }
        });
        let sl = slot.clone();
        s.command::<api::Install, _, _>(move |_ctx, _call, a| {
            let sl = sl.clone();
            async move {
                let st = state(&sl)?;
                let home = st.home.clone().ok_or_else(|| WireError::unavailable("no wisp home"))?;
                let plan = install_plan(&a.lang, &home).ok_or_else(|| WireError::invalid(wisp_lsp_core::servers::install_refusal()))?;
                {
                    let mut busy = lock(&st.installing);
                    if *busy {
                        return Err(WireError::conflict("An install is already running."));
                    }
                    *busy = true;
                }
                let _ = tokio::fs::create_dir_all(&plan.dir).await;
                let npm = std::env::var("WISP_NPM").ok().filter(|n| !n.is_empty()).unwrap_or_else(|| "npm".into());
                let r = st.proc.exec(&npm, &plan.args, wisp_proc::ExecOpts { cwd: Some(plan.dir.clone()), timeout: Some(Duration::from_secs(300)), ..wisp_proc::ExecOpts::default() }).await;
                *lock(&st.installing) = false;
                match r {
                    Ok(r) if r.exit.code == Some(0) => Ok(Installed { ok: true }),
                    Ok(r) => Err(WireError::invalid(wisp_lsp_core::servers::install_error(&r.stderr_text(), "npm install failed"))),
                    Err(e) => Err(WireError::invalid(e.to_string())),
                }
            }
        });
        // v1's routes: the same commands
        s.route(Route {
            method: "POST",
            pattern: "/sessions/:id/lsp",
            permission: "lsp:ask",
            doc: true,
            summary: "Ask the task's language server: definition, references, hover, diagnostics, rename, completion",
            raw: false,
            max_body: None,
            handler: Arc::new(|ctx, call, req| {
                Box::pin(async move {
                    let mut b: Value = req.json()?;
                    b["id"] = json!(req.param("id").unwrap_or_default());
                    Response::ok(ctx.run_json(&call, "lsp.ask", b).await?)
                })
            }),
        });
        s.route(Route {
            method: "POST",
            pattern: "/lsp/install",
            permission: "lsp:install",
            doc: true,
            summary: "Install npm's language server for a language into wisp's folder",
            raw: false,
            max_body: None,
            handler: Arc::new(|ctx, call, req| Box::pin(async move { Response::ok(ctx.run_json(&call, "lsp.install", req.json()?).await?) })),
        });
        let start = slot;
        s.on_start(move |ctx| async move {
            let proc = ctx.service::<Proc>()?.as_ref().clone();
            let home = ctx.service::<wisp_kernel::services::Paths>().ok().map(|p| p.home().to_owned());
            let _ = start.set(Arc::new(State { proc, home, servers: Mutex::new(HashMap::new()), installing: Mutex::new(false) }));
            Ok(())
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_is_valid() {
        assert_eq!(LspPlugin.manifest().id, "wisp.lsp");
    }
}
