//! A new worktree is a fresh checkout: what git ignores (`.env`, local config, a built cache) isn't in it,
//! and some repos need a step first. So, as Claude Code, Cursor and Conductor do, wisp copies what
//! `.worktreeinclude` names (copy-on-write where the file system has it) and runs the repo's setup with
//! ROOT_WORKTREE_PATH set. Never fails the launch: what went wrong is returned for the task to say.

use std::collections::HashSet;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::time::Duration;

use wisp_proc::{Env, ExecOpts};
use wisp_worktrees_api::{Prepared, SetupEnvCtx, SourceScripts, TrustItem, Worktree};
use wisp_worktrees_core::include;
use wisp_worktrees_core::setup::{self, RepoSetup};

use crate::engine::Engine;
use crate::fsx;

/// The ignored files and folders of `root` that `.worktreeinclude` (or the default) names.
///
/// git.service@1 has no ignored-paths listing yet (`Repo::ignored` is requested), so this reads the
/// root's own entries plus each literal path a pattern names. What's tracked is already in the new
/// checkout and `copy_included` skips anything already there, so the result is the same for the
/// patterns repos use (`.env*`, `node_modules/`, `config/local.json`).
pub async fn included_paths(root: &str) -> Vec<String> {
    let file = fsx::read_opt(fsx::join(root, ".worktreeinclude")).await;
    let pats = include::patterns(file.as_deref());
    if pats.is_empty() {
        return Vec::new();
    }
    let mut listing: Vec<String> = fsx::entries(root).await.into_iter().filter(|(n, _)| n != ".git").map(|(n, d)| if d { format!("{n}/") } else { n }).collect();
    for line in file.as_deref().unwrap_or("").lines().map(str::trim) {
        let lit = line.trim_start_matches('/').trim_end_matches('/');
        if lit.contains('/') && !lit.contains(['*', '?']) && !line.starts_with(['#', '!']) {
            if let Ok(m) = tokio::fs::metadata(fsx::join(root, lit)).await {
                listing.push(if m.is_dir() { format!("{lit}/") } else { lit.to_owned() });
            }
        }
    }
    listing.sort();
    let mut seen = HashSet::new();
    include::included(&pats, &listing.join("\0")).into_iter().filter(|p| seen.insert(p.clone())).collect()
}

#[derive(Debug, Default)]
pub struct Copied {
    pub copied: Vec<String>,
    pub problems: Vec<String>,
    /// bytes that share the checkout's blocks rather than take new ones
    pub cloned: u64,
}

/// The included files from the checkout into `dir`. Never fails.
pub async fn copy_included(e: &Engine, root: &str, dir: &str) -> Copied {
    let mut out = Copied::default();
    for rel in included_paths(root).await {
        let clean = rel.trim_end_matches('/'); // `cp -R dir/` would copy what's in it
        let (from, to) = (fsx::join(root, clean), fsx::join(dir, clean));
        if fsx::exists(&to).await {
            continue;
        }
        let done = match fsx::mkdirp(fsx::parent(&to)).await {
            Ok(()) => clone_or_copy(e, &from, &to).await,
            Err(err) => Err(err),
        };
        match done {
            Ok(shared) => {
                if shared {
                    out.cloned += disk_bytes(&from).await;
                }
                out.copied.push(clean.to_owned());
            }
            Err(err) => out.problems.push(format!("couldn't copy {rel}: {err}")),
        }
    }
    out
}

/// Copy-on-write through the system's cp (`cp -c -R` on APFS, `--reflink=always` on Linux); a cp that
/// fails or isn't there leaves nothing behind and the copy is a plain one. true: the blocks are shared.
pub async fn clone_or_copy(e: &Engine, from: &str, to: &str) -> std::io::Result<bool> {
    clone_or_copy_with(e, from, to, e.platform, "cp").await
}

pub async fn clone_or_copy_with(e: &Engine, from: &str, to: &str, platform: &str, cp: &str) -> std::io::Result<bool> {
    if let Some(flags) = include::cow_args(platform) {
        let mut args: Vec<String> = flags.iter().map(|s| (*s).to_owned()).collect();
        args.extend([from.to_owned(), to.to_owned()]);
        let opts = ExecOpts { timeout: Some(Duration::from_millis(setup::SETUP_TIMEOUT_MS)), ..ExecOpts::default() };
        match e.proc.exec(cp, &args, opts).await {
            Ok(r) if r.exit.success() => return Ok(platform == "linux" || same_device(from, &fsx::parent(to)).await),
            _ => fsx::rm_rf(to).await, // what it got through before it gave up
        }
    }
    copy_tree(PathBuf::from(from), PathBuf::from(to)).await?;
    Ok(false)
}

/// `cp -c` clones only within one volume and copies quietly otherwise.
async fn same_device(a: &str, b: &str) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        match (tokio::fs::symlink_metadata(a).await, tokio::fs::metadata(b).await) {
            (Ok(x), Ok(y)) => x.dev() == y.dev(),
            _ => false,
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (a, b);
        false
    }
}

type Boxed = Pin<Box<dyn Future<Output = std::io::Result<()>> + Send>>;

/// A plain recursive copy that keeps modes and symlinks as they were.
fn copy_tree(from: PathBuf, to: PathBuf) -> Boxed {
    Box::pin(async move {
        let meta = tokio::fs::symlink_metadata(&from).await?;
        if meta.file_type().is_symlink() {
            let target = tokio::fs::read_link(&from).await?;
            #[cfg(unix)]
            return tokio::fs::symlink(target, &to).await;
            #[cfg(not(unix))]
            return tokio::fs::copy(&from, &to).await.map(|_| drop(target));
        }
        if meta.is_dir() {
            tokio::fs::create_dir_all(&to).await?;
            let mut rd = tokio::fs::read_dir(&from).await?;
            while let Some(ent) = rd.next_entry().await? {
                copy_tree(ent.path(), to.join(ent.file_name())).await?;
            }
            return Ok(());
        }
        tokio::fs::copy(&from, &to).await.map(|_| ())
    })
}

/// The disk a tree takes, each inode once (pnpm's hard links), symlinks not followed.
async fn disk_bytes(p: &str) -> u64 {
    let mut seen = HashSet::new();
    let mut stack = vec![PathBuf::from(p)];
    let mut total = 0;
    while let Some(at) = stack.pop() {
        let Ok(m) = tokio::fs::symlink_metadata(&at).await else { continue };
        if m.is_dir() {
            stack.extend(fsx::entries(&at).await.into_iter().map(|(n, _)| at.join(n)));
        } else if m.is_file() {
            total += file_bytes(&m, &mut seen);
        }
    }
    total
}

#[cfg(unix)]
fn file_bytes(m: &std::fs::Metadata, seen: &mut HashSet<u64>) -> u64 {
    use std::os::unix::fs::MetadataExt;
    if seen.insert(m.ino()) { m.blocks() * 512 } else { 0 }
}

#[cfg(not(unix))]
fn file_bytes(m: &std::fs::Metadata, _seen: &mut HashSet<u64>) -> u64 {
    m.len()
}

/// The setup a new worktree of `root` runs: own file, Cursor's, then the first contributed source.
pub async fn repo_setup(e: &Engine, root: &str) -> (RepoSetup, Option<(usize, SourceScripts)>) {
    let own = fsx::read_opt(fsx::join(root, setup::OWN_FILE)).await;
    let cursor = fsx::read_opt(fsx::join(root, setup::CURSOR_FILE)).await;
    let mut other = None;
    for (i, s) in e.sources.iter().enumerate() {
        if let Some(sc) = s.read(root).await {
            other = Some((i, sc));
            break;
        }
    }
    (setup::repo_setup(own.as_deref(), cursor.as_deref(), other.as_ref().map(|(_, s)| s)), other)
}

fn source_env(e: &Engine, rs: &RepoSetup, other: Option<&(usize, SourceScripts)>, ctx: &SetupEnvCtx) -> Vec<(String, String)> {
    // only a setup that came from the source gets its env (wisp's own file gets none of Conductor's vars)
    match other {
        Some((i, sc)) if rs.file.as_deref() == Some(sc.file.as_str()) => e.sources.get(*i).map(|s| s.env(ctx)).unwrap_or_default(),
        _ => Vec::new(),
    }
}

/// The steps in order in `dir`; stops at the first that fails (the next likely needs it).
pub async fn run_setup(e: &Engine, root: &str, dir: &str, commands: &[String], env: &[(String, String)]) -> (Vec<String>, Vec<String>) {
    let (mut ran, mut problems) = (Vec::new(), Vec::new());
    let shell = std::env::var("SHELL").ok();
    let comspec = std::env::var("ComSpec").ok();
    for cmd in commands {
        let (bin, args) = setup::shell_argv(e.platform == "windows", shell.as_deref(), comspec.as_deref(), cmd);
        let vars = env.iter().fold(Env::default().with("ROOT_WORKTREE_PATH", root), |v, (k, x)| v.with(k.clone(), x.clone()));
        let opts = ExecOpts { cwd: Some(Path::new(dir).to_path_buf()), env: vars, timeout: Some(Duration::from_millis(setup::SETUP_TIMEOUT_MS)), ..ExecOpts::default() };
        match e.proc.exec(&bin, &args, opts).await {
            Ok(r) if r.exit.success() => ran.push(cmd.clone()),
            Ok(r) => {
                let why = if r.timed_out { "timed out".to_owned() } else { format!("exit {}", r.exit.shell_code()) };
                problems.push(setup::step_failed(cmd, &r.stderr_text(), &why));
                break;
            }
            Err(err) => {
                problems.push(setup::step_failed(cmd, "", &err.to_string()));
                break;
            }
        }
    }
    (ran, problems)
}

/// Copy, then set up. `hold`: the steps the repo isn't trusted for: they wait in `held`.
pub async fn prepare(e: &Engine, root: &str, dir: &str, hold: Option<Vec<TrustItem>>, branch: &str) -> Prepared {
    let Copied { copied, mut problems, cloned } = copy_included(e, root, dir).await;
    let (rs, other) = repo_setup(e, root).await;
    problems.extend(rs.problem.clone());
    let cloned = (cloned > 0).then_some(cloned);
    if let Some(held) = hold.filter(|h| !h.is_empty()) {
        return Prepared { copied, ran: Vec::new(), problems, held: Some(held), cloned };
    }
    let env = source_env(e, &rs, other.as_ref(), &SetupEnvCtx { root: root.into(), dir: dir.into(), branch: branch.into() });
    let (ran, more) = run_setup(e, root, dir, &rs.commands, &env).await;
    problems.extend(more);
    Prepared { copied, ran, problems, held: None, cloned }
}

/// Trust and start: the held steps run now (a setup from a contributed source keeps its env).
pub async fn run_held(e: &Engine, wt: &Worktree) -> Option<Prepared> {
    let mut p = wt.prepared.clone()?;
    let held = p.held.take()?;
    let commands: Vec<String> = held.iter().map(|x| x.command.clone()).collect();
    let (rs, other) = repo_setup(e, &wt.root).await;
    let env = source_env(e, &rs, other.as_ref(), &SetupEnvCtx { root: wt.root.clone(), dir: wt.path.clone(), branch: wt.base.clone() });
    let (ran, problems) = run_setup(e, &wt.root, &wt.path, &commands, &env).await;
    p.ran.extend(ran);
    p.problems.extend(problems);
    Some(p)
}
