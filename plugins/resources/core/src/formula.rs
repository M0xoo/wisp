//! Reading a formula (ADR-0026): `wisp: 1`, YAML (one document or several), JSON or TOML with the same
//! shape; `include:` other formulas; `profiles:` parts picked with `--profile`; `${env:NAME}` filled in
//! here; `${secret:NAME}` left as a reference (secrets never go in a file, or in the store's rows).
//! The files and the environment come through [`Source`]: this module does no IO.

use std::collections::BTreeSet;

use serde_json::{Map, Value};
use wisp_resources_api::{FORMAT, KindInfo, Resource};

use crate::plan::merge;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Yaml,
    Json,
    Toml,
}

/// By the file's extension; YAML when it has none it knows.
#[allow(clippy::case_sensitive_file_extension_comparisons)] // lowercased first
pub fn format_of(path: &str) -> Format {
    let p = path.to_ascii_lowercase();
    if p.ends_with(".json") {
        Format::Json
    } else if p.ends_with(".toml") {
        Format::Toml
    } else {
        Format::Yaml
    }
}

/// Where formulas and `${env:…}` come from: the CLI's files and URLs, or a test's map.
pub trait Source {
    /// The text of `reference` (a path or URL as written in `include:`), seen from `from`; with the name
    /// it goes by (resolved path or URL) for the next include and for errors.
    fn load(&mut self, reference: &str, from: Option<&str>) -> Result<(String, String), String>;
    fn env(&self, name: &str) -> Option<String>;
}

/// A formula, read: its resources in file order (later ones patch earlier ones of the same name).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Loaded {
    pub resources: Vec<Resource>,
    /// every file or URL read, the root first
    pub sources: Vec<String>,
    /// the `${secret:NAME}` names it references
    pub secrets: Vec<String>,
}

/// The documents in `text`.
pub fn documents(text: &str, format: Format) -> Result<Vec<Value>, String> {
    match format {
        Format::Json => serde_json::from_str::<Value>(text).map(|v| vec![v]).map_err(|e| format!("JSON: {e}")),
        Format::Toml => toml::from_str::<Value>(text).map(|v| vec![v]).map_err(|e| format!("TOML: {e}")),
        Format::Yaml => {
            let docs: Vec<Value> = serde_saphyr::from_multiple(text).map_err(|e| format!("YAML: {e}"))?;
            Ok(docs.into_iter().filter(|d| !d.is_null()).collect())
        }
    }
}

/// `${env:NAME}` filled in every string; the names that weren't set are added to `missing`.
pub fn fill_env(v: &mut Value, src: &dyn Source, missing: &mut BTreeSet<String>) {
    match v {
        Value::String(s) if s.contains("${env:") => {
            let mut out = String::new();
            let mut rest = s.as_str();
            while let Some(at) = rest.find("${env:") {
                out.push_str(&rest[..at]);
                let after = &rest[at + 6..];
                let Some(end) = after.find('}') else {
                    out.push_str(&rest[at..]);
                    rest = "";
                    break;
                };
                let name = &after[..end];
                match src.env(name) {
                    Some(val) => out.push_str(&val),
                    None => {
                        missing.insert(name.to_owned());
                    }
                }
                rest = &after[end + 1..];
            }
            out.push_str(rest);
            *s = out;
        }
        Value::Array(a) => a.iter_mut().for_each(|x| fill_env(x, src, missing)),
        Value::Object(o) => o.values_mut().for_each(|x| fill_env(x, src, missing)),
        _ => {}
    }
}

/// Every `${secret:NAME}` in `v`.
pub fn secrets_in(v: &Value, out: &mut BTreeSet<String>) {
    match v {
        Value::String(s) => {
            let mut rest = s.as_str();
            while let Some(at) = rest.find("${secret:") {
                let after = &rest[at + 9..];
                let Some(end) = after.find('}') else { break };
                out.insert(after[..end].to_owned());
                rest = &after[end + 1..];
            }
        }
        Value::Array(a) => a.iter().for_each(|x| secrets_in(x, out)),
        Value::Object(o) => o.values().for_each(|x| secrets_in(x, out)),
        _ => {}
    }
}

/// The keys of a formula document that aren't sections.
const META: [&str; 3] = ["wisp", "include", "profiles"];

/// A section's items as (name, spec).
fn items(kind: &KindInfo, v: &Value, at: &str) -> Result<Vec<(String, Value)>, String> {
    match v {
        Value::Object(_) if kind.singleton => Ok(vec![("default".to_owned(), v.clone())]),
        Value::Object(m) if kind.map_form => Ok(m.iter().map(|(k, x)| (k.clone(), x.clone())).collect()),
        // `crew: { Ada: { role: … } }` is the same as a list with names
        Value::Object(m) => Ok(m.iter().map(|(k, x)| (k.clone(), x.clone())).collect()),
        Value::Array(list) if !kind.map_form => list
            .iter()
            .enumerate()
            .map(|(i, x)| {
                let mut o = x.as_object().cloned().ok_or_else(|| format!("{at}[{i}]: a {} is an object with a name", kind.kind))?;
                let name = match o.remove("name") {
                    Some(Value::String(n)) if !n.trim().is_empty() => n,
                    _ => return Err(format!("{at}[{i}]: every {} needs a name", kind.kind)),
                };
                Ok((name, Value::Object(o)))
            })
            .collect(),
        Value::Null => Ok(Vec::new()),
        _ => Err(format!("{at}: {} takes {}", kind.section, if kind.map_form { "a map of name: value" } else { "a list of named items" })),
    }
}

struct Reader<'a> {
    src: &'a mut dyn Source,
    kinds: &'a [KindInfo],
    profiles: &'a [String],
    out: Loaded,
    stack: Vec<String>,
}

impl Reader<'_> {
    fn file(&mut self, reference: &str, from: Option<&str>) -> Result<(), String> {
        let (text, name) = self.src.load(reference, from)?;
        if self.stack.contains(&name) {
            return Err(format!("{name} includes itself (through {})", self.stack.join(" → ")));
        }
        if self.stack.len() >= 16 {
            return Err(format!("{name}: includes nest more than 16 deep"));
        }
        self.out.sources.push(name.clone());
        self.stack.push(name.clone());
        for (i, doc) in documents(&text, format_of(&name)).map_err(|e| format!("{name}: {e}"))?.into_iter().enumerate() {
            let at = if i == 0 { name.clone() } else { format!("{name} (document {})", i + 1) };
            self.document(doc, &at, &name)?;
        }
        self.stack.pop();
        Ok(())
    }

    fn document(&mut self, doc: Value, at: &str, file: &str) -> Result<(), String> {
        let Value::Object(mut m) = doc else { return Err(format!("{at}: a formula is a map (wisp: 1, then its sections)")) };
        match m.get("wisp").and_then(Value::as_u64) {
            Some(v) if v == u64::from(FORMAT) => {}
            Some(v) => return Err(format!("{at}: wisp: {v} is newer than this wisp reads (wisp: {FORMAT}); update wisp")),
            None => return Err(format!("{at}: not a wisp formula: it starts with `wisp: {FORMAT}`")),
        }
        let includes: Vec<String> = match m.remove("include") {
            Some(Value::String(s)) => vec![s],
            Some(Value::Array(a)) => a.into_iter().filter_map(|x| x.as_str().map(str::to_owned)).collect(),
            _ => Vec::new(),
        };
        for inc in includes {
            self.file(&inc, Some(file))?;
        }
        let profiles = m.remove("profiles");
        self.sections(&m, at)?;
        if let Some(Value::Object(p)) = profiles {
            for want in self.profiles {
                if let Some(Value::Object(part)) = p.get(want) {
                    self.sections(part, &format!("{at} profiles.{want}"))?;
                }
            }
        }
        Ok(())
    }

    fn sections(&mut self, m: &Map<String, Value>, at: &str) -> Result<(), String> {
        for (section, v) in m.iter().filter(|(k, _)| !META.contains(&k.as_str())) {
            let Some(kind) = self.kinds.iter().find(|k| k.named(section)) else {
                let known: Vec<&str> = self.kinds.iter().map(|k| k.section.as_str()).collect();
                return Err(format!("{at}: no plugin in this wisp owns `{section}:` (sections: {})", known.join(", ")));
            };
            for (name, spec) in items(kind, v, &format!("{at} {section}"))? {
                self.add(Resource::new(kind.kind.clone(), name, spec));
            }
        }
        Ok(())
    }

    /// A resource; one already declared with the same kind and name is patched by it.
    fn add(&mut self, r: Resource) {
        if let Some(had) = self.out.resources.iter_mut().find(|x| x.kind == r.kind && x.name == r.name) {
            had.spec = merge(&had.spec, &r.spec);
        } else {
            self.out.resources.push(r);
        }
    }
}

/// Reads the formula at `root` and what it includes, with `profiles` picked.
pub fn load(root: &str, src: &mut dyn Source, kinds: &[KindInfo], profiles: &[String]) -> Result<Loaded, String> {
    let mut r = Reader { src, kinds, profiles, out: Loaded::default(), stack: Vec::new() };
    r.file(root, None)?;
    let mut out = r.out;
    let mut missing = BTreeSet::new();
    for res in &mut out.resources {
        fill_env(&mut res.spec, &*r.src, &mut missing);
    }
    if !missing.is_empty() {
        return Err(format!("unset environment variables: {}", missing.into_iter().collect::<Vec<_>>().join(", ")));
    }
    let mut secrets = BTreeSet::new();
    for res in &out.resources {
        secrets_in(&res.spec, &mut secrets);
    }
    out.secrets = secrets.into_iter().collect();
    Ok(out)
}

/// A formula pasted as text (the app's Import, ADR-0034): read like a file, but `include:` can't be followed
/// (there's nowhere to read it from) and `${env:…}` has no environment to fill from.
pub fn read_text(text: &str, format: Format, kinds: &[KindInfo]) -> Result<Loaded, String> {
    struct Pasted<'a>(&'a str);
    impl Source for Pasted<'_> {
        fn load(&mut self, reference: &str, from: Option<&str>) -> Result<(String, String), String> {
            match from {
                None => Ok((self.0.to_owned(), reference.to_owned())),
                Some(_) => Err(format!("it includes {reference}, which pasted text can't reach: import the file or its URL instead")),
            }
        }
        fn env(&self, _name: &str) -> Option<String> {
            None
        }
    }
    let root = match format {
        Format::Json => "pasted.json",
        Format::Toml => "pasted.toml",
        Format::Yaml => "pasted.yml",
    };
    load(root, &mut Pasted(text), kinds, &[])
}

/// A formula from somewhere else: a URL or a gist anywhere in its includes.
pub fn foreign(sources: &[String]) -> bool {
    sources.iter().any(|s| s.starts_with("http://") || s.starts_with("https://") || s.starts_with("gist:"))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use std::collections::BTreeMap;

    use serde_json::json;

    use super::*;

    struct Files(BTreeMap<String, String>, BTreeMap<String, String>);
    impl Source for Files {
        fn load(&mut self, reference: &str, _: Option<&str>) -> Result<(String, String), String> {
            self.0.get(reference).cloned().map(|t| (t, reference.to_owned())).ok_or_else(|| format!("{reference}: no such file"))
        }
        fn env(&self, name: &str) -> Option<String> {
            self.1.get(name).cloned()
        }
    }

    fn kinds() -> Vec<KindInfo> {
        vec![KindInfo::new("crew", "crew", "wisp.crew", json!({})), KindInfo::new("agent", "agents", "wisp.runtime", json!({})), KindInfo::new("setting", "settings", "wisp.settings", json!({})).map_form()]
    }

    fn files(list: &[(&str, &str)]) -> Files {
        Files(list.iter().map(|(a, b)| ((*a).to_owned(), (*b).to_owned())).collect(), [("HOME_DIR".to_owned(), "/home/me".to_owned())].into())
    }

    #[test]
    fn sections_includes_profiles_env_and_secrets() {
        let mut f = files(&[
            ("wisp.yml", "wisp: 1\ninclude: [base.yml]\nagents:\n  - name: reviewer\n    harness: codex\n    model: gpt-5\ncrew:\n  Ada: { role: reviewer, cwd: \"${env:HOME_DIR}/api\" }\nsettings:\n  worktrees.max: 4\nprofiles:\n  work:\n    agents:\n      - name: reviewer\n        model: gpt-5-pro\n"),
            ("base.yml", "wisp: 1\nagents:\n  - name: reviewer\n    effort: high\n    connectors: [\"${secret:LINEAR}\"]\n"),
        ]);
        let got = load("wisp.yml", &mut f, &kinds(), &["work".into()]).unwrap();
        assert_eq!(got.sources, ["wisp.yml", "base.yml"]);
        assert_eq!(got.secrets, ["LINEAR"]);
        let rev = got.resources.iter().find(|r| r.name == "reviewer").unwrap();
        assert_eq!(rev.spec, json!({ "harness": "codex", "model": "gpt-5-pro", "effort": "high", "connectors": ["${secret:LINEAR}"] }));
        let ada = got.resources.iter().find(|r| r.name == "Ada").unwrap();
        assert_eq!(ada.spec["cwd"], "/home/me/api");
        assert!(got.resources.iter().any(|r| r.kind == "setting" && r.name == "worktrees.max" && r.spec == json!(4)));
    }

    #[test]
    fn json_toml_and_several_yaml_documents_read_the_same() {
        let yaml = "wisp: 1\ncrew:\n  - name: Ada\n    role: lead\n---\nwisp: 1\ncrew:\n  - name: Bo\n";
        let json_ = "{\"wisp\": 1, \"crew\": [{\"name\": \"Ada\", \"role\": \"lead\"}, {\"name\": \"Bo\"}]}";
        let toml_ = "wisp = 1\n[[crew]]\nname = \"Ada\"\nrole = \"lead\"\n[[crew]]\nname = \"Bo\"\n";
        let read = |name: &str, text: &str| load(name, &mut files(&[(name, text)]), &kinds(), &[]).unwrap().resources;
        let a = read("a.yml", yaml);
        assert_eq!(a, read("a.json", json_));
        assert_eq!(a, read("a.toml", toml_));
        assert_eq!(a.len(), 2);
    }

    #[test]
    fn what_it_refuses() {
        let err = |text: &str| load("x.yml", &mut files(&[("x.yml", text)]), &kinds(), &[]).unwrap_err();
        assert!(err("crew: []").contains("starts with `wisp: 1`"));
        assert!(err("wisp: 2\n").contains("newer"));
        assert!(err("wisp: 1\nspells: []\n").contains("no plugin in this wisp owns `spells:`"));
        assert!(err("wisp: 1\ncrew:\n  - role: x\n").contains("needs a name"));
        assert!(err("wisp: 1\ncrew: { Ada: { cwd: \"${env:NOPE}\" } }\n").contains("NOPE"));
        assert!(err("wisp: 1\ninclude: x.yml\n").contains("includes itself"));
        assert!(foreign(&["wisp.yml".into(), "https://x.dev/team.yml".into()]));
        assert!(!foreign(&["wisp.yml".into()]));
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod read_text_tests {
    use super::*;

    #[test]
    fn a_pasted_formula_reads_as_its_resources_and_refuses_an_include() {
        let kinds = vec![KindInfo::new("crew", "crew", "wisp.crew", serde_json::json!({})).map_form()];
        let got = read_text("wisp: 1\ncrew:\n  ada:\n    role: reviews PRs\n    brief: ${secret:linear}\n", Format::Yaml, &kinds).unwrap();
        assert_eq!(got.resources.iter().map(|r| (r.kind.as_str(), r.name.as_str())).collect::<Vec<_>>(), [("crew", "ada")]);
        assert_eq!(got.secrets, ["linear"]);
        let e = read_text("wisp: 1\ninclude: base.yml\n", Format::Yaml, &kinds).unwrap_err();
        assert!(e.contains("pasted text can't reach"), "{e}");
        assert!(read_text("not: a formula", Format::Yaml, &kinds).unwrap_err().contains("not a wisp formula"));
        assert_eq!(read_text("{\"wisp\": 1}", Format::Json, &kinds).unwrap().resources.len(), 0);
    }
}
