//! The exec tier (plan §6.7 tier 3): a plugin as a subprocess speaking JSON-RPC 2.0 over stdio, one
//! message per line. Its code never runs in the kernel: this bridge registers what it asks for under
//! the plugin's own context, so the same permission checks, scopes and traces apply. A dead child turns
//! the plugin off with the reason, and the kernel switches it back on after a backoff.
//!
//! Child → kernel: `command.register {id, permission?, readOnly?}`, `intercept.register {n, hook,
//! priority?, failure?, timeoutMs?}`, `on {n, type}`, `emit {type, data, call?}`, `contribute {point,
//! item, version?}`, `run {cmd, args, call?}`, `hook {hook, ctx, call}`, `settings.get {key}`,
//! `log {level, msg}`. Kernel → child: `initialize {id, manifest, settings}` (answered once every
//! registration was accepted), `command.run {id, args, call, trace}`, `intercept.run {n, ctx, call,
//! trace}`, `event {n, e}`, `settings.changed {key, value}` (a notification). `call` is a token that
//! continues the kernel-side call (nested commands keep the trace and caller).
//!
//! size-ok: the JSON-RPC bridge's registrations and its lifecycle share one child handle
pub mod rpc;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::{Value, json};

use crate::activate::{add_command, add_hook, add_sub};
use crate::events::{Payload, SubFn};
use crate::host::{CmdFn, CmdReg, Ctx, HookFn, HookReg};
use crate::reg::PointEntry;
use crate::state::KernelState;
use crate::{Call, Failure, InterceptOpts, Manifest, Plugin, Result, Setup, Verdict, WireError};
use rpc::{Peer, Reply};

/// How an install starts exec plugins (the grid sandboxes them). A kernel service:
/// `App::service(Arc::new(MySpawner) as Arc<dyn ExecSpawner>)`.
pub trait ExecSpawner: Send + Sync + 'static {
    /// stdin, stdout and stderr piped; the child dies with the handle (`kill_on_drop`).
    fn spawn(
        &self,
        program: &Path,
        args: &[String],
        cwd: Option<&Path>,
        env: &[(String, String)],
    ) -> std::io::Result<tokio::process::Child>;
}

#[derive(Debug, Clone)]
pub struct ExecOptions {
    /// first restart after this long, doubling each time
    pub restart_base_ms: u64,
    pub max_restarts: u32,
    /// how long the child may take to finish `initialize`
    pub init_timeout_ms: u64,
    pub env: Vec<(String, String)>,
}

impl Default for ExecOptions {
    fn default() -> Self {
        Self {
            restart_base_ms: 1000,
            max_restarts: 5,
            init_timeout_ms: 10_000,
            env: Vec::new(),
        }
    }
}

/// A plugin whose manifest says `"server": {"exec": ["bin", …args]}`. `root` is its folder: a relative
/// program path is resolved against it, and the child runs there.
#[derive(Debug, Clone)]
pub struct ExecPlugin {
    manifest: Manifest,
    root: Option<PathBuf>,
    opts: ExecOptions,
}

impl ExecPlugin {
    pub fn new(manifest: Manifest, root: Option<PathBuf>) -> Self {
        Self {
            manifest,
            root,
            opts: ExecOptions::default(),
        }
    }
    #[must_use]
    pub fn with_options(mut self, opts: ExecOptions) -> Self {
        self.opts = opts;
        self
    }
}

impl Plugin for ExecPlugin {
    fn manifest(&self) -> Manifest {
        self.manifest.clone()
    }
    fn setup(&self, s: &mut Setup) -> Result<()> {
        let (m, root, opts) = (self.manifest.clone(), self.root.clone(), self.opts.clone());
        s.on_start(move |ctx| start(ctx, m, root, opts));
        Ok(())
    }
}

fn default_spawn(
    program: &Path,
    args: &[String],
    cwd: Option<&Path>,
    env: &[(String, String)],
) -> std::io::Result<tokio::process::Child> {
    let mut c = tokio::process::Command::new(program);
    c.args(args)
        .envs(env.iter().cloned())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    if let Some(d) = cwd {
        c.current_dir(d);
    }
    c.spawn()
}

async fn start(ctx: Ctx, m: Manifest, root: Option<PathBuf>, opts: ExecOptions) -> Result<()> {
    let k = ctx.k()?;
    let id = m.id.clone();
    let argv = m
        .exec()
        .filter(|a| !a.is_empty())
        .ok_or_else(|| WireError::invalid(format!("{id} has no exec command")))?;
    let mut program = PathBuf::from(&argv[0]);
    if program.is_relative()
        && argv[0].contains('/')
        && let Some(r) = &root
    {
        program = r.join(program);
    }
    let mut env = opts.env.clone();
    env.push(("WISP_PLUGIN".into(), id.clone()));
    let spawned = match k.service::<Arc<dyn ExecSpawner>>() {
        Some(s) => s.spawn(&program, &argv[1..], root.as_deref(), &env),
        None => default_spawn(&program, &argv[1..], root.as_deref(), &env),
    };
    let mut child = spawned.map_err(|e| {
        WireError::unavailable(format!("{id}: can't start {}: {e}", program.display()))
    })?;
    let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        return Err(WireError::internal(format!("{id}: the child has no stdio")));
    };
    let bridge = Arc::new(Bridge {
        ctx: ctx.clone(),
        k: Arc::downgrade(&k),
        calls: Mutex::default(),
        n: AtomicU64::new(0),
        peer: OnceLock::new(),
    });
    let b = bridge.clone();
    let peer = Peer::start(
        stdout,
        stdin,
        Arc::new(move |method: &str, p: Value| b.handle(method, p)),
        ctx.scope().child_token(),
    );
    let _ = bridge.peer.set(peer.clone());
    if let Some(err) = child.stderr.take() {
        ctx.spawn(log_stderr(id.clone(), err));
    }
    supervise(&k, &ctx, child, peer.clone(), &opts);
    let settings: serde_json::Map<String, Value> = m
        .settings()
        .into_iter()
        .map(|d| (d.key.clone(), ctx.setting(&d.key).unwrap_or(Value::Null)))
        .collect();
    for key in settings.keys() {
        let (p, key2) = (peer.clone(), key.clone());
        ctx.watch_setting(key, move |v| {
            p.notify("settings.changed", json!({ "key": key2, "value": v }));
        });
    }
    let manifest = serde_json::to_value(&m).unwrap_or(Value::Null);
    let init = peer.request(
        "initialize",
        json!({ "id": id, "manifest": manifest, "settings": settings }),
    );
    let ms = opts.init_timeout_ms;
    let r = tokio::select! {
        r = init => r.map(|_| ()),
        () = k.sleep(ms) => Err(WireError::new(crate::Code::Timeout, format!("{id} didn't finish setup within {ms} ms"))),
    };
    if r.is_err() {
        peer.close("setup failed");
    }
    r
}

async fn log_stderr(id: String, err: tokio::process::ChildStderr) {
    use tokio::io::AsyncBufReadExt;
    let mut lines = tokio::io::BufReader::new(err).lines();
    while let Ok(Some(l)) = lines.next_line().await {
        tracing::warn!(plugin = %id, "{l}");
    }
}

/// Waits on the child: a death while the plugin is on is a crash (off with the reason, restart with a
/// backoff); the plugin going off kills it.
fn supervise(
    k: &Arc<KernelState>,
    ctx: &Ctx,
    mut child: tokio::process::Child,
    peer: Arc<Peer>,
    opts: &ExecOptions,
) {
    let (weak, scope, id, base, max) = (
        Arc::downgrade(k),
        ctx.scope().clone(),
        ctx.plugin().to_owned(),
        opts.restart_base_ms,
        opts.max_restarts,
    );
    tokio::spawn(async move {
        tokio::select! {
            status = child.wait() => {
                let how = status.map_or_else(|e| format!("failed: {e}"), |s| s.code().map_or_else(|| "was killed".to_owned(), |c| format!("exited (code {c})")));
                let why = format!("{id}'s process {how}");
                peer.close(&why);
                // a death before `initialize` answered is a failed start, handled there
                let live = |k: &KernelState| k.lock_plugins().ok().and_then(|ps| ps.phase(&id)) == Some(crate::life::Phase::Active);
                if !scope.is_cancelled() && let Some(k) = weak.upgrade() && live(&k) {
                    crate::life::crashed(&k, &id, &why, base, max);
                }
            }
            () = scope.cancelled() => {
                peer.close(&format!("{id} is off"));
                let _ = child.kill().await;
            }
        }
    });
}

struct Bridge {
    ctx: Ctx,
    k: std::sync::Weak<KernelState>,
    /// calls the child is inside of, by token
    calls: Mutex<HashMap<String, Call>>,
    n: AtomicU64,
    peer: OnceLock<Arc<Peer>>,
}

fn s(p: &Value, k: &str) -> String {
    p.get(k)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn trace(c: &Call) -> Value {
    let i = &c.inner;
    json!({ "root": i.root, "depth": i.depth, "stack": i.stack, "caller": i.caller, "readOnly": i.read_only })
}

impl Bridge {
    fn k(&self) -> Result<Arc<KernelState>> {
        self.k
            .upgrade()
            .ok_or_else(|| WireError::unavailable("the kernel has stopped"))
    }

    /// Forwards a call into the child; the token lets it run nested commands inside this trace.
    async fn into(self: Arc<Self>, call: Call, method: &str, mut params: Value) -> Result<Value> {
        let t = format!("c{}", self.n.fetch_add(1, Ordering::Relaxed) + 1);
        if let Ok(mut c) = self.calls.lock() {
            c.insert(t.clone(), call.clone());
        }
        params["call"] = Value::from(t.clone());
        params["trace"] = trace(&call);
        let r = match self.peer.get() {
            Some(p) => p.request(method, params).await,
            None => Err(WireError::unavailable("no child")),
        };
        if let Ok(mut c) = self.calls.lock() {
            c.remove(&t);
        }
        r
    }

    fn live(&self, p: &Value) -> Option<Call> {
        let t = p.get("call")?.as_str()?;
        self.calls.lock().ok()?.get(t).cloned()
    }

    #[allow(clippy::needless_pass_by_value)] // the rpc handler hands over each message's params
    fn handle(self: &Arc<Self>, method: &str, p: Value) -> Reply {
        let k = match self.k() {
            Ok(k) => k,
            Err(e) => return Reply::Now(Err(e)),
        };
        let now = |r: Result<()>| Reply::Now(r.map(|()| Value::Null));
        match method {
            "command.register" => now(self.command(&k, &p)),
            "intercept.register" => now(self.intercept(&k, &p)),
            "on" => {
                self.on(&k, &p);
                now(Ok(()))
            }
            "emit" => {
                let call = self.live(&p).unwrap_or_else(|| self.ctx.root_call());
                crate::dispatch::emit(
                    &self.ctx,
                    &call,
                    &s(&p, "type"),
                    Payload::Json(Arc::new(p.get("data").cloned().unwrap_or(Value::Null))),
                );
                now(Ok(()))
            }
            "contribute" => {
                let item = p.get("item").cloned().unwrap_or(Value::Null);
                let version = p
                    .get("version")
                    .and_then(Value::as_u64)
                    .and_then(|v| u32::try_from(v).ok())
                    .unwrap_or(1);
                let e = PointEntry {
                    owner: self.ctx.inner.id.clone(),
                    version,
                    item: Arc::new(item.clone()),
                    json: Some(item),
                };
                now(k.write_reg().map(|mut r| r.add_point(&s(&p, "point"), e)))
            }
            "run" => {
                let (ctx, parent) = (
                    self.ctx.clone(),
                    self.live(&p).unwrap_or_else(|| self.ctx.root_call()),
                );
                let (cmd, args) = (s(&p, "cmd"), p.get("args").cloned().unwrap_or(Value::Null));
                Reply::Later(Box::pin(async move {
                    crate::dispatch::json(&k, Some(ctx), &parent, &cmd, args).await
                }))
            }
            "hook" => {
                let Some(call) = self.live(&p) else {
                    return Reply::Now(Err(WireError::invalid("a hook runs inside a call")));
                };
                let (hook, v) = (s(&p, "hook"), p.get("ctx").cloned().unwrap_or(Value::Null));
                Reply::Later(Box::pin(async move {
                    crate::hooks::json(&k, &call, &hook, v).await
                }))
            }
            "settings.get" => {
                Reply::Now(Ok(self.ctx.setting(&s(&p, "key")).unwrap_or(Value::Null)))
            }
            "log" => {
                let (msg, plugin) = (s(&p, "msg"), self.ctx.plugin());
                match p.get("level").and_then(Value::as_str) {
                    Some("debug") => tracing::debug!(plugin, "{msg}"),
                    Some("info") => tracing::info!(plugin, "{msg}"),
                    Some("error") => tracing::error!(plugin, "{msg}"),
                    _ => tracing::warn!(plugin, "{msg}"),
                }
                now(Ok(()))
            }
            _ => Reply::Now(Err(WireError::not_found(format!("no method {method}")))),
        }
    }

    fn command(self: &Arc<Self>, k: &KernelState, p: &Value) -> Result<()> {
        let id = s(p, "id");
        let (b, cid) = (self.clone(), id.clone());
        let json: CmdFn = Arc::new(move |_ctx, call, args| {
            let (b, cid) = (b.clone(), cid.clone());
            Box::pin(async move {
                b.into(call, "command.run", json!({ "id": cid, "args": args }))
                    .await
            })
        });
        let permission = p
            .get("permission")
            .and_then(Value::as_str)
            .map(str::to_owned);
        add_command(
            k,
            &self.ctx,
            CmdReg {
                id,
                permission,
                read_only: p.get("readOnly") == Some(&Value::Bool(true)),
                json,
                typed: None,
            },
        )
    }

    #[allow(clippy::many_single_char_names)]
    fn intercept(self: &Arc<Self>, k: &KernelState, p: &Value) -> Result<()> {
        let n = p.get("n").cloned().unwrap_or(Value::Null);
        let b = self.clone();
        let json: HookFn = Arc::new(move |_ctx, call, v| {
            let (b, n) = (b.clone(), n.clone());
            Box::pin(async move {
                let out = b
                    .into(call, "intercept.run", json!({ "n": n, "ctx": v }))
                    .await?;
                serde_json::from_value::<Verdict<Value>>(out)
                    .map_err(|e| WireError::invalid(format!("not a verdict: {e}")))
            })
        });
        let d = InterceptOpts::default();
        let opts = InterceptOpts {
            priority: p
                .get("priority")
                .and_then(Value::as_i64)
                .and_then(|x| i32::try_from(x).ok())
                .unwrap_or(d.priority),
            failure: if p.get("failure").and_then(Value::as_str) == Some("closed") {
                Failure::Closed
            } else {
                Failure::Open
            },
            timeout_ms: p
                .get("timeoutMs")
                .and_then(Value::as_u64)
                .unwrap_or(d.timeout_ms),
        };
        add_hook(
            k,
            &self.ctx,
            HookReg {
                hook: s(p, "hook"),
                opts,
                json,
                typed: None,
            },
        )
    }

    #[allow(clippy::many_single_char_names)]
    fn on(self: &Arc<Self>, k: &Arc<KernelState>, p: &Value) {
        let n = p.get("n").cloned().unwrap_or(Value::Null);
        let b = self.clone();
        let f: SubFn = Arc::new(move |_ctx, env| {
            let (b, n) = (b.clone(), n.clone());
            Box::pin(async move {
                let e =
                    serde_json::to_value(&*env).map_err(|e| WireError::internal(e.to_string()))?;
                match b.peer.get() {
                    Some(peer) => peer
                        .request("event", json!({ "n": n, "e": e }))
                        .await
                        .map(|_| ()),
                    None => Err(WireError::unavailable("no child")),
                }
            })
        });
        add_sub(k, &self.ctx, s(p, "type"), f);
    }
}
