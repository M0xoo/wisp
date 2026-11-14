//! wisp-history-core: a repo's agent history without IO (ADR-0033, 0042): the `.wisp/` layout
//! ([`repo`]), what a blame adds up to, how much of a task's code is still there, and which past tasks a
//! new one starts knowing about.

pub mod repo;

use std::fmt::Write as _;

use serde_json::Value;

/// A tracked task as its file says.
#[derive(Debug, Clone, PartialEq)]
pub struct Doc {
    /// its path, relative to the repo
    pub path: String,
    pub doc: Value,
}

impl Doc {
    pub fn id(&self) -> &str {
        self.doc.get("id").and_then(Value::as_str).unwrap_or_default()
    }
    pub fn files(&self) -> Vec<&str> {
        self.doc.get("files").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect()
    }
    pub fn commits(&self) -> Vec<&str> {
        self.doc.get("commits").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect()
    }
    pub fn title(&self) -> &str {
        self.doc.get("title").and_then(Value::as_str).unwrap_or_default()
    }
}

/// The task (full id, or ≥ 6 chars of it) among `all`.
pub fn find<'a>(all: &'a [Doc], id: &str) -> Option<&'a Doc> {
    all.iter().find(|t| t.id() == id || (id.len() >= 6 && t.id().starts_with(id)))
}

/// The tasks a commit is for: its trailers (a short id resolved), else the task files that list it.
pub fn tasks_of_commit(all: &[Doc], sha: &str, message: &str) -> Vec<String> {
    let named: Vec<String> = repo::trailers(message).into_iter().map(|t| find(all, &t).map_or(t, |d| d.id().to_owned())).collect();
    if !named.is_empty() {
        return named;
    }
    all.iter().filter(|d| d.commits().contains(&sha)).map(|d| d.id().to_owned()).collect()
}

/// A file's lines by task: (total, by hand, [(task, lines)] most first).
pub fn shares(lines: &[(String, u32)], tasks_of: &dyn Fn(&str) -> Vec<String>) -> (u32, u32, Vec<(String, u32)>) {
    let mut by: Vec<(String, u32)> = Vec::new();
    let (mut total, mut hand) = (0, 0);
    for (sha, n) in lines {
        total += n;
        match tasks_of(sha).into_iter().next() {
            Some(t) => match by.iter_mut().find(|(x, _)| *x == t) {
                Some(e) => e.1 += n,
                None => by.push((t, *n)),
            },
            None => hand += n,
        }
    }
    by.sort_by_key(|(_, n)| std::cmp::Reverse(*n));
    (total, hand, by)
}

/// How much of what a task wrote is still there: lines its commits added that blame still gives them, over
/// the lines they added. None when its commits added nothing (or aren't known).
pub fn still_there(surviving: u32, added: u32) -> Option<f64> {
    (added > 0).then(|| (f64::from(surviving) / f64::from(added)).min(1.0))
}

/// Paths a prompt names (`src/auth/login.rs`, `math.js`, `auth/`): words with a `/` or a file extension.
pub fn paths_in(prompt: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for w in prompt.split(|c: char| c.is_whitespace() || matches!(c, ',' | ';' | '(' | ')' | '`' | '"' | '\'')) {
        let w = w.trim_end_matches(['.', ':', '!', '?']).trim_start_matches("./");
        let ext = w
            .rsplit_once('.')
            .is_some_and(|(a, e)| !a.is_empty() && (1..=5).contains(&e.len()) && e.chars().all(|c| c.is_ascii_alphanumeric()));
        if (w.contains('/') || ext) && !w.contains("://") && w.len() > 2 && !out.contains(&w.to_owned()) {
            out.push(w.to_owned());
        }
    }
    out
}

/// The past tasks a new task starts knowing about: those that touched a path its prompt names, newest
/// first, at most `max` (none when the prompt names no path).
pub fn relevant<'a>(all: &'a [Doc], prompt: &str, max: usize) -> Vec<&'a Doc> {
    let paths = paths_in(prompt);
    let mut hits: Vec<&Doc> = all
        .iter()
        .filter(|d| d.files().iter().any(|f| paths.iter().any(|p| f.starts_with(p.trim_end_matches('/')) || f.ends_with(&format!("/{p}")))))
        .collect();
    hits.sort_by_key(|d| std::cmp::Reverse(d.doc.get("createdAt").and_then(Value::as_i64).unwrap_or(0)));
    hits.truncate(max);
    hits
}

/// The lines a new task's system prompt gets about them.
pub fn inject_text(docs: &[&Doc]) -> String {
    if docs.is_empty() {
        return String::new();
    }
    let mut s = String::from("## Earlier tasks on these files (this repo's .wisp/)\n");
    for d in docs {
        let prompt = d.doc.pointer("/spec/prompt").and_then(Value::as_str).unwrap_or_default().lines().next().unwrap_or_default();
        let _ = writeln!(s, "- {} ({}): {}", d.title(), repo::short(d.id()), prompt.chars().take(160).collect::<String>());
    }
    s.push_str("Read one with the wisp_task tool (or .wisp/tasks/) before changing what it decided.\n");
    s
}

/// The prompt of a task that carries on from an earlier one (`wisp resume`, an approved resume request).
pub fn resume_prompt(title: &str, asked: &str, report: &str) -> String {
    let report: String = report.chars().take(6000).collect();
    format!(
        "Carry on with an earlier task: \"{title}\".\n\nWhat was asked then:\n{asked}\n\nWhat happened (its report):\n{report}\n\nPick it up from there, on the code as it is today."
    )
}

/// The task files of `id` among the `.wisp/`-relative paths `all` (its task file, report, transcripts).
pub fn files_of(all: &[String], id: &str) -> Vec<String> {
    let short = repo::short(id);
    all.iter()
        .filter(|p| {
            (p.starts_with("tasks/") && p.rsplit('/').next().is_some_and(|n| n.starts_with(&format!("{short}-"))))
                || p.starts_with(&format!("history/{id}."))
        })
        .cloned()
        .collect()
}

#[cfg(test)]
#[allow(clippy::assert_is_empty)]
mod tests {
    use super::*;
    use serde_json::json;

    fn d(id: &str, files: &[&str], commits: &[&str], at: i64) -> Doc {
        Doc {
            path: format!(".wisp/tasks/{id}.task.yml"),
            doc: json!({ "id": id, "title": format!("T {id}"), "files": files, "commits": commits, "createdAt": at, "spec": { "prompt": "do it" } }),
        }
    }

    #[test]
    fn commits_resolve_to_tasks_by_trailer_then_by_the_files() {
        let all = [d("01a1bc12ab34ffff", &[], &["s2"], 1)];
        assert_eq!(tasks_of_commit(&all, "s1", "x\n\nWisp-Task: 01a1bc12ab34"), ["01a1bc12ab34ffff"]);
        assert_eq!(tasks_of_commit(&all, "s2", "no trailer"), ["01a1bc12ab34ffff"], "a backfilled task lists its commits");
        assert!(tasks_of_commit(&all, "s3", "by hand").is_empty());
    }

    #[test]
    fn shares_and_what_is_still_there() {
        let of = |s: &str| if s == "a" { vec!["t1".to_owned()] } else { Vec::new() };
        assert_eq!(shares(&[("a".into(), 3), ("b".into(), 1)], &of), (4, 1, vec![("t1".into(), 3)]));
        assert_eq!(still_there(3, 4), Some(0.75));
        assert_eq!(still_there(5, 4), Some(1.0), "never over 100%");
        assert_eq!(still_there(0, 0), None);
    }

    #[test]
    fn injection_finds_the_tasks_on_the_files_named() {
        assert_eq!(paths_in("fix src/auth/login.rs and math.js, see https://x.io/a."), ["src/auth/login.rs", "math.js"]);
        assert!(paths_in("make it faster").is_empty());
        let all = [d("old", &["src/auth/login.rs"], &[], 1), d("new", &["src/auth/token.rs"], &[], 3), d("other", &["web/app.ts"], &[], 2)];
        let r: Vec<&str> = relevant(&all, "the bug in src/auth/", 5).iter().map(|d| d.id()).collect();
        assert_eq!(r, ["new", "old"]);
        assert!(relevant(&all, "make it faster", 5).is_empty(), "no path named: nothing injected");
        assert!(inject_text(&relevant(&all, "math.js", 5)).is_empty());
    }
}

/// A tracked task as the Repo tab's row (`history.list`).
pub fn repo_task(d: &Doc) -> wisp_history_api::RepoTask {
    let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
    let n = |k: &str| u32::try_from(d.doc.get(k).and_then(Value::as_array).map_or(0, Vec::len)).unwrap_or(u32::MAX);
    wisp_history_api::RepoTask {
        id: d.id().to_owned(),
        title: d.title().to_owned(),
        agent: s(&d.doc["spec"], "agent"),
        by: s(&d.doc, "trackedBy"),
        created_at: d.doc.get("createdAt").and_then(Value::as_i64).unwrap_or(0),
        pr: s(&d.doc, "pr"),
        commits: n("commits"),
        files: n("files"),
        level: s(&d.doc, "level"),
        path: d.path.clone(),
    }
}

/// The Repo tab's rows: those matching the filters (a path prefix, an agent, words in the title or prompt), newest first.
pub fn repo_list(all: &[Doc], path: Option<&str>, agent: Option<&str>, grep: Option<&str>) -> Vec<wisp_history_api::RepoTask> {
    let want = |o: Option<&str>| o.map(str::trim).filter(|x| !x.is_empty()).map(str::to_owned);
    let (path, agent, grep) = (want(path), want(agent), want(grep).map(|g| g.to_lowercase()));
    let mut out: Vec<wisp_history_api::RepoTask> = all
        .iter()
        .filter(|d| path.as_deref().is_none_or(|p| d.files().iter().any(|f| f.starts_with(p.trim_end_matches('/')))))
        .filter(|d| agent.as_deref().is_none_or(|a| d.doc.pointer("/spec/agent").and_then(Value::as_str) == Some(a)))
        .filter(|d| {
            grep.as_deref().is_none_or(|g| {
                format!("{} {}", d.title(), d.doc.pointer("/spec/prompt").and_then(Value::as_str).unwrap_or_default())
                    .to_lowercase()
                    .contains(g)
            })
        })
        .map(repo_task)
        .collect();
    out.sort_by_key(|t| std::cmp::Reverse(t.created_at));
    out
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod repo_list_tests {
    use super::*;
    use serde_json::json;

    fn doc(id: &str, at: i64, agent: &str, prompt: &str, files: &[&str]) -> Doc {
        Doc {
            path: format!(".wisp/tasks/{id}.task.yml"),
            doc: json!({ "id": id, "title": format!("task {id}"), "createdAt": at, "level": "report", "trackedBy": "ada", "spec": { "agent": agent, "prompt": prompt }, "commits": ["a1", "b2"], "pr": "#12", "files": files }),
        }
    }

    #[test]
    fn the_repo_tab_lists_the_repos_tracked_tasks_newest_first_with_the_clis_filters() {
        let all = [
            doc("t1", 10, "claude", "fix the login", &["auth/login.ts"]),
            doc("t2", 30, "codex", "add search", &["web/search.ts"]),
            doc("t3", 20, "claude", "rename auth", &["auth/a.ts", "web/b.ts"]),
        ];
        let ids = |l: Vec<wisp_history_api::RepoTask>| l.into_iter().map(|t| t.id).collect::<Vec<_>>();
        assert_eq!(ids(repo_list(&all, None, None, None)), ["t2", "t3", "t1"]);
        assert_eq!(ids(repo_list(&all, Some("auth/"), None, None)), ["t3", "t1"]);
        assert_eq!(ids(repo_list(&all, None, Some("claude"), Some("LOGIN"))), ["t1"]);
        assert_eq!(ids(repo_list(&all, Some(" "), Some(""), None)).len(), 3, "an empty filter is none");
        let row = repo_task(&all[0]);
        assert_eq!((row.agent.as_str(), row.by.as_str(), row.commits, row.files, row.pr.as_str()), ("claude", "ada", 2, 1, "#12"));
    }
}
