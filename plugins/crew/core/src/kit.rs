//! A member's kit (v1 crew.js `normalizeKit`, `offerFiles`, `kitNote`; web/js/skill-md.js): instructions
//! files it follows on every job and skills it reads when a job fits one. Files stay files: the host
//! writes each skill's SKILL.md ([`skill_md`]) through its file port; this module works on strings.

use std::collections::BTreeMap;

use serde_json::Value;
use wisp_crew_api::{KIT_BODY_MAX, KIT_MAX, KIT_TOTAL_MAX, KitFile, Member, OFFER_FILES, OfferFile};

use crate::error::{Result, bad};
use crate::text::{clip, squash, str_of, thousands, truncate, unix};

/// New ids, injected: the core draws no randomness.
pub trait Ids {
    fn next_id(&mut self) -> String;
}

/// A kit id the client sent may stay (v1 `ID`, crew.js:57).
pub fn is_id(s: &str) -> bool {
    (6..=40).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

/// v1 `SKILL_NAME`: up to 64 lowercase letters, digits and dashes, not starting with a dash.
pub fn is_skill_name(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty() && b.len() <= 64 && b[0] != b'-' && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// v1 `RULES_NAME`: up to 60 letters, digits, spaces, dots, underscores or dashes, starting with a word character.
pub fn is_rules_name(s: &str) -> bool {
    let w = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let mut it = s.chars();
    it.next().is_some_and(w) && s.chars().count() <= 60 && it.all(|c| w(c) || c == ' ' || c == '.' || c == '-')
}

/// "Release Notes" → "release-notes", as SKILL.md names are written.
pub fn skill_name(s: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for c in s.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if dash && !out.is_empty() {
                out.push('-');
            }
            dash = false;
            out.push(c);
        } else {
            dash = true;
        }
    }
    clip(&out, 64)
}

/// A file found on this computer as kit text (v1 `/crew-kit` read each file): a skill's SKILL.md without its front
/// matter, an instructions file trimmed; both clipped to [`KIT_BODY_MAX`] characters so the kit takes it.
pub fn local_body(text: &str, skill: bool) -> String {
    let body = if skill { parse_skill_md(&unix(text)).body } else { unix(text).trim().to_owned() };
    clip(&body, KIT_BODY_MAX)
}

/// A SKILL.md's text: its front matter (plain `key: value` lines, folded `>` / `|` values too) and the rest.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SkillMd {
    pub name: String,
    pub description: String,
    pub body: String,
}

fn meta_key(line: &str) -> Option<(&str, &str)> {
    let (k, v) = line.split_once(':')?;
    let mut ks = k.chars();
    let ok = ks.next().is_some_and(|c| c.is_ascii_alphabetic()) && ks.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    ok.then_some((k, v))
}

fn unquote(v: &str) -> &str {
    for q in ['"', '\''] {
        if v.len() >= 2 && v.starts_with(q) && v.ends_with(q) {
            return &v[1..v.len() - 1];
        }
    }
    v
}

/// v1 `parseSkillMd`: no front matter, all of it is the body.
pub fn parse_skill_md(text: &str) -> SkillMd {
    let src = unix(text);
    let src = src.trim_start_matches('\u{feff}');
    let Some(after) = src.strip_prefix("---\n") else { return SkillMd { body: src.trim().to_owned(), ..SkillMd::default() } };
    let Some(close) = after.find("\n---") else { return SkillMd { body: src.trim().to_owned(), ..SkillMd::default() } };
    let fm = &after[..close];
    let rest = &after[close + 4..];
    let body = rest.strip_prefix('\n').unwrap_or(rest);
    let mut meta = BTreeMap::new();
    let lines: Vec<&str> = fm.split('\n').collect();
    let mut i = 0;
    while i < lines.len() {
        if let Some((k, v)) = meta_key(lines[i]) {
            let mut v = v.trim().to_owned();
            if matches!(v.as_str(), ">" | "|" | ">-" | "|-" | ">+" | "|+") {
                let mut more = Vec::new();
                while i + 1 < lines.len()
                    && (lines[i + 1].is_empty() || lines[i + 1].starts_with(char::is_whitespace))
                    && meta_key(lines[i + 1]).is_none()
                {
                    i += 1;
                    more.push(lines[i].trim());
                }
                more.join(if v.starts_with('|') { "\n" } else { " " }).trim().clone_into(&mut v);
            }
            meta.insert(k.to_lowercase(), unquote(&v).to_owned());
        }
        i += 1;
    }
    SkillMd {
        name: meta.remove("name").unwrap_or_default(),
        description: meta.remove("description").unwrap_or_default(),
        body: body.trim().to_owned(),
    }
}

/// The SKILL.md a skill in a kit is written out as.
pub fn skill_md(name: &str, description: &str, body: &str) -> String {
    let d = serde_json::to_string(&squash(description)).unwrap_or_default();
    format!("---\nname: {name}\ndescription: {d}\n---\n\n{body}\n")
}

fn kind_of(v: &Value) -> Option<&'static str> {
    match v.get("kind").and_then(Value::as_str) {
        Some("skill") => Some("skill"),
        Some("rules") => Some("rules"),
        _ => None,
    }
}

/// One kit file, checked (the name, a skill's description, the body and its size).
fn kit_file(x: &Value, out: &[KitFile], exists: &dyn Fn(&str) -> bool, ids: &mut dyn Ids) -> Result<KitFile> {
    if !x.is_object() {
        return Err(bad("Each kit file needs a kind, a name and a body."));
    }
    let kind = kind_of(x).ok_or_else(|| bad("A kit file is a skill or an instructions file (kind: skill or rules)."))?;
    let name = str_of(x.get("name")).trim().to_owned();
    if kind == "skill" && !is_skill_name(&name) {
        let not = if name.is_empty() { String::new() } else { format!(", not \"{}\"", truncate(&name, 40)) };
        return Err(bad(format!("A skill’s name is up to 64 lowercase letters, digits and dashes{not}.")));
    }
    if kind == "rules" && !is_rules_name(&name) {
        return Err(bad("An instructions file’s name is up to 60 letters, digits, spaces, dots or dashes, like AGENTS.md."));
    }
    if out.iter().any(|y| y.kind == kind && y.name.to_lowercase() == name.to_lowercase()) {
        return Err(bad(format!("There are two {} named {name}.", if kind == "skill" { "skills" } else { "instructions files" })));
    }
    let description = clip(&squash(&str_of(x.get("description"))), 1024);
    if kind == "skill" && description.is_empty() {
        return Err(bad(format!("Say when {name} should be used: that’s how they know to read it.")));
    }
    let body = unix(&str_of(x.get("body"))).trim().to_owned();
    if body.is_empty() {
        return Err(bad(format!("{name} is empty.")));
    }
    let n = body.chars().count();
    if n > KIT_BODY_MAX {
        return Err(bad(format!("{name} is too long ({} characters; at most {}).", thousands(n), thousands(KIT_BODY_MAX))));
    }
    let path = x
        .get("path")
        .and_then(Value::as_str)
        .filter(|p| kind == "skill" && p.starts_with('/') && p.len() < 500 && exists(p))
        .map(str::to_owned);
    let id = x.get("id").and_then(Value::as_str).filter(|s| is_id(s)).map_or_else(|| ids.next_id(), str::to_owned);
    let on = x.get("on") != Some(&Value::Bool(false));
    Ok(KitFile { id, kind: kind.to_owned(), name, description: (kind == "skill").then_some(description), body, path, on })
}

/// A list of kit files, checked (v1 crew.js:143-167). `exists`: a skill's folder on this computer.
pub fn normalize_kit(list: &Value, exists: &dyn Fn(&str) -> bool, ids: &mut dyn Ids) -> Result<Vec<KitFile>> {
    let Some(list) = list.as_array() else { return Err(bad("kit must be a list of files.")) };
    if list.len() > KIT_MAX {
        return Err(bad(format!("At most {KIT_MAX} skills and instructions files per member.")));
    }
    let mut out: Vec<KitFile> = Vec::new();
    let mut total = 0;
    for x in list {
        let k = kit_file(x, &out, exists, ids)?;
        total += k.body.chars().count();
        if total > KIT_TOTAL_MAX {
            return Err(bad(format!(
                "Their skills and instructions add up to more than {} characters. Trim or remove some.",
                thousands(KIT_TOTAL_MAX)
            )));
        }
        out.push(k);
    }
    Ok(out)
}

/// A proposed file as a kit file would read it: the kind (`instructions` is rules), a fit name.
fn proposed(x: &Value) -> Value {
    let kind = match x.get("kind").and_then(Value::as_str) {
        Some("rules" | "instructions") => "rules",
        _ => "skill",
    };
    let raw = x.get("name").and_then(Value::as_str);
    let name = if kind == "skill" {
        skill_name(raw.unwrap_or(""))
    } else {
        raw.unwrap_or("AGENTS.md")
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | ' ' | '.' | '-'))
            .collect::<String>()
            .trim()
            .to_owned()
    };
    serde_json::json!({ "kind": kind, "name": name, "description": clip(&str_of(x.get("description")), 1024), "body": clip(&str_of(x.get("body")), KIT_BODY_MAX) })
}

fn offer_of(k: KitFile) -> OfferFile {
    OfferFile { kind: k.kind, name: k.name, description: k.description, body: k.body }
}

/// No ids are kept on an offer: any will do while checking.
struct Scratch;
impl Ids for Scratch {
    fn next_id(&mut self) -> String {
        String::from("scratch0")
    }
}

/// One proposed file checked like a kit file, or why it can't be one.
pub fn offer_file(x: &Value) -> Result<OfferFile> {
    let p = proposed(x);
    normalize_kit(&Value::Array(vec![p]), &|_| false, &mut Scratch).map(|mut v| offer_of(v.remove(0)))
}

/// The files a job proposed that would pass as kit files, each on its own (v1 crew.js:171-181).
pub fn offer_files(list: &[Value]) -> Vec<OfferFile> {
    let mut out: Vec<OfferFile> = Vec::new();
    for x in list.iter().take(OFFER_FILES) {
        if let Ok(f) = offer_file(x)
            && !out.iter().any(|y| y.kind == f.kind && y.name.to_lowercase() == f.name.to_lowercase())
        {
            out.push(f);
        }
    }
    out
}

/// What a job's note says about the kit (v1 `kitNote`). `files`: skill name → its SKILL.md here; without
/// them (a job on another machine) the skills are written out in full.
#[allow(clippy::format_push_string)] // a prompt built once per job, not a hot path
pub fn kit_note(m: &Member, files: Option<&BTreeMap<String, String>>) -> String {
    let on: Vec<&KitFile> = m.kit.iter().filter(|k| k.on).collect();
    let rules: Vec<&&KitFile> = on.iter().filter(|k| k.kind == "rules").collect();
    let skills: Vec<&&KitFile> = on.iter().filter(|k| k.kind == "skill").collect();
    let mut out = String::new();
    if !rules.is_empty() {
        let each: Vec<String> = rules.iter().map(|r| format!("#### {}\n\n{}", r.name, r.body)).collect();
        out += &format!(
            "\n### Your instructions (from the user)\n\nFollow these on every job, as you would an AGENTS.md. Where they differ from the project's own, these win for your work.\n\n{}\n",
            each.join("\n\n")
        );
    }
    if skills.is_empty() {
        return out;
    }
    let read = if files.is_some() { " Read its SKILL.md (with your file-reading tool) before you start on that part." } else { "" };
    out += &format!(
        "\n### Your skills\n\nA skill is the user's how-to for one kind of work. When a job fits a skill's description, follow that skill.{read}\n\n"
    );
    let desc = |k: &KitFile| k.description.clone().unwrap_or_default();
    if let Some(files) = files {
        let lines: Vec<String> = skills
            .iter()
            .map(|k| {
                let file = files.get(&k.name).map_or("", String::as_str);
                let dir = k.path.as_ref().map_or(String::new(), |p| format!(" (its other files are in `{p}`)"));
                format!("- **{}**: {} `{file}`{dir}", k.name, desc(k))
            })
            .collect();
        out += &(lines.join("\n") + "\n");
    } else {
        let parts: Vec<String> = skills.iter().map(|k| format!("#### Skill: {}\n\nWhen: {}\n\n{}", k.name, desc(k), k.body)).collect();
        out += &(parts.join("\n\n") + "\n");
    }
    out
}
