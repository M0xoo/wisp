//! A formula folder as one configuration (ADR-0034), sans-IO. Every file's sections, `variables`,
//! `locals`, `outputs` and `modules` are read together; every resource has an address `kind.name`; the
//! `${…}` references ([`crate::expr`]) build a dependency graph, evaluated in order (a cycle is refused);
//! `count` and `for_each` make several resources from one; a module is another folder (the caller loads
//! its files) whose resources are named `<module>-<name>` and addressed `module.<m>.<kind>.<name>`.

use std::collections::{BTreeMap, HashMap};

use serde_json::{Map, Value, json};
use wisp_resources_api::{KindInfo, Resource};

use crate::expr::{Scope, Seg, eval_value, refs};
use crate::formula::{documents, format_of};

/// What the configuration needs from outside: `file()`/`env()`, and a module's files by its source.
pub trait Env {
    fn outside(&self, f: &str, arg: &str) -> Result<Value, String>;
    /// The files of the module `name` at `source` (a path relative to `from`, or a git URL the caller fetched).
    fn module(&mut self, name: &str, source: &str, from: &str) -> Result<Vec<(String, String)>, String>;
}

/// A declared variable.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Variable {
    pub name: String,
    /// string | number | bool | list | map | any
    pub ty: String,
    pub default: Option<Value>,
    pub description: String,
}

/// The configuration: its resources (evaluated), where each was declared, its outputs and its graph.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Config {
    pub resources: Vec<Resource>,
    /// (address, kind, stored name, `file:line`)
    pub addresses: Vec<(String, String, String, String)>,
    pub outputs: Map<String, Value>,
    /// (address, what it references): `wisp graph`
    pub edges: Vec<(String, String)>,
    /// (module name, source), in the order they're used
    pub modules: Vec<(String, String)>,
    pub variables: Vec<Variable>,
}

/// One module's (or the root's) inputs.
#[derive(Debug, Clone, Default)]
pub struct Input {
    pub files: Vec<(String, String)>,
    /// values for the variables (`-var`, var files, `WISP_VAR_`; a module's `inputs`)
    pub vars: Map<String, Value>,
    pub workspace: String,
    /// `reviewers-` inside the module `reviewers`
    pub prefix: String,
    /// `module.reviewers.` inside it
    pub at: String,
}

const META: [&str; 9] = ["wisp", "include", "profiles", "variables", "locals", "outputs", "modules", "workspace", "history"];

#[derive(Debug, Clone)]
struct Decl {
    kind: String,
    name: String,
    spec: Value,
    count: Option<Value>,
    each: Option<Value>,
    at: String,
}

fn line_of(text: &str, name: &str) -> usize {
    text.lines().position(|l| {
        let t = l.trim_start().trim_start_matches("- ");
        t == format!("name: {name}") || t.starts_with(&format!("{name}:")) || t.contains(&format!("name: \"{name}\""))
    })
    .map_or(1, |i| i + 1)
}

fn items(kind: &KindInfo, v: &Value, at: &str) -> Result<Vec<(String, Value)>, String> {
    match v {
        Value::Object(_) if kind.singleton => Ok(vec![("default".to_owned(), v.clone())]),
        Value::Object(m) => Ok(m.iter().map(|(k, x)| (k.clone(), x.clone())).collect()),
        Value::Array(list) if !kind.map_form => list
            .iter()
            .enumerate()
            .map(|(i, x)| {
                let mut o = x.as_object().cloned().ok_or_else(|| format!("{at}[{i}]: a {} is an object with a name", kind.kind))?;
                match o.remove("name") {
                    Some(Value::String(n)) if !n.trim().is_empty() => Ok((n, Value::Object(o))),
                    _ => Err(format!("{at}[{i}]: every {} needs a name", kind.kind)),
                }
            })
            .collect(),
        Value::Null => Ok(Vec::new()),
        _ => Err(format!("{at}: {} takes a list of named items or a map", kind.section)),
    }
}

#[allow(clippy::cast_possible_truncation)] // a whole number checked by the caller
fn whole(f: f64) -> i64 {
    f as i64
}

/// The variables the files declare (to ask for the missing ones before evaluating).
pub fn declared(files: &[(String, String)]) -> Vec<Variable> {
    let mut out = Vec::new();
    for (file, text) in files {
        for doc in documents(text, format_of(file)).unwrap_or_default() {
            for (name, d) in doc.get("variables").and_then(Value::as_object).into_iter().flatten() {
                let s = |k: &str| d.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
                out.push(Variable { name: name.clone(), ty: s("type"), default: d.get("default").cloned(), description: s("description") });
            }
        }
    }
    out
}

/// A `-var` value (a string from the command line) or a default, made the declared type.
pub fn typed(v: &Variable, value: Value) -> Result<Value, String> {
    let bad = |want: &str| Err(format!("var.{}: {want}, not {value}", v.name));
    match (v.ty.as_str(), &value) {
        ("" | "any", _) | ("string", Value::String(_)) | ("number", Value::Number(_)) | ("bool", Value::Bool(_)) | ("list", Value::Array(_)) | ("map", Value::Object(_)) => Ok(value),
        ("number", Value::String(s)) => s.trim().parse::<f64>().ok().and_then(serde_json::Number::from_f64).map(|n| if n.as_f64().is_some_and(|f| f.fract() == 0.0) { json!(n.as_f64().map_or(0, whole)) } else { Value::Number(n) }).map_or_else(|| bad("a number"), Ok),
        ("bool", Value::String(s)) if s == "true" || s == "false" => Ok(Value::Bool(s == "true")),
        ("list" | "map", Value::String(s)) => match serde_json::from_str::<Value>(s) {
            Ok(x) if (v.ty == "list" && x.is_array()) || (v.ty == "map" && x.is_object()) => Ok(x),
            _ => bad(if v.ty == "list" { "a list (JSON)" } else { "a map (JSON)" }),
        },
        ("string", Value::Number(_) | Value::Bool(_)) => Ok(Value::String(value.to_string())),
        (t, _) if ["string", "number", "bool", "list", "map"].contains(&t) => bad(&format!("a {t}")),
        (t, _) => Err(format!("var.{}: type `{t}` isn't one of string, number, bool, list, map, any", v.name)),
    }
}

/// What the evaluator sees: everything resolved so far, plus `each` / `count` for one instance.
struct View<'a> {
    known: &'a Map<String, Value>,
    extra: Map<String, Value>,
    env: &'a dyn Env,
}

impl Scope for View<'_> {
    fn get(&self, path: &[Seg]) -> Result<Value, String> {
        let Some(Seg::Key(head)) = path.first() else { return Err("a reference starts with a name".into()) };
        let shown = |p: &[Seg]| p.iter().map(|s| match s { Seg::Key(k) => k.clone(), Seg::Index(i) => format!("[{i}]") }).collect::<Vec<_>>().join(".");
        let mut v = self.extra.get(head).or_else(|| self.known.get(head)).ok_or_else(|| format!("`{}` isn't declared", shown(&path[..path.len().min(2)])))?;
        for (n, seg) in path.iter().enumerate().skip(1) {
            v = match seg {
                Seg::Key(k) => v.get(k),
                Seg::Index(i) => v.get(*i).or_else(|| v.get(i.to_string())),
            }
            .ok_or_else(|| format!("`{}` isn't declared", shown(&path[..=n])))?;
        }
        // a resource as a whole is its name (`agent: ${agent.reviewer}`)
        if path.len() >= 2
            && !["var", "local", "module", "each", "count"].contains(&head.as_str())
            && let Some(name) = v.get("$name")
        {
            return Ok(name.clone());
        }
        Ok(v.clone())
    }
    fn outside(&self, f: &str, arg: &str) -> Result<Value, String> {
        self.env.outside(f, arg)
    }
}

/// The node a reference depends on (`agent.reviewer`, `local.x`, `module.m`), if any.
fn node_of(path: &[String], kinds: &[KindInfo]) -> Option<String> {
    let head = path.first()?;
    match head.as_str() {
        "var" | "each" | "count" | "workspace" => None,
        "local" | "module" => path.get(1).map(|n| format!("{head}.{n}")),
        k => kinds.iter().find(|x| x.kind == k).and_then(|_| path.get(1)).map(|n| format!("{k}.{n}")),
    }
}

struct Graph {
    deps: BTreeMap<String, Vec<String>>,
}

impl Graph {
    /// Every node after what it references; a cycle is an error naming it.
    fn order(&self) -> Result<Vec<String>, String> {
        fn visit<'a>(g: &'a Graph, n: &'a str, st: &mut HashMap<&'a str, u8>, path: &mut Vec<&'a str>, out: &mut Vec<String>) -> Result<(), String> {
            match st.get(n) {
                Some(2) => return Ok(()),
                Some(1) => {
                    let from = path.iter().position(|p| *p == n).unwrap_or(0);
                    let mut cyc: Vec<&str> = path[from..].to_vec();
                    cyc.push(n);
                    return Err(format!("a cycle: {}", cyc.join(" → ")));
                }
                _ => {}
            }
            st.insert(n, 1);
            path.push(n);
            for d in g.deps.get(n).into_iter().flatten() {
                if g.deps.contains_key(d.as_str()) {
                    visit(g, d, st, path, out)?;
                }
            }
            path.pop();
            st.insert(n, 2);
            out.push(n.to_owned());
            Ok(())
        }
        let mut state: HashMap<&str, u8> = HashMap::new();
        let mut out = Vec::new();
        for n in self.deps.keys() {
            visit(self, n, &mut state, &mut Vec::new(), &mut out)?;
        }
        Ok(out)
    }
}

#[derive(Default)]
struct Read {
    decls: Vec<Decl>,
    vars: Vec<Variable>,
    locals: Map<String, Value>,
    outputs: Map<String, Value>,
    modules: Vec<(String, Value, String)>,
}

fn read(input: &Input, kinds: &[KindInfo]) -> Result<Read, String> {
    let mut r = Read::default();
    for (file, text) in &input.files {
        for doc in documents(text, format_of(file)).map_err(|e| format!("{file}: {e}"))? {
            let Value::Object(m) = doc else { return Err(format!("{file}: a formula file is a map of sections")) };
            if let Some(v) = m.get("wisp").and_then(Value::as_u64).filter(|v| *v != 1) {
                return Err(format!("{file}: wisp: {v} is newer than this wisp reads; update wisp"));
            }
            for (name, d) in m.get("variables").and_then(Value::as_object).into_iter().flatten() {
                let s = |k: &str| d.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
                r.vars.push(Variable { name: name.clone(), ty: s("type"), default: d.get("default").cloned(), description: s("description") });
            }
            r.locals.extend(m.get("locals").and_then(Value::as_object).cloned().unwrap_or_default());
            for (k, o) in m.get("outputs").and_then(Value::as_object).into_iter().flatten() {
                r.outputs.insert(k.clone(), o.get("value").cloned().unwrap_or_else(|| o.clone()));
            }
            for (k, d) in m.get("modules").and_then(Value::as_object).into_iter().flatten() {
                r.modules.push((k.clone(), d.clone(), file.clone()));
            }
            for (section, v) in m.iter().filter(|(k, _)| !META.contains(&k.as_str())) {
                let Some(kind) = kinds.iter().find(|k| k.named(section)) else {
                    return Err(format!("{file}: no plugin in this wisp owns `{section}:`"));
                };
                for (name, spec) in items(kind, v, &format!("{file} {section}"))? {
                    let at = format!("{file}:{}", line_of(text, &name));
                    if let Some(had) = r.decls.iter().find(|d| d.kind == kind.kind && d.name == name) {
                        return Err(format!("{}{}.{name} is declared twice: {} and {at}", input.at, kind.kind, had.at));
                    }
                    let mut spec = spec;
                    let (count, each) = match spec.as_object_mut() {
                        Some(o) => (o.remove("count"), o.remove("for_each")),
                        None => (None, None),
                    };
                    r.decls.push(Decl { kind: kind.kind.clone(), name, spec, count, each, at });
                }
            }
        }
    }
    Ok(r)
}

fn variables(input: &Input, vars: &[Variable]) -> Result<Map<String, Value>, String> {
    if let Some(k) = input.vars.keys().find(|k| !vars.iter().any(|v| v.name == **k)) {
        return Err(format!("var.{k} is set but no file declares it (variables: {{ {k}: {{ type: string }} }})"));
    }
    let mut out = Map::new();
    for v in vars {
        let value = input.vars.get(&v.name).cloned().or_else(|| v.default.clone()).ok_or_else(|| format!("var.{} has no value: -var {}=…, a var file or WISP_VAR_{}", v.name, v.name, v.name))?;
        out.insert(v.name.clone(), typed(v, value)?);
    }
    Ok(out)
}

/// The instances one declaration makes: (stored name, `each`/`count` values).
/// One instance: its stored name, its `count.index` / `each.key`, and what it adds to the scope.
type Instance = (String, Option<Value>, Map<String, Value>);

fn instances(d: &Decl, prefix: &str, view: &View<'_>) -> Result<Vec<Instance>, String> {
    let base = format!("{prefix}{}", d.name);
    if let Some(c) = &d.count {
        let n = eval_value(c, view)?.as_u64().ok_or_else(|| format!("{}: count is a whole number", d.at))?;
        return Ok((0..n).map(|i| (format!("{base}-{i}"), Some(json!(i)), Map::from_iter([("count".to_owned(), json!({ "index": i }))]))).collect());
    }
    if let Some(e) = &d.each {
        let pairs: Vec<(String, Value)> = match eval_value(e, view)? {
            Value::Array(a) => a.into_iter().map(|v| (v.as_str().map_or_else(|| v.to_string(), str::to_owned), v)).collect(),
            Value::Object(m) => m.into_iter().collect(),
            _ => return Err(format!("{}: for_each takes a list or a map", d.at)),
        };
        return Ok(pairs.into_iter().map(|(k, v)| (format!("{base}-{k}"), Some(json!(k)), Map::from_iter([("each".to_owned(), json!({ "key": k, "value": v }))]))).collect());
    }
    Ok(vec![(base, None, Map::new())])
}

/// The whole folder evaluated.
#[allow(clippy::many_single_char_names, clippy::too_many_lines)] // one pass over the graph's nodes
pub fn configure(input: &Input, kinds: &[KindInfo], env: &mut dyn Env) -> Result<Config, String> {
    let r = read(input, kinds)?;
    let mut known = Map::new();
    known.insert("var".into(), Value::Object(variables(input, &r.vars)?));
    known.insert("workspace".into(), json!(input.workspace));
    let mut deps: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut dep_of = |node: String, v: &Value| {
        let d: Vec<String> = refs(v).iter().filter_map(|p| node_of(p, kinds)).filter(|d| *d != node).collect();
        deps.entry(node).or_default().extend(d);
    };
    for (k, v) in &r.locals {
        dep_of(format!("local.{k}"), v);
    }
    for (m, d, _) in &r.modules {
        dep_of(format!("module.{m}"), d.get("inputs").unwrap_or(&Value::Null));
    }
    for d in &r.decls {
        let all = json!([d.spec, d.count, d.each]);
        dep_of(format!("{}.{}", d.kind, d.name), &all);
    }
    let g = Graph { deps };
    let order = g.order()?;
    let mut cfg = Config { variables: r.vars.clone(), ..Config::default() };
    for (node, ds) in &g.deps {
        for d in ds.iter().filter(|d| g.deps.contains_key(d.as_str())) {
            cfg.edges.push((format!("{}{node}", input.at), format!("{}{d}", input.at)));
        }
    }
    let (mut locals, mut mods) = (Map::new(), Map::new());
    for node in order {
        let (head, name) = node.split_once('.').unwrap_or((node.as_str(), ""));
        match head {
            "local" => {
                let v = eval_value(&r.locals[name], &View { known: &known, extra: Map::new(), env })?;
                locals.insert(name.to_owned(), v);
                known.insert("local".into(), Value::Object(locals.clone()));
            }
            "module" => {
                let Some((m, d, from)) = r.modules.iter().find(|(m, _, _)| m == name) else { continue };
                let source = d.get("source").and_then(Value::as_str).ok_or_else(|| format!("module.{m}: it needs a source"))?.to_owned();
                let inputs = eval_value(d.get("inputs").unwrap_or(&json!({})), &View { known: &known, extra: Map::new(), env })?;
                let files = env.module(m, &source, from)?;
                let sub = Input { files, vars: inputs.as_object().cloned().unwrap_or_default(), workspace: input.workspace.clone(), prefix: format!("{}{m}-", input.prefix), at: format!("{}module.{m}.", input.at) };
                let c = configure(&sub, kinds, env).map_err(|e| format!("module.{m} ({source}): {e}"))?;
                cfg.modules.push((format!("{}{m}", input.at), source));
                cfg.modules.extend(c.modules);
                cfg.resources.extend(c.resources);
                cfg.addresses.extend(c.addresses);
                cfg.edges.extend(c.edges);
                mods.insert(m.clone(), Value::Object(c.outputs));
                known.insert("module".into(), Value::Object(mods.clone()));
            }
            _ => {
                let Some(d) = r.decls.iter().find(|d| d.kind == head && d.name == name) else { continue };
                let mut made = Vec::new();
                for (stored, key, extra) in instances(d, &input.prefix, &View { known: &known, extra: Map::new(), env })? {
                    let spec = eval_value(&d.spec, &View { known: &known, extra, env })?;
                    let mut attrs = spec.as_object().cloned().unwrap_or_default();
                    attrs.insert("name".into(), json!(stored));
                    attrs.insert("$name".into(), json!(stored));
                    made.push((key, Value::Object(attrs)));
                    let addr = match &made.last().and_then(|(k, _)| k.clone()) {
                        Some(k) => format!("{}{}.{}[{}]", input.at, d.kind, d.name, k.as_str().map_or_else(|| k.to_string(), |s| format!("\"{s}\""))),
                        None => format!("{}{}.{}", input.at, d.kind, d.name),
                    };
                    cfg.addresses.push((addr, d.kind.clone(), stored.clone(), d.at.clone()));
                    cfg.resources.push(Resource::new(d.kind.clone(), stored, spec));
                }
                let entry = if d.count.is_some() {
                    Value::Array(made.into_iter().map(|(_, v)| v).collect())
                } else if d.each.is_some() {
                    Value::Object(made.into_iter().map(|(k, v)| (k.and_then(|k| k.as_str().map(str::to_owned)).unwrap_or_default(), v)).collect())
                } else {
                    made.pop().map(|(_, v)| v).unwrap_or_default()
                };
                let slot = known.entry(d.kind.clone()).or_insert_with(|| json!({}));
                if let Some(o) = slot.as_object_mut() {
                    o.insert(d.name.clone(), entry);
                }
            }
        }
    }
    for (k, v) in &r.outputs {
        cfg.outputs.insert(k.clone(), eval_value(v, &View { known: &known, extra: Map::new(), env })?);
    }
    Ok(cfg)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use wisp_resources_api::KindInfo;

    struct NoIo(BTreeMap<String, Vec<(String, String)>>);
    impl Env for NoIo {
        fn outside(&self, f: &str, a: &str) -> Result<Value, String> {
            Ok(json!(format!("{f}({a})")))
        }
        fn module(&mut self, _n: &str, source: &str, _from: &str) -> Result<Vec<(String, String)>, String> {
            self.0.get(source).cloned().ok_or_else(|| format!("no module at {source}"))
        }
    }

    fn kinds() -> Vec<KindInfo> {
        [("agent", "agents"), ("crew", "crew"), ("machine", "machines")].iter().map(|(k, s)| KindInfo::new(k, s, "t", json!({}))).collect()
    }

    fn files(f: &[(&str, &str)]) -> Vec<(String, String)> {
        f.iter().map(|(a, b)| ((*a).to_owned(), (*b).to_owned())).collect()
    }

    #[allow(clippy::needless_pass_by_value)]
    fn run(f: &[(&str, &str)], vars: Value, mods: &[(&str, &[(&str, &str)])]) -> Result<Config, String> {
        let input = Input { files: files(f), vars: vars.as_object().cloned().unwrap_or_default(), workspace: "dev".into(), ..Input::default() };
        let mut env = NoIo(mods.iter().map(|(s, f)| ((*s).to_owned(), files(f))).collect());
        configure(&input, &kinds(), &mut env)
    }

    #[test]
    fn files_references_variables_locals_count_for_each_and_outputs() {
        let c = run(
            &[
                ("agents.wisp.yml", "variables:\n  model: { type: string, default: opus }\n  n: { type: number, default: 2 }\nlocals:\n  harness: codex\nagents:\n  - name: reviewer\n    harness: ${local.harness}\n    model: ${var.model}\n"),
                ("crew.wisp.yml", "crew:\n  ada:\n    agent: ${agent.reviewer}\n    model: \"${agent.reviewer.model}-${workspace}\"\n  bots:\n    count: ${var.n}\n    agent: bot-${count.index}\n  svc:\n    for_each: [api, web]\n    role: watches ${each.key}\noutputs:\n  who: { value: \"${crew.ada.agent}\" }\n"),
            ],
            json!({ "model": "sonnet" }),
            &[],
        )
        .unwrap();
        let spec = |n: &str| c.resources.iter().find(|r| r.name == n).map(|r| r.spec.clone()).unwrap();
        assert_eq!(spec("reviewer"), json!({ "harness": "codex", "model": "sonnet" }));
        assert_eq!(spec("ada"), json!({ "agent": "reviewer", "model": "sonnet-dev" }));
        assert_eq!(spec("bots-1"), json!({ "agent": "bot-1" }));
        assert_eq!(spec("svc-web"), json!({ "role": "watches web" }));
        assert_eq!(c.outputs["who"], json!("reviewer"));
        assert!(c.edges.contains(&("crew.ada".into(), "agent.reviewer".into())));
        assert!(c.addresses.iter().any(|(a, _, n, at)| a == "crew.svc[\"api\"]" && n == "svc-api" && at == "crew.wisp.yml:8"));
    }

    #[test]
    fn what_it_refuses() {
        let e = run(&[("a.wisp.yml", "agents:\n  x: { model: \"${agent.y.model}\" }\n  y: { model: \"${agent.x.model}\" }\n")], json!({}), &[]).unwrap_err();
        assert!(e.contains("a cycle: agent.x → agent.y → agent.x") || e.contains("a cycle: agent.y → agent.x → agent.y"), "{e}");
        let e = run(&[("a.wisp.yml", "agents: { x: {} }"), ("b.wisp.yml", "\n\nagents:\n  x: {}\n")], json!({}), &[]).unwrap_err();
        assert!(e.contains("agent.x is declared twice: a.wisp.yml:1 and b.wisp.yml:4"), "{e}");
        assert!(run(&[("a.wisp.yml", "variables: { n: { type: number } }")], json!({}), &[]).unwrap_err().contains("var.n has no value"));
        assert!(run(&[("a.wisp.yml", "variables: { n: { type: number } }")], json!({ "n": "lots" }), &[]).unwrap_err().contains("a number"));
        assert_eq!(run(&[("a.wisp.yml", "variables: { n: { type: number } }\nagents: { x: { n: \"${var.n}\" } }")], json!({ "n": "3" }), &[]).unwrap().resources[0].spec, json!({ "n": 3 }));
        assert!(run(&[("a.wisp.yml", "")], json!({ "zzz": 1 }), &[]).unwrap_err().contains("no file declares it"));
        assert!(run(&[("a.wisp.yml", "agents: { x: { m: \"${agent.nope.model}\" } }")], json!({}), &[]).unwrap_err().contains("agent.nope"));
    }

    #[test]
    fn a_module_is_prefixed_takes_inputs_and_gives_outputs() {
        let module: &[(&str, &str)] = &[("team.wisp.yml", "variables: { model: { type: string } }\nagents:\n  reviewer: { model: \"${var.model}\" }\ncrew:\n  lead: { agent: \"${agent.reviewer}\" }\noutputs:\n  reviewer: { value: \"${agent.reviewer}\" }\n")];
        let c = run(&[("main.wisp.yml", "modules:\n  rev: { source: ./mods/team, inputs: { model: haiku } }\ncrew:\n  ada: { agent: \"${module.rev.reviewer}\" }\n")], json!({}), &[("./mods/team", module)]).unwrap();
        let names: Vec<&str> = c.resources.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, ["rev-reviewer", "rev-lead", "ada"]);
        assert_eq!(c.resources[1].spec, json!({ "agent": "rev-reviewer" }), "inside the module, its own names");
        assert_eq!(c.resources[2].spec, json!({ "agent": "rev-reviewer" }));
        assert!(c.addresses.iter().any(|(a, ..)| a == "module.rev.agent.reviewer"));
        assert_eq!(c.modules, [("rev".to_owned(), "./mods/team".to_owned())]);
    }
}
