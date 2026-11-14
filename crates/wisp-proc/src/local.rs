//! `LocalProc`: the proc service on this computer. It resolves the program (resolve.rs), starts it on
//! pipes (pipes.rs) or a PTY (pty.rs), keeps every live child so shutdown can end them all, and ties
//! each to its scope.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError, RwLock};
use std::time::Duration;

use crate::BoxFuture;

use crate::child::{ChildHandle, tie_to_scope};
use crate::resolve::{self, Platform, RealFs, Resolved};
use crate::{Child, ExecOpts, ExecResult, MAX_EXEC_OUTPUT, ProcError, ProcService, Result, Signal, SpawnOpts, Stream, pipes, pty};

#[derive(Debug, Default)]
struct Registry {
    next: AtomicU64,
    live: Mutex<HashMap<u64, ChildHandle>>,
}

#[derive(Debug, Default, Clone)]
pub struct LocalProc {
    reg: Arc<Registry>,
}

impl LocalProc {
    pub fn new() -> Self {
        Self::default()
    }

    fn track(&self, handle: &ChildHandle) {
        let id = self.reg.next.fetch_add(1, Ordering::Relaxed);
        self.reg.live.lock().unwrap_or_else(PoisonError::into_inner).insert(id, handle.clone());
        let (reg, handle) = (self.reg.clone(), handle.clone());
        tokio::spawn(async move {
            handle.exited().await;
            reg.live.lock().unwrap_or_else(PoisonError::into_inner).remove(&id);
        });
    }
}

/// The PATH the desktop app handed over after start (its login shell's, read behind the first window: `wisp serve`'s
/// stdin, crates/wisp/src/serve.rs). Programs are found on it and start with it; until then the inherited PATH.
static HANDED_PATH: RwLock<Option<String>> = RwLock::new(None);

/// Finds and starts programs on `path` from now on, in place of the PATH this process inherited. An empty one is
/// ignored. A no-op on Windows: the desktop app never hands one over there, and the environment spells it `Path`, so
/// a handed `PATH` would be a second variable beside it (two PATHs, the child's pick unknown).
pub fn set_path(path: &str) {
    if cfg!(windows) || path.is_empty() {
        return;
    }
    *HANDED_PATH.write().unwrap_or_else(PoisonError::into_inner) = Some(path.to_owned());
}

fn handed_path() -> Option<String> {
    HANDED_PATH.read().unwrap_or_else(PoisonError::into_inner).clone()
}

/// The PATH programs are found on: the handed-over one, else the inherited one. For code that looks a program up
/// itself (a harness's fingerprint, a language server) so it finds the one `spawn` starts.
#[must_use]
pub fn search_path() -> Option<std::ffi::OsString> {
    handed_path().map(Into::into).or_else(|| std::env::var_os("PATH"))
}

/// This process's variables, with the handed-over PATH in place of the inherited one: for code that reads the
/// environment itself (a config lookup, a child it builds an environment for) in place of `std::env::vars()`.
#[must_use]
pub fn vars() -> Vec<(String, String)> {
    parent_env()
}

/// This process's variables, with the handed-over PATH in place of the inherited one.
fn parent_env() -> Vec<(String, String)> {
    let mut vars: Vec<(String, String)> = std::env::vars().collect();
    if let Some(path) = handed_path() {
        vars.retain(|(k, _)| k != "PATH");
        vars.push(("PATH".to_owned(), path));
    }
    vars
}

/// A child inherits this process's PATH unless told: the handed-over one goes in, where the caller didn't say.
fn with_handed_path(mut env: crate::Env) -> crate::Env {
    let says = env.clear || env.set.iter().any(|(k, _)| k == "PATH") || env.remove.iter().any(|k| k == "PATH");
    if let Some(path) = handed_path().filter(|_| !says) {
        env.set.insert(0, ("PATH".to_owned(), path));
    }
    env
}

/// The parent's variables patched by `env`, for lookups that must see the child's PATH.
fn lookup_env(opts_env: &crate::Env) -> Vec<(String, String)> {
    opts_env.resolve(parent_env())
}

fn resolve_for(bin: &str, args: &[String], opts: &SpawnOpts) -> Resolved {
    if Platform::current() == Platform::Unix {
        return Resolved { command: bin.to_owned(), args: args.to_vec(), verbatim: opts.verbatim };
    }
    let r = resolve::resolve_command(bin, args, &lookup_env(&opts.env), Platform::Windows, &RealFs);
    Resolved { verbatim: r.verbatim || opts.verbatim, ..r }
}

fn check_cwd(cwd: Option<&Path>) -> Result<()> {
    match cwd {
        Some(dir) if !dir.is_dir() => Err(ProcError::NoFolder(dir.display().to_string())),
        _ => Ok(()),
    }
}

impl ProcService for LocalProc {
    fn which(&self, bin: &str, env: Option<Vec<(String, String)>>) -> BoxFuture<'static, Option<PathBuf>> {
        let bin = bin.to_owned();
        Box::pin(async move {
            let env = env.unwrap_or_else(parent_env);
            tokio::task::spawn_blocking(move || resolve::which(&bin, &env, Platform::current(), &RealFs))
                .await
                .ok()
                .flatten()
                .map(PathBuf::from)
        })
    }

    fn spawn(&self, bin: &str, args: &[String], mut opts: SpawnOpts) -> Result<Child> {
        opts.env = with_handed_path(opts.env.for_program(bin));
        let span = tracing::debug_span!("proc.spawn", bin, pty = opts.pty.is_some());
        let _entered = span.enter();
        check_cwd(opts.cwd.as_deref())?;
        let r = resolve_for(bin, args, &opts);
        let child = match opts.pty {
            Some(size) => {
                // portable-pty searches PATH itself and words a miss its own way: say NotFound, as pipes do.
                if !r.command.contains(['/', '\\'])
                    && resolve::which(&r.command, &lookup_env(&opts.env), Platform::current(), &RealFs).is_none()
                {
                    return Err(ProcError::NotFound(bin.to_owned()));
                }
                pty::spawn(bin, &r, &opts, size)?
            }
            None => pipes::spawn(bin, &r, &opts)?,
        };
        self.track(&child.handle);
        tie_to_scope(&child.handle, opts.scope);
        Ok(child)
    }

    fn exec(&self, bin: &str, args: &[String], opts: ExecOpts) -> BoxFuture<'static, Result<ExecResult>> {
        let spawn = SpawnOpts {
            cwd: opts.cwd.clone(),
            env: opts.env.clone(),
            no_stdin: opts.input.is_none(),
            scope: opts.scope.clone(),
            ..SpawnOpts::default()
        };
        // Resolving the program, checking the folder and forking block: they run on the blocking
        // pool, and only the wait for output runs on the runtime (callers needn't wrap it).
        let (me, bin, args) = (self.clone(), bin.to_owned(), args.to_vec());
        let span = tracing::debug_span!("proc.exec", bin);
        Box::pin(tracing::Instrument::instrument(
            async move {
                let name = bin.clone();
                let child = tokio::task::spawn_blocking(move || me.spawn(&bin, &args, spawn))
                    .await
                    .map_err(|e| ProcError::Spawn { bin: name, message: e.to_string() })??;
                collect(child, opts).await
            },
            span,
        ))
    }

    fn spawn_detached(&self, bin: &str, args: &[String], mut opts: SpawnOpts) -> Result<u32> {
        opts.env = with_handed_path(opts.env.for_program(bin));
        check_cwd(opts.cwd.as_deref())?;
        let r = resolve_for(bin, args, &opts);
        let mut cmd = tokio::process::Command::new(&r.command);
        detached_args(&mut cmd, &r);
        if let Some(cwd) = &opts.cwd {
            cmd.current_dir(cwd);
        }
        if opts.env.clear {
            cmd.env_clear();
        }
        for k in &opts.env.remove {
            cmd.env_remove(k);
        }
        cmd.envs(opts.env.set.iter().map(|(k, v)| (k, v)));
        cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).kill_on_drop(false);
        detach(&mut cmd);
        let mut child = cmd.spawn().map_err(|e| ProcError::from_spawn(bin, &e))?;
        let pid = child.id().unwrap_or(0);
        // Reaped when it ends, never killed with wisp.
        tokio::spawn(async move {
            let _ = child.wait().await;
        });
        Ok(pid)
    }

    fn live(&self) -> usize {
        // The registry drops a child in a task that runs after `exited`; on a busy runtime that's later, so
        // count by the exit itself: once `exited()` resolved, the child is never live.
        self.reg.live.lock().unwrap_or_else(PoisonError::into_inner).values().filter(|h| h.running()).count()
    }

    fn kill_all(&self, grace: Duration) -> BoxFuture<'static, ()> {
        let handles: Vec<ChildHandle> = self.reg.live.lock().unwrap_or_else(PoisonError::into_inner).values().cloned().collect();
        Box::pin(async move {
            let kills: Vec<_> = handles.iter().map(|h| tokio::spawn(h.kill_with(Signal::Term, grace))).collect();
            for k in kills {
                let _ = k.await;
            }
        })
    }
}

#[cfg(unix)]
fn detached_args(cmd: &mut tokio::process::Command, r: &Resolved) {
    cmd.args(&r.args);
}

#[cfg(windows)]
fn detached_args(cmd: &mut tokio::process::Command, r: &Resolved) {
    if r.verbatim {
        for a in &r.args {
            cmd.raw_arg(a);
        }
    } else {
        cmd.args(&r.args);
    }
}

/// Its own session: closing wisp (or its terminal) doesn't reach it.
#[cfg(unix)]
fn detach(cmd: &mut tokio::process::Command) {
    cmd.process_group(0);
}

/// Its own console window and process group, outside any job of ours.
#[cfg(windows)]
fn detach(cmd: &mut tokio::process::Command) {
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
}

/// Runs `child` to completion for `exec`: input in, output kept up to the cap, the tree killed on timeout.
pub(crate) async fn collect(child: Child, opts: ExecOpts) -> Result<ExecResult> {
    let (handle, mut output) = child.split();
    if let Some(input) = opts.input {
        let _ = handle.write(input);
    }
    handle.close_stdin();
    let max = if opts.max_output == 0 { MAX_EXEC_OUTPUT } else { opts.max_output };
    let (mut stdout, mut stderr, mut truncated, mut timed_out) = (Vec::new(), Vec::new(), false, false);
    let deadline = opts.timeout.map(|t| tokio::time::Instant::now() + t);
    loop {
        let next = match deadline {
            Some(at) => {
                if let Ok(v) = tokio::time::timeout_at(at, output.recv()).await {
                    v
                } else {
                    timed_out = true;
                    handle.kill_now().await;
                    break;
                }
            }
            None => output.recv().await,
        };
        let Some(chunk) = next else { break };
        let buf = if chunk.stream == Stream::Stdout { &mut stdout } else { &mut stderr };
        let room = max.saturating_sub(buf.len());
        truncated |= chunk.data.len() > room;
        buf.extend_from_slice(&chunk.data[..chunk.data.len().min(room)]);
    }
    let exit = handle.exited().await;
    Ok(ExecResult { exit, stdout, stderr, timed_out, truncated })
}
