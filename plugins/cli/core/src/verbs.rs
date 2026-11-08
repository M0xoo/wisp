//! `wisp <plugin> <verb> [words] [--flags]`, generated from the catalogue (ADR-0022): a command
//! `crew.set_layout` is `wisp crew set-layout`, `runtime.queue.sendNow` is `wisp runtime queue send-now`.
//! Flags and `--help` come from the argument type; the required fields also take plain words, in order.

use std::fmt::Write as _;

use serde_json::{Map, Value, json};
use wisp_kernel::CommandInfo;

use crate::decl::{ArgSpec, Field, Kind, kebab, parse};

/// A command line that doesn't fit the command: said with what to type instead.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Usage(pub String);

impl std::fmt::Display for Usage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

#[derive(Debug, Clone)]
pub struct Verb {
    pub info: CommandInfo,
    /// the first word (`crew`)
    pub plugin: String,
    /// the rest (`["queue", "send-now"]`)
    pub words: Vec<String>,
    pub spec: ArgSpec,
}

impl Verb {
    pub fn path(&self) -> String {
        format!("{} {}", self.plugin, self.words.join(" "))
    }
}

/// The words a command id is typed as.
pub fn path_of(id: &str) -> (String, Vec<String>) {
    let mut it = id.split('.');
    let ns = kebab(it.next().unwrap_or_default());
    (ns, it.map(kebab).collect())
}

/// `send_now`, `sendNow` and `send-now` are one word.
fn same(a: &str, b: &str) -> bool {
    kebab(a) == b
}

/// What `wisp` does with the options it reads itself before a generated verb sees the rest.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Own {
    pub json: bool,
    pub help: bool,
}

#[derive(Debug, Clone, Default)]
pub struct Catalogue {
    pub verbs: Vec<Verb>,
}

impl Catalogue {
    pub fn new(list: Vec<CommandInfo>) -> Self {
        let mut verbs: Vec<Verb> = list
            .into_iter()
            .map(|info| {
                let (plugin, words) = path_of(&info.id);
                let spec = parse(info.args.as_deref());
                Verb { info, plugin, words, spec }
            })
            .collect();
        verbs.sort_by_key(Verb::path);
        Self { verbs }
    }

    /// Each first word with its verbs, in order.
    pub fn plugins(&self) -> Vec<(&str, Vec<&Verb>)> {
        let mut out: Vec<(&str, Vec<&Verb>)> = Vec::new();
        for v in &self.verbs {
            match out.last_mut() {
                Some((p, list)) if *p == v.plugin => list.push(v),
                _ => out.push((&v.plugin, vec![v])),
            }
        }
        out
    }

    pub fn has_plugin(&self, word: &str) -> bool {
        self.verbs.iter().any(|v| same(word, &v.plugin))
    }

    pub fn by_id(&self, id: &str) -> Option<&Verb> {
        self.verbs.iter().find(|v| v.info.id == id)
    }

    /// The verb `words` start with (the longest that fits), and how many words it took. A dotted word
    /// (`queue.send-now`) is its parts.
    pub fn resolve(&self, words: &[String]) -> Option<(&Verb, usize)> {
        let first = words.first()?;
        let mut best: Option<(&Verb, usize)> = None;
        for v in self.verbs.iter().filter(|v| same(first, &v.plugin)) {
            // the words after the first, a dotted word split in its parts, until the verb is matched
            let mut parts: Vec<String> = Vec::new();
            let mut taken = 1;
            while parts.len() < v.words.len() {
                let Some(next) = words.get(taken) else { break };
                taken += 1;
                parts.extend(next.split('.').map(str::to_owned));
            }
            let fits = parts.len() == v.words.len() && parts.iter().zip(&v.words).all(|(a, b)| same(a, b));
            if fits && best.is_none_or(|(_, n)| taken > n) {
                best = Some((v, taken));
            }
        }
        best
    }

    /// The plugin's verbs whose first word is `word`, for "did you mean".
    pub fn near(&self, plugin: &str, word: &str) -> Vec<String> {
        self.verbs.iter().filter(|v| same(plugin, &v.plugin) && v.words.first().is_some_and(|w| w.starts_with(word) || word.starts_with(w.as_str()))).map(Verb::path).collect()
    }
}

/// `wisp`'s own options among a generated verb's words: `--json`, `--help`, and `--port N` (the
/// caller already read it).
pub fn own(rest: &[String]) -> (Own, Vec<String>) {
    let mut o = Own::default();
    let mut out = Vec::new();
    let mut it = rest.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--json" => o.json = true,
            "--help" | "-h" => o.help = true,
            "--port" | "-p" => {
                it.next();
            }
            _ if a.starts_with("--port=") => {}
            _ => out.push(a.clone()),
        }
    }
    (o, out)
}

fn value_of(f: &Field, raw: &str) -> Result<Value, Usage> {
    if f.nullable && raw == "null" {
        return Ok(Value::Null);
    }
    match &f.kind {
        Kind::Str => Ok(json!(raw)),
        Kind::Num => raw.parse::<i64>().map(Value::from).or_else(|_| raw.parse::<f64>().map(Value::from)).map_err(|_| Usage(format!("--{} takes a number, not {raw:?}", f.flag()))),
        Kind::Bool => match raw {
            "true" | "yes" | "on" | "1" => Ok(json!(true)),
            "false" | "no" | "off" | "0" => Ok(json!(false)),
            _ => Err(Usage(format!("--{} is true or false, not {raw:?}", f.flag()))),
        },
        Kind::List => Ok(json!(raw.split(',').map(str::trim).filter(|s| !s.is_empty()).collect::<Vec<_>>())),
        Kind::Choice(c) => {
            if c.iter().any(|x| x == raw) {
                Ok(json!(raw))
            } else {
                Err(Usage(format!("--{} is one of {}, not {raw:?}", f.flag(), c.join(", "))))
            }
        }
        Kind::Json => Ok(serde_json::from_str(raw).unwrap_or_else(|_| json!(raw))),
    }
}

fn put(obj: &mut Map<String, Value>, f: &Field, v: Value) {
    if f.kind == Kind::List
        && let (Some(Value::Array(had)), Value::Array(more)) = (obj.get_mut(&f.name), &v)
    {
        had.extend(more.iter().cloned());
        return;
    }
    obj.insert(f.name.clone(), v);
}

/// The command's arguments from the words after its verb.
#[allow(clippy::many_single_char_names)]
pub fn build(v: &Verb, rest: &[String]) -> Result<Value, Usage> {
    let spec = &v.spec;
    let mut obj = Map::new();
    let mut words: Vec<String> = Vec::new();
    let mut i = 0;
    let mut literal = false;
    while i < rest.len() {
        let a = &rest[i];
        i += 1;
        if literal || !a.starts_with("--") || a == "-" {
            words.push(a.clone());
            continue;
        }
        if a == "--" {
            literal = true;
            continue;
        }
        let (name, inline) = match a[2..].split_once('=') {
            Some((n, x)) => (n.to_owned(), Some(x.to_owned())),
            None => (a[2..].to_owned(), None),
        };
        if name == "args" {
            let raw = match inline {
                Some(x) => x,
                None => rest.get(i).cloned().inspect(|_| i += 1).ok_or_else(|| Usage("--args needs a JSON object".into()))?,
            };
            match serde_json::from_str::<Value>(&raw) {
                Ok(Value::Object(m)) => {
                    for (k, x) in m {
                        obj.insert(k, x);
                    }
                }
                Ok(other) if !spec.object => return Ok(other),
                _ => return Err(Usage(format!("--args takes a JSON object, not {raw:?}"))),
            }
            continue;
        }
        let negated = name.strip_prefix("no-").and_then(|n| spec.field(n).filter(|f| f.kind == Kind::Bool));
        if let Some(f) = negated {
            put(&mut obj, f, json!(false));
            continue;
        }
        let Some(f) = spec.field(&name) else {
            let known: Vec<String> = spec.fields.iter().map(|f| format!("--{}", f.flag())).collect();
            return Err(Usage(if known.is_empty() { format!("wisp {} takes no --{name} (see --help)", v.path()) } else { format!("wisp {} has no --{name}: {}", v.path(), known.join(" ")) }));
        };
        let raw = match (inline, &f.kind) {
            (Some(x), _) => x,
            (None, Kind::Bool) => "true".into(),
            (None, _) => rest.get(i).cloned().inspect(|_| i += 1).ok_or_else(|| Usage(format!("--{} needs a value", f.flag())))?,
        };
        put(&mut obj, f, value_of(f, &raw)?);
    }
    // the words fill the required fields still unset, in order; the last text field takes the rest
    let open: Vec<&Field> = spec.positionals().into_iter().filter(|f| !obj.contains_key(&f.name)).collect();
    let mut wi = words.into_iter();
    for (n, f) in open.iter().enumerate() {
        let last = n + 1 == open.len();
        let raw = if last && f.kind == Kind::Str {
            let all: Vec<String> = wi.by_ref().collect();
            if all.is_empty() { None } else { Some(all.join(" ")) }
        } else {
            wi.next()
        };
        if let Some(raw) = raw {
            put(&mut obj, f, value_of(f, &raw)?);
        }
    }
    if let Some(extra) = wi.next() {
        return Err(Usage(format!("wisp {} doesn't take {extra:?} here (see --help)", v.path())));
    }
    if !spec.object {
        return Ok(Value::Object(obj));
    }
    if let Some(miss) = spec.fields.iter().find(|f| !f.optional && f.kind != Kind::Bool && !obj.contains_key(&f.name)) {
        let doc = if miss.doc.is_empty() { String::new() } else { format!(" ({})", miss.doc) };
        return Err(Usage(format!("wisp {} needs --{}{doc}", v.path(), miss.flag())));
    }
    if spec.none && obj.is_empty() {
        return Ok(Value::Null);
    }
    Ok(Value::Object(obj))
}

fn kind_hint(f: &Field) -> String {
    let base = match &f.kind {
        Kind::Str => "TEXT".to_owned(),
        Kind::Num => "N".to_owned(),
        Kind::Bool => String::new(),
        Kind::List => "A,B".to_owned(),
        Kind::Choice(c) => c.join("|"),
        Kind::Json => "JSON".to_owned(),
    };
    if f.nullable && !base.is_empty() { format!("{base}|null") } else { base }
}

/// `wisp <plugin> <verb> --help`.
pub fn help_verb(v: &Verb) -> String {
    let mut s = format!("wisp {}", v.path());
    if let Some(t) = &v.info.title {
        let _ = write!(s, " — {t}");
    }
    s.push('\n');
    if !v.spec.doc.is_empty() {
        let _ = writeln!(s, "  {}", v.spec.doc);
    }
    let pos: Vec<String> = v.spec.positionals().iter().map(|f| format!("<{}>", f.flag())).collect();
    let _ = write!(s, "\nusage: wisp {}{}{}", v.path(), if pos.is_empty() { String::new() } else { format!(" {}", pos.join(" ")) }, if v.spec.fields.iter().any(|f| f.optional) { " [--flags]" } else { "" });
    s.push_str("\n\n");
    let mut rows: Vec<(String, String)> = v
        .spec
        .fields
        .iter()
        .map(|f| {
            let hint = kind_hint(f);
            let flag = if hint.is_empty() { format!("--{}", f.flag()) } else { format!("--{} {hint}", f.flag()) };
            let req = if f.optional || f.kind == Kind::Bool { "" } else { "required. " };
            (flag, format!("{req}{}", f.doc))
        })
        .collect();
    if !v.spec.object || v.spec.fields.is_empty() {
        rows.push(("--args JSON".into(), if v.spec.object { "the arguments as one JSON object".into() } else { "the arguments as JSON".into() }));
    }
    rows.push(("--json".into(), "print the result as JSON".into()));
    let w = rows.iter().map(|(f, _)| f.chars().count()).max().unwrap_or(0).min(34);
    for (f, d) in rows {
        let _ = writeln!(s, "  {f:<w$}  {d}");
    }
    let _ = write!(s, "\n{} · {}{}", v.info.id, v.info.permission, if v.info.read_only { " · read-only" } else { "" });
    s
}

/// `wisp help <plugin>`.
pub fn help_plugin(c: &Catalogue, plugin: &str) -> Option<String> {
    let (p, verbs) = c.plugins().into_iter().find(|(p, _)| same(plugin, p))?;
    let w = verbs.iter().map(|v| v.words.join(" ").chars().count()).max().unwrap_or(0);
    let mut s = format!("wisp {p} <verb>   ({} commands, from {})\n\n", verbs.len(), verbs.first().map_or("", |v| v.info.plugin.as_str()));
    for v in verbs {
        let _ = writeln!(s, "  {:<w$}  {}", v.words.join(" "), v.info.title.as_deref().unwrap_or(""));
    }
    let _ = write!(s, "\nwisp {p} <verb> --help: its flags");
    Some(s)
}

/// `wisp help`: the curated verbs, then every plugin's.
pub fn help_all(c: &Catalogue, curated: &str) -> String {
    let mut s = format!("{curated}\n\nEvery command, by plugin (wisp help <plugin> for its verbs):\n");
    for (p, verbs) in c.plugins() {
        let some: Vec<&str> = verbs.iter().take(6).map(|v| v.words.first().map_or("", String::as_str)).collect();
        let mut seen: Vec<&str> = Vec::new();
        for w in some {
            if !seen.contains(&w) {
                seen.push(w);
            }
        }
        let more = if verbs.len() > seen.len() { " …" } else { "" };
        let _ = writeln!(s, "  wisp {p:<12} {:>3}  {}{more}", verbs.len(), seen.join(", "));
    }
    s.pop();
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(id: &str, args: Option<&str>) -> CommandInfo {
        CommandInfo { id: id.into(), plugin: "wisp.x".into(), title: Some(format!("the {id}")), read_only: false, permission: id.replace('.', ":"), args: args.map(str::to_owned) }
    }

    fn cat() -> Catalogue {
        Catalogue::new(vec![
            info("settings.set", Some("{ \n/**\n * the setting's key\n */\nkey: string, value: unknown, }")),
            info("crew.set_layout", Some("{ layout: Array<unknown>, }")),
            info("crew.create", Some("{ name?: string, paused?: boolean, parallel?: number, on?: Array<string>, mode?: \"plan\" | \"auto\", wakeAt?: number | null, }")),
            info("runtime.queue.sendNow", Some("{ id: SessionId, itemId: string, }")),
            info("runtime.create", Some("{ prompt: string, agent?: string, }")),
            info("runtime.list", None),
            info("plugins.list", Some("null")),
        ])
    }

    fn w(s: &str) -> Vec<String> {
        s.split(' ').map(str::to_owned).collect()
    }

    #[test]
    fn every_command_has_a_path_that_resolves_back_to_it() {
        let c = cat();
        for v in &c.verbs {
            let mut words = vec![v.plugin.clone()];
            words.extend(v.words.iter().cloned());
            assert_eq!(c.resolve(&words).map(|(x, n)| (x.info.id.as_str(), n)), Some((v.info.id.as_str(), words.len())));
        }
        assert_eq!(c.resolve(&w("runtime queue.send-now S1 i1")).map(|(v, n)| (v.info.id.as_str(), n)), Some(("runtime.queue.sendNow", 2)));
        assert_eq!(c.resolve(&w("crew set_layout")).map(|(v, _)| v.info.id.as_str()), Some("crew.set_layout"));
        assert!(c.resolve(&w("fix the bug")).is_none());
    }

    #[test]
    fn words_and_flags_become_the_arguments() {
        let c = cat();
        let set = c.by_id("settings.set").unwrap();
        assert_eq!(build(set, &w("theme dark")).unwrap(), json!({ "key": "theme", "value": "dark" }));
        assert_eq!(build(set, &w("worktrees.max 4")).unwrap(), json!({ "key": "worktrees.max", "value": 4 }));
        let create = c.by_id("crew.create").unwrap();
        let got = build(create, &w("--name Ada --paused --parallel 2 --on ci --on=done --mode auto --wake-at null")).unwrap();
        assert_eq!(got, json!({ "name": "Ada", "paused": true, "parallel": 2, "on": ["ci", "done"], "mode": "auto", "wakeAt": null }));
        assert_eq!(build(create, &w("--no-paused")).unwrap(), json!({ "paused": false }));
        assert!(build(create, &w("--mode yolo")).unwrap_err().0.contains("plan, auto"));
        assert!(build(create, &w("--color red")).unwrap_err().0.contains("--name"));
        let send = c.by_id("runtime.queue.sendNow").unwrap();
        assert!(build(send, &w("S1")).unwrap_err().0.contains("--item-id"));
        let start = c.by_id("runtime.create").unwrap();
        assert_eq!(build(start, &w("fix the add bug --agent codex")).unwrap(), json!({ "prompt": "fix the add bug", "agent": "codex" }));
        assert_eq!(build(c.by_id("runtime.list").unwrap(), &w("--args {\"limit\":2}")).unwrap(), json!({ "limit": 2 }));
        assert_eq!(build(c.by_id("plugins.list").unwrap(), &[]).unwrap(), Value::Null);
    }

    #[test]
    fn help_comes_from_the_argument_docs() {
        let c = cat();
        let h = help_verb(c.by_id("settings.set").unwrap());
        assert!(h.starts_with("wisp settings set — the settings.set"), "{h}");
        assert!(h.contains("usage: wisp settings set <key> <value>"));
        assert!(h.contains("--key TEXT") && h.contains("required. the setting's key"), "{h}");
        let p = help_plugin(&c, "crew").unwrap();
        assert!(p.contains("set-layout") && p.contains("create"));
        assert!(help_all(&c, "usage: …").contains("wisp runtime"));
        let (o, rest) = own(&w("theme --json dark --port 9"));
        assert_eq!((o.json, rest), (true, w("theme dark")));
    }
}
