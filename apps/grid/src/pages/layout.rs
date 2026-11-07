//! The signed-in app's frame: the header (brand, Home/Account tabs, who's signed in) and the page.

use super::app_css::APP_CSS;
use super::icons::CLOUD;
use super::scripts::PENDING;
use super::site::tag;
use super::{ASSETS, PageCfg, PageUser, esc};

/// The two tabbed pages share a wider header with Home and Account.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Tab {
    None,
    Home,
    Account,
}

pub(super) struct AppPage<'a> {
    pub cfg: &'a PageCfg,
    pub title: &'a str,
    pub user: Option<&'a PageUser>,
    /// With a user and no tab: a Sign out button in the header.
    pub csrf: &'a str,
    pub body: &'a str,
    /// More in `<head>` (a page's own styles).
    pub head: &'a str,
    pub narrow: bool,
    pub tab: Tab,
}

impl<'a> AppPage<'a> {
    pub fn new(cfg: &'a PageCfg, title: &'a str, body: &'a str) -> Self {
        Self { cfg, title, user: None, csrf: "", body, head: "", narrow: false, tab: Tab::None }
    }
}

/// The round avatar: the picture, or the first letter.
pub(super) fn avatar(user: &PageUser) -> String {
    match user.avatar.as_deref().filter(|a| !a.is_empty()) {
        Some(src) => format!(r#"<span class="av"><img src="{}" alt=""></span>"#, esc(src)),
        None => format!(r#"<span class="av">{}</span>"#, user.initial()),
    }
}

fn me(p: &AppPage<'_>) -> String {
    let Some(user) = p.user else {
        return String::new();
    };
    let (who, av) = (esc(&user.handle), avatar(user));
    if p.tab != Tab::None {
        return format!(r#"<div class="me"><a href="/account" title="Your account"><span class="who">{who}</span>{av}</a></div>"#);
    }
    let out = if p.csrf.is_empty() {
        String::new()
    } else {
        format!(
            r#"<form class="inline" method="post" action="/signout"><input type="hidden" name="csrf" value="{}"><button class="ghost">Sign out</button></form>"#,
            esc(p.csrf)
        )
    };
    format!(r#"<div class="me"><span class="who">{who}</span>{av}{out}</div>"#)
}

pub(super) fn app_page(p: &AppPage<'_>) -> String {
    let cfg = p.cfg;
    let tabbed = p.tab != Tab::None;
    let nav = if tabbed {
        let cur = |t| if p.tab == t { r#" aria-current="page""# } else { "" };
        format!(
            r#"<nav class="navt" aria-label="Your grid"><a href="/"{}>Home</a><a href="/account"{}>Account</a></nav>"#,
            cur(Tab::Home),
            cur(Tab::Account)
        )
    } else {
        String::new()
    };
    let wide = if tabbed { " wide" } else { "" };
    let narrow = if p.narrow { " narrow" } else { "" };
    let cloud = CLOUD.replacen("<svg", r#"<svg width="13" height="13""#, 1);
    format!(
        r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title} · {name}</title><meta name="referrer" content="same-origin"><link rel="icon" href="{ASSETS}/icon.svg"><style>{APP_CSS}</style>{head}</head><body>
<header class="top{wide}"><a class="brand" href="{url}/"><span class="mark"></span>wisp</a><span class="chipx">{cloud}{tag}</span>
{nav}
{me}</header>
<main class="main{narrow}{wide}">{body}</main>{PENDING}</body></html>"#,
        title = esc(p.title),
        name = esc(&cfg.name),
        head = p.head,
        url = esc(&cfg.public_url),
        tag = esc(&tag(cfg)),
        me = me(p),
        body = p.body,
    )
}

/// The cloud wisp's state as the page says it.
pub(super) fn state_label(st: &str) -> Option<&'static str> {
    Some(match st {
        "running" => "Running",
        "queued" => "Waiting for room",
        "starting" => "Waking up",
        "stopping" => "Going to sleep",
        "stopped" => "Asleep",
        _ => return None,
    })
}
