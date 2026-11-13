//! The way in, on the sign-in page (twice: under the hero and at the end): the sign-in buttons, the
//! full and waitlist notes, and in an app's own browser the way out to the phone's real one.

use super::icons::{ARROW, CHECK, COPY};
use super::in_app::{InApp, browser_name, open_outside};
use super::signin::Seats;
use super::site::waitlist;
use super::{PageCfg, Provider, esc};
use crate::http::encode_component;

/// What the join box needs.
pub(super) struct Join<'a> {
    pub cfg: &'a PageCfg,
    pub providers: &'a [Provider],
    pub seats: &'a Seats,
    pub ret: &'a str,
    pub error: &'a str,
    pub linking: bool,
    pub waitlisted: bool,
    pub in_app: Option<&'a InApp>,
}

/// A provider's logo: its own icon, else the one before a `:` (`oidc:corp`), else a key (dev: code).
pub(super) fn logo(id: &str) -> &'static str {
    use super::icons::{CODE, KEY, named};
    named(id).or_else(|| named(id.split(':').next().unwrap_or_default())).unwrap_or(if id == "dev" { CODE } else { KEY })
}

/// GitHub first, dev last, the rest as the grid lists them; Google left out in an app's browser,
/// where its sign-in can only fail (it refuses web views).
fn ordered(providers: &[Provider], in_app: bool) -> Vec<&Provider> {
    let mut list: Vec<&Provider> = providers.iter().filter(|p| !(in_app && p.id == "google")).collect();
    list.sort_by_key(|p| match p.id.as_str() {
        "github" => 0,
        "dev" => 2,
        _ => 1,
    });
    list
}

fn buttons(j: &Join<'_>, wl: bool) -> String {
    let q = if j.ret.is_empty() { String::new() } else { format!("?return={}", encode_component(j.ret)) };
    let list = ordered(j.providers, j.in_app.is_some());
    // Two ways in share one row, so adding Google doesn't push the page down; "Continue with" drops
    // on phones.
    let pair = list.len() == 2;
    let mut out = String::new();
    for (i, p) in list.iter().enumerate() {
        let first = if i == 0 && !wl && j.in_app.is_none() { " first" } else { "" };
        let label = esc(&p.label);
        let text =
            if pair { format!(r#"<span><span class="cw">Continue with </span>{label}</span>"#) } else { format!("Continue with {label}") };
        out += &format!(r#"<a class="btn{first}" href="/auth/{}/start{q}">{}{text}</a>"#, encode_component(&p.id), logo(&p.id));
    }
    if pair { format!(r#"<div class="ways">{out}</div>"#) } else { out }
}

/// No seat count: with seats that open as the grid grows, "3 left" says little and reads as a
/// countdown. Just whether there's room, and the waitlist when there isn't. Full: new people get the
/// waitlist first; the few with an account still sign in below it.
pub(super) fn join_box(j: &Join<'_>) -> String {
    let full = !j.linking && j.seats.left == Some(0);
    let wl = if full && !j.waitlisted { waitlist(j.cfg) } else { None };
    let invite = j.seats.invite || j.seats.closed;
    let note = if j.waitlisted {
        "<b>All seats are taken, so you’re on the waitlist.</b> Seats open as the grid grows, oldest on the list first; yours is held for you then. Sign in again to check."
    } else if wl.is_some() {
        "<b>All preview seats are taken.</b> Leave your email and you get the next one. Already have a seat? Sign in below."
    } else {
        "<b>This grid is full:</b> it has all the accounts it takes. Already have one? Sign in below."
    };
    let error = if j.error.is_empty() { String::new() } else { format!(r#"<p class="err">{}</p>"#, esc(j.error)) };
    let full = if full { format!(r#"<p class="full">{note}</p>"#) } else { String::new() };
    let next = wl.map(|u| format!(r#"<a class="btn first" href="{u}">{ARROW}Get the next free seat</a>"#)).unwrap_or_default();
    let mut ways = buttons(j, wl.is_some());
    if ways.is_empty() {
        ways = r#"<p class="err">No sign-in is set up on this grid yet. Its operator adds GitHub or Google in grid.json.</p>"#.into();
    }
    let fine = if j.linking {
        "<span>Sign in with it once; after that either one opens your account.</span>".to_string()
    } else {
        let last = if invite { "Invite only" } else { "Free during the preview" };
        format!("<span>{CHECK}Nothing to install</span><span>{CHECK}Your own agent accounts</span><span>{CHECK}{last}</span>")
    };
    format!(
        r#"<div class="join" id="join">{error}
    {full}
    {next}
    {ways}
    <div class="fine">{fine}</div></div>"#
    )
}

/// In X's (or another app's) own browser: the way out to Safari or Chrome, the link to copy, and
/// "email me the link" for finishing on a computer (it joins the waitlist as source in-app).
pub(super) fn in_app_box(in_app: &InApp, url: &str) -> String {
    let whose = if in_app.app == "this app" { "this app’s".to_string() } else { format!("{}’s", in_app.app) };
    let (app, url_e, out) = (esc(in_app.app), esc(url), esc(&open_outside(url, in_app.os)));
    let (whose, browser) = (esc(&whose), browser_name(in_app.os));
    format!(
        r#"<div class="inapp" id="inapp" data-app="{app}" data-url="{url_e}">
    <p><b>You’re in {whose} browser.</b> Signing in doesn’t work here: Google blocks it and GitHub would ask for your password.</p>
    <div class="ways"><a class="btn first" href="{out}" data-inapp="open">{ARROW}Open in {browser}</a><button class="btn" type="button" data-inapp="copy">{COPY}<span>Copy link</span></button></div>
    <input class="link" readonly value="{url_e}" aria-label="Link to this page" hidden>
    <p class="tip">Nothing happens? Tap <b>⋯</b> at the top right, then <b>Open in browser</b>.</p>
    <form class="mail" id="inappMail" novalidate><label for="inappEmail">Or get the link by email for your computer:</label>
      <div><input id="inappEmail" type="email" name="email" placeholder="you@example.com" autocomplete="email" autocapitalize="off" enterkeyhint="send" required><button class="btn" type="submit">Email me</button></div>
      <p class="sent" role="status" hidden>{CHECK}<span></span></p><p class="err" role="alert" hidden></p></form>
  </div>"#
    )
}
