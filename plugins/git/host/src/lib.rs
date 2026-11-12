//! wisp-git (`wisp.git`): provides `git.service@1` (plan §6.11.1, the worked example of a plugin service)
//! and the `git.*` commands. Every git and gh call runs async through the kernel's proc service
//! (`wisp_proc::Proc`): nothing blocks a runtime thread, and the pure logic lives in wisp-git-core.

mod changes;
mod checkpoint;
pub mod commands;
mod error;
mod read;
mod repo;
mod place;
pub mod run;
pub mod service;
mod shared;
mod write;

use std::sync::Arc;

use wisp_git_api::commands::{
    Checkout, Clone as CloneCmd, Commit, GetChanges, GetOrigin, GetStatus, GetTools, Revert, Stage,
};
use wisp_git_api::{Blobs, GitServiceV1};
use wisp_kernel::{Manifest, Plugin, Result, Setup, WireError};
use wisp_proc::Proc;

pub use error::GitError;

/// Where a repo is cloned when no folder is named (v1 `defaults.cloneDir`).
pub const CLONE_DIR: &str = "git.cloneDir";
pub use repo::RepoImpl;
pub use service::{GitServiceImpl, Service};
pub use shared::Now;

#[derive(Debug, Default)]
pub struct GitPlugin {
    /// a git to run instead of the one found on PATH (tests; v1's `WISP_GIT_BIN`)
    pub git_bin: Option<String>,
}

/// The service on its own, for an install or a test that has a proc service but no kernel yet.
pub fn service(
    proc: Proc,
    blobs: Option<Arc<dyn Blobs>>,
    now: Now,
    git_bin: Option<String>,
) -> Arc<GitServiceImpl> {
    GitServiceImpl::new(run::Git::new(proc, git_bin), blobs, now)
}

fn system_now() -> Now {
    Arc::new(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
    })
}

/// `.env` files show masked in Changes (v1 `defaults.maskEnvFiles`): on unless off.
pub const MASK_ENV: &str = "git.maskEnvFiles";

/// The setting as stored: off only when `false` (or v1's `"off"`).
pub fn mask_env(v: Option<&serde_json::Value>) -> bool {
    !(matches!(v, Some(serde_json::Value::Bool(false))) || v.and_then(serde_json::Value::as_str) == Some("off"))
}

impl Plugin for GitPlugin {
    fn manifest(&self) -> Manifest {
        Manifest::embedded(include_str!("../wisp-plugin.json"))
    }

    fn setup(&self, s: &mut Setup) -> Result<()> {
        let ctx = s.ctx();
        let proc = ctx.service::<Proc>()?;
        let blobs = ctx.service::<Arc<dyn Blobs>>().ok().map(|b| (*b).clone());
        let now: Now = match ctx.clock() {
            Ok(c) => Arc::new(move || c.now_ms()),
            Err(_) => system_now(),
        };
        let svc = service((*proc).clone(), blobs, now, self.git_bin.clone());
        s.provide::<GitServiceV1>(Arc::new(Service(svc.clone())));
        let w = |e: GitError| WireError::from(e);
        let sv = svc.clone();
        s.command::<GetStatus, _, _>(move |_ctx, _call, a| {
            let sv = sv.clone();
            async move {
                let (r, _l) = commands::handle(&sv, &a.path).await.map_err(w)?;
                r.inner.status().await.map_err(w)
            }
        });
        let sv = svc.clone();
        s.command::<GetChanges, _, _>(move |ctx, _call, mut a| {
            let sv = sv.clone();
            // v1 `defaults.maskEnvFiles`: on unless switched off, whatever the caller asked
            a.mask = a.mask && mask_env(ctx.setting(MASK_ENV).as_ref());
            async move { commands::changes(&sv, a).await.map_err(w) }
        });
        let sv = svc.clone();
        s.command::<Revert, _, _>(move |_ctx, _call, a| {
            let sv = sv.clone();
            async move { commands::revert(&sv, a).await.map_err(w) }
        });
        let sv = svc.clone();
        s.command::<Stage, _, _>(move |_ctx, _call, a| {
            let sv = sv.clone();
            async move { commands::stage(&sv, a).await.map_err(w) }
        });
        let sv = svc.clone();
        s.command::<Commit, _, _>(move |_ctx, _call, a| {
            let sv = sv.clone();
            async move { commands::commit(&sv, a).await.map_err(w) }
        });
        let sv = Service(svc.clone());
        s.command::<GetTools, _, _>(move |_ctx, call, ()| {
            let sv = sv.clone();
            async move { wisp_git_api::GitService::tools(&sv, &call).await }
        });
        checkpoint::register(s, &svc);
        // a task's folder on another computer (v1 places.js): its repo here, and that computer's checkout of it
        let sv = svc.clone();
        s.command::<GetOrigin, _, _>(move |_ctx, call, a| {
            let sv = sv.clone();
            async move {
                call.require("git:read")?;
                Ok(sv.origin_at(&a.path).await)
            }
        });
        let sv = svc.clone();
        s.command::<Checkout, _, _>(move |ctx, call, a| {
            let sv = sv.clone();
            async move {
                call.require("git:clone")?;
                let home = std::env::var("HOME").unwrap_or_default();
                let set = ctx.setting(CLONE_DIR);
                let parent = wisp_git_core::repo_url::clone_root(set.as_ref().and_then(|v| v.as_str()), &home, |d| std::path::Path::new(d).is_dir());
                sv.checkout(a, &home, parent).await.map_err(w)
            }
        });
        let sv = Service(svc);
        s.command::<CloneCmd, _, _>(move |ctx, call, mut a| {
            let sv = sv.clone();
            async move {
                // no folder named: where Settings → Projects → clone into says (v1 defaults.cloneDir)
                if a.parent.trim().is_empty() {
                    let home = std::env::var("HOME").unwrap_or_default();
                    let set = ctx.setting(CLONE_DIR);
                    a.parent = wisp_git_core::repo_url::clone_root(set.as_ref().and_then(|v| v.as_str()), &home, |d| std::path::Path::new(d).is_dir());
                }
                wisp_git_api::GitService::clone_repo(&sv, &call, a).await
            }
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn manifest_is_valid() {
        let m = wisp_kernel::Plugin::manifest(&super::GitPlugin::default());
        assert_eq!(m.id, "wisp.git", "{:?}", m.description);
        assert!(m.provides.contains_key("git.service"));
    }

    #[test]
    fn env_files_are_masked_unless_switched_off() {
        assert!(super::mask_env(None));
        assert!(super::mask_env(Some(&serde_json::json!(true))));
        assert!(!super::mask_env(Some(&serde_json::json!(false))));
        assert!(!super::mask_env(Some(&serde_json::json!("off"))), "v1's value");
    }
}
