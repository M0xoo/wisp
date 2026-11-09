//! The signed-out site's frame: head (meta, Open Graph, the hosted grid's analytics), nav and footer,
//! and the bits the site's sections share.

use super::scripts::{PENDING, POSTHOG_STUB};
use super::site_css::SITE_CSS;
use super::{ASSETS, PageCfg, esc};

const DESC: &str = "Your own wisp on a server: Claude Code, Codex and the rest keep working when your laptop closes, and the report waits on your phone.";

/// The word beside the logo follows the grid's name, so grid.json's "name": "wisp Cloud" shows Cloud.
pub(super) fn tag(cfg: &PageCfg) -> String {
    let name = if cfg.name.is_empty() { "wisp Grid" } else { &cfg.name };
    let rest = strip_wisp(name);
    if rest.is_empty() { "Grid".into() } else { rest.to_string() }
}

/// `/^wisp\s+/i`: "wisp " (any case, any run of spaces) off the front.
fn strip_wisp(name: &str) -> &str {
    let Some(head) = name.get(..4).filter(|h| h.eq_ignore_ascii_case("wisp")) else {
        return name;
    };
    let rest = &name[head.len()..];
    let trimmed = rest.trim_start();
    if trimmed.len() == rest.len() { name } else { trimmed }
}

/// The hosted grid's sign-in page counts visits and clicks in wisp's `PostHog` project, like
/// trywisp.dev, so the funnel reads site → this page → GitHub → signed up. Its cookie is on
/// .trywisp.dev, so it's the same anonymous visitor as on the site. Self-hosted grids load nothing.
fn analytics_script(key: &str) -> String {
    let key = serde_json::to_string(key).unwrap_or_else(|_| "\"\"".into());
    format!(
        "<script>{POSTHOG_STUB}\nposthog.init({key},{{api_host:'https://us.i.posthog.com',defaults:'2026-05-30',person_profiles:'identified_only'}});\ndocument.addEventListener('click',(e)=>{{const a=e.target.closest('a[href^=\"/auth/\"]');if(a)posthog.capture('grid_signin_clicked',{{provider:decodeURIComponent(a.pathname.split('/')[2]||'')}},{{transport:'sendBeacon'}})}});</script>"
    )
}

/// `analytics`: the `PostHog` project key, on the hosted grid only.
pub(super) fn site_head(title: &str, cfg: &PageCfg, analytics: Option<&str>) -> String {
    let (title, url) = (esc(title), esc(&cfg.public_url));
    let analytics = analytics.map(analytics_script).unwrap_or_default();
    let tag = esc(&tag(cfg));
    format!(
        r##"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title><meta name="referrer" content="same-origin"><meta name="description" content="{DESC}">
<link rel="canonical" href="{url}/"><meta property="og:type" content="website"><meta property="og:url" content="{url}/"><meta property="og:title" content="{title}"><meta property="og:description" content="{DESC}"><meta property="og:image" content="{url}{ASSETS}/og.png"><meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="{ASSETS}/icon.svg"><style>{SITE_CSS}</style>{analytics}</head><body>
<header class="nav" id="nav"><div class="wrap"><a class="brand" href="/"><span class="mark"></span>wisp<span class="tag">{tag}</span></a>
<nav class="links"><a href="#how">How it works</a><a href="#report">What you get back</a><a href="#private">Private by design</a></nav>
<div class="right"><a class="pill" href="https://trywisp.dev" target="_blank" rel="noopener">trywisp.dev</a><a class="pill dark" href="#join">Sign in</a></div></div></header>"##
    )
}

pub(super) fn site_foot(cfg: &PageCfg) -> String {
    format!(
        r#"<footer class="foot"><div class="wrap"><span>{} · {}</span><a href="https://trywisp.dev" target="_blank" rel="noopener">wisp</a><a href="https://github.com/WispAgents/wisp" target="_blank" rel="noopener">Open source (MIT)</a><a href="https://github.com/WispAgents/wisp/tree/main/grid" target="_blank" rel="noopener">Run your own grid</a></div></footer>
<script>addEventListener('scroll',()=>document.getElementById('nav').classList.toggle('scrolled',scrollY>8),{{passive:true}})</script>{PENDING}</body></html>"#,
        esc(&cfg.name),
        esc(&cfg.domain)
    )
}

/// A screenshot of the app, light or dark with the page.
pub(super) fn shot(name: &str, alt: &str) -> String {
    format!(
        r#"<picture><source srcset="{ASSETS}/dark-{name}.webp" media="(prefers-color-scheme: dark)"><img src="{ASSETS}/light-{name}.webp" alt="{}" decoding="async"></picture>"#,
        esc(alt)
    )
}

/// The hosted grid's waitlist lives on trywisp.dev; a self-hosted grid that's full just says so.
pub(super) fn waitlist(cfg: &PageCfg) -> Option<&'static str> {
    (cfg.domain == "grid.trywisp.dev").then_some("https://trywisp.dev/cloud.html#join")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tag_is_the_grids_name_without_wisp() {
        let tag_of = |name: &str| tag(&PageCfg { name: name.into(), ..PageCfg::default() });
        assert_eq!(tag_of("wisp Grid"), "Grid");
        assert_eq!(tag_of("wisp Cloud"), "Cloud");
        assert_eq!(tag_of("WISP   Lab"), "Lab");
        assert_eq!(tag_of("wispy"), "wispy");
        assert_eq!(tag_of("wisp "), "Grid");
        assert_eq!(tag_of(""), "Grid");
        assert_eq!(tag_of("Acme"), "Acme");
    }
}
