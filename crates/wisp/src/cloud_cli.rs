//! wisp and a wisp Grid from the terminal (ADR-0010, 0038, 0041), over wisp.grid-client's commands:
//!
//! - `wisp cloud signin [grid]` (the device flow: a code to approve in the browser), `status`, `signout`;
//! - `wisp computer on|off|status`: this computer on the grid, reachable from your other wisps;
//! - `wisp share <kind>.<name> --to cloud`: a setup (with what it references) to wisp Cloud, previewed;
//!   `wisp share <task> --to cloud` is `share_cli`'s, through `share.send`;
//! - `wisp shares [--revoke <id>] [--updates]`: what you've shared (access, views, imports, versions), and
//!   what you imported that has an update;
//! - `wisp open <link>`: a share link (`…/s/<id>`, `grid://<handle>/<name>`, `wisp://open/<id>`): a setup's
//!   plan, then apply it (`--yes`); a task goes to `wisp open`'s choices.
use std::fmt::Write as _;
use std::io::IsTerminal as _;
use std::path::Path;

use serde_json::{Value, json};
use wisp_cli_core::term::{BOLD, DIM, GREEN, RED, YELLOW, paint};
use wisp_resources_api::{Plan, Resource};

use crate::client::{CliError, Client, Result};
use crate::code::Opts;
use crate::scripted::say;

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

fn tty() -> bool {
    std::io::stdin().is_terminal() && std::io::stdout().is_terminal()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(0))
}

/// `7d`, `12h`, `30m` → ms.
pub fn duration_ms(d: &str) -> Option<i64> {
    let (n, unit) = d.split_at(d.len().checked_sub(1)?);
    let n: i64 = n.parse().ok()?;
    Some(
        n * match unit {
            "d" => 86_400_000,
            "h" => 3_600_000,
            "m" => 60_000,
            _ => return None,
        },
    )
}

/// `anyone`, `people:ada,bo`, `teams:acme`, `password` (with `--password`).
pub fn access_of(a: &str, password: Option<&str>) -> std::result::Result<Value, String> {
    let (kind, list) = a.split_once(':').unwrap_or((a, ""));
    let names: Vec<&str> = list.split(',').map(str::trim).filter(|x| !x.is_empty()).collect();
    match kind {
        "anyone" => Ok(json!({ "kind": "anyone" })),
        "people" if !names.is_empty() => Ok(json!({ "kind": "people", "people": names })),
        "teams" if !names.is_empty() => Ok(json!({ "kind": "teams", "teams": names })),
        "password" => password
            .filter(|p| !p.is_empty())
            .map(|p| json!({ "kind": "password", "password": p }))
            .ok_or_else(|| "--access password needs --password <it>".to_owned()),
        _ => Err(format!("--access {a}: anyone, people:<handles>, teams:<teams> or password")),
    }
}

/// The access, expiry and gallery flags as `share.send`'s fields.
pub fn send_args(o: &Opts) -> Result<Value> {
    let mut v = json!({ "to": "wisp-cloud" });
    if let Some(a) = &o.access {
        v["access"] = access_of(a, o.password.as_deref()).map_err(CliError::said)?;
    }
    if let Some(e) = &o.expires {
        let ms = duration_ms(e).ok_or_else(|| CliError::said(format!("--expires {e}: like 7d, 12h or 30m")))?;
        v["expiresAt"] = json!(now_ms() + ms);
    }
    if o.publish {
        v["publish"] = json!(true);
    }
    Ok(v)
}

/// Whether wisp Cloud takes shares now; says how to sign in (or share to a file) when it doesn't.
pub async fn ready(c: &Client) -> Result<bool> {
    let d = c.cmd("share.destinations", json!({})).await?;
    let cloud = d.as_array().into_iter().flatten().find(|x| s(x, "id") == "wisp-cloud");
    match cloud {
        Some(x) if x["ready"] == json!(true) => Ok(true),
        Some(x) => {
            eprintln!("  ✗ {}", s(x, "why"));
            Ok(false)
        }
        None => {
            eprintln!("  ✗ wisp Cloud isn't in this build (wisp.grid-client); share to a file: --to file");
            Ok(false)
        }
    }
}

pub fn said_shared(v: &Value) {
    let st = crate::cli::style();
    let access = v.pointer("/access/kind").and_then(Value::as_str).unwrap_or("anyone");
    say(&format!(
        "  {} {}  {}",
        paint(&st, GREEN, "✓"),
        s(v, "url"),
        paint(&st, DIM, &format!("v{} · {access} · {}", v["version"], s(v, "source")))
    ));
}

/// `wisp cloud signin|status|signout`.
pub async fn cloud(c: &Client, o: &Opts) -> Result<i32> {
    let st = crate::cli::style();
    match o.words.first().map(String::as_str) {
        Some("signin" | "login") => {
            let mut args = json!({});
            if let Some(g) = o.words.get(1) {
                args["grid"] = json!(g);
            }
            let f = c.cmd("grid-client.signin", args).await?;
            say(&format!("  Open {}\n  and check the code: {}", paint(&st, BOLD, s(&f, "verifyUrl")), paint(&st, BOLD, s(&f, "userCode"))));
            if tty() {
                crate::serve::open_url(s(&f, "verifyUrl"));
            }
            let id = s(&f, "id").to_owned();
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(700)).await;
                let f = c.cmd("grid-client.signinStatus", json!({ "id": id })).await?;
                match s(&f, "state") {
                    "waiting" => {}
                    "done" => {
                        say(&format!("  {} signed in to {} as {}", paint(&st, GREEN, "✓"), s(&f, "grid"), s(&f, "handle")));
                        return Ok(0);
                    }
                    _ => {
                        eprintln!("  ✗ {}", s(&f, "error"));
                        return Ok(1);
                    }
                }
            }
        }
        Some("signout" | "logout") => {
            c.cmd("grid-client.signout", json!({})).await?;
            say(&format!("  {} signed out", paint(&st, GREEN, "✓")));
            Ok(0)
        }
        Some("status") | None => {
            let v = c.cmd("grid-client.status", json!({})).await?;
            if o.json {
                say(&v.to_string());
            } else if v["signedIn"] == json!(true) {
                say(&format!("  signed in to {} as {}", s(&v, "grid"), s(&v, "handle")));
                say(&format!("  this computer: {}", computer_line(&v["computer"])));
            } else {
                say("  not signed in (wisp cloud signin)");
            }
            Ok(0)
        }
        Some(other) => Err(CliError::said(format!("wisp cloud {other}: signin, status or signout"))),
    }
}

fn computer_line(c: &Value) -> String {
    let state = s(c, "state");
    let mut line = if c["on"] == json!(true) { format!("on, {state}") } else { "off".to_owned() };
    if !s(c, "url").is_empty() {
        let _ = write!(line, " · {}", s(c, "url"));
    }
    if !s(c, "error").is_empty() {
        let _ = write!(line, " · {}", s(c, "error"));
    }
    line
}

/// `wisp computer on|off|status`.
pub async fn computer(c: &Client, o: &Opts) -> Result<i32> {
    let st = crate::cli::style();
    let v = match o.words.first().map(String::as_str) {
        Some("on") => c.cmd("grid-client.computer", json!({ "on": true })).await?,
        Some("off") => c.cmd("grid-client.computer", json!({ "on": false })).await?,
        _ => c.cmd("grid-client.status", json!({})).await?["computer"].clone(),
    };
    if o.json {
        say(&v.to_string());
    } else {
        say(&format!("  {} this computer: {}", paint(&st, GREEN, "◌"), computer_line(&v)));
    }
    Ok(0)
}

/// `wisp shares`.
/// `wisp sandbox new [name…] | ls | rm <id>`: a box of its own on the grid for one task, kept as a machine
/// (`wisp run --on "Sandbox …" …` runs there).
pub async fn sandbox(c: &Client, o: &Opts) -> Result<i32> {
    let st = crate::cli::style();
    let verb = o.words.first().map_or("ls", String::as_str);
    let rest = o.words.get(1..).unwrap_or_default().join(" ");
    match verb {
        "new" | "add" => {
            let v = c.cmd("grid-client.sandbox", json!({ "name": rest })).await?;
            if o.json {
                say(&v.to_string());
            } else {
                say(&format!(
                    "  {} sandbox {} at {}  {}",
                    paint(&st, GREEN, "✓"),
                    s(&v, "id"),
                    s(&v, "url"),
                    paint(&st, DIM, &format!("(machine {})", s(&v, "machine")))
                ));
            }
        }
        "ls" | "list" => {
            let v = c.cmd("grid-client.sandboxes", json!({})).await?;
            if o.json {
                say(&v.to_string());
                return Ok(0);
            }
            let list = v.as_array().cloned().unwrap_or_default();
            if list.is_empty() {
                say("  no sandboxes: wisp sandbox new <what it's for>");
            }
            for x in &list {
                let here = if s(x, "machine").is_empty() { paint(&st, DIM, "(not a machine here)") } else { String::new() };
                say(&format!("  {}  {:<28} {} {here}", s(x, "id"), s(x, "name"), s(x, "url")));
            }
        }
        "rm" | "remove" | "delete" => {
            let id = o.words.get(1).ok_or_else(|| CliError::said("wisp sandbox rm <id>"))?;
            c.cmd("grid-client.sandboxRemove", json!({ "id": id })).await?;
            say(&format!("  {} sandbox {id} deleted, with its home", paint(&st, GREEN, "✓")));
        }
        other => return Err(CliError::said(format!("wisp sandbox {other}: new, ls or rm"))),
    }
    Ok(0)
}

/// `wisp team ls | new <slug> [name…] | show <slug> | add <slug> <handle> [role] | rm <slug> <handle>`
pub async fn team(c: &Client, o: &Opts) -> Result<i32> {
    let word = |i: usize| o.words.get(i).cloned().unwrap_or_default();
    let op = if o.words.is_empty() { "ls".to_owned() } else { word(0) };
    let mut args = json!({ "op": op, "slug": word(1) });
    match op.as_str() {
        "new" | "create" => args["name"] = json!(o.words.get(2..).unwrap_or_default().join(" ")),
        "add" => {
            args["handle"] = json!(word(2));
            args["role"] = json!(word(3));
        }
        "rm" | "remove" => args["handle"] = json!(word(2)),
        _ => {}
    }
    let v = c.cmd("grid-client.teams", args).await?;
    if o.json || !matches!(op.as_str(), "ls" | "list" | "show") {
        say(&if o.json { v.to_string() } else { format!("  ✓ {op} {}", word(1)) });
        return Ok(0);
    }
    let teams = v.get("teams").and_then(Value::as_array).or_else(|| v.as_array()).cloned().unwrap_or_default();
    for t in &teams {
        say(&format!("  {:<20} {:<24} {}", s(t, "slug"), s(t, "name"), s(t, "role")));
    }
    for m in v.get("members").and_then(Value::as_array).into_iter().flatten() {
        say(&format!("  {:<20} {}", s(m, "handle"), s(m, "role")));
    }
    Ok(0)
}

pub async fn shares(c: &Client, o: &Opts) -> Result<i32> {
    let st = crate::cli::style();
    if let Some(id) = &o.revoke {
        c.cmd("grid-client.revoke", json!({ "id": id })).await?;
        say(&format!("  {} {id} isn't shared any more", paint(&st, GREEN, "✓")));
        return Ok(0);
    }
    if o.updates {
        let list = c.cmd("grid-client.updates", json!({})).await?;
        if o.json {
            say(&list.to_string());
            return Ok(0);
        }
        let items = list.as_array().cloned().unwrap_or_default();
        if items.is_empty() {
            say("  everything you imported is up to date");
        }
        for u in &items {
            say(&format!(
                "  {} {}  v{} → v{}  {}",
                paint(&st, YELLOW, "↑"),
                s(u, "title"),
                u["have"],
                u["latest"],
                paint(&st, DIM, &format!("wisp open {}", s(u, "url")))
            ));
        }
        return Ok(0);
    }
    let list = c.cmd("grid-client.shares", json!({})).await?;
    if o.json {
        say(&list.to_string());
        return Ok(0);
    }
    let items = list.as_array().cloned().unwrap_or_default();
    if items.is_empty() {
        say("  nothing shared yet (wisp share <id|kind.name> --to cloud)");
    }
    for v in &items {
        let gone = if v["revoked"] == json!(true) { paint(&st, RED, " revoked") } else { String::new() };
        say(&format!(
            "  {:<9} {}  {}{gone}\n            {}",
            s(v, "kind"),
            paint(&st, BOLD, s(v, "title")),
            paint(
                &st,
                DIM,
                &format!(
                    "v{} · {} · {} views · {} imports",
                    v["version"],
                    v.pointer("/access/kind").and_then(Value::as_str).unwrap_or("anyone"),
                    v["views"],
                    v["imports"]
                )
            ),
            s(v, "url")
        ));
    }
    Ok(0)
}

/// A setup's content for wisp Cloud: its resources (with specs, for the receiver's plan) and its formula.
fn setup_content(list: &[Resource], ks: &[wisp_resources_api::KindInfo]) -> Value {
    let resources: Vec<Value> = list
        .iter()
        .map(|r| {
            let keys: Vec<String> = r
                .spec
                .as_object()
                .map(|o| {
                    o.iter()
                        .filter(|(_, v)| v.is_string() || v.is_number() || v.is_boolean())
                        .take(3)
                        .map(|(k, v)| format!("{k}: {}", v.as_str().map_or_else(|| v.to_string(), str::to_owned)))
                        .collect()
                })
                .unwrap_or_default();
            json!({ "kind": r.kind, "name": r.name, "summary": keys.join(", "), "spec": r.spec })
        })
        .collect();
    json!({ "resources": resources, "files": [{ "name": "wisp.yml", "text": wisp_resources_core::export::write(list, ks, wisp_resources_core::formula::Format::Yaml) }] })
}

/// `wisp share <kind>.<name> --to cloud`: the setup, with what it references, previewed, then shared.
pub async fn share_setup(c: &Client, o: &Opts) -> Result<i32> {
    let st = crate::cli::style();
    let addr = o.words.first().cloned().unwrap_or_default();
    if !ready(c).await? {
        return Ok(1);
    }
    let ks = crate::code::kinds(c).await?;
    let all: Vec<Resource> =
        serde_json::from_value(c.cmd("resources.export", json!({})).await?).map_err(|e| CliError::said(e.to_string()))?;
    let list = crate::folder::with_deps(&all, std::slice::from_ref(&addr));
    if list.is_empty() {
        return Err(CliError::said(format!("{addr} isn't set up here (wisp export shows what is)")));
    }
    let content = setup_content(&list, &ks);
    say(&format!(
        "{} {addr}  {}",
        paint(&st, BOLD, "Share setup"),
        paint(&st, DIM, &format!("({} resources, secrets as ${{secret:…}})", list.len()))
    ));
    for r in &list {
        say(&format!("  {} {}.{}", paint(&st, GREEN, "+"), r.kind, r.name));
    }
    if !o.yes {
        if !tty() {
            eprintln!("  ✗ not a terminal: share with --yes once you've read what goes");
            return Ok(1);
        }
        let mut l = String::new();
        eprint!("\n  Share it to wisp Cloud? [y/N] ");
        let _ = std::io::stdin().read_line(&mut l);
        if !matches!(l.trim(), "y" | "Y" | "yes") {
            say("  nothing shared");
            return Ok(1);
        }
    }
    let name = addr.split_once('.').map_or(addr.as_str(), |(_, n)| n).to_owned();
    let mut send = send_args(o)?;
    send["kind"] = json!("setup");
    send["key"] = json!(name);
    send["title"] = json!(addr);
    send["content"] = content;
    let v = c.cmd("share.send", send).await?;
    said_shared(&v);
    Ok(0)
}

/// Whether a word is a share link `wisp open` should fetch from a grid.
pub fn is_link(w: &str) -> bool {
    w.starts_with("grid://")
        || w.starts_with("wisp://open/")
        || ((w.starts_with("http://") || w.starts_with("https://")) && w.contains("/s/"))
}

/// `wisp open <link>`.
pub async fn open_link(c: &Client, o: &Opts, cwd: &Path) -> Result<i32> {
    let st = crate::cli::style();
    let link = o.words.first().cloned().unwrap_or_default();
    let mut args = json!({ "link": link });
    if let Some(p) = &o.password {
        args["password"] = json!(p);
    }
    let f = c.cmd("grid-client.fetch", args).await?;
    let card = &f["card"];
    let ok = f["verified"] == json!(true);
    say(&format!(
        "{} {}  {}  {}",
        paint(&st, BOLD, s(card, "title")),
        paint(
            &st,
            DIM,
            &format!("({}, v{} by {})", s(card, "kind"), f["version"], card.pointer("/from/handle").and_then(Value::as_str).unwrap_or("?"))
        ),
        if ok { paint(&st, GREEN, "✓ signed") } else { paint(&st, RED, "✗ its signature doesn't match: it was changed after signing") },
        paint(&st, DIM, s(card, "source"))
    ));
    if !ok {
        return Ok(1);
    }
    if f["latest"].as_i64() > f["version"].as_i64() {
        say(&format!("  {} v{} is the latest", paint(&st, YELLOW, "!"), f["latest"]));
    }
    match s(card, "kind") {
        "task" => {
            let code = crate::share_cli::open_bundle(c, o, cwd, f["content"].clone()).await?;
            if code == 0 {
                let _ = c.cmd("grid-client.imported", json!({ "link": link, "version": f["version"] })).await;
            }
            Ok(code)
        }
        "setup" | "module" | "crew" | "workflow" | "agent" => apply_setup(c, o, &link, &f).await,
        other => {
            say(&serde_json::to_string_pretty(&f["content"]).unwrap_or_default());
            say(&paint(&st, DIM, &format!("  (a {other}: shown as it is)")));
            Ok(0)
        }
    }
}

/// A shared setup's plan here, then (`--yes`, or yes in a terminal) applied, and recorded for updates.
async fn apply_setup(c: &Client, o: &Opts, link: &str, f: &Value) -> Result<i32> {
    let st = crate::cli::style();
    let resources: Vec<Value> = f
        .pointer("/content/resources")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|r| json!({ "kind": r["kind"], "name": r["name"], "spec": r["spec"] }))
        .collect();
    let args = json!({ "resources": resources, "foreign": true, "trust": o.trust });
    let plan: Plan =
        serde_json::from_value(c.cmd("resources.plan", args.clone()).await?).map_err(|e| CliError::said(format!("resources.plan: {e}")))?;
    crate::code::show_plan(&plan, &st);
    if !plan.problems.is_empty() || !plan.missing_secrets.is_empty() {
        return Ok(1);
    }
    if plan.ops.is_empty() {
        say(&format!("  {} nothing to change: you have it", paint(&st, GREEN, "✓")));
        let _ = c.cmd("grid-client.imported", json!({ "link": link, "version": f["version"] })).await;
        return Ok(0);
    }
    if !plan.sensitive.is_empty() && !o.trust {
        eprintln!("  ✗ it comes from elsewhere and changes who may act: read the plan, then open it with --trust");
        return Ok(1);
    }
    if !o.yes {
        if !tty() {
            eprintln!("  ✗ not a terminal: apply it with --yes");
            return Ok(1);
        }
        let mut l = String::new();
        eprint!("\n  Apply it? [y/N] ");
        let _ = std::io::stdin().read_line(&mut l);
        if !matches!(l.trim(), "y" | "Y" | "yes") {
            say("  nothing applied");
            return Ok(1);
        }
    }
    let done = c.cmd("resources.apply", args).await?;
    let _ = c.cmd("grid-client.imported", json!({ "link": link, "version": f["version"] })).await;
    say(&format!("  {} applied {} change{}", paint(&st, GREEN, "✓"), done["applied"], if done["applied"] == 1 { "" } else { "s" }));
    Ok(0)
}

/// A `grid://<handle>/<name>[?ref=v2]` module source (ADR-0041): its files and the version they are, through
/// the running wisp's grid client (signature checked, the import recorded for "update available").
pub fn fetch_module(link: &str) -> Result<(Vec<(String, String)>, i64)> {
    tokio::task::block_in_place(|| {
        tokio::runtime::Handle::current().block_on(async {
            let home =
                crate::services::home(std::env::var("WISP_HOME").ok().as_deref(), std::env::var("HOME").ok().map(std::path::PathBuf::from));
            let port = crate::client::discover(&home).unwrap_or(4477);
            let c = Client::connect(port, true).await?;
            let f = c.cmd("grid-client.fetch", json!({ "link": link })).await?;
            if f["verified"] != json!(true) {
                return Err(CliError::said(format!("{link}: its signature doesn't match: not fetched")));
            }
            let files: Vec<(String, String)> = f
                .pointer("/content/files")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|x| Some((x.get("name")?.as_str()?.to_owned(), x.get("text")?.as_str()?.to_owned())))
                .filter(|(n, _)| !n.contains('/') && !n.starts_with('.'))
                .collect();
            if files.is_empty() {
                return Err(CliError::said(format!("{link} has no formula files (a {} share)", s(&f["card"], "kind"))));
            }
            let v = f["version"].as_i64().unwrap_or(0);
            let _ = c.cmd("grid-client.imported", json!({ "link": link, "version": v })).await;
            Ok((files, v))
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn access_and_expiry_flags() {
        assert_eq!(access_of("people:ada, bo", None), Ok(json!({ "kind": "people", "people": ["ada", "bo"] })));
        assert_eq!(access_of("teams:acme", None), Ok(json!({ "kind": "teams", "teams": ["acme"] })));
        assert!(access_of("password", None).is_err() && access_of("people:", None).is_err() && access_of("secret", None).is_err());
        assert_eq!(access_of("password", Some("x")), Ok(json!({ "kind": "password", "password": "x" })));
        assert_eq!(
            (duration_ms("7d"), duration_ms("12h"), duration_ms("30m"), duration_ms("7"), duration_ms("")),
            (Some(604_800_000), Some(43_200_000), Some(1_800_000), None, None)
        );
        assert!(
            is_link("grid://ada/review")
                && is_link("http://wisp.localhost:8080/s/AbC")
                && is_link("wisp://open/AbC")
                && !is_link("https://example.com/x.wisp-task")
        );
    }
}
