//! describeCommand: a shell command as the ticker's sentence, e.g. `sed -n 15,50p src/a.js` →
//! "Reading lines 15–50 of src/a.js". Best effort: a command we don't know falls back to "Running
//! <command>", and the raw command stays in the activity detail. Pure; the port of v1
//! `server/adapters/commands.js`, output for output (`tests/commands.rs`: 10,047 recorded cases).

mod argv;
mod files;
mod heredoc;
mod shell;
mod system;
mod tools;
mod url;
mod vcs;

use serde_json::Value;

use self::argv::{Ctx, Desc, basename, operands, short};
use self::shell::{parse_stage, segments, strip_heredocs};
use crate::js;
use crate::paths::RunPaths;
use crate::text::{clip, lower};

/// A stage with no command at all (`while` alone): v1 threw on it, and the whole line fell back.
#[derive(Debug, Clone, Copy)]
struct Empty;

/// What `command` does, in words, for the live ticker (v1 `describeCommand(command, cwd)`).
pub fn describe_command(command: &str, paths: &RunPaths) -> String {
    let raw = js::trim(command);
    let fallback = || format!("Running {}", clip(raw, 60));
    if raw.is_empty() {
        return fallback();
    }
    let parts: Vec<Desc> = match segments(&strip_heredocs(raw))
        .iter()
        .map(|p| describe_pipeline(p, paths))
        .collect::<Result<Vec<_>, Empty>>()
    {
        Ok(p) => p.into_iter().flatten().collect(),
        Err(Empty) => return fallback(),
    };
    // Separators like `echo ---` or `cd x` only count when nothing better was found.
    let strong: Vec<&Desc> = parts.iter().filter(|p| !p.weak).collect();
    let pool: Vec<&Desc> = if strong.is_empty() {
        parts.iter().collect()
    } else {
        strong.clone()
    };
    let mut texts: Vec<&str> = Vec::new();
    for p in pool {
        if !texts.contains(&p.text.as_str()) {
            texts.push(&p.text);
        }
    }
    if texts.is_empty()
        || (strong.is_empty() && texts.len() > 1)
        || (texts.len() == 1 && parts.iter().all(|p| p.unknown))
    {
        return fallback();
    }
    match texts.get(1).filter(|s| !s.is_empty()) {
        None => clip(texts[0], 90),
        Some(second) => {
            let more = if texts.len() > 2 {
                format!(" (+{} more)", texts.len() - 2)
            } else {
                String::new()
            };
            clip(&format!("{}, then {}{more}", texts[0], lower(second)), 90)
        }
    }
}

/// v1 took any value: `String(command ?? '')`.
pub fn describe_command_value(command: &Value, paths: &RunPaths) -> String {
    describe_command(&js::str(command), paths)
}

/// A pipeline is described by its first stage that says something (`git log | head` → git log).
fn describe_pipeline(stages: &[Vec<String>], paths: &RunPaths) -> Result<Option<Desc>, Empty> {
    let mut best: Option<Desc> = None;
    for words in stages {
        let stage = parse_stage(words);
        if stage.argv.is_empty() {
            continue;
        }
        let d = describe_stage(&stage, paths, stages.len() > 1)?;
        if let Some(d) = d.as_ref().filter(|d| !d.weak && !d.unknown) {
            return Ok(Some(d.clone()));
        }
        if best.is_none() {
            best = d;
        }
    }
    Ok(best)
}

/// The stage made of these words (`while <cond>`).
fn describe_words(words: &[String], paths: &RunPaths, piped: bool) -> Result<Option<Desc>, Empty> {
    describe_stage(&parse_stage(words), paths, piped)
}

fn describe_stage(
    stage: &shell::Stage,
    paths: &RunPaths,
    piped: bool,
) -> Result<Option<Desc>, Empty> {
    let Some((cmd0, args)) = stage.argv.split_first() else {
        return Err(Empty);
    };
    let cmd = basename(cmd0);
    if let Some(out) = stage.out.as_deref().filter(|o| !o.is_empty())
        && matches!(cmd, "echo" | "printf" | "cat" | "tee")
    {
        return Ok(Some(Desc::strong(format!("Writing {}", short(out, paths)))));
    }
    let ctx = Ctx {
        cmd,
        args,
        input: stage.input.as_deref(),
        paths,
        piped,
        files: operands(args),
    };
    let known = match system::describe(&ctx)? {
        Some(k) => Some(k),
        None => files::describe(&ctx).or_else(|| tools::describe(&ctx)),
    };
    Ok(match known {
        Some(d) => d,
        None => tools::describe_tool(&stage.argv, paths, false),
    })
}

/// `bash -c '<script>'`: the script's own description, marked unknown when that is the raw fallback.
fn describe_inner(script: Option<&str>, paths: &RunPaths) -> Desc {
    let s = script.unwrap_or("");
    let label = describe_command(s, paths);
    if label == format!("Running {}", clip(js::trim(s), 60)) {
        Desc::unknown(label)
    } else {
        Desc::strong(label)
    }
}
