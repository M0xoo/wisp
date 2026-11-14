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
use crate::text::lower;
use std::cell::Cell;

/// A stage with no command at all (`while` alone): v1 threw on it, and the whole line fell back.
#[derive(Debug, Clone, Copy)]
struct Empty;

thread_local! {
    /// While set, nothing is clipped: `describe_command` builds a step's whole title (what an opened step shows),
    /// not the short label the row and the ticker use (v1 commands.js `whole`, #780). Pure: no I/O, one thread's state.
    static WHOLE: Cell<bool> = const { Cell::new(false) };
}

/// Whether a whole title is being built (nothing shortened).
pub(crate) fn whole() -> bool {
    WHOLE.with(Cell::get)
}

/// The kit's `clip`, or the text whole (its whitespace collapsed) while a whole title is being built.
pub(crate) fn clip(s: &str, n: usize) -> String {
    if WHOLE.with(Cell::get) { s.split_whitespace().collect::<Vec<_>>().join(" ") } else { crate::text::clip(s, n) }
}

/// A run step's label, and its whole title when the label had to be cut (v1 `runLabel`, #780): `description` is the
/// agent's own words for it (clipped at 80 as v1), else the command described.
pub fn run_label(command: &str, paths: &RunPaths, description: Option<&str>) -> (String, Option<String>) {
    let said = description.map(str::trim).filter(|d| !d.is_empty());
    let label = said.map_or_else(|| describe_command(command, paths), |d| crate::text::clip(d, 80));
    let title = if let Some(d) = said {
        d.split_whitespace().collect::<Vec<_>>().join(" ")
    } else {
        WHOLE.with(|w| w.set(true));
        let t = describe_command(command, paths);
        WHOLE.with(|w| w.set(false));
        t
    };
    let cut = (title != label).then_some(title);
    (label, cut)
}

/// What `command` does, in words, for the live ticker (v1 `describeCommand(command, cwd)`).
pub fn describe_command(command: &str, paths: &RunPaths) -> String {
    let raw = js::trim(command);
    let fallback = || format!("Running {}", clip(raw, 60));
    if raw.is_empty() {
        return fallback();
    }
    let parts: Vec<Desc> =
        match segments(&strip_heredocs(raw)).iter().map(|p| describe_pipeline(p, paths)).collect::<Result<Vec<_>, Empty>>() {
            Ok(p) => p.into_iter().flatten().collect(),
            Err(Empty) => return fallback(),
        };
    // Separators like `echo ---` or `cd x` only count when nothing better was found.
    let strong: Vec<&Desc> = parts.iter().filter(|p| !p.weak).collect();
    let pool: Vec<&Desc> = if strong.is_empty() { parts.iter().collect() } else { strong.clone() };
    let mut texts: Vec<&str> = Vec::new();
    for p in pool {
        if !texts.contains(&p.text.as_str()) {
            texts.push(&p.text);
        }
    }
    if texts.is_empty() || (strong.is_empty() && texts.len() > 1) || (texts.len() == 1 && parts.iter().all(|p| p.unknown)) {
        return fallback();
    }
    match texts.get(1).filter(|s| !s.is_empty()) {
        None => clip(texts[0], 90),
        Some(second) => {
            let more = if texts.len() > 2 { format!(" (+{} more)", texts.len() - 2) } else { String::new() };
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

fn describe_stage(stage: &shell::Stage, paths: &RunPaths, piped: bool) -> Result<Option<Desc>, Empty> {
    let Some((cmd0, args)) = stage.argv.split_first() else {
        return Err(Empty);
    };
    let cmd = basename(cmd0);
    if let Some(out) = stage.out.as_deref().filter(|o| !o.is_empty())
        && matches!(cmd, "echo" | "printf" | "cat" | "tee")
    {
        return Ok(Some(Desc::strong(format!("Writing {}", short(out, paths)))));
    }
    let ctx = Ctx { cmd, args, input: stage.input.as_deref(), paths, piped, files: operands(args) };
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
    if label == format!("Running {}", clip(js::trim(s), 60)) { Desc::unknown(label) } else { Desc::strong(label) }
}
