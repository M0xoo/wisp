//! The hub's pages (ADR-0038, ADR-0041), readable without wisp: a share of every kind at `/s/<id>`, a
//! locked or gone one, and the gallery at `/gallery`. Every value is escaped (`esc`); nothing a sharer
//! wrote is ever markup.
//!
//! What a share's content is, by kind (the JSON wisp signs and sends):
//! - `task`: a `.wisp-task` bundle (`title`, `spec.prompt`, `report.answers[].text|blocks`, `report.files`);
//! - `setup`, `module`, `crew`, `workflow`, `agent`: `{ resources: [{kind, name, summary}], files: [{name, text}] }`;
//! - `doc`, `report`: `{ markdown }`;
//! - anything else: shown as its JSON.

use serde_json::Value;

use super::layout::{AppPage, app_page};
use super::{PageCfg, esc};

/// What the page knows about a share before its content.
#[derive(Debug, Clone, Default)]
pub struct ShareCard {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub summary: String,
    pub from: String,
    pub version: i64,
    /// `grid://<handle>/<key>`
    pub source: String,
}

const STYLE: &str = "<style>.hub-meta{color:var(--muted,#666);font-size:13px;margin:4px 0 16px}.hub-list{list-style:none;padding:0;margin:0 0 16px}.hub-list li{padding:6px 0;border-bottom:1px solid rgba(127,127,127,.18)}.hub-pre{white-space:pre-wrap;word-break:break-word;font:13px/1.5 ui-monospace,Menlo,monospace;background:rgba(127,127,127,.08);padding:12px;border-radius:8px;overflow:auto}.hub-k{font:12px ui-monospace,Menlo,monospace;opacity:.7;margin-right:6px}.hub-open{margin:12px 0 20px}.hub-open code{font:13px ui-monospace,Menlo,monospace}</style>";

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

fn open_in_wisp(c: &ShareCard, public_url: &str) -> String {
    let link = format!("{public_url}/s/{}", c.id);
    format!(
        r#"<div class="hub-open"><a class="primary tall" href="wisp://open/{id}">Open in wisp</a> <span class="sub">or run <code>wisp open {link}</code></span></div>"#,
        id = esc(&c.id),
        link = esc(&link)
    )
}

fn task_body(v: &Value) -> String {
    let mut out = String::new();
    let prompt = v.pointer("/spec/prompt").and_then(Value::as_str).unwrap_or_default();
    if !prompt.is_empty() {
        out.push_str(&format!(r#"<h2 class="h2">The ask</h2><div class="hub-pre">{}</div>"#, esc(prompt)));
    }
    let answers = v.pointer("/report/answers").and_then(Value::as_array).cloned().unwrap_or_default();
    if !answers.is_empty() {
        out.push_str(r#"<h2 class="h2">What it did</h2>"#);
        for a in &answers {
            let text = s(a, "text");
            let text = if text.is_empty() { a.get("blocks").map(Value::to_string).unwrap_or_default() } else { text.to_owned() };
            out.push_str(&format!(r#"<div class="hub-pre">{}</div>"#, esc(&text)));
        }
    }
    let files: Vec<String> = v
        .pointer("/report/files")
        .and_then(Value::as_array)
        .map(|f| f.iter().filter_map(|x| x.as_str().map(esc)).collect())
        .unwrap_or_default();
    if !files.is_empty() {
        out.push_str(&format!(
            r#"<h2 class="h2">Files it changed</h2><ul class="hub-list">{}</ul>"#,
            files.iter().map(|f| format!("<li>{f}</li>")).collect::<String>()
        ));
    }
    if out.is_empty() {
        out.push_str(r#"<p class="sub">The ask and its setup, to run on your own code.</p>"#);
    }
    out
}

fn setup_body(v: &Value) -> String {
    let mut out = String::new();
    let res = v.get("resources").and_then(Value::as_array).cloned().unwrap_or_default();
    if !res.is_empty() {
        out.push_str(&format!(
            r#"<h2 class="h2">What it sets up</h2><ul class="hub-list">{}</ul>"#,
            res.iter()
                .map(|r| format!(
                    r#"<li><span class="hub-k">{}</span><b>{}</b> {}</li>"#,
                    esc(s(r, "kind")),
                    esc(s(r, "name")),
                    esc(s(r, "summary"))
                ))
                .collect::<String>()
        ));
    }
    for f in v.get("files").and_then(Value::as_array).into_iter().flatten() {
        out.push_str(&format!(r#"<h2 class="h2">{}</h2><div class="hub-pre">{}</div>"#, esc(s(f, "name")), esc(s(f, "text"))));
    }
    out
}

/// A share's page: what it is, who shared it, how to open it in wisp, and its content in plain words.
pub fn share_page(cfg: &PageCfg, c: &ShareCard, content: &Value) -> String {
    let what = match c.kind.as_str() {
        "task" => task_body(content),
        "setup" | "module" | "crew" | "workflow" | "agent" => setup_body(content),
        "doc" | "report" => format!(r#"<div class="hub-pre">{}</div>"#, esc(s(content, "markdown"))),
        _ => format!(r#"<div class="hub-pre">{}</div>"#, esc(&serde_json::to_string_pretty(content).unwrap_or_default())),
    };
    let summary = if c.summary.is_empty() { String::new() } else { format!(r#"<p class="sub">{}</p>"#, esc(&c.summary)) };
    let body = format!(
        r#"<h1 class="h1">{title}</h1>{summary}<div class="hub-meta">A {kind} shared by <b>{from}</b> · v{v} · <code>{src}</code></div>{open}{what}"#,
        title = esc(&c.title),
        kind = esc(&c.kind),
        from = esc(&c.from),
        v = c.version,
        src = esc(&c.source),
        open = open_in_wisp(c, &cfg.public_url),
    );
    app_page(&AppPage { head: STYLE, ..AppPage::new(cfg, &c.title, &body) })
}

/// A locked share: only that it's locked, and how it opens. Nothing of what it is.
pub fn locked_page(cfg: &PageCfg, id: &str, access: &str, wrong: bool) -> String {
    let body = match access {
        "password" => format!(
            r#"<h1 class="h1">This share has a password</h1><p class="sub">Ask whoever shared it for the password.</p>{}<form method="post" action="/s/{}" style="margin-top:16px;display:flex;gap:10px"><input class="input" type="password" name="password" autocomplete="off" autofocus required><button class="primary tall">Open</button></form>"#,
            if wrong { r#"<div class="flash bad">That password isn’t right.</div>"# } else { "" },
            esc(id)
        ),
        "people" => {
            r#"<h1 class="h1">This share is for some people only</h1><p class="sub">Sign in as one of them to open it.</p>"#.to_owned()
        }
        _ => r#"<h1 class="h1">This share is for a team</h1><p class="sub">Sign in as a member of that team to open it.</p>"#.to_owned(),
    };
    app_page(&AppPage { narrow: true, ..AppPage::new(cfg, "A locked share", &body) })
}

/// Revoked or expired.
pub fn gone_page(cfg: &PageCfg, why: &str) -> String {
    let text = if why == "expired" { "This link has expired." } else { "Whoever shared this stopped sharing it." };
    let body = format!(r#"<h1 class="h1">This share is gone</h1><p class="sub">{text}</p>"#);
    app_page(&AppPage { narrow: true, ..AppPage::new(cfg, "A share that's gone", &body) })
}

/// The gallery: what people published, searchable.
pub fn gallery_page(cfg: &PageCfg, q: &str, found: &[Value]) -> String {
    let items: String = found
        .iter()
        .map(|f| {
            let c = &f["card"];
            format!(
                r#"<li><span class="hub-k">{kind}</span><a href="/s/{id}"><b>{title}</b></a> <span class="sub">{summary}</span> <span class="hub-meta">by {from} · {imports} imports</span></li>"#,
                kind = esc(s(c, "kind")),
                id = esc(s(c, "id")),
                title = esc(s(c, "title")),
                summary = esc(s(c, "summary")),
                from = esc(c.pointer("/from/handle").and_then(Value::as_str).unwrap_or_default()),
                imports = f["imports"].as_i64().unwrap_or(0),
            )
        })
        .collect();
    let list = if items.is_empty() {
        r#"<p class="sub">Nothing matches yet.</p>"#.to_owned()
    } else {
        format!(r#"<ul class="hub-list">{items}</ul>"#)
    };
    let body = format!(
        r#"<h1 class="h1">What people are building</h1><p class="sub">Formulas, modules, crew, workflows, plugins and apps people chose to publish. Use this opens it in wisp, where you see its plan before anything changes.</p><form method="get" action="/gallery" style="margin:16px 0;display:flex;gap:10px"><input class="input" name="q" value="{}" placeholder="Search"><button class="primary tall">Search</button></form>{list}"#,
        esc(q)
    );
    app_page(&AppPage { head: STYLE, ..AppPage::new(cfg, "Gallery", &body) })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn cfg() -> PageCfg {
        PageCfg { name: "wisp Grid".into(), domain: "wisp.localhost".into(), public_url: "http://wisp.localhost:8080".into() }
    }

    #[test]
    fn a_share_page_works_without_wisp() {
        let card = |kind: &str| ShareCard {
            id: "abc".into(),
            kind: kind.into(),
            title: "<b>Review</b>".into(),
            from: "ada".into(),
            version: 2,
            source: "grid://ada/review".into(),
            ..ShareCard::default()
        };
        let task = share_page(
            &cfg(),
            &card("task"),
            &json!({ "spec": { "prompt": "fix <script>x</script>" }, "report": { "answers": [{ "text": "Done" }], "files": ["src/a.ts"] } }),
        );
        assert!(task.contains("fix &#60;script&#62;") || task.contains("fix &lt;script&gt;"), "escaped");
        assert!(!task.contains("<script>x") && task.contains("src/a.ts") && task.contains("wisp open http://wisp.localhost:8080/s/abc"));
        assert!(!task.contains("<b>Review</b>"));
        let setup = share_page(
            &cfg(),
            &card("setup"),
            &json!({ "resources": [{ "kind": "agent", "name": "reviewer", "summary": "claude, plan mode" }], "files": [{ "name": "agents.wisp.yml", "text": "agent: …" }] }),
        );
        assert!(setup.contains("reviewer") && setup.contains("agents.wisp.yml") && setup.contains("v2"));
        let doc = share_page(&cfg(), &card("doc"), &json!({ "markdown": "# Notes" }));
        assert!(doc.contains("# Notes"));
        let locked = locked_page(&cfg(), "abc", "password", true);
        assert!(locked.contains("password isn’t right") && !locked.contains("Review"));
        assert!(gone_page(&cfg(), "expired").contains("expired"));
        assert!(gallery_page(&cfg(), "<q>", &[]).contains("Nothing matches"));
    }
}
