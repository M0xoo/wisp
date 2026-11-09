//! The `git` blame source (`history.blame@1`) and the `gh` PR lookup, through wisp-proc.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use wisp_history_api::BlameSource;
use wisp_kernel::BoxFuture;
use wisp_proc::{ExecOpts, Proc};

pub async fn run(proc: &Proc, bin: &str, root: &std::path::Path, args: &[&str]) -> Option<String> {
    let opts = ExecOpts { cwd: Some(root.to_owned()), timeout: Some(Duration::from_secs(60)), max_output: 64 << 20, ..ExecOpts::default() };
    let args: Vec<String> = args.iter().map(|a| (*a).to_owned()).collect();
    let r = proc.exec(bin, &args, opts).await.ok()?;
    r.exit.success().then(|| r.stdout_text())
}

#[derive(Clone)]
pub struct Git(pub Arc<Proc>);

impl BlameSource for Git {
    fn id(&self) -> &'static str {
        "git"
    }
    fn blame(&self, root: PathBuf, file: String, range: Option<(u32, u32)>) -> BoxFuture<'static, Vec<(String, u32)>> {
        let p = self.0.clone();
        Box::pin(async move {
            let l = range.map(|(a, b)| format!("{a},{b}"));
            let mut args = vec!["blame", "--porcelain"];
            if let Some(l) = &l {
                args.extend(["-L", l.as_str()]);
            }
            args.extend(["--", file.as_str()]);
            let out = run(&p, "git", &root, &args).await.unwrap_or_default();
            let mut per: Vec<(String, u32)> = Vec::new();
            for line in out.lines() {
                let mut w = line.split_whitespace();
                if let (Some(sha), Some(_), Some(_)) = (w.next(), w.next(), w.next())
                    && sha.len() == 40
                    && sha.bytes().all(|b| b.is_ascii_hexdigit())
                {
                    match per.iter_mut().find(|(s, _)| s == sha) {
                        Some(e) => e.1 += 1,
                        None => per.push((sha.to_owned(), 1)),
                    }
                }
            }
            per
        })
    }
    fn lines(&self, root: PathBuf, file: String) -> BoxFuture<'static, Vec<(String, String)>> {
        let p = self.0.clone();
        Box::pin(async move {
            let out = run(&p, "git", &root, &["blame", "--porcelain", "--", file.as_str()]).await.unwrap_or_default();
            porcelain_lines(&out)
        })
    }
    fn message(&self, root: PathBuf, sha: String) -> BoxFuture<'static, String> {
        let p = self.0.clone();
        Box::pin(async move { run(&p, "git", &root, &["show", "-s", "--format=%B", &sha]).await.unwrap_or_default() })
    }
    fn commits(&self, root: PathBuf, spec: String, path: String) -> BoxFuture<'static, Vec<String>> {
        let p = self.0.clone();
        Box::pin(async move {
            let out = if spec.contains("..") {
                run(&p, "git", &root, &["rev-list", &spec]).await
            } else if !spec.is_empty() {
                run(&p, "git", &root, &["rev-parse", "--verify", &format!("{spec}^{{commit}}")]).await
            } else {
                run(&p, "git", &root, &["log", "--format=%H", "--", &path]).await
            };
            out.unwrap_or_default().lines().filter(|l| !l.is_empty()).map(str::to_owned).collect()
        })
    }
    fn grep(&self, root: PathBuf, needle: String) -> BoxFuture<'static, Vec<String>> {
        let p = self.0.clone();
        Box::pin(async move { run(&p, "git", &root, &["log", "--all", "--format=%H", "--fixed-strings", &format!("--grep={needle}")]).await.unwrap_or_default().lines().filter(|l| !l.is_empty()).map(str::to_owned).collect() })
    }
    fn added(&self, root: PathBuf, sha: String) -> BoxFuture<'static, Vec<(String, u32)>> {
        let p = self.0.clone();
        Box::pin(async move {
            run(&p, "git", &root, &["show", "--numstat", "--format=", &sha])
                .await
                .unwrap_or_default()
                .lines()
                .filter_map(|l| {
                    let mut w = l.split('\t');
                    let n = w.next()?.parse().ok()?;
                    let _ = w.next()?;
                    Some((w.next()?.to_owned(), n))
                })
                .collect()
        })
    }
    fn knows(&self, root: PathBuf) -> BoxFuture<'static, bool> {
        let p = self.0.clone();
        Box::pin(async move { run(&p, "git", &root, &["rev-parse", "--git-dir"]).await.is_some() })
    }
}

/// The PR a task's commits (or its branch) went into, from GitHub through `gh` (`WISP_GH_BIN`, else
/// `gh` on PATH): the PR whose head is the task's branch, or whose head commit is one of its commits. None
/// without gh, without a remote, or when nothing matches: never a guess.
pub async fn pr_of(proc: &Proc, root: &std::path::Path, commits: &[String], branch: &str) -> Option<String> {
    let gh = std::env::var("WISP_GH_BIN").ok().filter(|b| !b.is_empty()).unwrap_or_else(|| "gh".into());
    let pick = |out: Option<String>| -> Option<String> {
        let v: serde_json::Value = serde_json::from_str(&out?).ok()?;
        let list = v.as_array()?;
        let hit = list.iter().find(|p| !branch.is_empty() && p["headRefName"] == branch).or_else(|| list.iter().find(|p| commits.iter().any(|c| p["headRefOid"] == c.as_str())))?;
        hit["url"].as_str().map(str::to_owned)
    };
    if !branch.is_empty()
        && let Some(u) = pick(run(proc, &gh, root, &["pr", "list", "--state", "all", "--head", branch, "--json", "number,url,headRefName,headRefOid"]).await)
    {
        return Some(u);
    }
    let sha = commits.first()?;
    pick(run(proc, &gh, root, &["pr", "list", "--state", "all", "--search", sha, "--json", "number,url,headRefName,headRefOid"]).await)
}

/// `git`, with the proc service looked up at each call (it's there once the kernel runs).
pub struct LazyGit(pub wisp_kernel::Ctx);

impl LazyGit {
    fn git(&self) -> Option<Git> {
        self.0.service::<Proc>().ok().map(Git)
    }
}

/// `git blame --porcelain` as (commit, text) per line: each line is a header (`sha orig final [count]`), then
/// metadata the first time a commit shows, then the line's text after a tab.
pub(crate) fn porcelain_lines(out: &str) -> Vec<(String, String)> {
    let mut lines = Vec::new();
    let mut sha = String::new();
    for l in out.lines() {
        if let Some(text) = l.strip_prefix('\t') {
            lines.push((sha.clone(), text.to_owned()));
            continue;
        }
        let mut w = l.split_whitespace();
        if let (Some(s), Some(_), Some(_)) = (w.next(), w.next(), w.next())
            && s.len() == 40
            && s.bytes().all(|b| b.is_ascii_hexdigit())
        {
            s.clone_into(&mut sha);
        }
    }
    lines
}

macro_rules! lazy {
    ($self:ident, $default:expr, |$g:ident| $body:expr) => {
        match $self.git() {
            Some($g) => $body,
            None => Box::pin(async { $default }),
        }
    };
}

impl BlameSource for LazyGit {
    fn id(&self) -> &'static str {
        "git"
    }
    fn blame(&self, root: PathBuf, file: String, range: Option<(u32, u32)>) -> BoxFuture<'static, Vec<(String, u32)>> {
        lazy!(self, Vec::new(), |g| g.blame(root, file, range))
    }
    fn lines(&self, root: PathBuf, file: String) -> BoxFuture<'static, Vec<(String, String)>> {
        lazy!(self, Vec::new(), |g| g.lines(root, file))
    }
    fn message(&self, root: PathBuf, sha: String) -> BoxFuture<'static, String> {
        lazy!(self, String::new(), |g| g.message(root, sha))
    }
    fn commits(&self, root: PathBuf, spec: String, path: String) -> BoxFuture<'static, Vec<String>> {
        lazy!(self, Vec::new(), |g| g.commits(root, spec, path))
    }
    fn grep(&self, root: PathBuf, needle: String) -> BoxFuture<'static, Vec<String>> {
        lazy!(self, Vec::new(), |g| g.grep(root, needle))
    }
    fn added(&self, root: PathBuf, sha: String) -> BoxFuture<'static, Vec<(String, u32)>> {
        lazy!(self, Vec::new(), |g| g.added(root, sha))
    }
    fn knows(&self, root: PathBuf) -> BoxFuture<'static, bool> {
        lazy!(self, false, |g| g.knows(root))
    }
}
