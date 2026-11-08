//! What the reviewer is asked, and what its reply becomes (v1 reviewPrompt, readReview, partialSummary).

use serde_json::Value;
use wisp_review_api::{Coverage, Finding, Severity, TestsRun};

use crate::pick::clip;

pub const MAX_FINDINGS: usize = 20;

fn files_word(n: u32) -> String {
    format!("{n} file{}", if n == 1 { "" } else { "s" })
}

/// The first `n` characters (JS `slice(0, n)`).
fn head(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// The last `n` characters (JS `slice(-n)`).
fn tail(s: &str, n: usize) -> String {
    let c = s.chars().count();
    s.chars().skip(c.saturating_sub(n)).collect()
}

/// Replaces the reviewer's own summary when it found nothing in a partial diff: "Nothing to fix" would
/// read as a pass.
pub fn partial_summary(c: &Coverage) -> String {
    if c.seen > 0 {
        return "No issues in what it read.".into();
    }
    match c.cut.len() {
        0 => "No issues found, but it read nothing.".into(),
        1 => "No issues in the part it read.".into(),
        _ => "No issues in the parts it read.".into(),
    }
}

#[derive(Debug, Clone, Default)]
pub struct PromptInput<'a> {
    pub title: &'a str,
    pub task: &'a str,
    pub diff: &'a str,
    pub tests: Option<&'a TestsRun>,
    pub constraints: &'a [String],
    pub coverage: Option<&'a Coverage>,
}

fn constraints_block(c: &[String]) -> String {
    if c.is_empty() {
        return String::new();
    }
    let list: Vec<String> = c
        .iter()
        .enumerate()
        .map(|(i, r)| format!("{}. {r}", i + 1))
        .collect();
    format!(
        "\n<constraints>\nThe user set these for this task, in their own words. Check the diff against each one. A change that breaks one (touches what they ruled out, works outside what they narrowed it to, or plainly doesn't do what Done when asks) is a \"high\" finding with \"constraint\" set to its number, and its text names the path and the user's words, like \"Touched migrations/ — you said: don't touch migrations\". Leave \"constraint\" out of every other finding.\n{}\n</constraints>\n",
        list.join("\n")
    )
}

fn tests_block(t: Option<&TestsRun>) -> String {
    let Some(t) = t.filter(|t| t.verdict != "skip") else {
        return String::new();
    };
    let out = if t.verdict == "pass" {
        String::new()
    } else {
        format!("\n{}\n", tail(&t.output, 3000))
    };
    format!(
        "\n<tests command=\"{}\" verdict=\"{}\">{out}</tests>\n",
        t.command, t.verdict
    )
}

fn partial_block(c: Option<&Coverage>) -> String {
    let Some(c) = c.filter(|c| c.partial()) else {
        return String::new();
    };
    let mut s = format!(
        "\n<partial>\nThis diff is partial: it holds {} of {} whole.",
        c.seen,
        files_word(c.files)
    );
    if !c.cut.is_empty() {
        s.push_str(&format!("\nOnly part of: {}", c.cut.join(", ")));
    }
    if !c.missing.is_empty() {
        s.push_str(&format!("\nNot in it: {}", c.missing.join(", ")));
    }
    if let Some(m) = c.more.filter(|m| *m > 0) {
        s.push_str(&format!("\nAnd {} not named here.", files_word(m)));
    }
    s.push_str("\nYou may read those from your working directory. Your answer covers only what you read: say so in your summary, and don't call the rest clean.\n</partial>\n");
    s
}

pub fn review_prompt(p: &PromptInput<'_>) -> String {
    let diff = if !p.diff.is_empty() {
        p.diff.to_owned()
    } else if p.coverage.is_some_and(|c| c.files > 0) {
        "(none of it fits here: read the files named above)".into()
    } else {
        "(no changes)".into()
    };
    let constraint = if p.constraints.is_empty() {
        ""
    } else {
        ", \"constraint\": 1"
    };
    format!(
        "You review a pull request another coding agent wrote, before it's merged. Your working directory is its branch at the PR's head: open the files, read the code around the change, run read-only commands. Don't take the PR's word for anything you can check.

Look for what would make a careful reviewer ask for changes: bugs, missed cases, broken behaviour elsewhere, security problems, missing tests for what changed, and code that ignores the project's own rules (AGENTS.md, CONTRIBUTING, README). Skip style nits and anything the diff didn't touch. No findings is a fine answer.

<pr title=\"{}\">
{}
</pr>
{}{}{}
<diff>
{diff}
</diff>

Reply with one JSON object: {{\"summary\": \"one sentence\", \"findings\": [{{\"severity\": \"high\" | \"medium\" | \"low\", \"file\": \"path\", \"line\": 12, \"text\": \"what is wrong and what to do\"{constraint}}}]}}",
        head(&p.title.replace('"', "'"), 200),
        head(p.task, 3000),
        tests_block(p.tests),
        constraints_block(p.constraints),
        partial_block(p.coverage),
    )
}

/// JS `Number(v)`: a number, a numeric string ("" is 0), a bool; anything else NaN (None).
fn js_number(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) if s.trim().is_empty() => Some(0.0),
        Value::String(s) => s.trim().parse().ok(),
        Value::Bool(b) => Some(f64::from(u8::from(*b))),
        Value::Null => Some(0.0),
        _ => None,
    }
}

fn positive_int(v: &Value) -> Option<u32> {
    let n = js_number(v)?;
    (n.is_finite() && n.fract() == 0.0 && n > 0.0 && n <= f64::from(u32::MAX)).then(|| n as u32)
}

fn text_of(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(true) => "true".into(),
        _ => String::new(),
    }
}

fn severity(v: &Value) -> Severity {
    match v.as_str() {
        Some("high") => Severity::High,
        Some("low") => Severity::Low,
        _ => Severity::Medium,
    }
}

fn finding(f: &Value, constraints: &[String]) -> Finding {
    let n = positive_int(&f["constraint"]).filter(|n| (*n as usize) <= constraints.len());
    let rule = n.map(|n| constraints[n as usize - 1].clone());
    let file = text_of(&f["file"]);
    Finding {
        severity: if rule.is_some() {
            Severity::High
        } else {
            severity(&f["severity"])
        },
        file: (!file.is_empty()).then(|| clip(&file, 200)),
        line: positive_int(&f["line"]),
        text: clip(&text_of(&f["text"]), 600),
        constraint: n,
        rule,
    }
}

/// A reviewer's reply as (summary, findings), high first, or None when it said nothing usable. A finding
/// that breaks one of `constraints` is high whatever the reviewer said, and carries the user's words.
pub fn read_review(j: &Value, constraints: &[String]) -> Option<(String, Vec<Finding>)> {
    let list = j.as_object()?.get("findings")?.as_array()?;
    let mut findings: Vec<Finding> = list
        .iter()
        .filter(|f| f.is_object() && !text_of(&f["text"]).trim().is_empty())
        .take(MAX_FINDINGS)
        .map(|f| finding(f, constraints))
        .collect();
    findings.sort_by_key(|f| f.severity); // stable: the reviewer's order within a severity
    let given = text_of(&j["summary"]);
    let summary = if !given.is_empty() {
        given
    } else if findings.is_empty() {
        "Nothing to fix.".into()
    } else {
        format!(
            "{} issue{} found.",
            findings.len(),
            if findings.len() > 1 { "s" } else { "" }
        )
    };
    Some((clip(&summary, 300), findings))
}
