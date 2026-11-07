//! The `wisp` command line (v1 bin/wisp.js): its usage text, flags and which word is a command. Pure:
//! main reads it before deciding whether anything else has to start.
use std::path::{Path, PathBuf};

pub const HELP: &str = "usage:
  wisp                          open wisp
  wisp \"task\"                   launch a task in this folder
  wisp serve                    run wisp here, in this terminal, without opening anything   (--port N  --host ADDR)
  wisp add [path]               add a project
  wisp ls                       list sessions        (--state running,waiting,review,done|needs  --limit N  --all: archived too)
  wisp show <id>                state + latest presentation as markdown
  wisp wait <id>                block until it finishes or asks you something
  wisp reply <id> \"text\"        follow up (answers a pending question)   (--queue  --mode plan|edits|auto
                                --agent ID  --model ID  --effort LEVEL: switch harness / model from here on)
  wisp btw <id> \"question\"      ask on the side without interrupting the run; prints the answer
  wisp stop <id>                stop a run
  wisp ship <id>                commit, push and open a PR for a worktree session   (--draft)
  wisp merge <id>               squash-merge its PR and sync your local base branch
  wisp run <recipe> [values…]   run a saved recipe; values fill its {params} in order, or key=value
  wisp recipes                  list recipes
  wisp usage                    spend and outcomes   (--days 7|30|90)
  wisp plugin                   list plugins (wisp's own and yours; spells are plugins now)
  wisp plugin new <name>        start a plugin of your own in ~/.wisp/plugins/<name>
  wisp plugin enable|disable <id>   switch a plugin on or off   (wisp plugin disable --all: every one of yours)
  wisp plugin install <file|url>    add a plugin someone sent (https, gist:<id>); off until --on
  wisp plugin rm <id> | export <id> remove one, or print its file to share
  wisp spell …                  the same as wisp plugin … (v1's name)
  wisp crew                     list your crew
  wisp crew import <file|url>   add members someone shared (.crew.json, https, gist:<id>); paused, in this folder (--cwd)
  wisp crew export <name…>      print their .crew.json   (--notebook  --team: who they delegate to  --no-kit  --gist: a secret gist)
  wisp computer                 is this computer on your wisp Grid? its address there
  wisp computer on              add it, so your phone and other computers reach it   (--grid HOST, default grid.trywisp.dev;
                                signs in first: allow the code in your browser)
  wisp computer off             take it off the grid
  wisp import                   bring a wisp v1 home (~/.wisp) into this wisp   (--dry-run)
  wisp desktop                  open the wisp app window
  wisp mcp                      run the MCP server (stdio) for other agents and editors
  wisp skill [install]          print / install the wisp agent skill   (--agent claude|codex|opencode|all  --project)
  wisp grid dev|init|serve|doctor  wisp Grid: wisp for many people on your server   (wisp grid help)
  wisp -- \"ls the repo\"         a task that starts with a command name

launch options: --mode plan|edits|auto  --agent claude|codex|opencode|cursor|antigravity|grok|copilot  --model ID  --effort LEVEL
                --cwd DIR  --also DIR (repeatable)  --wait  --json  --no-worktree  --compare agent[:model],…
                --try subagents=haiku|sonnet|task  --try skills=off  run it twice on --agent, the second with
                that changed (repeatable or comma separated); Compare says what differed
                --yes  go ahead although it takes a usage window past your Ask near the limit line
options:        --port N  --browser  --no-open  --json  --version";

pub const COMMANDS: [&str; 25] = [
    "add", "ls", "list", "show", "wait", "reply", "btw", "stop", "mcp", "skill", "ship", "merge", "run", "recipes", "usage", "spell", "spells", "plugin", "plugins", "crew", "grid", "computer", "serve", "import", "desktop",
];
pub const LS_STATES: [&str; 4] = ["running", "waiting", "review", "done"];
/// wisp-grid's commands (apps/grid's CLI). A test keeps `wisp grid <word>` routing in step.
pub const GRID_SUB: [&str; 9] = ["dev", "init", "serve", "doctor", "rotate-key", "backup", "users", "waitlist", "help"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompareRun {
    pub agent: String,
    pub model: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(clippy::struct_excessive_bools)]
pub struct Flags {
    pub open: bool,
    pub browser: bool,
    pub port: u16,
    /// --port was on the command line (not just WISP_PORT): scripted commands then skip discovery
    pub port_given: bool,
    pub host: Option<String>,
    pub mode: Option<String>,
    pub agent: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub cwd: Option<PathBuf>,
    pub also: Vec<PathBuf>,
    pub json: bool,
    pub wait: bool,
    pub yes: bool,
    pub queue: Option<bool>,
    pub state: Option<String>,
    pub limit: Option<u32>,
    pub project: bool,
    pub worktree: Option<bool>,
    pub compare: Option<Vec<CompareRun>>,
    pub tries: Vec<String>,
    pub draft: bool,
    pub days: Option<u32>,
    pub on: bool,
    pub all: bool,
    pub grid: Option<String>,
    pub notebook: bool,
    pub team: bool,
    pub kit: bool,
    pub gist: bool,
    pub dry_run: bool,
}

impl Flags {
    pub fn defaults(env_port: Option<&str>) -> Self {
        Self {
            open: true,
            browser: false,
            port: env_port.and_then(|p| p.parse().ok()).unwrap_or(wisp_api::DEFAULT_PORT),
            port_given: false,
            host: None,
            mode: None,
            agent: None,
            model: None,
            effort: None,
            cwd: None,
            also: Vec::new(),
            json: false,
            wait: false,
            yes: false,
            queue: None,
            state: None,
            limit: None,
            project: false,
            worktree: None,
            compare: None,
            tries: Vec::new(),
            draft: false,
            days: None,
            on: false,
            all: false,
            grid: None,
            notebook: false,
            team: false,
            kit: true,
            gist: false,
            dry_run: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Run,
    Version,
    Help,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Literal {
    No,
    /// `--` came first: the words are a task even if the first is a command name
    Task,
    Yes,
}

#[derive(Debug, Clone)]
pub struct Parsed {
    pub action: Action,
    pub flags: Flags,
    pub words: Vec<String>,
    pub literal: Literal,
    pub command: Option<&'static str>,
    /// the arguments with every `--flag=value` split in two (the grid parses its own from these)
    pub argv: Vec<String>,
}

pub fn expand(p: &str, home: &Path, cwd: &Path) -> PathBuf {
    let p = if p == "~" { home.to_path_buf() } else if let Some(rest) = p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")) { home.join(rest) } else { PathBuf::from(p) };
    if p.is_absolute() { p } else { cwd.join(p) }
}

fn compare_list(v: &str) -> Vec<CompareRun> {
    v.split(',')
        .filter(|s| !s.is_empty())
        .map(|x| {
            let mut it = x.splitn(2, ':');
            CompareRun { agent: it.next().unwrap_or("").to_owned(), model: it.next().filter(|m| !m.is_empty()).map(str::to_owned) }
        })
        .collect()
}

/// v1 session ids are 12 hex characters; v2 ones are UUIDs (with or without dashes).
pub fn session_id(s: &str) -> bool {
    let hex = |s: &str| s.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase());
    (s.len() == 12 && hex(s)) || (s.len() == 32 && hex(s)) || (s.len() == 36 && s.split('-').map(str::len).eq([8, 4, 4, 4, 12]) && hex(&s.replace('-', "")))
}

/// Newer commands are also common first words of a task ("ship the docs", "usage of X"), so they only
/// count when the rest fits; `wisp run` falls back to a task when no recipe has that name.
fn fits(cmd: &str, w: &[String]) -> bool {
    let n = w.len();
    let w1 = w.get(1).map_or("", String::as_str);
    match cmd {
        "grid" => n == 1 || GRID_SUB.contains(&w1),
        "ship" | "merge" | "btw" => session_id(w1),
        "usage" | "recipes" | "serve" | "desktop" | "import" => n == 1,
        "computer" => n == 1 || (n == 2 && ["on", "off", "status"].contains(&w1)),
        "run" => n > 1,
        "crew" => n == 1 || (w1 == "ls" && n == 2) || (["import", "export"].contains(&w1) && n > 2),
        _ => true,
    }
}

pub fn command_of(words: &[String], literal: Literal) -> Option<&'static str> {
    if literal == Literal::Task {
        return None;
    }
    let first = words.first()?;
    let cmd = COMMANDS.iter().find(|c| **c == first.as_str())?;
    fits(cmd, words).then_some(*cmd)
}

/// A flag that needs a value and got none.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0} needs a value — see wisp --help")]
pub struct UsageError(pub String);

/// Sets a flag; Ok(false): not a flag (a word).
fn set(f: &mut Flags, a: &str, value: &mut dyn FnMut() -> Result<String, UsageError>, home: &Path, cwd: &Path) -> Result<bool, UsageError> {
    match a {
        "--no-open" => f.open = false,
        "--browser" | "-b" => f.browser = true,
        "--port" | "-p" => {
            let v = value()?;
            f.port = v.parse().map_err(|_| UsageError(format!("{a} {v}: not a port")))?;
            f.port_given = true;
        }
        "--host" => f.host = Some(value()?),
        "--mode" | "-m" => f.mode = Some(value()?),
        "--agent" | "-a" => f.agent = Some(value()?),
        "--model" => f.model = Some(value()?),
        "--effort" => f.effort = Some(value()?),
        "--cwd" | "-C" => f.cwd = Some(expand(&value()?, home, cwd)),
        "--also" => f.also.push(expand(&value()?, home, cwd)),
        "--state" => f.state = Some(value()?),
        "--limit" => f.limit = value()?.parse().ok(),
        "--json" => f.json = true,
        "--wait" | "-w" => f.wait = true,
        "--yes" | "-y" => f.yes = true,
        "--queue" => f.queue = Some(true),
        "--project" => f.project = true,
        "--no-worktree" => f.worktree = Some(false),
        "--worktree" => f.worktree = Some(true),
        "--compare" => f.compare = Some(compare_list(&value()?)),
        "--try" => f.tries.push(value()?),
        "--draft" => f.draft = true,
        "--on" => f.on = true,
        "--all" => f.all = true,
        "--days" => f.days = value()?.parse().ok(),
        "--grid" => f.grid = Some(value()?),
        "--notebook" => f.notebook = true,
        "--team" => f.team = true,
        "--no-kit" => f.kit = false,
        "--gist" => f.gist = true,
        "--dry-run" => f.dry_run = true,
        _ => return Ok(false),
    }
    Ok(true)
}

pub fn parse(input: &[String], env_port: Option<&str>, home: &Path, cwd: &Path) -> Result<Parsed, UsageError> {
    let mut argv: Vec<String> = Vec::with_capacity(input.len());
    let mut flags = Flags::defaults(env_port);
    let mut words = Vec::new();
    let mut literal = Literal::No;
    // --state=review is --state review (it used to become a word, and the filter was dropped)
    for a in input {
        match a.split_once('=') {
            Some((k, v)) if literal == Literal::No && k.starts_with("--") && k.len() > 2 && k[2..].bytes().all(|b| b.is_ascii_lowercase() || b == b'-') => {
                argv.push(k.to_owned());
                argv.push(v.to_owned());
            }
            _ => argv.push(a.clone()),
        }
    }
    let mut i = 0;
    while i < argv.len() {
        let a = argv[i].clone();
        if literal != Literal::No {
            words.push(a);
        } else if a == "--" {
            literal = if words.is_empty() { Literal::Task } else { Literal::Yes };
        } else if a == "--version" || a == "-v" {
            return Ok(Parsed { action: Action::Version, flags, words, literal, command: None, argv });
        } else if a == "--help" || a == "-h" {
            return Ok(Parsed { action: Action::Help, flags, words, literal, command: None, argv });
        } else {
            let mut next = || {
                i += 1;
                argv.get(i).cloned().ok_or_else(|| UsageError(a.clone()))
            };
            if !set(&mut flags, &a, &mut next, home, cwd)? {
                words.push(a);
            }
        }
        i += 1;
    }
    let command = command_of(&words, literal);
    Ok(Parsed { action: Action::Run, flags, words, literal, command, argv })
}

#[cfg(test)]
#[path = "args_tests.rs"]
mod tests;
