//! The generated half of the command line (ADR-0022): `wisp <plugin> <verb>` for every command the
//! caller may run, `wisp help [plugin]` and `wisp completions zsh|bash|fish`, all from `cli.catalogue`
//! (wisp.cli). The parsing, help and rendering are wisp-cli-core's; this is the IO around them.
use std::io::IsTerminal;
use std::path::Path;

use serde_json::{Value, json};
use wisp_cli_core::verbs::{self, Catalogue};
use wisp_cli_core::{Images, Style, completions, human};

use crate::client::{CliError, Client, Result};
use crate::scripted::say;

/// What `wisp` exits with when the command line didn't fit (a refusal from wisp exits 1).
pub const USAGE_EXIT: i32 = 2;

/// The terminal's width: `COLUMNS`, else `stty size` on the terminal, else 80.
pub fn columns() -> usize {
    if let Some(n) = std::env::var("COLUMNS").ok().and_then(|c| c.parse::<usize>().ok()).filter(|n| *n >= 20) {
        return n;
    }
    #[cfg(unix)]
    if let Ok(tty) = std::fs::File::open("/dev/tty")
        && let Ok(o) = std::process::Command::new("stty").arg("size").stdin(tty).stderr(std::process::Stdio::null()).output()
        && let Some(n) = String::from_utf8_lossy(&o.stdout).split_whitespace().nth(1).and_then(|c| c.parse::<usize>().ok())
        && n >= 20
    {
        return n;
    }
    80
}

/// How stdout draws: colour on a terminal unless `NO_COLOR` (or `TERM=dumb`); OSC 8 links with colour;
/// inline images in `iTerm2`, `WezTerm` and kitty.
pub fn style() -> Style {
    let tty = std::io::stdout().is_terminal();
    let no_color = std::env::var_os("NO_COLOR").is_some_and(|v| !v.is_empty()) || std::env::var("TERM").is_ok_and(|t| t == "dumb");
    let width = if tty { columns() } else { std::env::var("COLUMNS").ok().and_then(|c| c.parse().ok()).unwrap_or(80) };
    if !tty || no_color {
        return Style::plain(width);
    }
    let program = std::env::var("TERM_PROGRAM").unwrap_or_default();
    let images = if program == "iTerm.app" || program == "WezTerm" {
        Images::Iterm
    } else if std::env::var_os("KITTY_WINDOW_ID").is_some() || std::env::var("TERM").is_ok_and(|t| t.contains("kitty")) {
        Images::Kitty
    } else {
        Images::None
    };
    Style { images, ..Style::color(width) }
}

/// The catalogue this caller sees, from the running wisp (kept in `<home>/cli-catalogue.json` too).
pub async fn catalogue(c: &Client, home: &Path) -> Result<Catalogue> {
    let list = c.cmd("cli.catalogue", json!({})).await?;
    if let Ok(text) = serde_json::to_vec(&list) {
        let _ = std::fs::write(home.join("cli-catalogue.json"), text);
    }
    let list: Vec<wisp_kernel::CommandInfo> = serde_json::from_value(list).map_err(|e| CliError::said(format!("cli.catalogue: {e}")))?;
    Ok(Catalogue::new(list))
}

/// The words after the verb, as typed: from the raw argv (the global parser has eaten flags such as
/// `--mode` that a command may declare too).
fn rest_after(argv: &[String], first: &str, taken: usize) -> Vec<String> {
    let start = argv.iter().position(|a| a == first).unwrap_or(0);
    argv.get(start + taken..).map(<[String]>::to_vec).unwrap_or_default()
}

/// `wisp <plugin> <verb> …` when the words name one; None: they don't (a task, then).
pub async fn generated(c: &Client, cat: &Catalogue, words: &[String], argv: &[String]) -> Result<Option<i32>> {
    let Some((v, taken)) = cat.resolve(words) else { return Ok(None) };
    let (own, rest) = verbs::own(&rest_after(argv, &words[0], taken));
    if own.help {
        say(&verbs::help_verb(v));
        return Ok(Some(0));
    }
    let args = match verbs::build(v, &rest) {
        Ok(a) => a,
        Err(u) => {
            eprintln!("  ✗ {u}");
            return Ok(Some(USAGE_EXIT));
        }
    };
    let out = c.cmd(&v.info.id, args).await?;
    print_result(&out, own.json || argv.iter().any(|a| a == "--json"));
    Ok(Some(0))
}

pub fn print_result(v: &Value, json: bool) {
    if json {
        say(&serde_json::to_string_pretty(v).unwrap_or_default());
        return;
    }
    say(&human::render(v, &style()).join("\n"));
}

/// `wisp help` and `wisp help <plugin>` (`wisp help <plugin> <verb>` is that verb's `--help`).
pub fn help(cat: &Catalogue, words: &[String]) -> i32 {
    match words.get(1..).unwrap_or_default() {
        [] => say(&verbs::help_all(cat, crate::args::HELP)),
        [p] => {
            let Some(h) = verbs::help_plugin(cat, p) else {
                eprintln!("  ✗ no plugin named {p} in this wisp: wisp help lists them");
                return USAGE_EXIT;
            };
            say(&h);
        }
        more => {
            let Some((v, _)) = cat.resolve(more) else {
                eprintln!("  ✗ no command wisp {}: wisp help {} lists its verbs", more.join(" "), more[0]);
                return USAGE_EXIT;
            };
            say(&verbs::help_verb(v));
        }
    }
    0
}

/// `wisp sdk types ts|py [FILE]`: the SDKs' typed commands, printed or written to FILE.
pub fn sdk_types(cat: &Catalogue, lang: Option<&String>, out: Option<&String>) -> i32 {
    let Some(text) = lang.and_then(|l| wisp_cli_core::sdk::types(cat, l)) else {
        eprintln!("  ✗ wisp sdk types ts|py [FILE]");
        return USAGE_EXIT;
    };
    match out {
        None => {
            // the text ends with its own newline
            say(text.strip_suffix('\n').unwrap_or(&text));
            0
        }
        Some(f) => match std::fs::write(f, text) {
            Ok(()) => {
                say(&format!("  ✓ wrote {f}"));
                0
            }
            Err(e) => {
                eprintln!("  ✗ couldn't write {f}: {e}");
                1
            }
        },
    }
}

pub fn completions(cat: &Catalogue, shell: Option<&String>) -> i32 {
    let Some(s) = shell.and_then(|sh| completions::script(sh, cat, &crate::args::COMMANDS)) else {
        eprintln!("  ✗ wisp completions zsh|bash|fish");
        return USAGE_EXIT;
    };
    say(&s);
    0
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::path::PathBuf;

    use super::*;

    fn root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
    }

    fn files(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() && !p.ends_with("node_modules") && !p.ends_with("dist") {
                files(&p, out);
            } else if p.extension().is_some_and(|x| x == "ts" || x == "tsx") {
                out.push(p);
            }
        }
    }

    /// Every command the plugin manifests declare.
    fn declared() -> Vec<wisp_kernel::CommandInfo> {
        let mut out = Vec::new();
        for e in std::fs::read_dir(root().join("plugins")).unwrap().flatten() {
            let Ok(text) = std::fs::read_to_string(e.path().join("host/wisp-plugin.json")) else { continue };
            let m: Value = serde_json::from_str(&text).unwrap();
            for c in m["contributes"]["commands"].as_array().into_iter().flatten() {
                out.push(wisp_kernel::CommandInfo {
                    id: c["id"].as_str().unwrap().to_owned(),
                    plugin: m["id"].as_str().unwrap().to_owned(),
                    title: c["title"].as_str().map(str::to_owned),
                    read_only: false,
                    permission: String::new(),
                    args: None,
                    ui_only: c["uiOnly"].as_str().map(str::to_owned),
                });
            }
        }
        out
    }

    /// The command ids the UI calls (`defineCommand({ id: '…' })`).
    fn ui_calls() -> BTreeSet<String> {
        let mut paths = Vec::new();
        for d in ["packages/shell/src", "packages/client/src", "apps/web/src"] {
            files(&root().join(d), &mut paths);
        }
        for e in std::fs::read_dir(root().join("plugins")).unwrap().flatten() {
            files(&e.path().join("ui/src"), &mut paths);
        }
        let mut out = BTreeSet::new();
        for p in paths {
            let text = std::fs::read_to_string(&p).unwrap_or_default();
            for (at, _) in text.match_indices("defineCommand") {
                let near = &text[at..text.len().min(at + 400)];
                if let Some(i) = near.find("id: '") {
                    let id: String = near[i + 5..].chars().take_while(|c| *c != '\'').collect();
                    if id.contains('.') {
                        out.insert(id);
                    }
                }
            }
        }
        out
    }

    #[test]
    fn every_command_the_ui_calls_has_a_cli_path() {
        let cat = Catalogue::new(declared());
        // every declared command resolves from its own path
        for v in &cat.verbs {
            let mut words = vec![v.plugin.clone()];
            words.extend(v.words.iter().cloned());
            assert_eq!(
                cat.resolve(&words).map(|(x, _)| x.info.id.clone()),
                Some(v.info.id.clone()),
                "wisp {} doesn't reach {}",
                words.join(" "),
                v.info.id
            );
        }
        let calls = ui_calls();
        assert!(calls.len() > 20, "the UI's commands were found: {calls:?}");
        let missing: BTreeSet<String> = calls.iter().filter(|id| cat.by_id(id).is_none()).cloned().collect();
        // the known gaps (UI written ahead of its host): the list only shrinks
        let known: BTreeSet<String> = std::fs::read_to_string(root().join("plugins/cli/parity-gaps.txt"))
            .unwrap()
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && !l.starts_with('#'))
            .map(str::to_owned)
            .collect();
        let new: Vec<&String> = missing.difference(&known).collect();
        assert!(new.is_empty(), "the UI calls commands no manifest declares, so the CLI can't reach them: {new:?}");
        let closed: Vec<&String> = known.difference(&missing).collect();
        assert!(closed.is_empty(), "these have a host command now: take them off plugins/cli/parity-gaps.txt: {closed:?}");
    }

    #[test]
    fn rest_after_reads_the_raw_words() {
        let argv: Vec<String> = ["--port", "9", "crew", "create", "--mode", "auto"].map(str::to_owned).to_vec();
        assert_eq!(rest_after(&argv, "crew", 2), ["--mode", "auto"]);
    }
}
