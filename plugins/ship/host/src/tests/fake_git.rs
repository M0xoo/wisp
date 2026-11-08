//! A git.service@1 fake: per-folder dirty/ahead counts, commits and pushes recorded, merge-tree and
//! base-merged answers set by the test. A push moves the branch's head in the fake gh.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use wisp_git_api::*;
use wisp_kernel::{Call, CancellationToken, Result, WireError};

use super::fake_gh::FakeGh;

#[derive(Debug, Default)]
pub struct GitState {
    pub dirty: HashMap<String, u32>,
    pub ahead: HashMap<String, u32>,
    /// commits the remote branch has, per folder (None: never pushed)
    pub pushed: HashMap<String, u32>,
    /// range → count, ahead of the rules above (a merged PR's head)
    pub counts: HashMap<String, Option<u32>>,
    pub merge_tree: Option<MergeTree>,
    pub base_merged: Option<BaseMerged>,
    pub log: Vec<String>,
    pub push_fails: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct FakeGit {
    pub st: Arc<Mutex<GitState>>,
    pub gh: FakeGh,
}

impl FakeGit {
    pub fn lock(&self) -> std::sync::MutexGuard<'_, GitState> {
        self.st.lock().unwrap_or_else(PoisonError::into_inner)
    }
    pub fn logged(&self, prefix: &str) -> Vec<String> {
        self.lock()
            .log
            .iter()
            .filter(|l| l.starts_with(prefix))
            .cloned()
            .collect()
    }
}

type F<T> = wisp_git_api::Fut<T>;

fn done<T: Send + 'static>(v: T) -> F<T> {
    Box::pin(async move { Ok(v) })
}

impl GitService for FakeGit {
    fn repo(&self, call: &Call, _owner: &CancellationToken, path: &str) -> F<Arc<dyn Repo>> {
        if let Err(e) = call.require("git:repo") {
            return Box::pin(async move { Err(e) });
        }
        let info = RepoInfo {
            path: path.into(),
            top: path.into(),
            root: path.into(),
            sub: String::new(),
        };
        done(Arc::new(FakeRepo {
            git: self.clone(),
            info,
        }) as Arc<dyn Repo>)
    }
    fn clone_repo(&self, _call: &Call, _req: CloneRequest) -> F<Cloned> {
        Box::pin(async { Err(WireError::invalid("not in the fake")) })
    }
    fn tools(&self, _call: &Call) -> F<Tools> {
        done(Tools::default())
    }
}

#[derive(Debug)]
pub struct FakeRepo {
    git: FakeGit,
    info: RepoInfo,
}

impl FakeRepo {
    fn p(&self) -> String {
        self.info.path.clone()
    }
    fn log(&self, l: String) {
        self.git.lock().log.push(l);
    }
}

impl Repo for FakeRepo {
    fn info(&self) -> &RepoInfo {
        &self.info
    }
    fn status(&self, _call: &Call) -> F<Status> {
        let n = self.git.lock().dirty.get(&self.p()).copied().unwrap_or(0);
        let entries = (0..n)
            .map(|i| StatusEntry {
                path: format!("f{i}"),
                xy: ".M".into(),
                from: None,
            })
            .collect();
        done(Status {
            entries,
            ..Status::default()
        })
    }
    fn changes(&self, _call: &Call, _base: &str) -> F<Option<Changes>> {
        done(None)
    }
    fn diff(&self, _call: &Call, _req: DiffRequest) -> F<Body> {
        done(Body::Inline { files: Vec::new() })
    }
    fn touched(&self, _call: &Call, _base: &str) -> F<Option<Touched>> {
        done(None)
    }
    fn branches(&self, _call: &Call) -> F<Vec<Branch>> {
        done(Vec::new())
    }
    fn worktrees(&self, _call: &Call) -> F<Vec<WorktreeEntry>> {
        done(Vec::new())
    }
    fn base(&self, _call: &Call, _fetch: bool) -> F<Option<BaseRef>> {
        done(None)
    }
    fn rev_parse(&self, _call: &Call, _rev: &str) -> F<Option<String>> {
        done(None)
    }
    fn count(&self, _call: &Call, range: &str) -> F<Option<u32>> {
        let st = self.git.lock();
        let ahead = st.ahead.get(&self.p()).copied().unwrap_or(0);
        let n = match st.counts.get(range) {
            Some(n) => *n,
            None if range.starts_with("origin/main..") => Some(ahead),
            None if range.starts_with("refs/remotes/") => {
                st.pushed.get(&self.p()).map(|p| ahead.saturating_sub(*p))
            }
            None => None,
        };
        done(n)
    }
    fn is_ancestor(&self, _call: &Call, _a: &str, _of: &str) -> F<bool> {
        done(true)
    }
    fn merge_base(&self, _call: &Call, _a: &str, _b: &str) -> F<Option<String>> {
        done(None)
    }
    fn merge_tree(&self, _call: &Call, a: &str, b: &str) -> F<MergeTree> {
        self.log(format!("merge-tree {a} {b}"));
        done(
            self.git
                .lock()
                .merge_tree
                .clone()
                .unwrap_or(MergeTree::Unknown),
        )
    }
    fn base_merged(&self, _call: &Call, _base: &str) -> F<BaseMerged> {
        done(self.git.lock().base_merged.clone().unwrap_or(BaseMerged {
            ok: true,
            why: None,
        }))
    }
    fn show(&self, _call: &Call, _rev: &str, _path: &str) -> F<Option<Vec<u8>>> {
        done(None)
    }
    fn files(&self, _call: &Call, _max: usize) -> F<Vec<String>> {
        done(Vec::new())
    }
    fn remote_url(&self, _call: &Call, _remote: &str) -> F<Option<String>> {
        done(None)
    }
    fn fetch(&self, _call: &Call, req: FetchRequest) -> F<()> {
        self.log(format!(
            "fetch {} {}",
            req.remote.unwrap_or_default(),
            req.refspec.unwrap_or_default()
        ));
        done(())
    }
    fn worktree_add(&self, _call: &Call, req: WorktreeAdd) -> F<WorktreeEntry> {
        let _ = std::fs::create_dir_all(&req.path);
        self.log(format!("worktree add {} {}", req.path, req.branch));
        done(WorktreeEntry {
            path: req.path,
            branch: req.branch,
            ..WorktreeEntry::default()
        })
    }
    fn worktree_remove(&self, _call: &Call, path: &str) -> F<()> {
        let _ = std::fs::remove_dir_all(path);
        self.log(format!("worktree remove {path}"));
        done(())
    }
    fn worktree_prune(&self, _call: &Call) -> F<()> {
        self.log("worktree prune".into());
        done(())
    }
    fn stage(&self, _call: &Call, _req: StageRequest) -> F<bool> {
        done(false)
    }
    fn apply(&self, _call: &Call, _req: ApplyRequest) -> F<Applied> {
        done(Applied::default())
    }
    fn commit(&self, call: &Call, req: CommitRequest) -> F<Option<String>> {
        if let Err(e) = call.require("git:commit") {
            return Box::pin(async move { Err(e) });
        }
        let p = self.p();
        let mut st = self.git.lock();
        if st.dirty.get(&p).copied().unwrap_or(0) == 0 {
            return done(None);
        }
        st.dirty.insert(p.clone(), 0);
        *st.ahead.entry(p.clone()).or_default() += 1;
        st.log.push(format!(
            "commit {p} {}|{}|all={}",
            req.message, req.body, req.all
        ));
        done(Some(format!("sha-{p}-{}", st.ahead[&p])))
    }
    fn push(&self, _call: &Call, req: PushRequest) -> F<()> {
        let p = self.p();
        let mut st = self.git.lock();
        if let Some(why) = st.push_fails.clone() {
            return Box::pin(async move { Err(WireError::invalid(why)) });
        }
        st.log.push(format!(
            "push {} {}{}",
            req.remote,
            if req.delete { "--delete " } else { "" },
            req.refspec
        ));
        if !req.delete {
            let ahead = st.ahead.get(&p).copied().unwrap_or(0);
            st.pushed.insert(p.clone(), ahead);
            let branch = req
                .refspec
                .trim_start_matches("HEAD:refs/heads/")
                .to_owned();
            self.git
                .gh
                .lock()
                .heads
                .insert(branch, format!("sha-{p}-{ahead}"));
        }
        done(())
    }
    fn branch_delete(&self, _call: &Call, name: &str) -> F<bool> {
        self.log(format!("branch -D {name}"));
        done(true)
    }
    fn sync_base(&self, _call: &Call, base: &str) -> F<Synced> {
        self.log(format!("sync {} {base}", self.p()));
        done(Synced {
            ok: true,
            text: format!("Local {base} is up to date with origin/{base}."),
        })
    }
    fn snapshot(&self, _call: &Call) -> F<Option<String>> {
        done(None)
    }
    fn patch(&self, _call: &Call, _base: &str) -> F<String> {
        done(String::new())
    }
    fn on_change(
        &self,
        _call: &Call,
        owner: &CancellationToken,
        _cb: ChangeFn,
    ) -> Result<Subscription> {
        Ok(Subscription::new(owner.child_token()))
    }
    fn touch(&self, _call: &Call, _kind: &str) -> Result<()> {
        Ok(())
    }
}
