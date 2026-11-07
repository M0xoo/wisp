//! What an agent reads about My Stuff (wisp_stuff, wisp_save's answer, @-mentions): one line per
//! item with where its file is, one item in full, and how to change it. The words are v1's.

use wisp_stuff_api::{StuffItem, StuffKind};

use crate::kind::clip;

/// `1536` → `1.5 KB`.
pub fn bytes(n: u64) -> String {
    #[allow(clippy::cast_precision_loss)]
    let f = n as f64;
    if n < 1024 {
        format!("{n} B")
    } else if n < 1024 * 1024 {
        format!("{:.1} KB", f / 1024.0)
    } else {
        format!("{:.1} MB", f / (1024.0 * 1024.0))
    }
}

/// Milliseconds since the epoch → `YYYY-MM-DD` (UTC), without a clock or a date crate.
pub fn day(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

fn update_words(kind: StuffKind) -> &'static str {
    match kind {
        StuffKind::App => {
            "To change it, copy the folder into your working directory, change it there, then wisp_save with id and app: <that folder>."
        }
        StuffKind::Link => "To change it, wisp_save with id and url.",
        StuffKind::Doc | StuffKind::Code => {
            "To change it, write the new version and wisp_save with id and text (or path)."
        }
        _ => "To change it, wisp_save with id and path (the new file).",
    }
}

/// One line per item. `path`: its file (or an app's folder) on this computer, for the agent to read.
pub fn stuff_line(x: &StuffItem, path: &str) -> String {
    let where_ = if let Some(u) = &x.url {
        format!("url: {u}")
    } else if x.kind == StuffKind::App {
        let public = x
            .published
            .as_ref()
            .map(|p| format!(", public at {}", p.url))
            .unwrap_or_default();
        format!(
            "folder: {path} (entry {}){public}",
            x.entry.as_deref().unwrap_or("index.html")
        )
    } else {
        format!("file: {path}")
    };
    let lang = x
        .lang
        .as_ref()
        .map(|l| format!(" ({l})"))
        .unwrap_or_default();
    let size = if x.size > 0 {
        format!(", {}", bytes(x.size))
    } else {
        String::new()
    };
    let by = if x.by.as_deref() == Some("agent") {
        "an agent"
    } else {
        "the user"
    };
    let rev = match (x.rev, x.updated_at) {
        (Some(r), Some(u)) if r > 1 => format!(", v{r} (updated {})", day(u)),
        _ => String::new(),
    };
    let from = x
        .from
        .as_ref()
        .and_then(|f| f.title.as_ref())
        .map(|t| format!(" from “{t}”"))
        .unwrap_or_default();
    let star = if x.starred == Some(true) {
        ", starred"
    } else {
        ""
    };
    let tags = x
        .tags
        .as_ref()
        .filter(|t| !t.is_empty())
        .map(|t| {
            format!(
                " {}",
                t.iter()
                    .map(|t| format!("#{t}"))
                    .collect::<Vec<_>>()
                    .join(" ")
            )
        })
        .unwrap_or_default();
    let note = x
        .note
        .as_ref()
        .filter(|n| !n.is_empty())
        .map(|n| format!("\n  note: {}", clip(n, 200)))
        .unwrap_or_default();
    format!(
        "- `{}` **{}** — {}{lang}{size}, saved {} by {by}{rev}{from}{star}{tags}\n  {where_}{note}",
        x.id,
        x.title,
        x.kind.as_str(),
        day(x.at)
    )
}

/// What one item says in full besides its line: a doc's or snippet's text, an app's files.
#[derive(Debug, Clone, Default)]
pub struct Detail {
    /// a doc or code file's text, when it is small (≤ 20 000 bytes) and readable
    pub text: Option<String>,
    /// an app's files, the first 40
    pub files: Vec<String>,
    /// what the app's grant holds now
    pub allowed: Vec<String>,
}

pub fn stuff_detail(x: &StuffItem, path: &str, d: &Detail) -> String {
    let mut body = String::new();
    if let (Some(t), true) = (&d.text, matches!(x.kind, StuffKind::Doc | StuffKind::Code)) {
        let lang = x.lang.clone().unwrap_or_else(|| crate::kind::ext(&x.name));
        body = format!("\n\n```{lang}\n{}\n```", t.strip_suffix('\n').unwrap_or(t));
    }
    if x.kind == StuffKind::App {
        let n = x.files.unwrap_or(0);
        let more = if n as usize > d.files.len() {
            ", …"
        } else {
            ""
        };
        let s = if n == 1 { "" } else { "s" };
        let db = x.db.as_ref().map(|db| {
            let seed = if db.seed.is_empty() { String::new() } else { format!(", made from {}", db.seed) };
            format!("\n  It has a database (SQLite, \"db\" in its wisp-app.json{seed}): its pages use it with import {{ sql }} from '/_wisp/db.js'.")
        });
        let uses = x.uses.as_ref().filter(|u| !u.is_empty()).map(|u| {
            let allowed = if d.allowed.is_empty() { "nothing yet".to_owned() } else { d.allowed.join(", ") };
            format!("\n  It uses wisp ({}; allowed: {allowed}) through <script src=\"/_wisp/pane.js\"></script> when it's pinned as a pane.", u.join(", "))
        });
        body = format!(
            "\n  {n} file{s}: {}{more}\n  The user launches it from My Stuff (wisp serves it on a port of its own).{}{}",
            d.files.join(", "),
            db.unwrap_or_default(),
            uses.unwrap_or_default()
        );
    }
    format!(
        "{}{body}\n  {} Don't change files in My Stuff's own folder.",
        stuff_line(x, path),
        update_words(x.kind)
    )
}

/// wisp_stuff's list. `total`: every item in My Stuff (to tell "nothing matches" from "empty").
pub fn find_text(
    found: &[(StuffItem, String)],
    limit: usize,
    total: usize,
    capped: bool,
) -> String {
    if found.is_empty() {
        return if capped || total > 0 {
            "Nothing in My Stuff matches that.".into()
        } else {
            "My Stuff is empty.".into()
        };
    }
    let n = found.len();
    let s = if n > 1 { "s" } else { "" };
    let newest = if n > limit {
        format!(" (the newest {limit})")
    } else {
        String::new()
    };
    let lines: Vec<String> = found
        .iter()
        .take(limit)
        .map(|(it, p)| stuff_line(it, p))
        .collect();
    format!(
        "{n} item{s} in My Stuff{newest}:\n{}\n\nRead or copy a file from its path; don't change it there. wisp_stuff with an id gives one in full (a doc's text, an app's files); wisp_save with an id updates it.",
        lines.join("\n")
    )
}

/// wisp_save's answer for a new item or an update.
pub fn save_text(it: &StuffItem, update: bool) -> String {
    let size = if it.size > 0 {
        format!(", {}", bytes(it.size))
    } else {
        String::new()
    };
    let what = format!("“{}” ({}{size})", it.title, it.kind.as_str());
    let app = it.kind == StuffKind::App;
    let launch = if app {
        " The user launches it from My Stuff: wisp serves it on a port of its own."
    } else {
        ""
    };
    let public = it.published.as_ref().map(|p| {
        let older = if p.rev.unwrap_or(1) == it.rev.unwrap_or(1) {
            ""
        } else {
            ", with an older version: wisp_save with this id and publish: true updates the link"
        };
        format!(" It's public at {}{older}.", p.url)
    });
    let public = public.unwrap_or_default();
    if update {
        return format!(
            "Updated {what} in the user's My Stuff, now v{}; the version before is kept and the user can restore it.{launch}{public} Show it in your answer as {{\"type\":\"stuff\",\"id\":\"{}\"}}.",
            it.rev.unwrap_or(1),
            it.id
        );
    }
    let inside = if app {
        " (the user launches it from there, inside wisp)"
    } else {
        ""
    };
    format!(
        "Saved {what} to the user's My Stuff, id {}. It's a copy: later changes to the original don't reach it (wisp_save with this id updates it).{launch}{public} Show it in your answer as {{\"type\":\"stuff\",\"id\":\"{}\"}}{inside}.",
        it.id, it.id
    )
}
