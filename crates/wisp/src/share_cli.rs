//! Sharing from the terminal (ADR-0027 "Sharing in practice"):
//!
//! - `wisp share <id> [--level spec|report|full] [--to file|gist] [--out x.wisp-task] [--yes]`: the
//!   preview first (what goes, every redaction), then the signed bundle, to a file or a secret gist (`gh`).
//!   `--to link` and `--to <peer>` need wisp Grid's client, not in this build yet: they say so.
//! - `wisp open <file|url|gist:<id>> [--run | --their-setup | --import | --compare]`: who signed it, what
//!   it needs, then run it on your code (names resolved in your formula), rerun it with their setup (the
//!   shared snapshot), import it read-only (`full`), or both runs side by side.
use std::io::{IsTerminal, Write};
use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use wisp_cli_core::term::{BOLD, DIM, GREEN, RED, YELLOW, paint};

use crate::client::{CliError, Client, Result};
use crate::code::Opts;
use crate::scripted::say;

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

fn tty() -> bool {
    std::io::stdin().is_terminal() && std::io::stdout().is_terminal()
}

fn ask(q: &str) -> String {
    let mut o = std::io::stdout().lock();
    let _ = write!(o, "{q}");
    let _ = o.flush();
    let mut l = String::new();
    let _ = std::io::stdin().read_line(&mut l);
    l.trim().to_owned()
}

/// `wisp share <id>`.
pub async fn share(c: &Client, o: &Opts, cwd: &Path) -> Result<i32> {
    let st = crate::cli::style();
    let Some(id) = o.words.first() else { return Err(CliError::said("wisp share <id> [--level spec|report|full] [--to file|gist]")) };
    let level = o.level.clone().unwrap_or_else(|| "spec".into());
    if !["spec", "report", "full"].contains(&level.as_str()) {
        return Err(CliError::said(format!("--level {level}: spec, report or full")));
    }
    let to = o.to.clone().map(|t| if t == "link" { "cloud".to_owned() } else { t }).unwrap_or_else(|| "file".into());
    if !["file", "gist", "cloud", "wisp-cloud"].contains(&to.as_str()) {
        eprintln!("  ✗ --to {to}: cloud, file or gist");
        return Ok(1);
    }
    // wisp Cloud: say how to sign in before anything (nothing is uploaded until it's ready)
    if to.contains("cloud") && !crate::cloud_cli::ready(c).await? {
        return Ok(1);
    }
    let args = json!({ "id": id, "level": level });
    let p = c.cmd("share.preview", args.clone()).await?;
    let b = &p["bundle"];
    say(&format!("{} {}  {}", paint(&st, BOLD, "Share"), s(b, "title"), paint(&st, DIM, &format!("({level})"))));
    let what = match level.as_str() {
        "spec" => "the ask and the setup it ran with; nothing of its output",
        "report" => "the ask, the setup, its answers and the files it changed",
        _ => "the ask, the setup and its whole history, transcript included",
    };
    say(&format!("  sends {what}"));
    let reds = p["redactions"].as_array().cloned().unwrap_or_default();
    if reds.is_empty() {
        say(&format!("  {} nothing to redact", paint(&st, GREEN, "✓")));
    } else {
        say(&format!("  {} taken out before it leaves:", paint(&st, YELLOW, "!")));
        for r in reds.iter().take(30) {
            say(&format!("    {:<6} {}  {} → {}", s(r, "kind"), paint(&st, DIM, s(r, "at")), s(r, "was"), paint(&st, GREEN, s(r, "now"))));
        }
        if reds.len() > 30 {
            say(&format!("    … and {} more", reds.len() - 30));
        }
    }
    if !o.yes {
        if !tty() {
            eprintln!("  ✗ not a terminal: share with --yes once you've read the preview (--json shows it whole)");
            return Ok(1);
        }
        if !matches!(ask("\n  Share it? [y/N] ").as_str(), "y" | "Y" | "yes") {
            say("  nothing shared");
            return Ok(1);
        }
    }
    if to.contains("cloud") {
        let mut send = crate::cloud_cli::send_args(o)?;
        send["kind"] = json!("task");
        send["id"] = json!(id);
        send["level"] = json!(level);
        let link = c.cmd("share.send", send).await?;
        crate::cloud_cli::said_shared(&link);
        return Ok(0);
    }
    let bundle = c.cmd("share.bundle", args).await?;
    let text = serde_json::to_string_pretty(&bundle).unwrap_or_default() + "\n";
    let file = o.out.clone().map_or_else(|| cwd.join(format!("{}.{}", wisp_share_core::slug(s(&bundle, "title")), wisp_share_api::EXTENSION)), PathBuf::from);
    std::fs::write(&file, &text)?;
    if to == "gist" {
        let out = tokio::process::Command::new("gh").args(["gist", "create", "--secret"]).arg(&file).output().await.map_err(|e| CliError::said(format!("gh: {e} (install the GitHub CLI and gh auth login)")))?;
        if !out.status.success() {
            return Err(CliError::said(format!("gh gist create: {}", String::from_utf8_lossy(&out.stderr).trim())));
        }
        say(&format!("  {} {}  (secret gist; wisp open it)", paint(&st, GREEN, "✓"), String::from_utf8_lossy(&out.stdout).trim()));
        return Ok(0);
    }
    say(&format!("  {} {}  (signed by {})", paint(&st, GREEN, "✓"), file.display(), s(&bundle["from"], "name")));
    Ok(0)
}

/// A bundle from a file, a URL or `gist:<id>`.
fn read(src: &str, cwd: &Path) -> Result<Value> {
    let (text, _) = wisp_resources_core::formula::Source::load(&mut crate::code::Files { cwd: cwd.to_owned() }, src, None).map_err(CliError::said)?;
    serde_json::from_str(&text).map_err(|e| CliError::said(format!("{src}: not a .wisp-task ({e})")))
}

/// The profile the bundle's task ran with, from its snapshot.
fn their_profile(b: &Value) -> Option<Value> {
    let agent = s(&b["spec"], "agent");
    b.pointer("/formula/agents").and_then(Value::as_array).and_then(|a| a.iter().find(|p| s(p, "name") == agent).or_else(|| a.first())).map(|p| {
        let mut p = p.clone();
        if let Some(o) = p.as_object_mut() {
            o.remove("name");
        }
        p
    })
}

/// A task from the bundle's spec, on this folder's code; `theirs`: with the sharer's setup.
async fn run(c: &Client, b: &Value, cwd: &Path, theirs: bool) -> Result<String> {
    let spec = &b["spec"];
    let mut a = json!({ "prompt": spec["prompt"], "cwd": cwd.display().to_string(), "lineage": { "sharedFrom": b["id"] }, "title": format!("{} (shared)", s(b, "title")) });
    for k in ["agent", "model", "effort", "mode", "goal", "connectors", "worktree"] {
        if let Some(v) = spec.get(k).filter(|v| !v.is_null() && **v != json!("") && **v != json!([])) {
            a[k] = v.clone();
        }
    }
    if let Some(steps) = spec.get("steps").filter(|s| s.as_array().is_some_and(|a| !a.is_empty())) {
        a["steps"] = steps.clone();
    }
    if theirs {
        if let Some(p) = their_profile(b) {
            a["profile"] = p;
        }
        a["formula"] = b["formula"].clone();
    }
    let made = c.cmd("runtime.create", a).await?;
    Ok(s(&made, "id").to_owned())
}

/// `wisp open <file|url>`.
pub async fn open(c: &Client, o: &Opts, cwd: &Path) -> Result<i32> {
    let Some(src) = o.words.first() else { return Err(CliError::said("wisp open <file.wisp-task|url|gist:<id>>")) };
    let bundle = read(src, cwd)?;
    open_bundle(c, o, cwd, bundle).await
}

/// A bundle in hand (a file's, or a wisp Cloud link's): who signed it, then what to do with it.
pub async fn open_bundle(c: &Client, o: &Opts, cwd: &Path, bundle: Value) -> Result<i32> {
    let st = crate::cli::style();
    let opened = c.cmd("share.open", json!({ "bundle": bundle })).await?;
    let b = &opened["bundle"];
    let ok = opened["verified"] == json!(true);
    say(&format!("{} {}  {}", paint(&st, BOLD, s(b, "title")), paint(&st, DIM, &format!("({})", s(&opened, "level"))), if ok { paint(&st, GREEN, &format!("✓ signed by {} ({})", s(&opened["signer"], "name"), s(&opened, "fingerprint"))) } else { paint(&st, RED, "✗ its signature doesn't match: it was changed after signing") }));
    say(&format!("  asks: {}", s(&b["spec"], "prompt").lines().next().unwrap_or("")));
    if let Some(p) = their_profile(b) {
        say(&format!("  ran with: {} {}", s(&b["spec"], "agent"), paint(&st, DIM, &p.to_string())));
    }
    for m in opened["missing"].as_array().into_iter().flatten() {
        say(&format!("  {} needs {} (not here)", paint(&st, YELLOW, "!"), m.as_str().unwrap_or("")));
    }
    if !ok {
        return Ok(1);
    }
    let full = s(&opened, "level") == "full";
    let action = match &o.action {
        Some(a) => a.clone(),
        None if tty() => {
            say("\n  1. Run it on my code (my setup)\n  2. Rerun with their setup\n  3. Compare: both, side by side");
            if full {
                say("  4. Import it read-only");
            }
            match ask("  pick › ").as_str() {
                "1" => "run".into(),
                "2" => "theirs".into(),
                "3" => "compare".into(),
                "4" if full => "import".into(),
                _ => return Ok(0),
            }
        }
        None => return Ok(0),
    };
    match action.as_str() {
        "run" | "theirs" => {
            let id = run(c, b, cwd, action == "theirs").await?;
            say(&format!("  {} {id}  wisp attach {id}", paint(&st, GREEN, "◌")));
        }
        "compare" => {
            let mine = run(c, b, cwd, false).await?;
            let theirs = run(c, b, cwd, true).await?;
            say(&format!("  {} mine {mine} · theirs {theirs}  (wisp rerun's --wait compares; wisp attach either)", paint(&st, GREEN, "◌")));
        }
        "import" => {
            let made = c.cmd("share.import", json!({ "bundle": bundle })).await?;
            say(&format!("  {} imported read-only: {}  (wisp task history {})", paint(&st, GREEN, "✓"), s(&made, "id"), s(&made, "id")));
        }
        other => return Err(CliError::said(format!("--{other}: --run, --their-setup, --import or --compare"))),
    }
    Ok(0)
}
