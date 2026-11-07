//! wisp-issues-core: everything issues decides, without IO. The host gathers (gh's output, an origin
//! URL, an HTTP answer, the clock) and these functions turn it into the picker's list.

pub mod rows;
pub mod sources;

use std::collections::{HashMap, VecDeque};

use wisp_issues_api::{IssueList, Problem, Source};

pub use rows::{adf_text, body, clip, gh_issue, jira_issue, linear_issue};
pub use sources::{
    JiraCreds, gh_args, gh_list, gh_problem, jira_creds, jira_request, jira_response, linear_key,
    linear_request, linear_response,
};

/// A list is good for a minute: the picker opens and is searched often.
pub const TTL_MS: i64 = 60_000;
/// Searches add up: past this many lists the oldest goes.
pub const CACHE_MAX: usize = 200;
pub const Q_MAX: usize = 200;

/// The search words as gh and the cache see them: trimmed, at most 200 characters.
pub fn normalize_q(q: &str) -> String {
    q.trim().chars().take(Q_MAX).collect()
}

/// `owner/repo` of a GitHub remote however it's spelled (https with or without `.git` or a page inside
/// it, `github.com/o/r`, `git@github.com:o/r.git`, `ssh://`, `git://`), or None for any other host.
/// The same answer as wisp-git-core's `parse_repo(..).gh`, kept here so issues needs no git internals.
pub fn github_repo(url: &str) -> Option<String> {
    let s = url.trim();
    let lower = s.to_lowercase();
    let rest = if let Some(i) = lower.find("://") {
        let scheme = &lower[..i];
        if !matches!(scheme, "http" | "https" | "ssh" | "git") {
            return None;
        }
        let after = &s[i + 3..];
        let (auth_host, path) = after.split_once('/')?;
        let host = auth_host.rsplit('@').next()?.split(':').next()?;
        host_path(host, path)?
    } else if lower.starts_with("github.com/") || lower.starts_with("www.github.com/") {
        let (host, path) = s.split_once('/')?;
        host_path(host, path)?
    } else {
        // scp-like: user@host:path (not host://)
        let (user_host, path) = s.split_once(':')?;
        let (user, host) = user_host.split_once('@')?;
        if user.is_empty()
            || path.starts_with("//")
            || !user
                .chars()
                .all(|c| c.is_alphanumeric() || "_.-".contains(c))
        {
            return None;
        }
        host_path(host, path)?
    };
    Some(rest)
}

fn host_path(host: &str, path: &str) -> Option<String> {
    let host = host.to_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host);
    if host != "github.com" {
        return None;
    }
    let path = path.split(['?', '#']).next().unwrap_or_default();
    let mut parts = path.split('/').filter(|p| !p.is_empty());
    let owner = parts.next()?;
    let repo = parts.next()?;
    let repo = repo
        .strip_suffix(".git")
        .or_else(|| repo.strip_suffix(".GIT"))
        .unwrap_or(repo);
    (!repo.is_empty()).then(|| format!("{owner}/{repo}"))
}

/// The project's own repo (a clone, or one on another computer), else its folder's origin.
pub fn repo_of_project(project_repo: &str, origin: Option<&str>) -> Option<String> {
    github_repo(project_repo).or_else(|| origin.and_then(github_repo))
}

/// An empty list for `source` carrying `p`.
pub fn refused(source: Source, linear: bool, jira: bool, p: Problem) -> IssueList {
    IssueList {
        source,
        linear,
        jira,
        error: Some(p.error),
        fix: p.fix,
        ..IssueList::default()
    }
}

/// Before any IO: a source that isn't connected, or GitHub without a project, is refused in words.
pub fn precheck(source: Source, has_project: bool, linear: bool, jira: bool) -> Option<IssueList> {
    let p = |error: &str, fix: &str| Problem {
        error: error.into(),
        fix: Some(fix.into()),
    };
    let why = match source {
        Source::Jira if !jira => p(
            "Connect Jira (a Jira or Atlassian connector with its site, email and API token) to list the issues assigned to you.",
            "jira",
        ),
        Source::Linear if !linear => p(
            "Connect Linear with an API key to list the issues assigned to you.",
            "linear",
        ),
        Source::Github if !has_project => p("Pick a project to see its issues.", "project"),
        _ => return None,
    };
    Some(refused(source, linear, jira, why))
}

pub fn no_remote(name: &str, linear: bool, jira: bool) -> IssueList {
    let name = if name.is_empty() {
        "This project"
    } else {
        name
    };
    refused(
        Source::Github,
        linear,
        jira,
        Problem {
            error: format!("{name} has no GitHub remote, so it has no issues to list."),
            fix: Some("remote".into()),
        },
    )
}

/// What the cache keys on: the source, GitHub's project, the words.
pub fn cache_key(source: Source, project: &str, q: &str) -> String {
    let p = if source == Source::Github {
        project
    } else {
        ""
    };
    format!("{}:{p}:{q}", source.as_str())
}

/// The minute's lists. Only lists are kept, never a problem: after a sign-in the next look asks again.
#[derive(Debug, Default)]
pub struct IssueCache {
    map: HashMap<String, (i64, IssueList)>,
    order: VecDeque<String>,
}

impl IssueCache {
    /// A fresh hit, with `linear`/`jira` as they are now (a connector added since shows at once).
    pub fn get(&self, key: &str, now: i64, linear: bool, jira: bool) -> Option<IssueList> {
        let (at, v) = self.map.get(key)?;
        (now - at < TTL_MS).then(|| IssueList {
            linear,
            jira,
            ..v.clone()
        })
    }

    pub fn put(&mut self, key: String, now: i64, value: IssueList) {
        if value.error.is_some() {
            return;
        }
        if self.map.insert(key.clone(), (now, value)).is_none() {
            self.order.push_back(key);
        }
        while self.map.len() > CACHE_MAX {
            let Some(old) = self.order.pop_front() else {
                break;
            };
            self.map.remove(&old);
        }
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }
    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
    pub fn clear(&mut self) {
        self.map.clear();
        self.order.clear();
    }
}
