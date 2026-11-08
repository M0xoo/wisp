//! wisp as code from the terminal (ADR-0026): `wisp apply -f`, `diff -f`, `validate -f`, `wisp schema`,
//! `wisp export [kinds…]`. The formula is read here (files, URLs, `gist:<id>`, includes, profiles,
//! `${env:…}`) with wisp-resources-core; the plan, the checks and the apply are wisp.resources' commands,
//! so the GUI, the SDK and a grid deploy get the same answers.
use std::io::{IsTerminal, Write};
use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use wisp_cli_core::term::{self, BOLD, DIM, GREEN, RED, YELLOW, paint};
use wisp_resources_api::{KindInfo, Plan, Resource};
use wisp_resources_core::export;
use wisp_resources_core::formula::{self, Format, Loaded, Source};

use crate::client::{CliError, Client, Result};
use crate::scripted::say;

/// The options these commands read from the raw command line.
#[derive(Debug, Default, Clone)]
#[allow(clippy::struct_excessive_bools)] // one per flag
pub struct Opts {
    pub files: Vec<String>,
    pub formulas: Vec<String>,
    pub profiles: Vec<String>,
    pub include: Vec<String>,
    pub format: Option<String>,
    pub prune: bool,
    pub trust: bool,
    pub dry_run: bool,
    pub yes: bool,
    pub json: bool,
    pub from: Option<String>,
    pub steps: Option<usize>,
    pub fill: bool,
    pub last: Option<usize>,
    pub project: Option<String>,
    pub wait: bool,
    /// `--agent`, `--model`, `--effort`, `--mode`: over the spec
    pub over: serde_json::Map<String, Value>,
    /// the words that aren't options
    pub words: Vec<String>,
}

/// Reads `argv` (after the command word) for the options above.
pub fn opts(argv: &[String]) -> Opts {
    let mut o = Opts::default();
    let mut it = argv.iter().peekable();
    while let Some(a) = it.next() {
        let (k, inline) = match a.split_once('=') {
            Some((k, v)) if k.starts_with("--") => (k.to_owned(), Some(v.to_owned())),
            _ => (a.clone(), None),
        };
        let val = |it: &mut std::iter::Peekable<std::slice::Iter<'_, String>>| inline.clone().or_else(|| it.next().cloned()).unwrap_or_default();
        match k.as_str() {
            "-f" | "--file" => o.files.push(val(&mut it)),
            "--formula" => o.formulas.extend(val(&mut it).split(',').filter(|s| !s.is_empty()).map(str::to_owned)),
            "--profile" => o.profiles.extend(val(&mut it).split(',').map(str::to_owned)),
            "--include" => o.include.extend(val(&mut it).split(',').map(str::to_owned)),
            "--format" => o.format = Some(val(&mut it)),
            "--from" => o.from = Some(val(&mut it)),
            "--steps" => o.steps = val(&mut it).parse().ok(),
            "--last" => o.last = val(&mut it).parse().ok(),
            "--project" => o.project = Some(val(&mut it)),
            "--agent" | "-a" | "--model" | "--effort" | "--mode" | "-m" => {
                let key = match k.as_str() {
                    "--agent" | "-a" => "agent",
                    "--mode" | "-m" => "mode",
                    x => x.trim_start_matches("--"),
                };
                o.over.insert(key.to_owned(), json!(val(&mut it)));
            }
            "--port" | "-p" | "--cwd" | "-C" => {
                let _ = val(&mut it);
            }
            "--prune" => o.prune = true,
            "--trust" => o.trust = true,
            "--dry-run" => o.dry_run = true,
            "--yes" | "-y" => o.yes = true,
            "--json" => o.json = true,
            "--wait" | "-w" => o.wait = true,
            "--fill-from-snapshot" => o.fill = true,
            _ => o.words.push(a.clone()),
        }
    }
    o
}

/// Files, URLs and `gist:<id>`, relative to the file that includes them.
pub struct Files {
    pub cwd: PathBuf,
}

fn fetch(url: &str) -> std::result::Result<String, String> {
    tokio::task::block_in_place(|| {
        tokio::runtime::Handle::current().block_on(async {
            let http = reqwest::Client::new();
            let r = http.get(url).header("user-agent", "wisp").send().await.map_err(|e| format!("{url}: {e}"))?;
            if !r.status().is_success() {
                return Err(format!("{url}: HTTP {}", r.status().as_u16()));
            }
            r.text().await.map_err(|e| format!("{url}: {e}"))
        })
    })
}

impl Source for Files {
    fn load(&mut self, reference: &str, from: Option<&str>) -> std::result::Result<(String, String), String> {
        if let Some(id) = reference.strip_prefix("gist:") {
            let v: Value = serde_json::from_str(&fetch(&format!("https://api.github.com/gists/{id}"))?).map_err(|e| format!("gist {id}: {e}"))?;
            let file = v.get("files").and_then(Value::as_object).and_then(|f| f.values().next()).cloned().unwrap_or_default();
            let name = file.get("filename").and_then(Value::as_str).unwrap_or("wisp.yml");
            return Ok((file.get("content").and_then(Value::as_str).unwrap_or_default().to_owned(), format!("gist:{id}/{name}")));
        }
        if reference.starts_with("https://") || reference.starts_with("http://") {
            return Ok((fetch(reference)?, reference.to_owned()));
        }
        if let Some(f) = from.filter(|f| f.starts_with("http")) {
            let base = f.rsplit_once('/').map_or(f, |(b, _)| b);
            let url = format!("{base}/{reference}");
            return Ok((fetch(&url)?, url));
        }
        let dir = from.map_or_else(|| self.cwd.clone(), |f| Path::new(f).parent().map_or_else(|| self.cwd.clone(), Path::to_path_buf));
        let p = if Path::new(reference).is_absolute() { PathBuf::from(reference) } else { dir.join(reference) };
        let text = std::fs::read_to_string(&p).map_err(|e| format!("{}: {e}", p.display()))?;
        Ok((text, p.display().to_string()))
    }
    fn env(&self, name: &str) -> Option<String> {
        std::env::var(name).ok()
    }
}

pub async fn kinds(c: &Client) -> Result<Vec<KindInfo>> {
    let v = c.cmd("resources.kinds", json!({})).await?;
    serde_json::from_value(v).map_err(|e| CliError::said(format!("resources.kinds: {e}")))
}

/// Every `-f` file read, in order (a later file patches an earlier one's resources).
pub fn load(files: &[String], profiles: &[String], kinds: &[KindInfo], cwd: &Path) -> Result<Loaded> {
    let mut all = Loaded::default();
    for f in files {
        let got = formula::load(f, &mut Files { cwd: cwd.to_owned() }, kinds, profiles).map_err(CliError::said)?;
        for r in got.resources {
            if let Some(had) = all.resources.iter_mut().find(|x| x.kind == r.kind && x.name == r.name) {
                had.spec = wisp_resources_core::plan::merge(&had.spec, &r.spec);
            } else {
                all.resources.push(r);
            }
        }
        all.sources.extend(got.sources);
        all.secrets.extend(got.secrets);
    }
    Ok(all)
}

fn need_files(o: &Opts, verb: &str) -> Result<()> {
    if o.files.is_empty() {
        return Err(CliError::said(format!("wisp {verb} -f wisp.yml (one -f per formula)")));
    }
    Ok(())
}

/// The plan, as the terminal shows it.
pub fn show_plan(p: &Plan, st: &wisp_cli_api::Style) {
    for (mark, line) in wisp_resources_core::plan::lines(&p.ops) {
        let painted = match mark {
            '+' => format!("  {} {}", paint(st, GREEN, "+"), line),
            '-' => format!("  {} {}", paint(st, RED, "-"), line),
            '~' => format!("  {} {}", paint(st, YELLOW, "~"), line),
            _ => paint(st, DIM, &format!("  {line}")),
        };
        say(&term::truncate(&painted, st.width.max(40)));
    }
    let (mut add, mut change, mut del) = (0, 0, 0);
    for o in &p.ops {
        match o.op {
            wisp_resources_api::OpKind::Create => add += 1,
            wisp_resources_api::OpKind::Update => change += 1,
            wisp_resources_api::OpKind::Delete => del += 1,
        }
    }
    say(&format!("\n  {}", paint(st, BOLD, &format!("{add} to add, {change} to change, {del} to remove, {} unchanged", p.unchanged))));
    for s in &p.sensitive {
        say(&format!("  {} {}", paint(st, YELLOW, "!"), s));
    }
    for s in &p.missing_secrets {
        say(&format!("  {} secret {s} isn't set here (wisp secret set {s})", paint(st, RED, "✗")));
    }
    for s in &p.problems {
        say(&format!("  {} {s}", paint(st, RED, "✗")));
    }
}

fn ask(question: &str) -> String {
    let mut o = std::io::stdout().lock();
    let _ = write!(o, "{question}");
    let _ = o.flush();
    let mut line = String::new();
    let _ = std::io::stdin().read_line(&mut line);
    line.trim().to_owned()
}

/// `wisp apply -f`, `wisp diff -f`, `wisp validate -f`.
pub async fn apply(c: &Client, verb: &str, o: &Opts, cwd: &Path) -> Result<i32> {
    need_files(o, verb)?;
    let st = crate::cli::style();
    let ks = kinds(c).await?;
    let loaded = load(&o.files, &o.profiles, &ks, cwd)?;
    let foreign = formula::foreign(&loaded.sources);
    let args = json!({ "resources": loaded.resources, "prune": o.prune, "foreign": foreign, "trust": o.trust });
    let plan: Plan = serde_json::from_value(c.cmd("resources.plan", args.clone()).await?).map_err(|e| CliError::said(e.to_string()))?;
    if o.json {
        say(&serde_json::to_string_pretty(&plan).unwrap_or_default());
        return Ok(i32::from(!plan.problems.is_empty()));
    }
    if verb == "validate" {
        for p in plan.problems.iter().chain(plan.missing_secrets.iter().map(|s| s as &String)) {
            say(&format!("  {} {p}", paint(&st, RED, "✗")));
        }
        if plan.problems.is_empty() && plan.missing_secrets.is_empty() {
            say(&format!("  {} {} resources in {} (wisp: 1)", paint(&st, GREEN, "✓"), loaded.resources.len(), loaded.sources.join(", ")));
            return Ok(0);
        }
        return Ok(1);
    }
    say(&format!("{} {}", paint(&st, BOLD, "Plan"), paint(&st, DIM, &format!("({}{})", loaded.sources.join(", "), if foreign { ", from elsewhere" } else { "" }))));
    show_plan(&plan, &st);
    if verb == "diff" || o.dry_run || plan.ops.is_empty() {
        if plan.ops.is_empty() && verb != "diff" {
            say(&format!("  {} nothing to change", paint(&st, GREEN, "✓")));
        }
        return Ok(i32::from(!plan.problems.is_empty()));
    }
    if !plan.problems.is_empty() || !plan.missing_secrets.is_empty() {
        return Ok(1);
    }
    let mut trust = o.trust;
    let sensitive = foreign && !plan.sensitive.is_empty();
    let tty = std::io::stdin().is_terminal() && std::io::stdout().is_terminal();
    if sensitive && !trust {
        if o.yes || !tty {
            eprintln!("  ✗ this formula comes from elsewhere and changes who may act: read the plan, then apply it with --trust");
            return Ok(1);
        }
        trust = ask("\n  It comes from elsewhere and changes who may act. Type trust to apply it: ") == "trust";
        if !trust {
            say("  nothing applied");
            return Ok(1);
        }
    } else if !o.yes {
        if !tty {
            eprintln!("  ✗ not a terminal: apply with --yes");
            return Ok(1);
        }
        let a = ask(&format!("\n  Apply {} change{}? [y/N] ", plan.ops.len(), if plan.ops.len() == 1 { "" } else { "s" }));
        if !matches!(a.as_str(), "y" | "Y" | "yes") {
            say("  nothing applied");
            return Ok(1);
        }
    }
    let mut args = args;
    args["trust"] = json!(trust);
    let done = c.cmd("resources.apply", args).await?;
    say(&format!("  {} applied {} change{}", paint(&st, GREEN, "✓"), done["applied"], if done["applied"] == 1 { "" } else { "s" }));
    Ok(0)
}

/// `wisp export [kinds…] [--include ui,account] [--format yaml|json|toml]`.
pub async fn export_cmd(c: &Client, o: &Opts) -> Result<i32> {
    let ks = kinds(c).await?;
    let list: Vec<Resource> = serde_json::from_value(c.cmd("resources.export", json!({ "kinds": o.words, "include": o.include })).await?).map_err(|e| CliError::said(e.to_string()))?;
    let format = match o.format.as_deref() {
        Some("json") => Format::Json,
        Some("toml") => Format::Toml,
        _ => Format::Yaml,
    };
    let text = export::write(&list, &ks, format);
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(text.as_bytes());
    Ok(0)
}

/// `wisp schema`: the JSON Schema of a formula for editors (`# yaml-language-server: $schema=…`).
pub async fn schema(c: &Client) -> Result<i32> {
    let ks = kinds(c).await?;
    say(&serde_json::to_string_pretty(&wisp_resources_core::schema::formula(&ks)).unwrap_or_default());
    Ok(0)
}

/// Whether `words` after `export` name kinds (`wisp export crew agents`), not a task ("export the csv").
pub fn kind_words(words: &[String], ks: &[KindInfo]) -> bool {
    words.iter().all(|w| ks.iter().any(|k| k.kind == *w || k.section == *w))
}
