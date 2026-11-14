//! Formulas as folders (ADR-0034) from the terminal: every `*.wisp.yml` (and `wisp.yml`) in `.wisp/` or
//! the folder given is one configuration, evaluated by wisp-resources-core's `module::configure`. Here is
//! what needs files and processes: reading the folder, variables (`WISP_VAR_*`, the workspace's var file,
//! `--var-file`, `-var`), modules (a path, or git fetched by `wisp init` into `.wisp/modules/` and pinned
//! in `.wisp/lock.yml`), workspaces, and `init`, `output`, `graph`, `fmt`, `mv`, `import`, `destroy`, and
//! `export` to a folder (split by kind, `--with-deps`).
use std::collections::BTreeSet;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};
use wisp_cli_core::term::{GREEN, YELLOW, paint};
use wisp_resources_api::{KindInfo, Resource};
use wisp_resources_core::export;
use wisp_resources_core::formula::{self, Format};
use wisp_resources_core::module::{self, Config, Env, Input};

use crate::client::{CliError, Client, Result};
use crate::code::Opts;
use crate::scripted::say;

/// Folders a formula folder holds that aren't formula files.
const SKIP: [&str; 5] = ["modules", "tasks", "history", "workspaces", "formulas"];

fn is_formula(name: &str) -> bool {
    name == "wisp.yml" || [".wisp.yml", ".wisp.yaml", ".wisp.json", ".wisp.toml"].iter().any(|e| name.ends_with(e))
}

/// The folder a command works on: `-f <folder>`, else `.wisp/`, else this folder when it has formula files.
pub fn folder(o: &Opts, cwd: &Path) -> Option<PathBuf> {
    if let Some(f) = o.files.first() {
        let p = cwd.join(f);
        return p.is_dir().then_some(p);
    }
    let dot = cwd.join(".wisp");
    if dot.is_dir() {
        return Some(dot);
    }
    let any = std::fs::read_dir(cwd).ok()?.flatten().any(|e| e.file_name().to_str().is_some_and(|n| n.ends_with(".wisp.yml")));
    any.then(|| cwd.to_owned())
}

/// Every formula file under `dir` (its `modules/`, `tasks/`, `history/`, `workspaces/` aside), sorted.
pub fn files_in(dir: &Path) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_owned()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            if p.is_dir() {
                if !name.starts_with('.') && (d != dir || !SKIP.contains(&name.as_str())) {
                    stack.push(p);
                }
            } else if is_formula(&name) && !name.ends_with(".vars.yml") {
                let shown = p.strip_prefix(dir).map_or_else(|_| p.display().to_string(), |r| r.display().to_string());
                if let Ok(text) = std::fs::read_to_string(&p) {
                    out.push((shown, text));
                }
            }
        }
    }
    out.sort();
    out
}

/// The workspace selected in `dir` (`.wisp/.workspace`; `default` when none).
pub fn workspace(dir: &Path) -> String {
    std::fs::read_to_string(dir.join(".workspace"))
        .map(|s| s.trim().to_owned())
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "default".into())
}

fn yaml_map(path: &Path) -> Result<Map<String, Value>> {
    let text = std::fs::read_to_string(path).map_err(|e| CliError::said(format!("{}: {e}", path.display())))?;
    let v = formula::documents(&text, formula::format_of(&path.display().to_string()))
        .map_err(CliError::said)?
        .into_iter()
        .next()
        .unwrap_or_default();
    Ok(v.as_object().cloned().unwrap_or_default())
}

/// The variables' values, later over earlier: `WISP_VAR_*`, the workspace's var file, `--var-file`s, `-var`s.
pub fn vars(o: &Opts, dir: &Path) -> Result<Map<String, Value>> {
    let mut out = Map::new();
    for (k, v) in std::env::vars() {
        if let Some(name) = k.strip_prefix("WISP_VAR_") {
            out.insert(name.to_owned(), json!(v));
        }
    }
    let ws = dir.join("workspaces").join(format!("{}.vars.yml", workspace(dir)));
    if ws.is_file() {
        out.extend(yaml_map(&ws)?);
    }
    for f in &o.var_files {
        out.extend(yaml_map(&dir.parent().unwrap_or(dir).join(f)).or_else(|_| yaml_map(Path::new(f)))?);
    }
    for (k, v) in &o.vars {
        out.insert(k.clone(), json!(v));
    }
    Ok(out)
}

/// Each declared variable with no value and no default, asked for (`ask` gets the question, answers a line);
/// an answer that isn't its type is refused.
pub fn ask_missing(
    declared: &[module::Variable],
    have: &mut Map<String, Value>,
    ask: &mut dyn FnMut(&str) -> Option<String>,
) -> Result<()> {
    let missing: Vec<&module::Variable> = declared.iter().filter(|v| v.default.is_none() && !have.contains_key(&v.name)).collect();
    for v in missing {
        let about = if v.description.is_empty() { String::new() } else { format!(" ({})", v.description) };
        let ty = if v.ty.is_empty() { "any" } else { v.ty.as_str() };
        let Some(answer) = ask(&format!("  var.{} [{ty}]{about}: ", v.name)).filter(|a| !a.is_empty()) else { continue };
        let typed = module::typed(v, json!(answer)).map_err(CliError::said)?;
        have.insert(v.name.clone(), typed);
    }
    Ok(())
}

/// A module source that git fetches (`git::…`, a URL, `github.com/…`), not a path.
fn remote(source: &str) -> bool {
    source.starts_with("git::") || source.contains("://") || source.starts_with("github.com/") || source.starts_with("gitlab.com/")
}

struct DirEnv {
    dir: PathBuf,
}

impl Env for DirEnv {
    fn outside(&self, f: &str, arg: &str) -> std::result::Result<Value, String> {
        match f {
            "file" => std::fs::read_to_string(self.dir.join(arg)).map(Value::String).map_err(|e| format!("file(\"{arg}\"): {e}")),
            _ => Ok(std::env::var(arg).map_or(Value::Null, Value::String)),
        }
    }
    fn module(&mut self, name: &str, source: &str, from: &str) -> std::result::Result<Vec<(String, String)>, String> {
        let at = if remote(source) {
            let p = self.dir.join("modules").join(name);
            if !p.is_dir() {
                return Err(format!("{source} isn't fetched: run wisp init"));
            }
            p
        } else {
            let base = self.dir.join(from).parent().map_or_else(|| self.dir.clone(), Path::to_path_buf);
            let p = base.join(source);
            if !p.is_dir() {
                return Err(format!("{} isn't a folder", p.display()));
            }
            p
        };
        let (sub, _) = split_source(source);
        let at = if remote(source) && !sub.is_empty() { at.join(sub) } else { at };
        Ok(files_in(&at))
    }
}

/// `repo//sub/dir?ref=v1` → (`sub/dir`, `v1`).
fn split_source(source: &str) -> (String, String) {
    let (body, r) = source.split_once("?ref=").unwrap_or((source, ""));
    let body = body.trim_start_matches("git::");
    let after_scheme = body.find("://").map_or(0, |i| i + 3);
    let sub = body[after_scheme..].split_once("//").map(|(_, s)| s.to_owned()).unwrap_or_default();
    (sub, r.to_owned())
}

/// The folder evaluated: resources, outputs, graph.
pub fn config(o: &Opts, ks: &[KindInfo], dir: &Path) -> Result<Config> {
    let files = files_in(dir);
    if files.is_empty() {
        return Err(CliError::said(format!("no *.wisp.yml in {}", dir.display())));
    }
    let mut have = vars(o, dir)?;
    if std::io::IsTerminal::is_terminal(&std::io::stdin()) && std::io::IsTerminal::is_terminal(&std::io::stderr()) {
        ask_missing(&module::declared(&files), &mut have, &mut |q| {
            eprint!("{q}");
            let mut line = String::new();
            std::io::stdin().read_line(&mut line).ok().map(|_| line.trim().to_owned())
        })?;
    }
    let input = Input { files, vars: have, workspace: workspace(dir), ..Input::default() };
    let mut c = module::configure(&input, ks, &mut DirEnv { dir: dir.to_owned() }).map_err(CliError::said)?;
    let mut missing = BTreeSet::new();
    let src = crate::code::Files { cwd: dir.to_owned() };
    for r in &mut c.resources {
        formula::fill_env(&mut r.spec, &src, &mut missing);
    }
    if !missing.is_empty() {
        return Err(CliError::said(format!("unset environment variables: {}", missing.into_iter().collect::<Vec<_>>().join(", "))));
    }
    Ok(c)
}

fn git(args: &[&str], cwd: &Path) -> Result<String> {
    let o = std::process::Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .map_err(|e| CliError::said(format!("git: {e}")))?;
    if !o.status.success() {
        return Err(CliError::said(format!("git {}: {}", args.join(" "), String::from_utf8_lossy(&o.stderr).trim())));
    }
    Ok(String::from_utf8_lossy(&o.stdout).trim().to_owned())
}

/// The modules the folder uses, by name, from its files (without evaluating anything).
fn declared_modules(dir: &Path) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for (f, text) in files_in(dir) {
        for doc in formula::documents(&text, formula::format_of(&f)).unwrap_or_default() {
            for (k, d) in doc.get("modules").and_then(Value::as_object).into_iter().flatten() {
                if let Some(s) = d.get("source").and_then(Value::as_str) {
                    out.push((k.clone(), s.to_owned()));
                }
            }
        }
    }
    out
}

/// A folder's content hash (its formula files), for the lock file.
fn hash_of(files: &[(String, String)]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for (n, t) in files {
        for b in n.bytes().chain(t.bytes()) {
            h ^= u64::from(b);
            h = h.wrapping_mul(0x0100_0000_01b3);
        }
    }
    format!("{h:016x}")
}

/// `wisp init [-upgrade]`: `.wisp/` made if it isn't there, git modules fetched into `.wisp/modules/<name>`,
/// every module pinned in `.wisp/lock.yml` (a git module by its commit, a path by its files' hash).
pub fn init_modules(dir: &Path, upgrade: bool) -> Result<Vec<String>> {
    let lock_path = dir.join("lock.yml");
    let had = if lock_path.is_file() { yaml_map(&lock_path)? } else { Map::new() };
    let had = had.get("modules").and_then(Value::as_object).cloned().unwrap_or_default();
    let mut lock = Map::new();
    let mut said = Vec::new();
    for (name, source) in declared_modules(dir) {
        if source.starts_with("grid://") {
            // a share on the grid: pinned by its version, moved by -upgrade (or its own ?ref=)
            let (_, r) = split_source(&source);
            let base = source.split("?ref=").next().unwrap_or_default();
            let pinned = had.get(&name).and_then(|m| m.get("version")).and_then(Value::as_i64).filter(|_| !upgrade);
            let want = if r.is_empty() { pinned.map(|v| format!("v{v}")).unwrap_or_default() } else { r };
            let link = if want.is_empty() { base.to_owned() } else { format!("{base}?ref={want}") };
            let (files, version) = crate::cloud_cli::fetch_module(&link)?;
            let at = dir.join("modules").join(&name);
            let _ = std::fs::remove_dir_all(&at);
            std::fs::create_dir_all(&at).map_err(|e| CliError::said(e.to_string()))?;
            for (f, text) in &files {
                std::fs::write(at.join(f), text).map_err(|e| CliError::said(e.to_string()))?;
            }
            said.push(format!("{name}: {source} at v{version}"));
            lock.insert(name, json!({ "source": source, "version": version }));
            continue;
        }
        if remote(&source) {
            let (_, r) = split_source(&source);
            let url = source.trim_start_matches("git::").split("?ref=").next().unwrap_or_default();
            let url = match url.find("://") {
                Some(i) => url[..i + 3].to_owned() + url[i + 3..].split("//").next().unwrap_or_default(),
                None => format!("https://{}", url.split("//").next().unwrap_or_default()),
            };
            let at = dir.join("modules").join(&name);
            let pinned = had.get(&name).and_then(|m| m.get("commit")).and_then(Value::as_str).map(str::to_owned);
            if !at.is_dir() {
                std::fs::create_dir_all(dir.join("modules")).map_err(|e| CliError::said(e.to_string()))?;
                git(&["clone", "--quiet", &url, &at.display().to_string()], dir)?;
            } else if upgrade {
                git(&["fetch", "--quiet", "--tags", "origin"], &at)?;
            }
            let want = match (&pinned, upgrade) {
                (Some(c), false) => c.clone(),
                _ if !r.is_empty() => r.clone(),
                _ => "origin/HEAD".into(),
            };
            git(&["checkout", "--quiet", &want], &at)
                .or_else(|_| git(&["checkout", "--quiet", "FETCH_HEAD"], &at).map(|_| String::new()))?;
            let commit = git(&["rev-parse", "HEAD"], &at)?;
            said.push(format!("{name}: {source} at {}", &commit[..commit.len().min(10)]));
            lock.insert(name, json!({ "source": source, "commit": commit }));
        } else {
            let p = dir.join(&source);
            let h = hash_of(&files_in(&p));
            said.push(format!("{name}: {source} ({h})"));
            lock.insert(name, json!({ "source": source, "hash": h }));
        }
    }
    if !lock.is_empty() {
        let text =
            format!("# wisp's module lock (wisp init; wisp init -upgrade to move them)\n{}", formula_yaml(&json!({ "modules": lock })));
        std::fs::write(&lock_path, text).map_err(|e| CliError::said(e.to_string()))?;
    }
    Ok(said)
}

fn formula_yaml(v: &Value) -> String {
    wisp_resources_core::export::yaml(v)
}

/// `wisp output [name] [--json]`.
pub fn output(c: &Config, o: &Opts) -> i32 {
    let pick: Vec<(&String, &Value)> = c.outputs.iter().filter(|(k, _)| o.words.is_empty() || o.words.contains(k)).collect();
    if o.json || (o.words.len() == 1 && pick.len() == 1) {
        let v = if o.words.len() == 1 {
            pick.first().map_or(Value::Null, |(_, v)| (*v).clone())
        } else {
            Value::Object(pick.iter().map(|(k, v)| ((*k).clone(), (*v).clone())).collect())
        };
        say(&match &v {
            Value::String(s) if !o.json => s.clone(),
            other => serde_json::to_string_pretty(other).unwrap_or_default(),
        });
        return 0;
    }
    for (k, v) in pick {
        say(&format!(
            "{k} = {}",
            match v {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            }
        ));
    }
    0
}

/// `wisp graph`: every address and what it references, as Graphviz.
pub fn graph(c: &Config) -> i32 {
    let mut s = String::from("digraph wisp {\n  rankdir = LR;\n");
    for (a, ..) in &c.addresses {
        let _ = writeln!(s, "  \"{a}\";");
    }
    for (a, b) in &c.edges {
        let _ = writeln!(s, "  \"{a}\" -> \"{b}\";");
    }
    s.push('}');
    say(&s);
    0
}

/// One file in wisp's layout: tabs to two spaces, no trailing blanks, one final newline.
pub fn fmt_text(text: &str) -> String {
    let mut out: Vec<String> = text.lines().map(|l| l.replace('\t', "  ").trim_end().to_owned()).collect();
    while out.last().is_some_and(String::is_empty) {
        out.pop();
    }
    let mut s = out.join("\n");
    s.push('\n');
    s
}

/// `wisp fmt [--check]`: the folder's files in wisp's layout. → the files that changed (or would).
pub fn fmt(dir: &Path, check: bool) -> Result<Vec<String>> {
    let mut changed = Vec::new();
    for (f, text) in files_in(dir) {
        let t = fmt_text(&text);
        if t != text {
            if !check {
                std::fs::write(dir.join(&f), t).map_err(|e| CliError::said(e.to_string()))?;
            }
            changed.push(f);
        }
    }
    Ok(changed)
}

/// Replaces the address `from` (`kind.name`) by `to` in a text: its references and, on `line` (1-based,
/// its declaration), its name.
pub fn rename_text(text: &str, from: &str, to: &str, line: Option<usize>) -> String {
    let (_, old) = from.split_once('.').unwrap_or(("", from));
    let (_, new) = to.split_once('.').unwrap_or(("", to));
    let ident = |c: char| c.is_ascii_alphanumeric() || c == '_' || c == '-';
    let mut out = String::new();
    for (i, l) in text.split_inclusive('\n').enumerate() {
        let mut l = l.to_owned();
        if Some(i + 1) == line {
            l = l.replacen(&format!("name: {old}"), &format!("name: {new}"), 1);
            if l.trim_start().starts_with(&format!("{old}:")) {
                l = l.replacen(&format!("{old}:"), &format!("{new}:"), 1);
            }
        }
        let mut s = String::new();
        let mut rest = l.as_str();
        while let Some(at) = rest.find(from) {
            let next = rest[at + from.len()..].chars().next();
            let before = rest[..at].chars().last();
            s.push_str(&rest[..at]);
            if next.is_some_and(ident) || before.is_some_and(|c| ident(c) || c == '.') {
                s.push_str(from);
            } else {
                s.push_str(to);
            }
            rest = &rest[at + from.len()..];
        }
        s.push_str(rest);
        out.push_str(&s);
    }
    out
}

/// The stored name and kind of an address (`agent.reviewer` → `reviewer`, inside a module `rev-reviewer`).
pub fn stored_name(c: &Config, address: &str) -> Option<(String, String)> {
    c.addresses.iter().find(|(a, ..)| a == address).map(|(_, k, n, _)| (n.clone(), k.clone()))
}

/// `wisp mv <from> <to>`: the declaration and every reference renamed in the folder's files.
pub fn mv(dir: &Path, c: &Config, from: &str, to: &str) -> Result<usize> {
    let (fk, _) = from.split_once('.').ok_or_else(|| CliError::said("wisp mv <kind>.<name> <kind>.<new name>"))?;
    if to.split_once('.').map(|(k, _)| k) != Some(fk) {
        return Err(CliError::said("wisp mv keeps the kind: agent.reviewer agent.critic"));
    }
    let decl = c.addresses.iter().find(|(a, ..)| a == from).ok_or_else(|| CliError::said(format!("{from} isn't declared here")))?;
    if c.addresses.iter().any(|(a, ..)| a == to) {
        return Err(CliError::said(format!("{to} is declared already")));
    }
    let (file, line) = decl.3.rsplit_once(':').map(|(f, l)| (f.to_owned(), l.parse().ok())).unwrap_or_default();
    let mut n = 0;
    for (f, text) in files_in(dir) {
        let t = rename_text(&text, from, to, if f == file { line } else { None });
        if t != text {
            std::fs::write(dir.join(&f), t).map_err(|e| CliError::said(e.to_string()))?;
            n += 1;
        }
    }
    Ok(n)
}

/// Which kinds a field's value names, by the field's name (`agent: reviewer`, `skills: [tidy]`).
fn kinds_named_by(key: &str) -> &'static [&'static str] {
    match key {
        "agent" | "agents" | "judge" | "judges" | "review" | "lead" | "profile" => &["agent"],
        "skill" | "skills" => &["skill"],
        "team" => &["team"],
        "connector" | "connectors" => &["connector"],
        "project" | "cwd" => &["project"],
        "crew" | "members" => &["crew"],
        "machine" | "machines" => &["machine"],
        "channel" | "to" => &["channel"],
        "task" | "tasks" => &["task"],
        "workflow" => &["workflow"],
        _ => &[],
    }
}

fn names_in(v: &Value, key: &str, out: &mut Vec<(String, String)>) {
    match v {
        Value::String(s) => {
            for k in kinds_named_by(key) {
                out.push(((*k).to_owned(), s.clone()));
            }
        }
        Value::Array(a) => a.iter().for_each(|x| names_in(x, key, out)),
        Value::Object(m) => {
            for (k, x) in m {
                names_in(x, k, out);
                if kinds_named_by(key) == ["crew"] || key == "members" {
                    out.push(("crew".into(), k.clone()));
                }
            }
        }
        _ => {}
    }
}

/// `addresses` and everything they reference, transitively (`--with-deps`).
pub fn with_deps(all: &[Resource], addresses: &[String]) -> Vec<Resource> {
    let mut want: Vec<(String, String)> =
        addresses.iter().filter_map(|a| a.split_once('.').map(|(k, n)| (k.to_owned(), n.to_owned()))).collect();
    let mut i = 0;
    while i < want.len() {
        let (k, n) = want[i].clone();
        if let Some(r) = all.iter().find(|r| r.kind == k && r.name == n) {
            let mut refs = Vec::new();
            names_in(&r.spec, "", &mut refs);
            for d in refs {
                if all.iter().any(|r| r.kind == d.0 && r.name == d.1) && !want.contains(&d) {
                    want.push(d);
                }
            }
        }
        i += 1;
    }
    all.iter().filter(|r| want.iter().any(|(k, n)| *k == r.kind && *n == r.name)).cloned().collect()
}

/// `wisp export … -o <folder>`: one file per kind (`agents.wisp.yml`), or one file with `--single-file`.
pub fn write_folder(list: &[Resource], ks: &[KindInfo], out: &Path, single: bool) -> Result<Vec<String>> {
    std::fs::create_dir_all(out).map_err(|e| CliError::said(format!("{}: {e}", out.display())))?;
    let mut written = Vec::new();
    if single {
        std::fs::write(out.join("wisp.yml"), export::write(list, ks, Format::Yaml)).map_err(|e| CliError::said(e.to_string()))?;
        return Ok(vec!["wisp.yml".into()]);
    }
    for k in ks {
        let mine: Vec<Resource> = list.iter().filter(|r| k.named(&r.kind)).cloned().collect();
        if mine.is_empty() {
            continue;
        }
        let name = format!("{}.wisp.yml", k.section);
        std::fs::write(out.join(&name), export::write(&mine, ks, Format::Yaml)).map_err(|e| CliError::said(e.to_string()))?;
        written.push(name);
    }
    Ok(written)
}

/// `wisp import <kind>.<name>`: what the app made, written into the folder's file for its kind.
pub async fn import_address(c: &Client, ks: &[KindInfo], dir: &Path, address: &str) -> Result<i32> {
    let (kind, name) = address.split_once('.').ok_or_else(|| CliError::said("wisp import <kind>.<name>"))?;
    let k = ks.iter().find(|k| k.named(kind)).ok_or_else(|| CliError::said(format!("no kind {kind}")))?;
    let list: Vec<Resource> = serde_json::from_value(c.cmd("resources.export", json!({ "kinds": [k.kind] })).await?)
        .map_err(|e| CliError::said(e.to_string()))?;
    let r = list.into_iter().find(|r| r.name == name).ok_or_else(|| CliError::said(format!("wisp has no {kind} named {name}")))?;
    if files_in(dir).iter().any(|(_, t)| t.contains(&format!("name: {name}")) || t.contains(&format!("\n  {name}:"))) {
        return Err(CliError::said(format!("{address} is in the files already")));
    }
    let file = dir.join(format!("{}.wisp.yml", k.section));
    let text = export::write(std::slice::from_ref(&r), ks, Format::Yaml);
    let body = if file.is_file() {
        let had = std::fs::read_to_string(&file).unwrap_or_default();
        format!("{had}\n---\n{text}")
    } else {
        text
    };
    std::fs::write(&file, body).map_err(|e| CliError::said(e.to_string()))?;
    say(&format!("  {} {address} → {}", paint(&crate::cli::style(), GREEN, "✓"), file.display()));
    Ok(0)
}

/// `wisp workspace [list|show|select <name>|new <name>]`.
pub fn workspace_cmd(dir: &Path, words: &[String]) -> Result<i32> {
    let st = crate::cli::style();
    let now = workspace(dir);
    let ws_dir = dir.join("workspaces");
    match words.first().map(String::as_str) {
        None | Some("show") => say(&now),
        Some("list") => {
            let mut names: BTreeSet<String> = std::fs::read_dir(&ws_dir)
                .into_iter()
                .flatten()
                .flatten()
                .filter_map(|e| e.file_name().to_str().and_then(|n| n.strip_suffix(".vars.yml")).map(str::to_owned))
                .collect();
            names.insert("default".into());
            for n in names {
                say(&format!("{} {n}", if n == now { "*" } else { " " }));
            }
        }
        Some(verb @ ("select" | "new")) => {
            let name = words
                .get(1)
                .filter(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'))
                .ok_or_else(|| CliError::said(format!("wisp workspace {verb} <name>")))?;
            let file = ws_dir.join(format!("{name}.vars.yml"));
            if verb == "new" {
                std::fs::create_dir_all(&ws_dir).map_err(|e| CliError::said(e.to_string()))?;
                if !file.exists() {
                    std::fs::write(&file, format!("# variables for the {name} workspace\n")).map_err(|e| CliError::said(e.to_string()))?;
                }
            } else if name != "default" && !file.exists() {
                return Err(CliError::said(format!("no workspace {name}: wisp workspace new {name}")));
            }
            std::fs::write(dir.join(".workspace"), format!("{name}\n")).map_err(|e| CliError::said(e.to_string()))?;
            say(&format!("  {} workspace {name}", paint(&st, YELLOW, "→")));
        }
        Some(other) => return Err(CliError::said(format!("wisp workspace list|show|select|new, not {other}"))),
    }
    Ok(0)
}

/// The AGENTS.md section `wisp init` adds (ADR-0033), once.
pub const AGENTS_NOTE: &str = "\n## wisp: the tasks behind this code\n\nBefore changing a file, read the tasks that shaped it: `wisp tasks --touching <path>` (or `wisp blame <file>:<line>`), or the files in `.wisp/tasks/`. They hold what was asked, the agent's report and its transcript.\n";

/// `wisp init`: `.wisp/` with its `wisp.yml` (history tracked: `ask`), the AGENTS.md note (and CLAUDE.md's
/// when there is one), and the modules fetched and locked.
pub fn init(cwd: &Path, o: &Opts) -> Result<i32> {
    let st = crate::cli::style();
    let dir = folder(o, cwd).unwrap_or_else(|| cwd.join(".wisp"));
    std::fs::create_dir_all(dir.join("tasks")).map_err(|e| CliError::said(e.to_string()))?;
    let main = dir.join("wisp.yml");
    if !main.exists() {
        let track = o.words.first().map_or("ask", String::as_str);
        std::fs::write(&main, format!("wisp: 1\n# what the repo keeps of the agent work that built it (ADR-0033): auto | ask | manual\nhistory: {{ track: {track} }}\n")).map_err(|e| CliError::said(e.to_string()))?;
        say(&format!("  {} {}", paint(&st, GREEN, "+"), main.display()));
    }
    let readme = dir.join("README.md");
    if !readme.exists() {
        let _ = std::fs::write(
            &readme,
            "# .wisp\n\nThis repo's agent setup and history (wisp, ADR-0033/0034):\n\n- `*.wisp.yml`: the formula (agents, crew, workflows, rules).\n- `tasks/`: one file per task that built this code (`<id>.task.yml`, `<id>.report.md`), and `history/<id>.jsonl.zst`, its transcript, scrubbed.\n- `lock.yml`: the modules' pinned versions.\n\n`wisp log`, `wisp blame <file>:<line>`, `wisp tasks --touching <path>`, `wisp resume <id>`.\n",
        );
    }
    let root = dir.parent().unwrap_or(cwd);
    for name in ["AGENTS.md", "CLAUDE.md"] {
        let p = root.join(name);
        if name == "CLAUDE.md" && !p.exists() {
            continue;
        }
        let had = std::fs::read_to_string(&p).unwrap_or_default();
        if !had.contains("## wisp: the tasks behind this code") && (name != "CLAUDE.md" || !had.contains("@AGENTS.md")) {
            std::fs::write(&p, format!("{had}{AGENTS_NOTE}")).map_err(|e| CliError::said(e.to_string()))?;
            say(&format!("  {} {} (the note on reading the tasks behind the code)", paint(&st, GREEN, "~"), p.display()));
        }
    }
    for m in init_modules(&dir, o.upgrade)? {
        say(&format!("  {} module {m}", paint(&st, GREEN, "✓")));
    }
    say(&format!("  {} {} is ready", paint(&st, GREEN, "✓"), dir.display()));
    Ok(0)
}

/// `wisp fmt [--check]`.
pub fn fmt_cmd(o: &Opts, cwd: &Path) -> Result<i32> {
    let dir = folder(o, cwd).ok_or_else(|| CliError::said("no .wisp/ or *.wisp.yml here"))?;
    let changed = fmt(&dir, o.check)?;
    for f in &changed {
        say(&format!("  {} {f}", if o.check { "would format" } else { "formatted" }));
    }
    Ok(i32::from(o.check && !changed.is_empty()))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn mv_renames_the_declaration_and_its_references_only() {
        let t = "agents:\n  - name: reviewer\n    model: x\ncrew:\n  ada: { agent: \"${agent.reviewer}\", model: \"${agent.reviewer.model}\", other: \"${agent.reviewers}\" }\n";
        let out = rename_text(t, "agent.reviewer", "agent.critic", Some(2));
        assert!(
            out.contains("- name: critic")
                && out.contains("${agent.critic}")
                && out.contains("${agent.critic.model}")
                && out.contains("${agent.reviewers}"),
            "{out}"
        );
    }

    #[test]
    fn deps_follow_the_names_a_spec_holds() {
        let r = |k: &str, n: &str, s: Value| Resource::new(k, n, s);
        let all = vec![
            r("crew", "ada", json!({ "agent": "reviewer" })),
            r("agent", "reviewer", json!({ "skills": ["tidy"], "harness": "codex" })),
            r("skill", "tidy", json!({})),
            r("agent", "other", json!({})),
        ];
        let got: Vec<String> = with_deps(&all, &["crew.ada".into()]).iter().map(|r| format!("{}.{}", r.kind, r.name)).collect();
        assert_eq!(got, ["crew.ada", "agent.reviewer", "skill.tidy"]);
    }

    #[test]
    fn a_missing_variable_is_asked_in_a_tty() {
        let files = vec![(
            "a.wisp.yml".to_owned(),
            "variables:\n  model: { type: string, description: the reviewer's model }\n  n: { type: number, default: 2 }\n".to_owned(),
        )];
        let mut have = Map::new();
        let mut asked = Vec::new();
        ask_missing(&module::declared(&files), &mut have, &mut |q| {
            asked.push(q.to_owned());
            Some("opus".into())
        })
        .unwrap();
        assert_eq!(asked, ["  var.model [string] (the reviewer's model): "], "only the one with no value or default");
        assert_eq!(have["model"], json!("opus"));
    }

    #[test]
    fn a_typed_answer_is_checked() {
        let files = vec![("a.wisp.yml".to_owned(), "variables: { n: { type: number } }".to_owned())];
        let e = ask_missing(&module::declared(&files), &mut Map::new(), &mut |_| Some("lots".into())).unwrap_err();
        assert!(e.to_string().contains("a number"), "{e}");
    }

    #[test]
    fn sources_and_fmt() {
        assert_eq!(split_source("git::https://github.com/acme/mods.git//review-team?ref=v1.2"), ("review-team".into(), "v1.2".into()));
        assert_eq!(split_source("github.com/acme/mods//team"), ("team".into(), String::new()));
        assert!(remote("github.com/acme/x") && !remote("./mods/team"));
        assert_eq!(fmt_text("a:\t1  \n\n\n"), "a:  1\n");
    }
}
