//! A shared task (`crate::shares`) at `<publicUrl>/s/<id>`: behind its passkey when it has one, then
//! the task in wisp's own look (the web bundle's share view draws it from the embedded JSON).

use serde_json::{Value, json};

use super::app_css::SHARE_CSS;
use super::layout::{AppPage, app_page};
use super::{PageCfg, esc, initial_of};


fn str_at<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// Who shared it, as `share.from` carries it (`{ name?, handle?, avatar? }`).
fn who(from: &Value) -> Option<&str> {
    str_at(from, "name").or_else(|| str_at(from, "handle"))
}

fn avatar_of(from: &Value) -> String {
    match str_at(from, "avatar") {
        Some(src) => format!(r#"<span class="av"><img src="{}" alt=""></span>"#, esc(src)),
        None => format!(r#"<span class="av">{}</span>"#, initial_of(who(from).unwrap_or("?"))),
    }
}

/// A locked share: only its passkey opens it. Who shared it shows; nothing else does.
#[derive(Debug, Clone, Default)]
pub struct SharePassPage {
    /// the share's `from`
    pub from: Value,
    /// the last passkey tried was wrong
    pub wrong: bool,
}

pub fn share_pass_page(cfg: &PageCfg, p: &SharePassPage) -> String {
    let head = format!("<style>{SHARE_CSS}</style>");
    let wrong = if p.wrong { r#"<div class="flash bad">That passkey isn’t right.</div>"# } else { "" };
    let body = format!(
        r#"<div class="sh-head">{}<div><h1 class="h1">A shared task</h1><p class="sub">{} locked it with a passkey. Ask them for it.</p></div></div>
      <form method="post" class="sh-lock"><input class="input tall" type="password" name="passkey" placeholder="Passkey" autocomplete="off" autofocus required aria-label="Passkey"><button class="primary tall">Open</button></form>
      {wrong}"#,
        avatar_of(&p.from),
        esc(who(&p.from).unwrap_or("Someone"))
    );
    app_page(&AppPage { narrow: true, head: &head, ..AppPage::new(cfg, "Shared task", &body) })
}

/// The web bundle's stylesheets and icon sprite, read from its index.html.
#[derive(Debug, Clone, Default)]
pub struct WebLook {
    pub styles: Vec<String>,
    pub sprite: String,
}

#[derive(Debug, Clone, Default)]
pub struct ShareViewPage {
    /// the share row as the page reads it (`{ id, title, url, from, … }`)
    pub share: Value,
    pub task: Value,
    /// a delegated run of the task, by id
    pub run: Option<String>,
    pub look: WebLook,
}

/// The path of a URL (`https://grid/s/abc` → `/s/abc`).
fn path_of(url: &str) -> &str {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    rest.find('/').map_or("/", |i| &rest[i..])
}

pub fn share_view_page(p: &ShareViewPage) -> String {
    let title_of_share = str_at(&p.share, "title").unwrap_or_default();
    let base = path_of(str_at(&p.share, "url").unwrap_or_default());
    let data = json!({ "share": p.share, "task": p.task, "run": p.run, "base": base }).to_string().replace('<', "\\u003c");
    let title = match &p.run {
        Some(r) => format!("@{}", p.task.get("runs").and_then(|x| x.get(r)).and_then(|x| str_at(x, "name")).unwrap_or(r)),
        None => title_of_share.to_owned(),
    };
    let from = p.share.get("from").cloned().unwrap_or(Value::Null);
    let by = format!("Shared by {} on wisp", who(&from).unwrap_or("someone"));
    let styles: String = p.look.styles.iter().map(|h| format!(r#"<link rel="stylesheet" href="{}">"#, esc(h))).collect();
    format!(
        r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>{title} · shared on wisp</title><meta name="referrer" content="same-origin"><meta name="robots" content="noindex">
<meta property="og:title" content="{og}"><meta property="og:description" content="{by}">
<link rel="icon" href="/favicon.svg">{styles}</head>
<body class="share-view">{sprite}
<header class="sv-top"><a class="sv-brand" href="https://trywisp.dev" target="_blank" rel="noopener"><img src="/favicon.svg" alt="">wisp</a><span class="sv-tag">Shared task</span></header>
<div class="sv-wrap">
  <main class="sv-main">
    <header class="split-head sv-head" id="svHead"><div class="sh-row"><span class="q-dot"></span><h2 class="sh-title">{title}</h2></div></header>
    <div class="sv-turns" id="svTurns" aria-busy="true"><div class="sv-sk"><i class="sk sk-line"></i><i class="sk sk-block"></i></div><div class="sv-sk"><i class="sk sk-line"></i><i class="sk sk-block"></i></div></div>
  </main>
  <aside class="sv-side it-bar" id="svSide"><i class="sk sk-pill"></i><i class="sk sk-line"></i><i class="sk sk-line short"></i></aside>
</div>
<div class="overlay" id="overlay" hidden></div>
<div class="toasts" id="toasts"></div>
<script type="application/json" id="shareData">{data}</script>
<script type="module" src="/js/share-view.js"></script>
</body></html>"#,
        title = esc(&title),
        og = esc(title_of_share),
        by = esc(&by),
        sprite = p.look.sprite,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_locked_share_says_who_and_nothing_else() {
        let cfg = PageCfg { name: "wisp Grid".into(), ..PageCfg::default() };
        let p = share_pass_page(&cfg, &SharePassPage { from: json!({"handle": "ada"}), wrong: true });
        assert!(p.contains("ada locked it with a passkey"));
        assert!(p.contains(r#"<span class="av">A</span>"#));
        assert!(p.contains("That passkey isn’t right."));
        assert!(share_pass_page(&cfg, &SharePassPage::default()).contains("Someone locked it"));
    }

    #[test]
    fn the_view_embeds_its_data_safely() {
        let p = share_view_page(&ShareViewPage {
            share: json!({"title": "Fix </script>", "url": "https://grid.test/s/abc", "from": {"name": "Ada"}}),
            task: json!({"runs": {"r1": {"name": "Quill"}}}),
            run: Some("r1".into()),
            look: WebLook { styles: vec!["/css/app.css".into()], sprite: "<svg></svg>".into() },
        });
        assert!(p.contains("<title>@Quill · shared on wisp</title>"));
        assert!(p.contains(r#""base":"/s/abc""#));
        assert!(!p.contains("Fix </script>"));
        assert!(p.contains("Shared by Ada on wisp"));
    }
}
