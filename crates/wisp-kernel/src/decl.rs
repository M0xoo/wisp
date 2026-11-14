//! A command's argument type, from the TypeScript declaration ts-rs writes for it (`CommandInfo.args`:
//! its doc comment, then the inline type). Every frontend generated from the catalogue reads it (the CLI's
//! flags, the MCP tools' input schemas; moved here from wisp-cli-core, 2026-11-09). The shape: an object's fields, each with
//! its doc, whether it is optional, and what kind of value a flag takes.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase", tag = "kind", content = "of")]
pub enum Kind {
    Str,
    Num,
    Bool,
    /// `Array<string>`: repeat the flag, or commas
    List,
    /// a string literal union
    Choice(Vec<String>),
    /// anything else (a named type, an object, an array of objects): JSON, or a word as a string
    Json,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Field {
    /// the wire name (`turnId`)
    pub name: String,
    pub doc: String,
    pub optional: bool,
    pub nullable: bool,
    pub kind: Kind,
    /// the type as declared, for `--help`
    pub ty: String,
}

impl Field {
    /// `--turn-id`
    pub fn flag(&self) -> String {
        kebab(&self.name)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArgSpec {
    pub doc: String,
    /// false: not an object (`null` for no arguments, a union): the command takes `--args JSON`
    pub object: bool,
    /// true: the type is `null` (no arguments at all)
    pub none: bool,
    pub fields: Vec<Field>,
}

impl ArgSpec {
    /// The required fields a word on the command line fills, in order (`wisp settings set theme dark`).
    pub fn positionals(&self) -> Vec<&Field> {
        self.fields.iter().filter(|f| !f.optional && f.kind != Kind::Bool).collect()
    }
    pub fn field(&self, flag_or_name: &str) -> Option<&Field> {
        self.fields
            .iter()
            .find(|f| f.name == flag_or_name || f.flag() == flag_or_name || f.name.eq_ignore_ascii_case(&flag_or_name.replace('-', "")))
    }
}

/// `turnId` → `turn-id`, `set_layout` → `set-layout`.
pub fn kebab(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 4);
    for (i, c) in s.chars().enumerate() {
        if c == '_' {
            out.push('-');
        } else if c.is_ascii_uppercase() {
            if i > 0 && !out.ends_with('-') {
                out.push('-');
            }
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

/// The text of a `/** … */` comment, its `*` margins gone.
fn doc_text(c: &str) -> String {
    let inner = c.trim().trim_start_matches("/**").trim_end_matches("*/");
    inner.lines().map(|l| l.trim().trim_start_matches('*').trim()).filter(|l| !l.is_empty()).collect::<Vec<_>>().join(" ")
}

/// Splits leading `/** … */` comments off `s`: (their text, the rest).
fn leading_doc(s: &str) -> (String, &str) {
    let mut rest = s.trim_start();
    let mut docs = Vec::new();
    while rest.starts_with("/*") {
        let Some(end) = rest.find("*/") else { break };
        docs.push(doc_text(&rest[..end + 2]));
        rest = rest[end + 2..].trim_start();
    }
    (docs.join(" "), rest)
}

/// The top-level pieces of `s` split at `sep`, outside brackets, strings and comments.
fn split_top(s: &str, sep: char) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut depth = 0i32;
    let mut quote: Option<char> = None;
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if let Some(q) = quote {
            cur.push(c);
            if c == '\\' {
                if let Some(n) = it.next() {
                    cur.push(n);
                }
            } else if c == q {
                quote = None;
            }
            continue;
        }
        if c == '/' && it.peek() == Some(&'*') {
            cur.push(c);
            while let Some(d) = it.next() {
                cur.push(d);
                if d == '*' && it.peek() == Some(&'/') {
                    cur.push('/');
                    it.next();
                    break;
                }
            }
            continue;
        }
        match c {
            '"' | '\'' | '`' => quote = Some(c),
            '{' | '<' | '(' | '[' => depth += 1,
            '}' | '>' | ')' | ']' => depth -= 1,
            _ => {}
        }
        if c == sep && depth == 0 {
            out.push(std::mem::take(&mut cur));
        } else {
            cur.push(c);
        }
    }
    if !cur.trim().is_empty() {
        out.push(cur);
    }
    out
}

fn kind_of(ty: &str) -> (Kind, bool) {
    let parts: Vec<String> = split_top(ty, '|').into_iter().map(|p| p.trim().to_owned()).filter(|p| !p.is_empty()).collect();
    let nullable = parts.iter().any(|p| p == "null");
    let rest: Vec<&str> = parts.iter().map(String::as_str).filter(|p| *p != "null").collect();
    let kind = match rest.as_slice() {
        ["string"] => Kind::Str,
        ["number" | "bigint"] => Kind::Num,
        ["boolean"] => Kind::Bool,
        ["Array<string>"] => Kind::List,
        // ts-rs names id newtypes `SessionId`, `TurnId`: strings on the wire
        [one] if one.ends_with("Id") && one.chars().next().is_some_and(|c| c.is_ascii_uppercase()) => Kind::Str,
        many if !many.is_empty() && many.iter().all(|p| p.len() >= 2 && p.starts_with('"') && p.ends_with('"')) => {
            Kind::Choice(many.iter().map(|p| p[1..p.len() - 1].to_owned()).collect())
        }
        _ => Kind::Json,
    };
    (kind, nullable)
}

/// Reads a field `name?: type` (its doc comment already split off).
fn field(doc: String, text: &str) -> Option<Field> {
    let colon = split_top(text, ':');
    let (head, ty) = match colon.as_slice() {
        [h, rest @ ..] if !rest.is_empty() => (h.trim(), rest.join(":").trim().to_owned()),
        _ => return None,
    };
    let optional = head.ends_with('?');
    let name = head.trim_end_matches('?').trim().trim_matches('"').to_owned();
    if name.is_empty() || name.starts_with('[') {
        return None;
    }
    let (kind, nullable) = kind_of(&ty);
    Some(Field { name, doc, optional, nullable, kind, ty })
}

/// The argument type of a command, or an empty spec (`--args JSON`) for no declaration.
pub fn parse(decl: Option<&str>) -> ArgSpec {
    let Some(decl) = decl else { return ArgSpec::default() };
    let (doc, body) = leading_doc(decl);
    let body = body.trim().trim_end_matches(';').trim();
    if body == "null" {
        return ArgSpec { doc, object: true, none: true, fields: Vec::new() };
    }
    // `{ … } & ({ … } | { … })`: the object part's fields; the rest goes in --args
    let first = split_top(body, '&').into_iter().next().unwrap_or_default();
    let first = first.trim();
    let (Some(inner), true) =
        (first.strip_prefix('{').and_then(|s| s.strip_suffix('}')), split_top(body, '|').len() == 1 || split_top(body, '&').len() > 1)
    else {
        return ArgSpec { doc, ..ArgSpec::default() };
    };
    let fields = split_top(inner, ',')
        .into_iter()
        .filter_map(|piece| {
            let (d, rest) = leading_doc(&piece);
            field(d, rest.trim())
        })
        .collect();
    ArgSpec { doc, object: true, none: false, fields }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_ts_rs_declaration_with_its_docs() {
        let d = "/**\n * `POST /crew/:id/jobs`. A job.\n */\n{ id: string, prompt: string, \n/**\n * a cron, or words (\"every 30 minutes\")\n */\ncron?: string, wakeAt?: number | null, on?: Array<string>, mode?: \"plan\" | \"edits\" | \"auto\", kit?: Array<unknown>, parentId?: SessionId, ext?: { [key in string]: JsonValue }, }";
        let a = parse(Some(d));
        assert!(a.object && a.doc.contains("A job."));
        let names: Vec<&str> = a.fields.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["id", "prompt", "cron", "wakeAt", "on", "mode", "kit", "parentId", "ext"]);
        let f = |n: &str| a.field(n).unwrap();
        assert_eq!(f("cron").doc, "a cron, or words (\"every 30 minutes\")");
        assert_eq!((f("wakeAt").kind.clone(), f("wakeAt").nullable, f("wakeAt").flag()), (Kind::Num, true, "wake-at".to_owned()));
        assert_eq!(f("on").kind, Kind::List);
        assert_eq!(f("mode").kind, Kind::Choice(vec!["plan".into(), "edits".into(), "auto".into()]));
        assert_eq!(f("kit").kind, Kind::Json);
        assert_eq!(f("parent-id").kind, Kind::Str);
        assert_eq!(a.positionals().iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), ["id", "prompt"]);
    }

    #[test]
    fn no_declaration_null_and_unions() {
        assert!(!parse(None).object);
        assert!(parse(Some("null")).none);
        assert!(!parse(Some("{ \"kind\": \"a\" } | { \"kind\": \"b\" }")).object);
        let mixed = parse(Some("{ seq: bigint, } & ({ \"kind\": \"text\", text: string, })"));
        assert_eq!(mixed.fields.len(), 1);
    }
}
