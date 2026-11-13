//! Names, kinds, types and the small text rules every saved thing goes through (v1 services/stuff.js,
//! http/static.js MIME, services/apps.js `MORE_MIME`, web/js/tags.js).

use wisp_stuff_api::StuffKind;

const IMAGE: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico"];
const VIDEO: &[&str] = &["mp4", "webm", "mov", "m4v"];
const DOC: &[&str] = &["md", "markdown", "mdx", "txt", "pdf", "rst", "adoc"];
const CODE: &[&str] = &[
    "js",
    "mjs",
    "cjs",
    "ts",
    "tsx",
    "jsx",
    "py",
    "rb",
    "go",
    "rs",
    "java",
    "kt",
    "swift",
    "c",
    "h",
    "cc",
    "cpp",
    "hpp",
    "cs",
    "php",
    "sh",
    "bash",
    "zsh",
    "fish",
    "ps1",
    "sql",
    "html",
    "css",
    "scss",
    "vue",
    "svelte",
    "json",
    "yaml",
    "yml",
    "toml",
    "xml",
    "ini",
    "lua",
    "dart",
    "ex",
    "exs",
    "scala",
    "r",
    "pl",
    "csv",
    "tsv",
    "diff",
    "patch",
    "env",
    "graphql",
    "proto",
    "tf",
    "dockerfile",
];

/// The longest a saved file may be (500 MB), and an upload.
pub const MAX_STUFF: u64 = 500 * 1024 * 1024;
/// Text saved from a reply (a doc, a snippet).
pub const MAX_TEXT: usize = 2 * 1024 * 1024;
pub const EXCERPT: usize = 1400;
pub const MAX_APP: u64 = 200 * 1024 * 1024;
pub const MAX_APP_FILES: u32 = 5000;

/// `logo.PNG` → `png`; a name without a dot (or a dotfile) has none. v1 path.extname.
pub fn ext(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    match base.rfind('.') {
        Some(i) if i > 0 => base[i + 1..].to_lowercase(),
        _ => String::new(),
    }
}

pub fn kind_of(name: &str) -> StuffKind {
    let e = ext(name);
    let e = e.as_str();
    if IMAGE.contains(&e) {
        StuffKind::Image
    } else if VIDEO.contains(&e) {
        StuffKind::Video
    } else if DOC.contains(&e) {
        StuffKind::Doc
    } else if CODE.contains(&e) || name.eq_ignore_ascii_case("dockerfile") || name.eq_ignore_ascii_case("makefile") {
        StuffKind::Code
    } else {
        StuffKind::File
    }
}

/// Text wisp can read for an excerpt: code and docs, but not a PDF.
pub fn texty(name: &str) -> bool {
    let e = ext(name);
    !e.is_empty() && (CODE.contains(&e.as_str()) || (DOC.contains(&e.as_str()) && e != "pdf"))
}

/// The content type for a file name, or None (v1 static.js MIME plus apps.js `MORE_MIME`).
pub fn known_mime(name: &str) -> Option<&'static str> {
    Some(match ext(name).as_str() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "pdf" => "application/pdf",
        "webmanifest" => "application/manifest+json",
        "json" | "map" => "application/json",
        "txt" | "md" => "text/plain; charset=utf-8",
        "csv" => "text/csv; charset=utf-8",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "xml" => "application/xml",
        _ => return None,
    })
}

/// What an app's file is served as.
pub fn type_of(name: &str) -> &'static str {
    known_mime(name).unwrap_or("application/octet-stream")
}

/// The type a saved item records: what it was sent as, else by its name, else text or bytes.
pub fn mime_for(name: &str, given: Option<&str>) -> String {
    if ext(name) == "svg" {
        return "image/svg+xml".into();
    }
    if let Some(g) = given.filter(|g| !g.is_empty()) {
        return g.to_owned();
    }
    known_mime(name).map_or_else(
        || {
            if texty(name) { "text/plain; charset=utf-8".into() } else { "application/octet-stream".into() }
        },
        str::to_owned,
    )
}

/// A code block's language → the extension its file is saved under.
pub fn lang_ext(lang: &str) -> Option<&'static str> {
    Some(match lang.to_lowercase().as_str() {
        "javascript" | "js" => "js",
        "typescript" | "ts" => "ts",
        "tsx" => "tsx",
        "jsx" => "jsx",
        "python" | "py" => "py",
        "ruby" => "rb",
        "go" => "go",
        "rust" => "rs",
        "java" => "java",
        "kotlin" => "kt",
        "swift" => "swift",
        "c" => "c",
        "cpp" | "c++" => "cpp",
        "csharp" | "cs" => "cs",
        "php" => "php",
        "shell" | "sh" | "bash" | "zsh" | "console" => "sh",
        "powershell" => "ps1",
        "sql" => "sql",
        "html" => "html",
        "css" => "css",
        "scss" => "scss",
        "vue" => "vue",
        "svelte" => "svelte",
        "json" => "json",
        "yaml" | "yml" => "yml",
        "toml" => "toml",
        "xml" => "xml",
        "lua" => "lua",
        "dart" => "dart",
        "elixir" => "ex",
        "scala" => "scala",
        "r" => "r",
        "diff" => "diff",
        "graphql" => "graphql",
        "dockerfile" => "dockerfile",
        "markdown" | "md" => "md",
        "text" | "txt" => "txt",
        "csv" => "csv",
        _ => return None,
    })
}

/// A file name safe on every disk: its base name, anything but word characters, `.`, `-` and space
/// as `_`, no leading dots, the last 120 characters. `fallback` when nothing is left.
pub fn safe_name(name: &str, fallback: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or_default();
    let mut out = String::new();
    let mut run = false;
    for c in base.chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-' || c == ' ' {
            out.push(c);
            run = false;
        } else if !run {
            out.push('_');
            run = true;
        }
    }
    let out = out.trim_start_matches('.');
    let n = out.chars().count();
    let out: String = out.chars().skip(n.saturating_sub(120)).collect();
    if out.is_empty() { fallback.to_owned() } else { out }
}

/// `launch-plan_v2.md` → `launch plan v2`.
pub fn title_from(name: &str) -> String {
    let stem = match name.rfind('.') {
        Some(i) if i + 1 < name.len() => &name[..i],
        _ => name,
    };
    let mut out = String::new();
    let mut sep = false;
    for c in stem.chars() {
        if c == '-' || c == '_' {
            sep = true;
        } else {
            if sep {
                out.push(' ');
            }
            sep = false;
            out.push(c);
        }
    }
    if sep {
        out.push(' ');
    }
    let t = out.trim();
    if t.is_empty() { name.to_owned() } else { t.to_owned() }
}

/// At most `n` characters, the last one `…` when cut. Keeps the lines (unlike `clip`).
pub fn cut(s: &str, n: usize) -> String {
    if s.chars().count() > n {
        let mut out: String = s.chars().take(n.saturating_sub(1)).collect();
        out.push('…');
        out
    } else {
        s.to_owned()
    }
}

/// One line: runs of white space as one space, trimmed, then `cut`.
pub fn clip(s: &str, n: usize) -> String {
    cut(&s.split_whitespace().collect::<Vec<_>>().join(" "), n)
}

/// The opening of a doc or snippet, for its card. Docs lose their front matter; lines are kept.
pub fn excerpt_of(text: &str, kind: StuffKind) -> String {
    let t = text.replace("\r\n", "\n");
    let body = if kind == StuffKind::Doc { strip_front_matter(&t) } else { &t };
    cut(body.trim_end(), EXCERPT)
}

fn strip_front_matter(t: &str) -> &str {
    let Some(rest) = t.strip_prefix("---\n") else {
        return t;
    };
    let Some(end) = rest.find("\n---\n") else {
        return t;
    };
    rest[end + 5..].trim_start_matches('\n')
}

/// Topic tags: lower case, `#` dropped, white space, `_` and `/` as `-`, letters, digits and `- . +`
/// only, no doubled or edge `-`/`.`, 32 characters, at most 10, each once (v1 web/js/tags.js).
pub fn normalize_tags(list: &serde_json::Value) -> Vec<String> {
    let raw: Vec<String> = match list {
        serde_json::Value::Array(a) => a
            .iter()
            .map(|v| {
                v.as_str().map_or_else(
                    || {
                        if v.is_null() { String::new() } else { v.to_string() }
                    },
                    str::to_owned,
                )
            })
            .collect(),
        serde_json::Value::String(s) => s.split(',').map(str::to_owned).collect(),
        _ => Vec::new(),
    };
    let mut out: Vec<String> = Vec::new();
    for r in raw {
        let t = tag(&r);
        if !t.is_empty() && !out.contains(&t) {
            out.push(t);
        }
        if out.len() == 10 {
            break;
        }
    }
    out
}

fn tag(raw: &str) -> String {
    let lower = raw.to_lowercase();
    let s = lower.trim().trim_start_matches('#');
    let mut out = String::new();
    let mut gap = false;
    for c in s.chars() {
        if c.is_whitespace() || c == '_' || c == '/' {
            gap = true;
            continue;
        }
        if gap {
            out.push('-');
            gap = false;
        }
        if c.is_alphanumeric() || c == '-' || c == '.' || c == '+' {
            out.push(c);
        }
    }
    while out.contains("--") {
        out = out.replace("--", "-");
    }
    let t = out.trim_matches(['-', '.']);
    t.chars().take(32).collect()
}
