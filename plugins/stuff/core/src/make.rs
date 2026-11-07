//! New records: a file, text from a reply, a link, an app. The host has already put the bytes in the
//! CAS; these decide names, kinds, types, titles and excerpts, and refuse what can't be kept.

use wisp_stuff_api::{DbSpec, StuffFrom, StuffItem, StuffKind};

use crate::Bad;
use crate::kind::{
    EXCERPT, MAX_TEXT, clip, excerpt_of, kind_of, lang_ext, mime_for, safe_name, texty, title_from,
};

/// Who saved it and where from: the same for every kind.
#[derive(Debug, Clone, Default)]
pub struct Origin {
    pub by: Option<String>,
    pub from: Option<StuffFrom>,
    pub source: Option<String>,
}

/// A file whose bytes are in the CAS. `head`: its first bytes as text (read only for docs and code).
#[derive(Debug, Clone, Default)]
pub struct FileIn<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub size: u64,
    pub blob: &'a str,
    pub mime: Option<&'a str>,
    pub lang: Option<&'a str>,
    pub head: Option<&'a str>,
}

/// A file's record.
pub fn file_item(f: &FileIn<'_>, o: &Origin, now: i64) -> StuffItem {
    let kind = kind_of(f.name);
    let excerpt = (matches!(kind, StuffKind::Doc | StuffKind::Code) && texty(f.name))
        .then(|| excerpt_of(f.head.unwrap_or_default(), kind));
    StuffItem {
        id: f.id.to_owned(),
        kind,
        name: f.name.to_owned(),
        title: title_from(f.name),
        mime: Some(mime_for(f.name, f.mime)),
        size: f.size,
        at: now,
        by: Some(o.by.clone().unwrap_or_else(|| "you".into())),
        blob: Some(f.blob.to_owned()),
        source: o.source.clone(),
        lang: f.lang.map(|l| l.chars().take(24).collect()),
        from: o.from.clone(),
        excerpt,
        ..StuffItem::default()
    }
}

/// How many bytes of a file to read for its excerpt (a UTF-8 character is at most 4).
pub const HEAD_BYTES: usize = EXCERPT * 4;

/// The text's own checks: something to save, and at most 2 MB.
pub fn check_text(text: &str) -> Result<(), Bad> {
    if text.trim().is_empty() {
        return Err(Bad::new(400, "Nothing to save: the text is empty."));
    }
    if text.len() > MAX_TEXT {
        return Err(Bad::new(
            413,
            "That text is too long for My Stuff (2 MB at most).",
        ));
    }
    Ok(())
}

/// The file name text is saved under: the name given (with the language's extension when it has
/// none), else one from its title, else `snippet`/`note`. A code block's language picks the
/// extension; plain text is markdown.
pub fn text_name(name: Option<&str>, lang: Option<&str>, title: Option<&str>) -> String {
    let lang = lang.filter(|l| !l.is_empty());
    let ext = lang.map_or("md", |l| lang_ext(l).unwrap_or("txt"));
    let mut base = safe_name(name.unwrap_or_default(), "");
    if !base.is_empty() && crate::kind::ext(&base).is_empty() {
        base = format!("{base}.{ext}");
    }
    if base.is_empty() {
        let from_title = title
            .map(|t| {
                safe_name(
                    &t.split_whitespace()
                        .collect::<Vec<_>>()
                        .join("-")
                        .to_lowercase(),
                    "",
                )
            })
            .unwrap_or_default();
        let stem = if !from_title.is_empty() {
            from_title
        } else if lang.is_some() {
            "snippet".into()
        } else {
            "note".into()
        };
        base = format!("{stem}.{ext}");
    }
    base
}

/// A link: `(href, host)`. Only full http(s) URLs.
pub fn parse_link(url: &str) -> Result<(String, String), Bad> {
    let not = || Bad::new(400, "That isn’t a link: give a full http(s) URL.");
    let u = url.trim();
    let Some(colon) = u.find(':') else {
        return Err(not());
    };
    let scheme = &u[..colon];
    let scheme_ok = scheme
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic())
        && scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c));
    if !scheme_ok {
        return Err(not());
    }
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err(Bad::new(400, "Only http(s) links can be saved."));
    }
    let rest = u[colon + 1..].trim_start_matches(['/', '\\']);
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(end);
    let hostport = authority.rsplit('@').next().unwrap_or_default();
    let host = if hostport.starts_with('[') {
        hostport.split_inclusive(']').next().unwrap_or_default()
    } else {
        hostport.split(':').next().unwrap_or_default()
    };
    if host.is_empty()
        || u.chars().any(char::is_whitespace)
        || !host
            .chars()
            .all(|c| c.is_alphanumeric() || "-._[]:".contains(c))
    {
        return Err(not());
    }
    let tail = if tail.starts_with('/') {
        tail.to_owned()
    } else {
        format!("/{tail}")
    };
    let href = format!("{scheme}://{}{tail}", authority.to_lowercase());
    let host = host.to_lowercase();
    let short = host.strip_prefix("www.").unwrap_or(&host).to_owned();
    Ok((href, short))
}

pub fn link_item(id: &str, href: &str, host: &str, o: &Origin, now: i64) -> StuffItem {
    StuffItem {
        id: id.to_owned(),
        kind: StuffKind::Link,
        name: host.to_owned(),
        title: host.to_owned(),
        url: Some(href.to_owned()),
        size: 0,
        at: now,
        by: Some(o.by.clone().unwrap_or_else(|| "you".into())),
        from: o.from.clone(),
        ..StuffItem::default()
    }
}

/// What an app's record holds besides its origin: worked out by the host from its folder.
#[derive(Debug, Clone, Default)]
pub struct AppFacts {
    pub folder: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub entry: String,
    pub db: Option<DbSpec>,
    pub uses: Vec<String>,
    pub tree: String,
    pub code: String,
    pub size: u64,
    pub files: u32,
}

pub fn app_item(id: &str, f: &AppFacts, o: &Origin, now: i64) -> StuffItem {
    let shown = f.name.clone().unwrap_or_else(|| f.folder.clone());
    StuffItem {
        id: id.to_owned(),
        kind: StuffKind::App,
        name: safe_name(&shown, "app"),
        title: clip(
            f.name
                .as_deref()
                .map_or_else(|| title_from(&f.folder), str::to_owned)
                .as_str(),
            140,
        ),
        mime: Some("text/html".into()),
        size: f.size,
        files: Some(f.files),
        entry: Some(f.entry.clone()),
        db: f.db.clone(),
        uses: (!f.uses.is_empty()).then(|| f.uses.clone()),
        at: now,
        by: Some(o.by.clone().unwrap_or_else(|| "you".into())),
        tree: Some(f.tree.clone()),
        code: Some(f.code.clone()),
        source: o.source.clone(),
        excerpt: f.description.as_deref().map(|d| clip(d, 400)),
        from: o.from.clone(),
        ..StuffItem::default()
    }
}

/// The entry an app opens on has to be inside it and there.
pub fn check_entry(entry: &str, exists: bool, src: &str) -> Result<(), Bad> {
    if entry.split(['/', '\\']).any(|s| s == "..") || !exists {
        return Err(Bad::new(
            400,
            format!(
                "No {entry} in {src}: build the app first (static files: HTML, JS, CSS), or name its entry in wisp-app.json."
            ),
        ));
    }
    Ok(())
}
