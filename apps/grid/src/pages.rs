//! The grid's own pages, ported from v1 `grid/pages.js` look for look. Signed out, it's the site
//! (trywisp.dev's paper, ink and one blue): what a grid gives you, the real app, and the way in.
//! Signed in, it's the app (wisp's own tokens and rows): your cloud computer, where to use it, your
//! devices and sign-ins. Server-rendered, no build: every form posts with a CSRF token, images come
//! from `apps/grid/assets` (served at `/_grid/a/<name>`).
//!
//! Every page is a pure function, plain data in and an HTML string out: no IO and no clock (a page
//! that says "5 min ago" is handed `now_ms`). Every interpolated value goes through [`esc`], which is
//! safe in text and in quoted attributes alike, so the edge can pass what people typed as it is.
// Page templates read best as `format!` per row; they render on a click, not on a hot path.
#![allow(clippy::format_collect, clippy::format_push_string)]

mod account;
mod app_css;
mod device;
mod home;
mod hub;
mod icons;
mod in_app;
mod join;
mod layout;
mod machines;
mod scripts;
mod share;
mod signin;
mod site;
mod site_css;
mod time;

pub use account::{AccountPage, DeviceView, IdentityView, RouteView, account_page};
pub use device::{APP_URL, ActivatePage, DeviceAsk, MessagePage, activate_page, message_page, site_not_found, waking_page};
pub use home::{ComputerView, HomePage, InstanceView, Offers, SiteView, home_page};
pub use hub::{ShareCard, gallery_page, gone_page, locked_page, share_page};
pub use in_app::{InApp, Os, browser_name, in_app_browser, open_outside};
pub use machines::{MachineView, Wish};
pub use share::{SharePassPage, ShareViewPage, WebLook, share_pass_page, share_view_page};
pub use signin::{Seats, SignInPage, dev_sign_in_page, sign_in_page};

use crate::config::GridConfig;

/// Where the grid serves `apps/grid/assets`.
pub(crate) const ASSETS: &str = "/_grid/a";

/// The part of the grid's config a page reads.
#[derive(Debug, Clone, Default)]
pub struct PageCfg {
    /// grid.json's `name` ("wisp Grid", "wisp Cloud").
    pub name: String,
    pub domain: String,
    /// `<scheme>://<domain><port>`, no trailing slash.
    pub public_url: String,
}

impl PageCfg {
    pub fn of(cfg: &GridConfig) -> Self {
        Self { name: cfg.name.clone(), domain: cfg.domain.clone(), public_url: cfg.public_url.clone() }
    }
}

/// Who a signed-in page is for.
#[derive(Debug, Clone, Default)]
pub struct PageUser {
    pub handle: String,
    pub name: Option<String>,
    pub email: Option<String>,
    pub avatar: Option<String>,
}

impl PageUser {
    /// The letter in the round avatar when there's no picture.
    pub(crate) fn initial(&self) -> String {
        initial_of(self.name.as_deref().filter(|n| !n.is_empty()).unwrap_or(&self.handle))
    }
}

/// `(s || '?').trim()[0].toUpperCase() || '?'`, escaped.
pub(crate) fn initial_of(s: &str) -> String {
    let s = if s.is_empty() { "?" } else { s };
    match s.trim().chars().next() {
        Some(c) => esc(&c.to_uppercase().collect::<String>()),
        None => "?".into(),
    }
}

/// A way to sign in, as pages show it, in the order the grid lists them.
#[derive(Debug, Clone, Default)]
pub struct Provider {
    pub id: String,
    pub label: String,
}

/// How a page's note reads: plain, or as something that went wrong.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Tone {
    #[default]
    Plain,
    Bad,
}

impl Tone {
    /// `?tone=bad` on a redirect back to the page.
    pub fn from_query(v: Option<&str>) -> Self {
        if v == Some("bad") { Self::Bad } else { Self::Plain }
    }

    pub(crate) fn class(self) -> &'static str {
        match self {
            Self::Plain => "",
            Self::Bad => "bad",
        }
    }
}

/// v1's `esc`: `& < > " '` as numeric references, so the same string is safe as text and inside a
/// quoted attribute.
pub fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&#38;"),
            '<' => out.push_str("&#60;"),
            '>' => out.push_str("&#62;"),
            '"' => out.push_str("&#34;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn esc_turns_every_html_special_into_a_numeric_reference() {
        assert_eq!(esc(r#"<a href="x" title='y'>&</a>"#), "&#60;a href=&#34;x&#34; title=&#39;y&#39;&#62;&#38;&#60;/a&#62;");
        assert_eq!(esc("plain ü"), "plain ü");
    }

    #[test]
    fn the_avatar_initial_is_the_first_letter_upper_cased() {
        let u = |name: Option<&str>, handle: &str| PageUser { handle: handle.into(), name: name.map(Into::into), ..PageUser::default() };
        assert_eq!(u(Some(" ada"), "x").initial(), "A");
        assert_eq!(u(None, "bob").initial(), "B");
        assert_eq!(u(Some(""), "").initial(), "?");
        assert_eq!(u(Some("<b>"), "x").initial(), "&#60;");
    }
}
