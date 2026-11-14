//! What to spawn for a Codex run (v1 codex.js `run()`): `codex exec --json …`, the prompt on stdin.
//! Plain data from a [`HarnessRun`]; the lean base prompt is a launch file the runtime writes.

use std::fmt::Write as _;

use wisp_codex_core::{CodexArgs, LEAN_BASE, args};
use wisp_harness_kit::protocol::{FileNote, attachment_note, with_protocol};
use wisp_runtime_api::harness::{HarnessRun, Launch, LaunchFile, Stdin};
use wisp_runtime_api::model::Mode;

pub const DEFAULT_BIN: &str = "codex";
const LEAN_FILE: &str = "codex-base.md";

fn is_image(mime: &str) -> bool {
    matches!(mime, "image/png" | "image/jpeg" | "image/jpg" | "image/gif" | "image/webp")
}

fn dir_of(p: &str) -> String {
    match p.rfind(['/', '\\']) {
        Some(0) => "/".to_owned(),
        Some(i) => p[..i].to_owned(),
        None => ".".to_owned(),
    }
}

fn mode(m: Mode) -> &'static str {
    match m {
        Mode::Plan => "plan",
        Mode::Edits => "edits",
        Mode::Auto => "auto",
    }
}

/// `developer`: this codex takes developer instructions (≥ 0.53, not Windows, none in config.toml).
pub fn launch(run: &HarnessRun, bin: &str, developer: bool) -> Launch {
    let resume = run.resume_id.as_deref().filter(|r| !r.is_empty());
    // resumed and forked threads have the protocol in their history already
    let developer = (developer && resume.is_none() && !run.system_prompt.trim().is_empty()).then_some(run.system_prompt.as_str());
    let with_path: Vec<_> = run.attachments.iter().filter(|a| a.path.is_some()).collect();
    let images: Vec<String> = with_path.iter().filter(|a| is_image(&a.mime)).filter_map(|a| a.path.clone()).collect();
    let attachment_dirs: Vec<String> = with_path.iter().filter_map(|a| a.path.as_deref().map(dir_of)).collect();
    let lean_base = format!("{{tmp}}/{LEAN_FILE}");
    let a = CodexArgs {
        mode: mode(run.mode),
        model: &run.model,
        effort: &run.effort,
        dirs: &run.dirs,
        resume_id: resume,
        fork: run.fork,
        capped: run.capped,
        lean_base: run.lean.then_some(lean_base.as_str()),
        developer,
        mcp_servers: Some(&run.mcp_servers),
        images: &images,
        attachment_dirs: &attachment_dirs,
    };
    let mut input = if developer.is_some() || run.system_prompt.trim().is_empty() {
        run.prompt.clone()
    } else {
        with_protocol(&run.prompt, &run.system_prompt, resume)
    };
    let notes: Vec<FileNote> = with_path
        .iter()
        .filter(|a| !is_image(&a.mime))
        .map(|a| FileNote { path: a.path.clone().unwrap_or_default(), mime: a.mime.clone(), size: a.size })
        .collect();
    input.push_str(&attachment_note(&notes, Some("Read text files and PDFs from disk")));
    if !images.is_empty() {
        let n = images.len();
        let _ = write!(input, "\n\n({n} image{} attached to this message.)", if n > 1 { "s are" } else { " is" });
    }
    Launch {
        program: bin.to_owned(),
        args: args(&a),
        cwd: run.cwd.clone(),
        stdin: Stdin::Bytes(input.into_bytes()),
        files: if run.lean { vec![LaunchFile { path: LEAN_FILE.into(), contents: LEAN_BASE.into() }] } else { Vec::new() },
        ..Launch::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wisp_runtime_api::model::Attachment;

    fn run() -> HarnessRun {
        HarnessRun {
            prompt: "fix the add bug".into(),
            cwd: "/w".into(),
            system_prompt: "# You are running inside wisp".into(),
            mode: Mode::Edits,
            ..HarnessRun::default()
        }
    }

    fn stdin(l: &Launch) -> String {
        match &l.stdin {
            Stdin::Bytes(b) => String::from_utf8_lossy(b).into_owned(),
            _ => String::new(),
        }
    }

    #[test]
    fn the_protocol_goes_as_developer_instructions_or_ahead_of_the_prompt() {
        let l = launch(&run(), "codex", true);
        assert!(l.args.iter().any(|a| a.starts_with("developer_instructions=\"# You are running inside wisp")));
        assert_eq!(stdin(&l), "fix the add bug");
        let old = launch(&run(), "codex", false);
        assert!(stdin(&old).contains("running inside wisp\n\n---\n\n# Task\n\nfix the add bug"));
        let mut r = run();
        r.resume_id = Some("prev-1".into());
        let resumed = launch(&r, "codex", true);
        assert_eq!(stdin(&resumed), "fix the add bug");
        assert!(resumed.args.ends_with(&["resume".to_owned(), "prev-1".to_owned()]));
    }

    #[test]
    fn attachments_images_and_lean() {
        let mut r = run();
        r.attachments = vec![
            Attachment { path: Some("/up/a.png".into()), mime: "image/png".into(), size: 10, ..Attachment::default() },
            Attachment { path: Some("/docs/b.pdf".into()), mime: "application/pdf".into(), size: 2048, ..Attachment::default() },
        ];
        r.lean = true;
        let l = launch(&r, "codex", false);
        assert!(l.args.windows(2).any(|w| w == ["-i", "/up/a.png"]));
        assert!(l.args.windows(2).any(|w| w == ["--add-dir", "/docs"]));
        assert!(l.args.iter().any(|a| a == "model_instructions_file=\"{tmp}/codex-base.md\""));
        assert_eq!(l.files.len(), 1);
        let s = stdin(&l);
        assert!(s.contains("/docs/b.pdf") && s.ends_with("(1 image is attached to this message.)"), "{s}");
    }
}
