//! git and gh: the subcommand says what happens, its operands say to what.
//!
//! size-ok: a data table: one describer per git/gh subcommand

use super::argv::{Desc, operands, shown, value_of};
use super::files::describe_grep;
use crate::paths::RunPaths;
use crate::re::Re;
use crate::text::clip;

static SCHEME: Re = Re::new(r"^https?://(www\.)?");
static DOT_GIT: Re = Re::new(r"\.git$");
static REPO_PREFIX: Re = Re::new(r"^/?repos/[^/]+/[^/]+/?");

struct Git<'a> {
    rest: &'a [String],
    ops: Vec<&'a str>,
    paths: &'a RunPaths,
}

impl Git<'_> {
    fn has(&self, flags: &[&str]) -> bool {
        self.rest.iter().any(|a| flags.contains(&a.as_str()))
    }
    fn f(&self, p: &str) -> String {
        super::argv::short(p, self.paths)
    }
    fn shown(&self) -> String {
        shown(&self.ops, self.paths)
    }
    fn op(&self, i: usize) -> Option<&str> {
        self.ops.get(i).copied()
    }
}

fn or<'a>(s: &'a str, fallback: &'a str) -> &'a str {
    if s.is_empty() { fallback } else { s }
}

fn diff(g: &Git) -> String {
    if g.has(&["--stat", "--name-only", "--name-status", "--shortstat"]) {
        return "Summarising changes".into();
    }
    if g.has(&["--cached", "--staged"]) {
        return "Reviewing staged changes".into();
    }
    if g.ops.is_empty() {
        return "Viewing changes".into();
    }
    // Paths read as "in a.js"; revisions and ranges (main..HEAD) as "(main..HEAD)".
    let paths = g.ops.iter().any(|o| o.contains('/') || o.contains('.'))
        && !g.ops.iter().any(|o| o.contains(".."));
    if paths {
        format!("Viewing changes in {}", g.shown())
    } else {
        format!("Viewing changes ({})", clip(&g.ops.join(" "), 30))
    }
}

fn log(g: &Git) -> String {
    let last = g.ops.last().copied();
    let of_file =
        g.op(0).is_some_and(|o| !o.contains("..")) && last.is_some_and(|l| l.contains(['/', '.']));
    match last {
        Some(l) if of_file => format!("Reading the history of {}", g.f(l)),
        _ => "Reading git history".into(),
    }
}

fn show(g: &Git) -> String {
    let Some(o) = g.op(0).filter(|o| !o.is_empty()) else {
        return "Viewing the last commit".into();
    };
    match o.split_once(':') {
        None => format!("Viewing commit {}", clip(o, 20)),
        Some((rev, file)) => format!("Reading {file} at {}", or(rev, "the index")),
    }
}

fn commit(g: &Git) -> String {
    if g.has(&["--amend"]) {
        return "Amending the last commit".into();
    }
    match value_of(g.rest, &["-m", "--message"]).filter(|m| !m.is_empty()) {
        Some(m) => format!(
            "Committing “{}”",
            clip(m.split('\n').next().unwrap_or(""), 50)
        ),
        None => "Committing changes".into(),
    }
}

fn checkout(g: &Git) -> String {
    let creating = ["-b", "-B", "-c", "-C"];
    if g.has(&creating) {
        return crate::js::trim(&format!(
            "Creating branch {}",
            value_of(g.rest, &creating).unwrap_or("")
        ))
        .to_owned();
    }
    if let Some(at) = g.rest.iter().position(|a| a == "--") {
        let list = operands(&g.rest[at + 1..])
            .iter()
            .map(|p| g.f(p))
            .collect::<Vec<_>>()
            .join(", ");
        return format!("Discarding changes to {}", or(&list, "files"));
    }
    g.op(0).filter(|o| !o.is_empty()).map_or_else(
        || "Switching branch".into(),
        |o| format!("Switching to {}", clip(o, 40)),
    )
}

fn branch(g: &Git) -> String {
    let first = g.op(0).unwrap_or("");
    if g.has(&["-d", "-D", "--delete"]) {
        return crate::js::trim(&format!("Deleting branch {first}")).to_owned();
    }
    if g.has(&["-m", "-M"]) {
        return "Renaming a branch".into();
    }
    if !first.is_empty() && !g.has(&["--list", "-a", "-r", "-v", "-vv"]) {
        format!("Creating branch {first}")
    } else if g.has(&["--show-current"]) {
        "Checking the current branch".into()
    } else {
        "Listing branches".into()
    }
}

/// `--abort` / `--continue`, else the operation itself.
fn resumable(g: &Git, abort: &str, carry_on: &str, start: String) -> String {
    if g.has(&["--abort"]) {
        abort.into()
    } else if g.has(&["--continue"]) {
        carry_on.into()
    } else {
        start
    }
}

fn sub_of(g: &Git, sub: &str) -> Option<String> {
    let op0 = g.op(0).unwrap_or("");
    Some(match sub {
        "status" => "Checking git status".into(),
        "diff" => diff(g),
        "log" | "shortlog" | "reflog" => log(g),
        "show" => show(g),
        "blame" => format!(
            "Checking who changed {}",
            g.ops.last().map_or_else(|| "the file".into(), |l| g.f(l))
        ),
        "add" => {
            if g.has(&["-A", "--all", "."]) || g.ops.contains(&".") {
                "Staging all changes".into()
            } else {
                format!("Staging {}", or(&g.shown(), "changes"))
            }
        }
        "commit" => commit(g),
        "push" => {
            if g.has(&["--tags"]) {
                "Pushing tags".into()
            } else {
                g.op(1).filter(|o| !o.is_empty()).map_or_else(
                    || "Pushing to the remote".into(),
                    |o| format!("Pushing {}", clip(o, 40)),
                )
            }
        }
        "pull" => "Pulling the latest changes".into(),
        "fetch" => {
            if op0.is_empty() {
                "Fetching from the remote".into()
            } else {
                format!("Fetching from {op0}")
            }
        }
        "clone" => format!(
            "Cloning {}",
            if op0.is_empty() {
                "a repository".into()
            } else {
                clip(&DOT_GIT.replace(&SCHEME.replace(op0, ""), ""), 50)
            }
        ),
        "checkout" | "switch" => checkout(g),
        "restore" => format!("Restoring {}", or(&g.shown(), "files")),
        "branch" => branch(g),
        "merge" => resumable(
            g,
            "Aborting the merge",
            "Finishing the merge",
            format!("Merging {}", g.op(0).unwrap_or("changes")),
        ),
        "rebase" => resumable(
            g,
            "Aborting the rebase",
            "Continuing the rebase",
            format!("Rebasing onto {}", g.op(0).unwrap_or("upstream")),
        ),
        "cherry-pick" => resumable(
            g,
            "Aborting the cherry-pick",
            "Continuing the cherry-pick",
            format!(
                "Cherry-picking {}",
                or(&clip(&g.ops.join(" "), 30), "a commit")
            ),
        ),
        "revert" => format!("Reverting {}", g.op(0).unwrap_or("a commit")),
        "reset" => {
            if g.has(&["--hard"]) {
                "Discarding local changes".into()
            } else if g.ops.is_empty() {
                "Resetting changes".into()
            } else {
                format!("Unstaging {}", g.shown())
            }
        }
        _ => return sub_more(g, sub),
    })
}

/// The rest of git's subcommands (stash … format-patch).
fn sub_more(g: &Git, sub: &str) -> Option<String> {
    let op0 = g.op(0).unwrap_or("");
    let r0 = g.rest.first().map_or("", String::as_str);
    Some(match sub {
        "stash" => match r0 {
            "pop" | "apply" => "Restoring stashed changes",
            "list" => "Listing stashes",
            "drop" => "Dropping a stash",
            "show" => "Viewing a stash",
            _ => "Stashing changes",
        }
        .into(),
        "tag" => {
            if !g.ops.is_empty() && !g.has(&["-l", "--list"]) {
                format!("Tagging {op0}")
            } else {
                "Listing tags".into()
            }
        }
        "remote" => {
            if r0 == "add" {
                crate::js::trim(&format!(
                    "Adding remote {}",
                    g.rest.get(1).map_or("", String::as_str)
                ))
                .to_owned()
            } else {
                "Checking remotes".into()
            }
        }
        "worktree" => match r0 {
            "add" => "Creating a worktree",
            "remove" => "Removing a worktree",
            "list" => "Listing worktrees",
            "prune" => "Cleaning up worktrees",
            _ => "Managing worktrees",
        }
        .into(),
        "rm" => format!("Removing {} from git", or(&g.shown(), "files")),
        "mv" => {
            if g.ops.len() == 2 {
                format!("Renaming {} to {}", g.f(g.ops[0]), g.f(g.ops[1]))
            } else {
                "Renaming files".into()
            }
        }
        "grep" => describe_grep("git grep", g.rest, g.paths, false).text,
        "ls-files" | "ls-tree" => "Listing tracked files".into(),
        "rev-parse" | "rev-list" | "merge-base" | "describe" | "name-rev" | "symbolic-ref"
        | "for-each-ref" | "cat-file" => "Inspecting the repository".into(),
        "config" => "Checking git settings".into(),
        "init" => "Creating a git repository".into(),
        "clean" => "Removing untracked files".into(),
        "bisect" => "Bisecting history".into(),
        "submodule" => "Updating submodules".into(),
        "apply" | "am" => "Applying a patch".into(),
        "format-patch" => "Exporting a patch".into(),
        _ => return None,
    })
}

pub(super) fn describe_git(args: &[String], paths: &RunPaths) -> Desc {
    // Skip global options: git -C dir -c k=v --no-pager status
    let mut i = 0;
    while i < args.len() && args[i].starts_with('-') {
        i += if matches!(args[i].as_str(), "-C" | "-c" | "--git-dir" | "--work-tree") {
            2
        } else {
            1
        };
    }
    let Some((sub, rest)) = args.get(i..).and_then(<[String]>::split_first) else {
        return Desc::strong("Running git");
    };
    let g = Git {
        rest,
        ops: operands(rest),
        paths,
    };
    Desc::strong(sub_of(&g, sub).unwrap_or_else(|| format!("Running git {sub}")))
}

fn pr(action: &str, r: &str) -> Option<String> {
    Some(match action {
        "create" => "Opening a pull request".into(),
        "view" => format!("Viewing pull request{r}"),
        "list" => "Listing pull requests".into(),
        "checks" => format!("Checking CI on pull request{r}"),
        "merge" => format!("Merging pull request{r}"),
        "diff" => format!("Viewing the diff of pull request{r}"),
        "checkout" | "co" => format!("Checking out pull request{r}"),
        "comment" => format!("Commenting on pull request{r}"),
        "review" => format!("Reviewing pull request{r}"),
        "edit" => format!("Editing pull request{r}"),
        "close" => format!("Closing pull request{r}"),
        "reopen" => format!("Reopening pull request{r}"),
        "ready" => format!("Marking pull request{r} ready"),
        "status" => "Checking pull request status".into(),
        _ => return None,
    })
}

fn issue(action: &str, r: &str) -> Option<String> {
    Some(match action {
        "create" => "Opening an issue".into(),
        "view" => format!("Reading issue{r}"),
        "list" => "Listing issues".into(),
        "comment" => format!("Commenting on issue{r}"),
        "close" => format!("Closing issue{r}"),
        "edit" => format!("Editing issue{r}"),
        _ => return None,
    })
}

fn fixed(action: &str, table: &[(&str, &str)], fallback: &str) -> String {
    table
        .iter()
        .find(|(k, _)| *k == action)
        .map_or(fallback, |(_, v)| v)
        .to_owned()
}

pub(super) fn describe_gh(args: &[String]) -> Desc {
    let area = args.first().map(String::as_str);
    let action = args.get(1).map_or("", String::as_str);
    let has_action = args.get(1).is_some();
    let rest = args.get(2..).unwrap_or(&[]);
    let num = operands(rest).into_iter().find(|o| {
        let d = o.strip_prefix('#').unwrap_or(o);
        !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit())
    });
    let r = num.map_or_else(String::new, |n| format!(" #{}", n.replacen('#', "", 1)));
    let action = if has_action { action } else { "\u{0}" }; // undefined matches no table key
    Desc::strong(match area {
        Some("pr") => pr(action, &r).unwrap_or_else(|| "Working with pull requests".into()),
        Some("issue") => issue(action, &r).unwrap_or_else(|| "Working with issues".into()),
        Some("run") => fixed(
            action,
            &[
                ("list", "Listing CI runs"),
                ("view", "Checking a CI run"),
                ("watch", "Watching a CI run"),
                ("rerun", "Re-running CI"),
            ],
            "Checking CI runs",
        ),
        Some("workflow") => if action == "run" {
            "Starting a workflow"
        } else {
            "Checking workflows"
        }
        .into(),
        Some("release") => fixed(
            action,
            &[
                ("create", "Publishing a GitHub release"),
                ("view", "Viewing a release"),
                ("list", "Listing releases"),
                ("edit", "Editing a release"),
                ("upload", "Uploading release files"),
            ],
            "Working with releases",
        ),
        Some("repo") => fixed(
            action,
            &[
                ("view", "Viewing the repository"),
                ("clone", "Cloning a repository"),
                ("create", "Creating a repository"),
                ("fork", "Forking a repository"),
            ],
            "Working with the repository",
        ),
        Some("api") => {
            let what = if has_action && !action.is_empty() && !action.starts_with('-') {
                let c = clip(&REPO_PREFIX.replace(action, ""), 30);
                format!(" ({})", or(&c, "repo"))
            } else {
                String::new()
            };
            format!("Calling the GitHub API{what}")
        }
        Some("auth") => "Checking GitHub sign-in".into(),
        Some("search") => "Searching GitHub".into(),
        other => crate::js::trim(&format!("Running gh {}", other.unwrap_or(""))).to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patterns_compile() {
        for r in [&SCHEME, &DOT_GIT, &REPO_PREFIX] {
            assert!(r.compiles(), "{}", r.pattern());
        }
    }
}
