//! wisp.machine's calls to other plugins, through their typed commands (`wisp-machines-api`,
//! `wisp-runtime-api`, `wisp-worktrees-api`).

use wisp_kernel::{Call, Ctx, Result};
use wisp_machine_api::this_mac::Facts;
use wisp_machine_core::this_mac::view::{TaskInfo, WtItem, WtLeftover, WtView};
use wisp_machines_api as m;
use wisp_runtime_api::commands as r;
use wisp_runtime_api::model::{Session, SessionState, Summary};
use wisp_runtime_api::paths::Folder;
use wisp_worktrees_api::{self as w, Standing, WorktreesView};

/// `machines.list`.
pub(crate) async fn peers(ctx: &Ctx, call: &Call) -> Result<Vec<m::PeerView>> {
    ctx.run::<m::List>(call, m::NoArgs {}).await
}

/// `machines.add`.
pub(crate) async fn add_peer(ctx: &Ctx, call: &Call, set: m::AddArgs) -> Result<()> {
    ctx.run::<m::Add>(call, set).await.map(drop)
}

/// `machines.update` of `id`.
pub(crate) async fn update_peer(ctx: &Ctx, call: &Call, id: String, set: m::AddArgs) -> Result<()> {
    ctx.run::<m::Update>(call, m::UpdateArgs { id, set }).await.map(drop)
}

/// `machines.remove`.
pub(crate) async fn remove_peer(ctx: &Ctx, call: &Call, id: String) -> Result<()> {
    ctx.run::<m::Remove>(call, m::IdArgs { id }).await.map(drop)
}

/// `runtime.list` (none, logged, when refused).
pub(crate) async fn tasks(ctx: &Ctx, call: &Call, archived: Option<bool>) -> Vec<Summary> {
    ctx.run::<r::List>(call, r::ListArgs { archived, limit: None }).await.unwrap_or_else(|err| {
        tracing::warn!(error = %err.message, "machine: runtime.list");
        Vec::new()
    })
}

/// `runtime.get`.
pub(crate) async fn session(ctx: &Ctx, call: &Call, id: &str) -> Result<Session> {
    ctx.run::<r::Get>(call, r::IdArgs { id: id.into() }).await
}

/// `runtime.create`: a task titled `title`, in `cwd` when it is a folder (else the runtime's default).
pub(crate) async fn create(ctx: &Ctx, call: &Call, prompt: String, title: String, cwd: Option<&str>) -> Result<String> {
    ctx.run::<r::Create>(call, start_args(prompt, title, cwd)).await.map(|c| c.id.0)
}

/// The task a fix files: a `cwd` that isn't a full path (empty, `.`) is left out, so the runtime picks its own
/// folder instead of resolving it against the server's.
fn start_args(prompt: String, title: String, cwd: Option<&str>) -> r::StartArgs {
    let cwd = cwd.and_then(|c| match Folder::of(c) {
        Ok(f) => Some(f.to_string()),
        Err(e) => {
            tracing::warn!(error = %e, "machine: a fix's folder");
            None
        }
    });
    r::StartArgs { prompt, title: Some(title), cwd, ..r::StartArgs::default() }
}

/// `worktrees.view` (none, logged, when refused: the page shows no worktrees).
pub(crate) async fn worktrees(ctx: &Ctx, call: &Call) -> Option<WtView> {
    match ctx.run::<w::View>(call, w::Empty {}).await {
        Ok(v) => Some(wt_of(&v)),
        Err(err) => {
            tracing::warn!(error = %err.message, "machine: worktrees.view");
            None
        }
    }
}

/// A state as This Mac names it (`running`, `review`, …).
fn state_name(s: SessionState) -> String {
    serde_json::to_value(s).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default()
}

/// A list row's task, as This Mac reads it.
pub(crate) fn task_of(s: &Summary) -> TaskInfo {
    TaskInfo { id: s.id.0.clone(), title: s.title.clone(), state: state_name(s.state), cwd: s.cwd.clone(), facts: Facts::default() }
}

/// A task as `runtime.get` answers it.
pub(crate) fn task_of_session(s: &Session) -> TaskInfo {
    TaskInfo { id: s.id.0.clone(), title: s.title.clone(), state: state_name(s.state), cwd: s.cwd.clone(), facts: Facts::default() }
}

/// Settings → Worktrees' answer, as much as This Mac reads.
pub(crate) fn wt_of(v: &WorktreesView) -> WtView {
    WtView {
        items: v.items.iter().map(|x| WtItem { id: x.id.clone(), idle: x.status == Standing::Idle, size: x.size }).collect(),
        leftovers: v.leftovers.iter().map(|x| WtLeftover { name: x.name.clone(), size: x.size, only: x.only }).collect(),
        size: v.size,
        disk: v.disk.map(|d| (d.free, d.total)),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    /// A fix filed from a task whose folder is relative or blank goes without one (the runtime's default),
    /// never with a path the server would resolve against its own folder.
    #[test]
    fn a_fix_never_carries_a_folder_that_isnt_a_full_path() {
        let a = |cwd| start_args("p".into(), "t".into(), cwd).cwd;
        assert_eq!(a(Some("/repo")), Some("/repo".to_owned()));
        assert_eq!(a(Some(".")), None);
        assert_eq!(a(Some("  ")), None);
        assert_eq!(a(Some("src")), None);
        assert_eq!(a(None), None);
    }

    /// worktrees.view's typed answer: the idle ones, the sizes, the disk.
    #[test]
    fn the_worktrees_view_is_read_from_its_typed_fields() {
        let v: WorktreesView = serde_json::from_value(serde_json::json!({
            "cleanup": "7", "max": "off", "ready": 0, "looking": false, "cleaning": null, "last": null, "size": 30,
            "disk": { "free": 1, "total": 2 },
            "items": [{ "id": "t1", "title": "", "project": "", "branch": "", "status": "idle", "only": 0, "size": 10, "usedAt": 0, "cleanAt": null },
                      { "id": "t2", "title": "", "project": "", "branch": "", "status": "busy", "only": 0, "size": null, "usedAt": 0, "cleanAt": null }],
            "leftovers": [{ "name": "x", "size": 5, "only": 2, "usedAt": 0 }]
        }))
        .unwrap();
        let w = wt_of(&v);
        assert_eq!(
            w.items.iter().map(|i| (i.id.as_str(), i.idle, i.size)).collect::<Vec<_>>(),
            [("t1", true, Some(10)), ("t2", false, None)]
        );
        assert_eq!((w.leftovers[0].name.as_str(), w.leftovers[0].size, w.leftovers[0].only), ("x", Some(5), Some(2)));
        assert_eq!((w.size, w.disk), (Some(30), Some((1, 2))));
    }

    /// The state names This Mac compares against (`running`) are runtime's wire names.
    #[test]
    fn states_are_named_as_on_the_wire() {
        assert_eq!(state_name(SessionState::Running), "running");
        assert_eq!(state_name(SessionState::Review), "review");
    }
}
