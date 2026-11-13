//! A stand-in for the GitHub CLI (port of v1 test/fixtures/fake-gh.mjs, the commands wisp runs):
//! `pr create/view/ready/merge/list`, `run list`, `issue list`, `gist create`, `api user`,
//! `api repos/<o>/<r>`. Pull requests live in a JSON file; merging pushes the PR head to the base
//! branch of the repo's origin (best effort), so a "sync your local main" step has something to fetch.
//!
//!   `FAKE_GH_STATE`  JSON file: {prs, runs, issues, checks, review, mergeable, user, repos, signedOut}
//!   `FAKE_RECORD`    directory; each call appends {argv, cwd} to gh.jsonl
//!
//! Writers (create, ready, merge, gist) take a lock directory next to the state file, so concurrent
//! calls (Ship it, the PR poll) never lose each other's writes.
#![allow(clippy::print_stdout, clippy::unwrap_used, clippy::expect_used)]
use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

fn fail(msg: &str) -> ! {
    eprintln!("{msg}");
    std::process::exit(1)
}

fn flag(argv: &[String], f: &str) -> Option<String> {
    argv.iter()
        .position(|a| a == f)
        .and_then(|i| argv.get(i + 1))
        .cloned()
}

fn git(args: &[&str]) -> Option<String> {
    let o = std::process::Command::new("git").args(args).output().ok()?;
    o.status
        .success()
        .then(|| String::from_utf8_lossy(&o.stdout).trim().to_owned())
}

struct Lock(PathBuf);
impl Drop for Lock {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir(&self.0);
    }
}

fn lock(file: &Path) -> Lock {
    let dir = PathBuf::from(format!("{}.lock", file.display()));
    for _ in 0..2000 {
        if std::fs::create_dir(&dir).is_ok() {
            return Lock(dir);
        }
        // a gh killed while it held the lock never takes it away
        if std::fs::metadata(&dir)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|e| e.as_secs() > 10)
        {
            let _ = std::fs::remove_dir(&dir);
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    fail("fake gh: the state lock is stuck")
}

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let file =
        PathBuf::from(std::env::var("FAKE_GH_STATE").unwrap_or_else(|_| "gh-state.json".into()));
    if let Ok(dir) = std::env::var("FAKE_RECORD") {
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(Path::new(&dir).join("gh.jsonl"))
        {
            // one write per line, so a reader never sees half a record
            let line = json!({ "argv": argv, "cwd": std::env::current_dir().ok() });
            let _ = f.write_all(format!("{line}\n").as_bytes());
        }
    }
    let (a, b) = (
        argv.first().map_or("", String::as_str),
        argv.get(1).map_or("", String::as_str),
    );
    let writes =
        (a == "pr" && matches!(b, "create" | "ready" | "merge")) || (a == "gist" && b == "create");
    let _guard = writes.then(|| lock(&file));
    let mut state: Value = std::fs::read_to_string(&file)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}));
    if !state["prs"].is_object() {
        state["prs"] = json!({});
    }
    let out = run(&argv, a, b, &mut state);
    if writes {
        std::fs::write(&file, serde_json::to_string_pretty(&state).unwrap())
            .unwrap_or_else(|e| fail(&format!("fake gh: {e}")));
    }
    if !out.is_empty() {
        println!("{out}");
    }
}

fn find<'a>(prs: &'a mut Map<String, Value>, r: &str) -> Option<&'a mut Value> {
    prs.values_mut().find(|p| {
        p["number"].as_u64().is_some_and(|n| n.to_string() == r)
            || p["url"] == r
            || p["headRefName"] == r
    })
}

fn run(argv: &[String], a: &str, b: &str, state: &mut Value) -> String {
    let refarg = argv.get(2).cloned().unwrap_or_default();
    match (a, b) {
        ("pr", "create") => {
            let n = state["prs"].as_object().map_or(0, Map::len) + 1;
            let (head, base) = (
                flag(argv, "--head").unwrap_or_default(),
                flag(argv, "--base").unwrap_or_default(),
            );
            let url = format!("https://github.com/acme/repo/pull/{n}");
            let pr = json!({
                "number": n, "url": url, "title": flag(argv, "--title"), "body": flag(argv, "--body"), "state": "OPEN",
                "isDraft": argv.iter().any(|x| x == "--draft"), "reviewDecision": "", "mergeStateStatus": "CLEAN",
                "headRefName": head, "baseRefName": base, "headRefOid": git(&["rev-parse", "HEAD"]),
                "statusCheckRollup": state.get("checks").cloned().unwrap_or_else(|| json!([])), "mergedAt": null
            });
            state["prs"][n.to_string()] = pr;
            format!("Creating pull request for {head} into {base}\n\n{url}")
        }
        ("pr", "view") => {
            let (checks, review, mergeable) = (
                state.get("checks").cloned(),
                state.get("review").cloned(),
                state.get("mergeable").cloned(),
            );
            let prs = state["prs"]
                .as_object_mut()
                .unwrap_or_else(|| fail("no pull requests found"));
            let Some(pr) = find(prs, &refarg) else {
                fail("no pull requests found")
            };
            // tests flip CI, review and mergeability between polls
            if let Some(c) = checks {
                pr["statusCheckRollup"] = c;
            }
            if let Some(r) = review {
                pr["reviewDecision"] = r;
            }
            if let Some(m) = mergeable {
                pr["mergeable"] = m;
            }
            let head = format!(
                "refs/remotes/origin/{}",
                pr["headRefName"].as_str().unwrap_or_default()
            );
            if let Some(oid) = git(&["rev-parse", "--verify", "--quiet", &head]) {
                pr["headRefOid"] = Value::from(oid);
            }
            pr.to_string()
        }
        ("pr", "ready") => {
            let prs = state["prs"]
                .as_object_mut()
                .unwrap_or_else(|| fail("no pull requests found"));
            let Some(pr) = find(prs, &refarg) else {
                fail("no pull requests found")
            };
            pr["isDraft"] = Value::Bool(false);
            String::new()
        }
        ("pr", "merge") => {
            let prs = state["prs"]
                .as_object_mut()
                .unwrap_or_else(|| fail("no pull requests found"));
            let Some(pr) = find(prs, &refarg) else {
                fail("no pull requests found")
            };
            let (head, base) = (
                pr["headRefName"].as_str().unwrap_or_default().to_owned(),
                pr["baseRefName"].as_str().unwrap_or_default().to_owned(),
            );
            pr["state"] = Value::from("MERGED");
            pr["mergedAt"] = Value::from("2026-11-08T00:00:00Z");
            let _ = git(&["push", "origin", &format!("{head}:{base}")]);
            String::new()
        }
        ("pr", "list") => Value::Array(
            state["prs"]
                .as_object()
                .map(|m| m.values().cloned().collect())
                .unwrap_or_default(),
        )
        .to_string(),
        ("run", "list") => state
            .get("runs")
            .cloned()
            .unwrap_or_else(|| json!([]))
            .to_string(),
        ("issue", "list") => state
            .get("issues")
            .cloned()
            .unwrap_or_else(|| json!([]))
            .to_string(),
        ("gist", "create") => {
            let n = state["gists"].as_u64().unwrap_or(0) + 1;
            state["gists"] = Value::from(n);
            format!("https://gist.github.com/acme/{n:032x}")
        }
        ("api", route) => api(route, state),
        _ => fail(&format!("fake gh: unsupported: {}", argv.join(" "))),
    }
}

fn api(route: &str, state: &Value) -> String {
    if route == "user" {
        if state["signedOut"] == true {
            fail("To get started with GitHub CLI, please run:  gh auth login");
        }
        return state["user"].to_string();
    }
    if let Some(repo) = route
        .strip_prefix("repos/")
        .filter(|r| r.matches('/').count() == 1)
    {
        return if let Some(r) = state["repos"].get(repo) {
            r.to_string()
        } else {
            println!("{}", json!({ "message": "Not Found" }));
            fail("gh: Not Found (HTTP 404)")
        };
    }
    fail(&format!("fake gh: unsupported api {route}"))
}
