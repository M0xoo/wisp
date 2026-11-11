//! The task's file view (v1 routes/workspace.js `/source`, `/files`): read a file of the task's folder, save it back
//! (refused while the agent works on the task, or when the file changed since it was opened), and list the folder's
//! files as git does. The folder is the task's worktree when it has one, else its folder. Reads and writes are async.

use std::path::PathBuf;
use std::time::Duration;

use serde_json::{Value, json};
use wisp_kernel::{Call, Ctx, Result, Setup, WireError};
use wisp_proc::{Env, ExecOpts, Proc};
use wisp_worktrees_api::{self as api, EXT};
use wisp_worktrees_core::source::{def_pattern, file_list, hash_of, hits, ident, inside, not_editable};

/// The task's folder and its state.
async fn folder(ctx: &Ctx, call: &Call, id: &str) -> Result<(PathBuf, String)> {
    let s = ctx.run_json(call, "runtime.get", json!({ "id": id })).await?;
    let tree = s.pointer(&format!("/ext/{EXT}/path")).and_then(Value::as_str).filter(|p| !p.is_empty());
    let cwd = s.get("cwd").and_then(Value::as_str).filter(|p| !p.is_empty());
    let root = tree.or(cwd).ok_or_else(|| WireError::not_found("This task has no folder."))?;
    let root = PathBuf::from(root);
    if !tokio::fs::metadata(&root).await.is_ok_and(|m| m.is_dir()) {
        return Err(WireError::not_found("This task's folder isn't here any more."));
    }
    Ok((root, s.get("state").and_then(Value::as_str).unwrap_or_default().to_owned()))
}

fn gone() -> WireError {
    WireError::not_found("That file isn't in this task's folder any more.")
}

pub(crate) fn register(s: &mut Setup) {
    s.command::<api::SourceCmd, _, _>(|ctx, call, a| async move {
        let (root, _) = folder(&ctx, &call, &a.id).await?;
        let file = inside(&root, &a.path).ok_or_else(gone)?;
        let bytes = tokio::fs::read(&file).await.map_err(|_| gone())?;
        if let Some(why) = not_editable(&bytes) {
            return Err(WireError::invalid(why));
        }
        let text = String::from_utf8(bytes).map_err(|_| WireError::invalid("Not a text file: open it in your editor."))?;
        Ok(api::Source { path: a.path.clone(), hash: hash_of(text.as_bytes()), text, root: root.display().to_string() })
    });
    s.command::<api::Save, _, _>(|ctx, call, a| async move {
        let (root, state) = folder(&ctx, &call, &a.id).await?;
        if state == "running" || state == "waiting" {
            return Err(WireError::conflict("The agent is working on this task: wait for it, or stop it, then save."));
        }
        if let Some(why) = not_editable(a.text.as_bytes()) {
            return Err(WireError::invalid(why));
        }
        let file = inside(&root, &a.path).ok_or_else(gone)?;
        let now = tokio::fs::read(&file).await.map_err(|_| gone())?;
        if !a.hash.is_empty() && hash_of(&now) != a.hash {
            return Err(WireError::conflict("The file changed since you opened it.").with_details(json!({ "text": String::from_utf8_lossy(&now), "hash": hash_of(&now) })));
        }
        tokio::fs::write(&file, a.text.as_bytes()).await.map_err(|e| WireError::internal(format!("couldn't save it: {e}")))?;
        Ok(api::Saved { hash: hash_of(a.text.as_bytes()) })
    });
    s.command::<api::Grep, _, _>(|ctx, call, a| async move {
        let (root, _) = folder(&ctx, &call, &a.id).await?;
        let name = ident(&a.def).ok_or_else(|| WireError::invalid("Go to definition looks for a name (letters, digits, _)."))?;
        let proc = ctx.service::<Proc>()?;
        let args: Vec<String> = ["grep", "-n", "-I", "-E", &def_pattern(name)].map(str::to_owned).to_vec();
        let opts = ExecOpts { cwd: Some(root), env: Env::default().with("GIT_OPTIONAL_LOCKS", "0"), timeout: Some(Duration::from_secs(15)), max_output: 1 << 20, ..ExecOpts::default() };
        Ok(match proc.exec("git", &args, opts).await {
            Ok(r) if r.exit.success() => hits(&r.stdout_text(), 20),
            _ => Vec::new(),
        })
    });
    s.command::<api::Files, _, _>(|ctx, call, a| async move {
        // a project of yours by its folder (New task's @), else the task's folder
        let root = if a.id.is_empty() {
            let mine = ctx.run_json(&call, "resources.export", json!({ "kinds": ["project"] })).await.unwrap_or_default();
            let known = mine.as_array().into_iter().flatten().any(|r| r.pointer("/spec/path").and_then(Value::as_str).is_some_and(|p| p.trim_end_matches('/') == a.path.trim_end_matches('/')));
            if !known {
                return Err(WireError::forbidden("Only a project of yours lists its files here."));
            }
            PathBuf::from(&a.path)
        } else {
            folder(&ctx, &call, &a.id).await?.0
        };
        let proc = ctx.service::<Proc>()?;
        let args: Vec<String> = ["ls-files", "--cached", "--others", "--exclude-standard", "-z"].map(str::to_owned).to_vec();
        let opts = ExecOpts { cwd: Some(root), env: Env::default().with("GIT_OPTIONAL_LOCKS", "0"), timeout: Some(Duration::from_secs(15)), max_output: 8 << 20, ..ExecOpts::default() };
        Ok(match proc.exec("git", &args, opts).await {
            Ok(r) if r.exit.success() => {
                let (files, more) = file_list(&r.stdout_text());
                api::FileList { files, more, git: true }
            }
            _ => api::FileList { files: Vec::new(), more: 0, git: false },
        })
    });
}
