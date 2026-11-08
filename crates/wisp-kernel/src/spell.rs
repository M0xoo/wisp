//! `convert_spell` (plan §6.0.1): a v1 `wispSpell: 1` file as a `wispPlugin: 1` manifest, so the spells
//! people already have load as plugins. v1's reader is server/spells.js (normalizeSpell); its slot and
//! part names are web/js/spell-schema.js. Everything a spell held maps to a field; what the shell must
//! still apply (actions, data sources, hooks) goes to the shell's and runtime's list points.
use serde_json::{Map, Value, json};

use crate::manifest::{Manifest, ManifestError};
use crate::semver;

/// A converted spell: the manifest, and what was left out or changed (shown to the user on import).
#[derive(Debug, Clone)]
pub struct Converted {
    pub manifest: Manifest,
    pub warnings: Vec<String>,
}

const KNOWN: &[&str] = &[
    "wispSpell",
    "id",
    "name",
    "version",
    "description",
    "author",
    "wisp",
    "harnesses",
    "when",
    "data",
    "buttons",
    "chips",
    "panels",
    "blocks",
    "parts",
    "ui",
    "prompt",
    "settings",
    "slash",
    "commands",
    "hooks",
    "recipes",
    "crew",
    "script",
];

/// The plugin id a spell becomes: spells were the user's own, so they live under `user.`.
pub fn spell_plugin_id(spell_id: &str) -> String {
    format!("user.{spell_id}")
}

fn spell_id_ok(s: &str) -> bool {
    (1..=41).contains(&s.len())
        && s.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// A v1 slot ('composer.bar', 'float') as an extension-tree input (`shell.composer`, `bar`).
pub fn slot_input(slot: &str) -> (String, String) {
    match slot.rsplit_once('.') {
        None => ("shell".into(), slot.into()),
        Some((parent, input)) => (format!("shell.{parent}"), input.into()),
    }
}

fn list(v: Option<&Value>) -> &[Value] {
    v.and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

fn s(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// The spell's `harnesses` and `when` as one extension `if` expression.
fn condition(j: &Map<String, Value>) -> Option<String> {
    let mut parts = Vec::new();
    let hs: Vec<String> = list(j.get("harnesses"))
        .iter()
        .filter_map(Value::as_str)
        .filter(|h| *h != "*")
        .map(|h| format!("'{h}'"))
        .collect();
    if !hs.is_empty() {
        parts.push(format!("session.harness in [{}]", hs.join(", ")));
    }
    if let Some(w) = j.get("when").and_then(Value::as_object) {
        parts.extend(w.iter().map(|(k, v)| format!("session.{k} == {v}")));
    }
    (!parts.is_empty()).then(|| parts.join(" && "))
}

fn panel_input(x: &Map<String, Value>) -> (String, String) {
    match s(x.get("as")) {
        Some("card") => slot_input(s(x.get("slot")).unwrap_or("card.bottom")),
        Some("feed") => ("shell.home".into(), "feed".into()),
        Some("dialog") => ("shell".into(), "dialogs".into()),
        _ => ("shell".into(), "panes".into()),
    }
}

fn extension(
    prefix: &str,
    kind: &str,
    x: &Map<String, Value>,
    i: usize,
    when: Option<&String>,
) -> Value {
    let (id, input) = if kind == "Panel" {
        panel_input(x)
    } else {
        slot_input(s(x.get("slot")).unwrap_or(if kind == "Chip" {
            "composer.chips"
        } else {
            "topbar"
        }))
    };
    let mut kit = Map::new();
    kit.insert("c".into(), Value::from(kind));
    for (k, v) in x {
        if k != "id" && k != "slot" {
            kit.insert(k.clone(), v.clone());
        }
    }
    let ext_id = s(x.get("id")).map_or_else(
        || format!("{prefix}.{}{i}", kind.to_lowercase()),
        |id| format!("{prefix}.{id}"),
    );
    let mut e = json!({ "id": ext_id, "attachTo": { "id": id, "input": input }, "kit": kit });
    if let Some(w) = when {
        e["if"] = Value::from(w.clone());
    }
    e
}

/// A v1 data source as the read permission it needs.
fn data_permission(src: &Value) -> Option<String> {
    if let Some(w) = s(src.get("wisp")) {
        return Some(format!("topic:read{{path:{w}}}"));
    }
    let gh: Vec<&str> = src
        .get("gh")?
        .as_array()?
        .iter()
        .filter_map(Value::as_str)
        .take(2)
        .collect();
    Some(format!("gh:read{{cmd:{}}}", gh.join(" ")))
}

fn styles(j: &Map<String, Value>) -> (Map<String, Value>, Map<String, Value>) {
    let (mut part_styles, mut props) = (Map::new(), Map::new());
    let hide = |styles: &mut Map<String, Value>, part: &str| {
        let e = styles.entry(part.to_owned()).or_insert_with(|| json!({}));
        e["display"] = Value::from("none");
    };
    for (part, v) in j
        .get("parts")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
    {
        let Some(v) = v.as_object() else { continue };
        if let Some(st) = v.get("style").and_then(Value::as_object) {
            let m: Map<String, Value> = st
                .iter()
                .map(|(k, x)| {
                    (
                        k.clone(),
                        Value::from(x.as_str().map_or_else(|| x.to_string(), str::to_owned)),
                    )
                })
                .collect();
            part_styles.insert(part.clone(), Value::Object(m));
        }
        if v.get("hide") == Some(&Value::Bool(true)) {
            hide(&mut part_styles, part);
        }
        let rest: Map<String, Value> = v
            .iter()
            .filter(|(k, _)| *k != "style" && *k != "hide")
            .map(|(k, x)| (k.clone(), x.clone()))
            .collect();
        if !rest.is_empty() {
            props.insert(part.clone(), Value::Object(rest));
        }
    }
    for part in list(j.get("ui").and_then(|u| u.get("hide")))
        .iter()
        .filter_map(Value::as_str)
    {
        hide(&mut part_styles, part);
    }
    (part_styles, props)
}

/// Point contributions that only the shell or the runtime can apply.
fn points(j: &Map<String, Value>, prefix: &str, out: &mut Map<String, Value>) {
    let mut put = |k: &str, v: Value| {
        if !v.is_null() && v.as_array().is_none_or(|a| !a.is_empty()) {
            out.insert(k.to_owned(), v);
        }
    };
    let ui = j.get("ui").and_then(Value::as_object);
    let (tokens, dark) = (
        ui.and_then(|u| u.get("tokens")).filter(|v| v.is_object()),
        ui.and_then(|u| u.get("dark")).filter(|v| v.is_object()),
    );
    if tokens.is_some() || dark.is_some() {
        let mut t = Map::new();
        if let Some(v) = tokens {
            t.insert("tokens".into(), v.clone());
        }
        if let Some(v) = dark {
            t.insert("dark".into(), v.clone());
        }
        put("shell.tokens", json!([t]));
    }
    if let Some(d) = j.get("data").and_then(Value::as_object) {
        let rows = d.iter().map(|(name, src)| {
            let mut m = Map::new();
            m.insert("name".into(), Value::from(name.clone()));
            src.as_object()
                .into_iter()
                .flatten()
                .for_each(|(k, v)| drop(m.insert(k.clone(), v.clone())));
            Value::Object(m)
        });
        put("shell.data", Value::Array(rows.collect()));
    }
    let actions = list(j.get("commands"))
        .iter()
        .filter_map(Value::as_object)
        .enumerate()
        .map(|(i, c)| {
            let mut m = Map::new();
            m.insert(
                "command".into(),
                Value::from(format!(
                    "{prefix}.{}",
                    s(c.get("id")).map_or_else(|| format!("k{i}"), str::to_owned)
                )),
            );
            c.iter()
                .for_each(|(k, v)| drop(m.insert(k.clone(), v.clone())));
            Value::Object(m)
        });
    put("shell.actions", Value::Array(actions.collect()));
    put(
        "shell.slash",
        j.get("slash").cloned().unwrap_or(Value::Null),
    );
    put(
        "runtime.hooks",
        j.get("hooks").cloned().unwrap_or(Value::Null),
    );
    put(
        "runtime.prompt",
        match j.get("prompt") {
            Some(Value::String(t)) => json!([{ "text": t }]),
            other => other.cloned().unwrap_or(Value::Null),
        },
    );
    put(
        "crew.members",
        j.get("crew").cloned().unwrap_or(Value::Null),
    );
    if let Some(script) = s(j.get("script")) {
        put("shell.sandbox", json!([{ "script": script }]));
    }
    put(
        "shell.blocks",
        Value::Array(
            list(j.get("blocks"))
                .iter()
                .filter(|b| b.is_object())
                .cloned()
                .collect(),
        ),
    );
}

fn err(path: &str, message: &str) -> Vec<ManifestError> {
    vec![ManifestError {
        path: path.into(),
        message: message.into(),
    }]
}

/// Everything a spell contributes, as the manifest's `contributes`.
fn contributions(j: &Map<String, Value>, sid: &str) -> Map<String, Value> {
    let when = condition(j);
    let mut ui: Vec<Value> = Vec::new();
    for (key, kind) in [
        ("buttons", "Button"),
        ("chips", "Chip"),
        ("panels", "Panel"),
    ] {
        ui.extend(
            list(j.get(key))
                .iter()
                .filter_map(Value::as_object)
                .enumerate()
                .map(|(i, b)| extension(sid, kind, b, i, when.as_ref())),
        );
    }
    let (part_styles, props) = styles(j);
    let mut c = Map::new();
    points(j, sid, &mut c);
    if !props.is_empty() {
        c.insert("shell.partProps".into(), json!([props]));
    }
    if !ui.is_empty() {
        c.insert("ui".into(), Value::Array(ui));
    }
    if !part_styles.is_empty() {
        c.insert("partStyles".into(), Value::Object(part_styles));
    }
    let commands: Vec<Value> = list(j.get("commands"))
        .iter()
        .filter_map(Value::as_object)
        .enumerate()
        .map(|(i, x)| {
            let id = s(x.get("id")).map_or_else(|| format!("k{i}"), str::to_owned);
            let title = s(x.get("label"))
                .or_else(|| s(x.get("id")))
                .unwrap_or("Untitled");
            json!({ "id": format!("{sid}.{id}"), "title": title })
        })
        .collect();
    if !commands.is_empty() {
        c.insert("commands".into(), Value::Array(commands));
    }
    if !list(j.get("recipes")).is_empty() {
        c.insert(
            "recipes".into(),
            Value::Array(list(j.get("recipes")).to_vec()),
        );
    }
    let blocks: Vec<Value> = list(j.get("blocks"))
        .iter()
        .filter_map(|b| s(b.get("type")))
        .map(|t| json!({ "type": t }))
        .collect();
    if !blocks.is_empty() {
        c.insert("blocks".into(), Value::Array(blocks));
    }
    if let Some(st) = j
        .get("settings")
        .and_then(Value::as_object)
        .filter(|o| !o.is_empty())
    {
        c.insert(
            "setSettings".into(),
            Value::Object(
                st.iter()
                    .map(|(k, v)| (format!("shell.{k}"), v.clone()))
                    .collect(),
            ),
        );
    }
    c
}

/// Converts a v1 spell. Err: the problems (each with its path). The output goes through the same
/// manifest checks as any plugin.
pub fn convert_spell(spell: &Value) -> Result<Converted, Vec<ManifestError>> {
    let Some(j) = spell.as_object() else {
        return Err(err("", "a spell is a JSON object"));
    };
    if j.get("wispSpell") != Some(&Value::from(1)) {
        return Err(err("wispSpell", "must be 1"));
    }
    let sid = j
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned();
    if !spell_id_ok(&sid) {
        return Err(err(
            "id",
            "lowercase letters, digits and dashes, starting with a letter or digit (at most 41)",
        ));
    }
    let mut warnings: Vec<String> = j
        .keys()
        .filter(|k| !KNOWN.contains(&k.as_str()))
        .map(|k| format!("{k}: not something spells knew about, left out"))
        .collect();
    if j.contains_key("wisp") {
        warnings.push(
            "wisp: a minimum wisp version; plugins name the kernel api instead (\"api\": \"^1\")"
                .into(),
        );
    }
    let c = contributions(j, &sid);
    let harnesses: Vec<&str> = list(j.get("harnesses"))
        .iter()
        .filter_map(Value::as_str)
        .filter(|h| *h != "*")
        .collect();
    let mut permissions: Vec<String> = Vec::new();
    for p in j
        .get("data")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(_, src)| data_permission(src))
    {
        if !permissions.contains(&p) {
            permissions.push(p);
        }
    }
    let mut m = json!({
        "wispPlugin": 1,
        "id": spell_plugin_id(&sid),
        "name": s(j.get("name")).unwrap_or(&sid),
        "version": s(j.get("version")).filter(|v| semver::valid_version(v)).unwrap_or("1.0.0"),
        "api": "^1",
        "trust": if s(j.get("script")).is_some() { "untrusted" } else { "declarative" },
    });
    for k in ["description", "author"] {
        if let Some(v) = s(j.get(k)) {
            m[k] = Value::from(v);
        }
    }
    if !harnesses.is_empty() {
        m["requires"] = Value::Object(
            harnesses
                .iter()
                .map(|h| {
                    (
                        format!("wisp.{h}"),
                        json!({ "version": "*", "optional": true }),
                    )
                })
                .collect(),
        );
    }
    if !permissions.is_empty() {
        m["permissions"] = json!(permissions);
    }
    if !c.is_empty() {
        m["contributes"] = Value::Object(c);
    }
    let problems = Manifest::check(&m);
    if !problems.is_empty() {
        return Err(problems);
    }
    let manifest = serde_json::from_value(m).map_err(|e| err("", &e.to_string()))?;
    Ok(Converted { manifest, warnings })
}
