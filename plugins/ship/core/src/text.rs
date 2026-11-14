//! The words Ship it uses: the draft commit message, the conflict-fix prompt, what an agent is told
//! when it attaches a PR, a failing job's log tail, and the GitHub URLs these read.

use wisp_ship_api::{Draft, PrSummary, Worktree};

/// Lines of a failing job's log the panel shows.
pub const LOG_LINES: usize = 80;

/// What the draft is made from: the latest presentation's hero and the rest of it, rendered by runtime.
#[derive(Debug, Clone, Default)]
pub struct DraftInput<'a> {
    pub hero_title: Option<&'a str>,
    pub hero_summary: Option<&'a str>,
    pub session_title: &'a str,
    pub first_prompt: &'a str,
    /// the presentation's other blocks as markdown (no hero, next, question, diff, code, media, task)
    pub markdown: &'a str,
}

/// `type(scope)!: ` at the start: already a conventional commit.
fn is_conventional(t: &str) -> bool {
    let kind = t.bytes().take_while(u8::is_ascii_lowercase).count();
    if kind == 0 {
        return false;
    }
    let mut rest = &t[kind..];
    if let Some(inner) = rest.strip_prefix('(') {
        let Some(close) = inner.find(')') else {
            return false;
        };
        let scope = &inner[..close];
        if scope.is_empty() || !scope.chars().all(|c| c.is_alphanumeric() || "_./-".contains(c)) {
            return false;
        }
        rest = &inner[close + 1..];
    }
    rest.strip_prefix('!').unwrap_or(rest).starts_with(": ")
}

fn word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `\b(needle)` (and `\b` after it when `whole`), case-insensitive.
fn has_word(hay: &str, needle: &str, whole: bool) -> bool {
    let hay = hay.to_ascii_lowercase();
    hay.match_indices(needle).any(|(i, m)| {
        let before = hay[..i].chars().next_back().is_none_or(|c| !word_char(c));
        let after = hay[i + m.len()..].chars().next().is_none_or(|c| !word_char(c));
        before && (!whole || after)
    })
}

fn commit_type(text: &str, prompt: &str) -> &'static str {
    let both = format!("{text} {prompt}");
    if ["fix", "bug", "broken", "crash", "flaky", "regression"].iter().any(|w| has_word(&both, w, false)) {
        "fix"
    } else if ["docs", "doc", "readme", "changelog"].iter().any(|w| has_word(text, w, true)) {
        "docs"
    } else if ["refactor", "cleanup", "clean up", "simplif"].iter().any(|w| has_word(text, w, false)) {
        "refactor"
    } else if ["tests", "test"].iter().any(|w| has_word(text, w, true)) {
        "test"
    } else {
        "feat"
    }
}

/// The answer's hero (title, summary) and the blocks a PR body keeps, as markdown (v1 draft's `keep`:
/// prose, callouts, steps, checklists, files; not the hero, next, question, diff, code, media or tasks).
pub fn presentation_parts(blocks: &[serde_json::Value]) -> (Option<&str>, Option<&str>, String) {
    let text = |b: &serde_json::Value, k: &str| b.get(k).and_then(serde_json::Value::as_str).unwrap_or_default().to_owned();
    let hero = blocks.iter().find(|b| b["type"] == "hero");
    let field = |k: &str| hero.and_then(|h| h.get(k)).and_then(serde_json::Value::as_str).filter(|s| !s.trim().is_empty());
    let items = |b: &serde_json::Value, line: &dyn Fn(&serde_json::Value) -> String| -> String {
        b["items"].as_array().map(|a| a.iter().map(line).collect::<Vec<_>>().join("\n")).unwrap_or_default()
    };
    let parts: Vec<String> = blocks
        .iter()
        .filter_map(|b| {
            let md = match b["type"].as_str()? {
                "markdown" => text(b, "text"),
                "callout" => match text(b, "title") {
                    t if t.is_empty() => format!("> {}", text(b, "text")),
                    t => format!("> **{t}** {}", text(b, "text")),
                },
                "steps" => items(b, &|i| {
                    format!(
                        "- {}{}",
                        text(i, "title"),
                        Some(text(i, "detail")).filter(|d| !d.is_empty()).map(|d| format!(": {d}")).unwrap_or_default()
                    )
                }),
                "checklist" => items(b, &|i| format!("- [{}] {}", if i["done"] == true { "x" } else { " " }, text(i, "text"))),
                "files" => items(b, &|i| format!("- `{}` {}", text(i, "path"), text(i, "note")).trim_end().to_owned()),
                _ => String::new(),
            };
            Some(md.trim().to_owned()).filter(|m| !m.is_empty())
        })
        .collect();
    (field("title"), field("summary"), parts.join("\n\n"))
}

/// The default commit message and PR text: conventional, from the hero title.
pub fn draft(d: &DraftInput<'_>) -> Draft {
    let text = d.hero_title.unwrap_or(d.session_title).trim();
    let title = if is_conventional(text) {
        text.to_owned()
    } else {
        let mut chars = text.chars();
        let lowered: String = chars.next().map(|c| c.to_lowercase().chain(chars).collect()).unwrap_or_default();
        format!("{}: {lowered}", commit_type(text, d.first_prompt))
    };
    let body = [d.hero_summary.unwrap_or_default(), d.markdown].iter().filter(|s| !s.is_empty()).copied().collect::<Vec<_>>().join("\n\n");
    let body = format!("{}\n\n_Shipped from [wisp](https://github.com/WispAgents/wisp)._", body.trim());
    Draft { title: title.chars().take(100).collect(), body: body.trim().to_owned() }
}

/// The follow-up a conflicting PR's task gets: merge the base in, don't rebase, don't push.
pub fn conflict_prompt(pr: &PrSummary, wt: &Worktree) -> String {
    let remote = wt.remote.as_deref().unwrap_or("origin");
    let base = &wt.base;
    [
        format!("PR #{} ({}) can no longer merge into `{base}`: changes that landed there since conflict with this branch. Bring the branch up to date:", pr.number, pr.url),
        String::new(),
        format!("1. `git fetch {remote}`, then `git merge {remote}/{base}`. Don't rebase: the branch is already pushed."),
        format!("2. Resolve every conflict, keeping the intent of both sides: what landed on `{base}` and what this task changed. Don't drop either side's changes to make a conflict go away."),
        "3. Run the checks that are cheap here (tests, type-check, build) on the merged result and fix what the merge broke.".into(),
        "4. Finish with `git commit --no-edit`. Don't push: wisp pushes to the PR when you're done.".into(),
        String::new(),
        "If a conflict needs a decision only the user can make, ask them.".into(),
    ]
    .join("\n")
}

/// The commit message of a pushed conflict fix.
pub fn fix_title(wt: &Worktree) -> String {
    format!("Merge {}/{} into {}", wt.remote.as_deref().unwrap_or("origin"), wt.base, wt.branch)
}

/// The note each PR of a task across repos carries.
pub fn across_note(names: &[&str]) -> String {
    let list: Vec<String> = names.iter().map(|n| format!("`{n}`")).collect();
    format!("\n\nPart of one task across {}: wisp opens a pull request in each.", list.join(", "))
}

/// What `wisp_pr` tells the agent after attaching. `n`: the task's PRs now.
pub fn attach_text(pr: &PrSummary, own: bool, n: usize) -> String {
    let where_ = if own {
        "It is the PR of this task’s own branch: Ship it pushes to it.".to_owned()
    } else if n > 1 {
        format!("The task has {n} PRs now; attach each one you open or work on.")
    } else {
        String::new()
    };
    let draft = if pr.draft { ", draft" } else { "" };
    format!(
        "Attached PR #{} “{}” ({}{draft}): {}. It shows on the task, and wisp follows its checks and reviews. {where_}",
        pr.number,
        pr.title,
        pr.state.to_lowercase(),
        pr.url
    )
    .trim()
    .to_owned()
}

pub fn detach_text(pr: &PrSummary) -> String {
    format!("Detached PR #{} ({}).", pr.number, pr.url)
}

/// `owner/repo` and the job id of a GitHub Actions job URL; None for anything else.
pub fn check_log_job(url: &str) -> Option<(String, String, String)> {
    let rest = url.strip_prefix("https://github.com/")?;
    let parts: Vec<&str> = rest.splitn(7, '/').collect();
    let ok = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_alphanumeric() || "_.-".contains(c));
    let digits = |s: &str| -> String { s.chars().take_while(char::is_ascii_digit).collect() };
    if parts.len() < 6
        || !ok(parts[0])
        || !ok(parts[1])
        || parts[2] != "actions"
        || parts[3] != "runs"
        || parts[4].is_empty()
        || !parts[4].bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    let job = parts[5].strip_prefix("job")?;
    let job = parts.get(6).filter(|_| job.is_empty()).map(|j| digits(j))?;
    (!job.is_empty()).then(|| (parts[0].to_owned(), parts[1].to_owned(), job))
}

/// The repo name of a PR URL (`…/acme/docs/pull/9` → `docs`), "" otherwise.
pub fn repo_of_url(url: &str) -> String {
    let Some(at) = url.find("github.com/") else {
        return String::new();
    };
    let mut parts = url[at + 11..].split('/');
    match (parts.next(), parts.next(), parts.next()) {
        (Some(o), Some(r), Some("pull")) if !o.is_empty() && !r.is_empty() => r.to_owned(),
        _ => String::new(),
    }
}

fn strip_stamp(l: &str) -> &str {
    let l = l.strip_prefix('\u{feff}').unwrap_or(l);
    let b = l.as_bytes();
    let date = b.len() >= 11
        && b[..4].iter().all(u8::is_ascii_digit)
        && b[4] == b'-'
        && b[5..7].iter().all(u8::is_ascii_digit)
        && b[7] == b'-'
        && b[8..10].iter().all(u8::is_ascii_digit)
        && b[10] == b'T';
    if !date {
        return l;
    }
    let tail = l[11..].bytes().take_while(|c| c.is_ascii_digit() || *c == b':' || *c == b'.').count();
    if tail == 0 || b.get(11 + tail) != Some(&b'Z') {
        return l;
    }
    let rest = &l[12 + tail..];
    rest.strip_prefix(' ').unwrap_or(rest)
}

fn strip_ansi(l: &str) -> String {
    let mut out = String::with_capacity(l.len());
    let mut rest = l;
    while let Some(i) = rest.find("\x1b[") {
        out.push_str(&rest[..i]);
        let after = &rest[i + 2..];
        let n = after.bytes().take_while(|c| c.is_ascii_digit() || *c == b';').count();
        if after.as_bytes().get(n) == Some(&b'm') {
            rest = &after[n + 1..];
        } else {
            out.push_str("\x1b[");
            rest = after;
        }
    }
    out.push_str(rest);
    out
}

/// `gh run view --log-failed` prints `job<TAB>step<TAB>stamp text`: just the text, its last `n` lines,
/// runs of blank lines folded to one.
pub fn log_tail(out: &str, n: usize) -> String {
    let lines: Vec<String> = out
        .split('\n')
        .map(|l| {
            let cols: Vec<&str> = l.split('\t').collect();
            let text = if cols.len() > 2 { cols[2..].join("\t") } else { String::new() };
            let text = if text.is_empty() { l.to_owned() } else { text };
            strip_ansi(strip_stamp(&text))
        })
        .collect();
    let kept: Vec<&str> = lines
        .iter()
        .enumerate()
        .filter(|(i, l)| !l.trim().is_empty() || (*i > 0 && !lines[i - 1].trim().is_empty()))
        .map(|(_, l)| l.as_str())
        .collect();
    kept[kept.len().saturating_sub(n)..].join("\n").trim().to_owned()
}

#[cfg(test)]
mod tests;
