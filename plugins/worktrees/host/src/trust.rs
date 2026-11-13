//! Project trust's reads (the files a repo would make run) and the `before:run` interceptor that holds a
//! turn until they are trusted. The decisions are wisp-worktrees-core's `trust` module.

use serde_json::{Value, json};
use wisp_kernel::Verdict;
use wisp_runtime_api::harness::ProjectHooks;
use wisp_worktrees_api::{Pending, TrustItem};
use wisp_worktrees_core::trust::{self, TrustState};

use crate::engine::Engine;
use crate::fsx;

/// `{ top: the checkout dir is in, key: the repo's main checkout }`, or the folder itself for both
/// outside git. Reads `.git` (a worktree's is a file naming its gitdir) without running git: this is on
/// every run's path.
pub async fn repo_of(dir: &str) -> (String, String) {
    let start = fsx::real(dir).await;
    let mut d = std::path::PathBuf::from(&start);
    loop {
        let g = d.join(".git");
        match tokio::fs::metadata(&g).await {
            Ok(m) if m.is_dir() => {
                let s = d.to_string_lossy().into_owned();
                return (s.clone(), s);
            }
            Ok(_) => {
                let top = d.to_string_lossy().into_owned();
                let key = linked_key(&d, &g).await.unwrap_or_else(|| top.clone());
                return (top, key);
            }
            Err(_) => {}
        }
        if !d.pop() {
            return (start.clone(), start);
        }
    }
}

async fn linked_key(top: &std::path::Path, dot_git: &std::path::Path) -> Option<String> {
    let text = fsx::read_opt(dot_git).await?;
    let gitdir = top.join(text.lines().find_map(|l| l.strip_prefix("gitdir:"))?.trim());
    let common = fsx::read_opt(gitdir.join("commondir")).await?;
    let common = fsx::real(&gitdir.join(common.trim()).to_string_lossy()).await;
    Some(fsx::parent(&common))
}

/// A harness's items for a run in `dir` (`Harness::project_hooks`): its folder's files and, from a subfolder,
/// the checkout's. Never the home folder's (`~/.claude/settings.json` is the user's own).
pub async fn hook_items(dir: &str, user_home: &str, hooks: &ProjectHooks) -> Vec<TrustItem> {
    let at = fsx::real(dir).await;
    let home = fsx::real(user_home).await;
    let (top, _) = repo_of(dir).await;
    let mut out = Vec::new();
    for d in trust::claude_dirs(&at, &top, &home) {
        for f in &hooks.settings {
            let text = fsx::read_opt(fsx::join(d, f)).await;
            out.extend(trust::settings_items(text.as_deref(), &trust::relative(&at, &fsx::join(d, f))));
        }
        if let Some(m) = &hooks.mcp {
            let text = fsx::read_opt(fsx::join(d, m)).await;
            out.extend(trust::mcp_items(text.as_deref(), &trust::relative(&at, &fsx::join(d, m))));
        }
    }
    out
}

/// What the harness `agent` runs from a project's own files, from its plugin (`runtime.harness@1`).
pub fn hooks_of(ctx: &wisp_kernel::Ctx, agent: &str) -> Option<ProjectHooks> {
    ctx.contributions(&wisp_runtime_api::harness::HARNESS).iter().find(|h| h.info().id == agent).and_then(|h| h.project_hooks())
}

/// The setup steps a new worktree of `root` would run, as the card lists them.
pub async fn setup_items(e: &Engine, root: &str) -> Vec<TrustItem> {
    let (rs, _) = crate::prepare::repo_setup(e, root).await;
    trust::setup_items(rs.file.as_deref(), &rs.commands)
}

/// What a run in `dir` would run that isn't trusted: its harness's items (`hooks`; a harness that reads none
/// has none) plus `extra` (a new worktree's held setup).
pub async fn pending(
    st: &TrustState,
    dir: &str,
    hooks: Option<&ProjectHooks>,
    extra: Vec<TrustItem>,
    user_home: &str,
) -> Option<Pending> {
    // "" (or a relative path) walks up from the server's own folder: its `.git`, its `.claude/settings.json`
    if let Err(e) = wisp_runtime_api::paths::Folder::of(dir) {
        tracing::warn!("worktrees: trust not checked: the run has {e}");
        return None;
    }
    let (_, key) = repo_of(dir).await;
    let mut items = match hooks {
        Some(h) => hook_items(dir, user_home, h).await,
        None => Vec::new(),
    };
    items.extend(extra);
    st.untrusted(&key, items)
}

/// A new worktree's setup steps when they aren't trusted (they wait), else None.
pub async fn setup_hold(
    e: &Engine,
    st: &TrustState,
    root: &str,
    project_ask: Option<&str>,
    mode: &str,
) -> Option<Vec<TrustItem>> {
    if !trust::asks(project_ask, mode) || wisp_runtime_api::paths::Folder::of(root).is_err() {
        return None;
    }
    let (_, key) = repo_of(root).await;
    st.untrusted(&key, setup_items(e, root).await)
        .map(|p| p.items)
}

/// `before:run`, on runtime's context (read by field name: `cwd`, `agent`, `mode`, `hold`, `untrusted`).
/// Holds the turn with the card's items; a turn already held, run without them, or in Full auto passes.
pub async fn before_run(
    st: &TrustState,
    project_ask: Option<&str>,
    user_home: &str,
    hooks: Option<&ProjectHooks>,
    ctx: Value,
) -> Verdict<Value> {
    let s = |k: &str| ctx.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
    let already = ctx.get("hold").is_some_and(|h| !h.is_null())
        || ctx
            .get("untrusted")
            .and_then(Value::as_bool)
            .unwrap_or(false);
    if already || !trust::asks(project_ask, &s("mode")) {
        return Verdict::Continue;
    }
    let Some(p) = pending(st, &s("cwd"), hooks, Vec::new(), user_home).await else {
        return Verdict::Continue;
    };
    let mut held = ctx;
    if let Some(obj) = held.as_object_mut() {
        obj.insert(
            "hold".into(),
            json!({ "by": "wisp.worktrees", "kind": "trust", "data": p }),
        );
    }
    Verdict::Modify { ctx: held }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    /// No harness is named here: what a run would load from the project comes from its harness's hooks.
    #[tokio::test]
    async fn a_harness_with_project_hooks_lists_them_and_one_without_lists_none() {
        let dir = std::env::temp_dir().join(format!("wisp-trust-{}", std::process::id()));
        tokio::fs::create_dir_all(dir.join(".git")).await.unwrap();
        tokio::fs::write(dir.join(".mcp.json"), r#"{"mcpServers":{"db":{"command":"npx","args":["db-mcp"]}}}"#).await.unwrap();
        let d = dir.to_string_lossy().into_owned();
        let hooks = ProjectHooks { settings: vec![".claude/settings.json".into()], mcp: Some(".mcp.json".into()) };
        let items = hook_items(&d, "/nonexistent-home", &hooks).await;
        assert!(items.iter().any(|i| i.name == "db"), "{items:?}");
        let st = TrustState::default();
        assert!(pending(&st, &d, None, Vec::new(), "/nonexistent-home").await.is_none(), "a harness that reads no project files asks nothing");
        assert!(pending(&st, &d, Some(&hooks), Vec::new(), "/nonexistent-home").await.is_some());
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    /// A run with no folder is never checked against the server's own folder's `.git` and `.mcp.json`.
    #[tokio::test]
    async fn a_run_with_no_folder_reads_no_project_files_of_the_servers_own_folder() {
        let hooks = ProjectHooks { settings: vec![".claude/settings.json".into()], mcp: Some(".mcp.json".into()) };
        let st = TrustState::default();
        for dir in ["", "  ", ".", "relative/dir"] {
            assert!(pending(&st, dir, Some(&hooks), vec![trust::item(wisp_worktrees_api::TrustKind::Mcp, Some(".mcp.json"), "db", "npx db-mcp", None)], "/nonexistent-home").await.is_none(), "{dir:?}");
        }
    }
}
