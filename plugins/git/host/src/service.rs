//! `git.service@1`: repo handles cached per path and owned by the callers' scopes (plan §6.11.1). The
//! first `repo(path)` asks git where the folder's worktree and main checkout are (one call); later ones
//! reuse the handle, warm. A handle goes when the last owner scope that asked for it is cancelled.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use wisp_git_api::{Blobs, CloneRequest, Cloned, Fut, GitService, Repo, RepoInfo, Tools};
use wisp_kernel::{Call, CancellationToken, WireError};

use crate::error::{GitError, Result};
use crate::repo::{Inner, RepoImpl};
use crate::run::{Git, Opts, args};
use crate::shared::{Now, RootState};

struct Entry {
    repo: RepoImpl,
    owners: usize,
}

pub struct GitServiceImpl {
    pub(crate) git: Arc<Git>,
    blobs: Option<Arc<dyn Blobs>>,
    now: Now,
    repos: Mutex<HashMap<PathBuf, Entry>>,
    roots: Mutex<HashMap<PathBuf, Arc<RootState>>>,
}

impl std::fmt::Debug for GitServiceImpl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GitService")
            .field("repos", &self.cached())
            .finish_non_exhaustive()
    }
}

impl GitServiceImpl {
    pub fn new(git: Arc<Git>, blobs: Option<Arc<dyn Blobs>>, now: Now) -> Arc<Self> {
        Arc::new(Self {
            git,
            blobs,
            now,
            repos: Mutex::new(HashMap::new()),
            roots: Mutex::new(HashMap::new()),
        })
    }

    /// Handles held right now.
    pub fn cached(&self) -> usize {
        self.repos.lock().map(|m| m.len()).unwrap_or(0)
    }

    fn root_state(&self, root: &Path) -> Arc<RootState> {
        match self.roots.lock() {
            Ok(mut m) => m
                .entry(root.to_path_buf())
                .or_insert_with(RootState::new)
                .clone(),
            Err(_) => RootState::new(),
        }
    }

    /// The cached handle for `path` with one more owner, if there is one.
    fn reuse(&self, path: &Path) -> Option<RepoImpl> {
        let mut m = self.repos.lock().ok()?;
        let e = m.get_mut(path)?;
        e.owners += 1;
        Some(e.repo.clone())
    }

    fn release(&self, path: &Path) {
        if let Ok(mut m) = self.repos.lock()
            && let Some(e) = m.get_mut(path)
        {
            e.owners = e.owners.saturating_sub(1);
            if e.owners == 0 {
                m.remove(path);
            }
        }
    }

    pub(crate) async fn open(
        self: Arc<Self>,
        owner: CancellationToken,
        path: String,
    ) -> Result<RepoImpl> {
        let dir = tokio::fs::canonicalize(&path)
            .await
            .map_err(|_| GitError::NoFolder(path.clone()))?;
        let repo = match self.reuse(&dir) {
            Some(r) => r,
            None => {
                let r = self.resolve(&dir).await?;
                let mut m = self
                    .repos
                    .lock()
                    .map_err(|_| GitError::Io("repo cache".into()))?;
                let e = m.entry(dir.clone()).or_insert(Entry { repo: r, owners: 0 });
                e.owners += 1;
                e.repo.clone()
            }
        };
        let me = self.clone();
        tokio::spawn(async move {
            owner.cancelled().await;
            me.release(&dir);
        });
        Ok(repo)
    }

    /// One `rev-parse` for the worktree's top and the common git dir (the main checkout is its parent).
    async fn resolve(&self, dir: &Path) -> Result<RepoImpl> {
        let out = self
            .git
            .read(
                dir,
                &[
                    "rev-parse",
                    "--path-format=absolute",
                    "--show-toplevel",
                    "--git-common-dir",
                ],
            )
            .await
            .map_err(|_| GitError::NotARepo(dir.display().to_string()))?;
        let mut lines = out.lines();
        let top = canonical(lines.next().unwrap_or_default()).await;
        let common = canonical(lines.next().unwrap_or_default()).await;
        let root = if common.file_name().is_some_and(|n| n == ".git") {
            common.parent().map_or(common.clone(), Path::to_path_buf)
        } else {
            common
        };
        let sub = dir
            .strip_prefix(&top)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        let info = RepoInfo {
            path: dir.display().to_string(),
            top: top.display().to_string(),
            root: root.display().to_string(),
            sub,
        };
        let shared = self.root_state(&root);
        let inner = Inner {
            info,
            dir: dir.to_path_buf(),
            root,
            git: self.git.clone(),
            shared,
            blobs: self.blobs.clone(),
            now: self.now.clone(),
        };
        Ok(RepoImpl {
            inner: Arc::new(inner),
        })
    }

    async fn clone_repo_into(&self, req: CloneRequest) -> Result<Cloned> {
        let repo = wisp_git_core::repo_url::parse_repo(&req.url, false)
            .ok_or_else(|| GitError::Refused(format!("{} isn’t a repo URL", req.url)))?;
        tokio::fs::create_dir_all(&req.parent).await?;
        let parent = PathBuf::from(&req.parent);
        let mut dir = parent.join(&repo.name);
        let mut n = 2;
        while tokio::fs::metadata(&dir).await.is_ok() {
            let origin = self.git.quiet(&dir, &["remote", "get-url", "origin"]).await;
            let top = self
                .git
                .quiet(&dir, &["rev-parse", "--show-toplevel"])
                .await;
            if !origin.is_empty()
                && canonical(&top).await == canonical(&dir.to_string_lossy()).await
                && wisp_git_core::repo_url::same_repo(&origin, &repo.url)
            {
                return Ok(Cloned {
                    dir: dir.display().to_string(),
                    existed: true,
                });
            }
            dir = parent.join(format!("{}-{n}", repo.name));
            n += 1;
        }
        let target = dir.to_string_lossy().into_owned();
        let mut last = String::new();
        let mut tries: Vec<(String, Vec<String>)> = Vec::new();
        if let Some(gh) = &repo.gh {
            tries.push(("gh".into(), args(&["repo", "clone", gh, &target])));
        }
        tries.push((
            self.git.bin().await,
            args(&["clone", "--quiet", &repo.url, &target]),
        ));
        for (bin, a) in tries {
            match self
                .git
                .exec_bin(&bin, &parent, &a, Opts::timeout(600))
                .await
                .and_then(|r| crate::run::check(&r))
            {
                Ok(()) => {
                    return Ok(Cloned {
                        dir: target,
                        existed: false,
                    });
                }
                Err(e) => {
                    last = e.to_string();
                    let _ = tokio::fs::remove_dir_all(&dir).await; // a half clone would block the next try
                }
            }
        }
        let what = repo.gh.clone().unwrap_or(repo.url.clone());
        Err(GitError::Refused(wisp_git_core::tools::clone_error(
            &what,
            &last,
            repo.gh.is_some(),
        )))
    }

    async fn probe(&self) -> Tools {
        let os = match std::env::consts::OS {
            "macos" => "macos",
            "windows" => "windows",
            _ => "linux",
        };
        let here = std::env::temp_dir();
        let g = self
            .git
            .exec(&here, &args(&["--version"]), Opts::timeout(8))
            .await;
        let gitv = match &g {
            Ok(r) => wisp_git_core::tools::git_state(
                r.exit.success(),
                &format!("{}{}", r.stdout_text(), r.stderr_text()),
                os,
            ),
            Err(_) => wisp_git_core::tools::git_state(false, "", os),
        };
        let h = self
            .git
            .exec_bin(
                "gh",
                &here,
                &args(&["auth", "status", "--hostname", "github.com"]),
                Opts::timeout(8),
            )
            .await;
        let ghv = match &h {
            Ok(r) => wisp_git_core::tools::gh_state(
                false,
                r.exit.success(),
                &format!("{}{}", r.stdout_text(), r.stderr_text()),
                os,
            ),
            Err(GitError::NotInstalled(_)) => wisp_git_core::tools::gh_state(true, false, "", os),
            Err(_) => wisp_git_core::tools::gh_state(false, false, "", os),
        };
        Tools { git: gitv, gh: ghv }
    }
}

async fn canonical(p: &str) -> PathBuf {
    tokio::fs::canonicalize(p)
        .await
        .unwrap_or_else(|_| PathBuf::from(p))
}

/// The service as plugins get it: an `Arc` around the cache.
#[derive(Debug, Clone)]
pub struct Service(pub Arc<GitServiceImpl>);

impl GitService for Service {
    fn repo(&self, call: &Call, owner: &CancellationToken, path: &str) -> Fut<Arc<dyn Repo>> {
        let ok = call.require("git:repo");
        let (me, owner, path) = (self.0.clone(), owner.clone(), path.to_owned());
        Box::pin(async move {
            ok?;
            let r = me.open(owner, path).await.map_err(WireError::from)?;
            Ok(Arc::new(r) as Arc<dyn Repo>)
        })
    }
    fn clone_repo(&self, call: &Call, req: CloneRequest) -> Fut<Cloned> {
        let ok = call.require("git:clone");
        let me = self.0.clone();
        Box::pin(async move {
            ok?;
            me.clone_repo_into(req).await.map_err(WireError::from)
        })
    }
    fn tools(&self, call: &Call) -> Fut<Tools> {
        let ok = call.require("git:read");
        let me = self.0.clone();
        Box::pin(async move {
            ok?;
            Ok(me.probe().await)
        })
    }
}
