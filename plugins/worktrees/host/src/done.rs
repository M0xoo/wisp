//! Done asks about the worktree (v1 services/done-folders.js): `list` for the dialog, `apply` for the
//! user's answer, `tidy` when there's nobody to ask. The rules are wisp-worktrees-core's `done` module.

use std::collections::HashMap;
use std::time::Duration;

use wisp_kernel::Call;
use wisp_proc::ExecOpts;
use wisp_worktrees_api::{DoneApplyArgs, DoneApplyOut, DoneList, FailedRemoval, FolderRow, RemoveOpts, Worktree};
use wisp_worktrees_core::done::{self, DoneFolder, DoneTask};

use crate::engine::Engine;
use crate::error::{Result, WtError};
use crate::fsx;
use crate::ports::{Port, TaskInfo};

async fn graph(e: &Engine, tasks: &[TaskInfo]) -> (Vec<DoneTask>, HashMap<String, Worktree>) {
    let mut by_path = HashMap::new();
    let mut out = Vec::with_capacity(tasks.len());
    for t in tasks {
        let mut folders = Vec::new();
        for x in &t.trees {
            let w = &x.worktree;
            let on_disk = !w.path.is_empty() && fsx::exists(&w.path).await;
            folders.push(DoneFolder { path: w.path.clone(), branch: w.branch.clone(), on_disk, foreign: e.foreign(w), pr: x.pr.clone() });
            by_path.entry(w.path.clone()).or_insert_with(|| w.clone());
        }
        out.push(DoneTask { id: t.id.clone(), title: t.title.clone(), kids: t.kids.clone(), parent_id: t.parent_id.clone(), group_id: t.group_id.clone(), done: t.done, busy: t.busy, kept: t.kept, parked: t.parked, folders });
    }
    (out, by_path)
}

/// Bytes under one folder, or None (no du, or too slow to wait for).
async fn size_of(e: &Engine, dir: &str) -> Option<u64> {
    let r = e.proc.exec("du", &["-sk".into(), dir.into()], ExecOpts { timeout: Some(Duration::from_secs(15)), ..ExecOpts::default() }).await.ok()?;
    let out = r.stdout_text();
    out.split('\t').next()?.trim().parse::<u64>().ok().map(|k| k * 1024)
}

/// One row a folder, in-use ones left out (nothing to decide on them now). `sizes: false` answers at
/// once (du over a big node_modules takes seconds); the page asks again for them.
pub async fn list(e: &Engine, port: &dyn Port, call: &Call, session: &str, sizes: bool) -> DoneList {
    let tasks = port.tasks().await;
    let (g, by_path) = graph(e, &tasks).await;
    let setting = done::on_done(port.settings().await.on_done.as_deref());
    let mut rows = Vec::new();
    for (t, f) in done::folders(&g, session) {
        if t.busy {
            continue;
        }
        let Some(wt) = by_path.get(&f.path) else { continue };
        let (only, st, size) = tokio::join!(e.folder_only(call, wt), e.status(call, wt, None), async { if sizes { size_of(e, &wt.path).await } else { None } });
        let st = st.ok();
        rows.push(FolderRow {
            path: f.path.clone(),
            task: t.id.clone(),
            title: t.title.clone(),
            own: t.id == session,
            branch: f.branch.clone(),
            size,
            only: only.ok(),
            uncommitted: st.map(|s| s.dirty),
            unpushed: st.map_or(0, |s| s.unpushed),
            pr: f.pr.clone(),
            kept: t.kept,
        });
    }
    DoneList { folders: rows, on_done: setting }
}

/// The user's answer. Only folders `list` would show; a removal that fails keeps the folder (pinned)
/// and says why.
pub async fn apply(e: &Engine, port: &dyn Port, call: &Call, args: &DoneApplyArgs) -> Result<DoneApplyOut> {
    let tasks = port.tasks().await;
    let (g, by_path) = graph(e, &tasks).await;
    done::check_paths(&g, &args.session_id, &args.remove, &args.keep).map_err(WtError::Invalid)?;
    let holder: HashMap<String, &DoneTask> = done::folders(&g, &args.session_id).into_iter().map(|(t, f)| (f.path.clone(), t)).collect();
    let mut out = DoneApplyOut::default();
    for p in &args.keep {
        if let Some(t) = holder.get(p).filter(|t| !t.kept) {
            port.set_kept(t.id.clone(), true).await;
        }
        out.kept.push(p.clone());
    }
    for p in &args.remove {
        let (Some(t), Some(wt)) = (holder.get(p), by_path.get(p)) else { continue };
        let forced = args.force.contains(p);
        let r = if t.busy { None } else { Some(e.remove(call, wt, RemoveOpts { strict: !forced, force: forced, ..RemoveOpts::default() }, Some(&|| true)).await) };
        match r {
            Some(Ok(r)) if r.removed => {
                if t.kept {
                    port.set_kept(t.id.clone(), false).await;
                }
                out.removed.push(p.clone());
            }
            other => {
                port.set_kept(t.id.clone(), true).await;
                let (error, dirty) = match other {
                    Some(Err(err)) => (Some(err.to_string()), None),
                    Some(Ok(r)) => (None, r.dirty),
                    None => (None, None),
                };
                out.failed.push(FailedRemoval { path: p.clone(), error: done::failure_text(t.busy, error.as_deref(), dirty) });
            }
        }
    }
    Ok(out)
}

/// Done with nobody to ask: only what nothing would be lost from, and nothing on an open PR. Kept tasks
/// and the Keep setting are left alone. The paths removed.
pub async fn tidy(e: &Engine, port: &dyn Port, call: &Call, session: &str) -> Vec<String> {
    let tasks = port.tasks().await;
    let (g, by_path) = graph(e, &tasks).await;
    let setting = done::on_done(port.settings().await.on_done.as_deref());
    let mut only = HashMap::new();
    for (_, f) in done::folders(&g, session) {
        if let Some(wt) = by_path.get(&f.path) {
            only.insert(f.path.clone(), e.folder_only(call, wt).await.ok());
        }
    }
    let mut gone = Vec::new();
    for f in done::tidy_candidates(&g, session, setting, |p| only.get(p).copied().flatten()) {
        let Some(wt) = by_path.get(&f.path) else { continue };
        if e.remove(call, wt, RemoveOpts { strict: true, ..RemoveOpts::default() }, None).await.is_ok_and(|r| r.removed) {
            gone.push(f.path.clone());
        }
    }
    gone
}
