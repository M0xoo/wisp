//! Account (`/account`), signed in: signed-in devices, the Telegram bot for `on laptop`, how you
//! sign in, sign out, and delete.

use super::home::{ComputerView, flash, hidden};
use super::icons::{GLOBE, LAPTOP, PHONE, SHIELD, TRASH};
use super::join::logo;
use super::layout::{AppPage, Tab, app_page, avatar};
use super::scripts::LIVE;
use super::time::ago;
use super::{PageCfg, PageUser, Provider, Tone, esc};
use crate::http::encode_component;

/// A device signed in to the account (the desktop or phone app, wisp on a computer).
#[derive(Debug, Clone, Default)]
pub struct DeviceView {
    pub id: String,
    pub name: String,
    pub created_at: Option<i64>,
    pub last_seen_at: Option<i64>,
}

/// One way the account signs in.
#[derive(Debug, Clone, Default)]
pub struct IdentityView {
    pub provider: String,
    pub login: Option<String>,
    pub email: Option<String>,
}

/// The Telegram bot that routes `on laptop …` (`crate::route`). What was given never shows again.
#[derive(Debug, Clone, Default)]
pub struct RouteView {
    pub set: bool,
    pub bot: Option<String>,
    pub senders: Vec<String>,
    /// Telegram no longer sends this bot's messages to the grid
    pub moved: bool,
    /// the cloud wisp has the same bot
    pub shared: bool,
}

#[derive(Debug, Clone, Default)]
pub struct AccountPage {
    pub user: PageUser,
    pub devices: Vec<DeviceView>,
    pub computers: Vec<ComputerView>,
    pub identities: Vec<IdentityView>,
    pub providers: Vec<Provider>,
    /// `None`: this grid routes no channels
    pub route: Option<RouteView>,
    pub csrf: String,
    pub flash: String,
    pub tone: Tone,
    pub now_ms: i64,
}

fn route_warn(title: &str, text: &str) -> String {
    format!(r#"<div class="r route-warn"><span class="ic">{SHIELD}</span><div class="tx"><b>{title}</b><small>{text}</small></div></div>"#)
}

fn route_section(route: &RouteView, computers: &[ComputerView], hidden: &str) -> String {
    let name = esc(computers.first().map_or("laptop", |c| c.name.as_str()));
    let n = route.senders.len();
    let inner = if route.set {
        let bot = route.bot.as_deref().map_or_else(|| "Your bot".to_owned(), |b| format!("@{}", esc(b)));
        let who = if n == 1 { "One person".to_owned() } else { format!("{n} people") };
        let moved = if route.moved {
            route_warn(
                "The webhook moved",
                "Telegram no longer sends this bot’s messages to the grid, so they aren’t reaching your computers. Something else with this bot’s token set it. Remove the bot here and connect it again.",
            )
        } else {
            String::new()
        };
        let shared = if route.shared {
            route_warn(
                "Your cloud wisp also has this bot",
                "Anything on your cloud wisp can read this bot’s token, and with it your messages and reports, or speak as this bot. It can’t start anything on your computers. Make a new bot with BotFather, then Remove this one and connect that.",
            )
        } else {
            String::new()
        };
        format!(
            r#"<div class="r wrap"><span class="ic">{SHIELD}</span><div class="tx"><b>{bot}</b><small>{who} can send: {senders}</small></div><form class="inline" method="post" action="/channels/route/remove">{hidden}<button class="ghost quiet">Remove</button></form></div>{moved}{shared}"#,
            senders = esc(&route.senders.join(", "))
        )
    } else {
        format!(
            r#"<form class="route-f" method="post" action="/channels/route" autocomplete="off">{hidden}
        <label><span>Bot token</span><input class="input" name="token" type="password" placeholder="From BotFather" autocomplete="off" autocapitalize="none" spellcheck="false" required></label>
        <label><span>Who may send</span><input class="input" name="senders" inputmode="numeric" placeholder="Your Telegram user id" autocomplete="off" required></label>
        <p class="hint">Make a new bot for this with BotFather, not the one your cloud wisp uses. Anything on your cloud wisp can read that bot’s token, and with it what goes through here. The grid keeps this token sealed and sets the webhook with a secret of its own.</p>
        <button class="primary">Connect</button></form>"#
        )
    };
    format!(
        r#"<h2 class="sec" id="route">Telegram to your computers</h2>
      <p class="hint">Tell your bot <code>on {name} fix the login</code> and it runs on that computer, once that computer has switched on <b>Settings → Notifications → Accept tasks from channels</b> itself. The grid reads these messages and your cloud wisp is never asked. The bot does nothing else: anything else gets a line saying so.</p>
      <div class="group" data-live="route">{inner}</div>

      "#
    )
}

fn devices(p: &AccountPage, hidden: &str) -> String {
    if p.devices.is_empty() {
        return format!(
            r#"<div class="r"><span class="ic">{LAPTOP}</span><div class="tx"><b>No devices yet</b><small>wisp on a computer and the phone app sign in here once, with a code.</small></div></div>"#
        );
    }
    p.devices
        .iter()
        .map(|d| {
            let on = p.computers.iter().find(|c| c.device_id == d.id).map_or_else(String::new, |c| format!("On the grid as {} · ", esc(&c.name)));
            let icon = if d.name.to_lowercase().contains("phone") { PHONE } else { LAPTOP };
            format!(
                r#"<div class="r"><span class="ic">{icon}</span><div class="tx"><b>{name}</b><small>{on}added {added} · last used {used}</small></div>
            <form class="inline" method="post" action="/devices/{id}/revoke">{hidden}<button class="ghost quiet">Remove</button></form></div>"#,
                name = esc(&d.name),
                added = ago(d.created_at, p.now_ms),
                used = ago(d.last_seen_at, p.now_ms),
                id = esc(&d.id),
            )
        })
        .collect()
}

fn ways(p: &AccountPage, hidden: &str) -> String {
    let label = |id: &str| p.providers.iter().find(|x| x.id == id).map_or_else(|| id.to_owned(), |x| x.label.clone());
    let many = p.identities.len() > 1;
    let mut out: String = p
        .identities
        .iter()
        .map(|i| {
            let who = i.login.as_deref().filter(|s| !s.is_empty()).or(i.email.as_deref()).unwrap_or_default();
            let unlink = if many {
                format!(r#"<form class="inline" method="post" action="/identities/unlink">{hidden}<input type="hidden" name="provider" value="{}"><button class="ghost">Disconnect</button></form>"#, esc(&i.provider))
            } else {
                String::new()
            };
            format!(
                r#"<div class="r"><span class="ic">{}</span><div class="tx"><b>{}</b><small>{}</small></div>
          {unlink}</div>"#,
                logo(&i.provider),
                esc(&label(&i.provider)),
                esc(who)
            )
        })
        .collect();
    out.push_str("\n        ");
    for prov in p.providers.iter().filter(|x| x.id != "dev" && !p.identities.iter().any(|i| i.provider == x.id)) {
        out.push_str(&format!(
            r#"<div class="r"><span class="ic">{}</span><div class="tx"><b>{}</b><small>Connect it too, and either one signs you in</small></div><a class="ghost line" href="/auth/{}/start?link=1">Connect</a></div>"#,
            logo(&prov.id),
            esc(&prov.label),
            encode_component(&prov.id)
        ));
    }
    out
}

pub fn account_page(cfg: &PageCfg, p: &AccountPage) -> String {
    let hidden = hidden(&p.csrf);
    let u = &p.user;
    let shown = u.name.as_deref().filter(|n| !n.is_empty()).unwrap_or(&u.handle);
    let sub = u.email.as_deref().filter(|e| !e.is_empty()).unwrap_or(&u.handle);
    let route_link = if p.route.is_some() { r##"<a href="#route">Telegram to your computers</a>"## } else { "" };
    let route = p.route.as_ref().map_or_else(String::new, |r| route_section(r, &p.computers, &hidden));
    let handle = esc(&u.handle);
    let body = format!(
        r##"{flash}<div class="acct">
      <aside class="a-side">
        <div class="a-who">{av}<div><b title="{shown}">{shown}</b><small title="{sub}">{sub}</small></div></div>
        <nav class="a-nav" aria-label="Account"><a href="#devices">Signed-in devices</a>{route_link}<a href="#ways">How you sign in</a><a href="#out">Sign out</a><a href="#delete">Delete your account</a></nav>
      </aside>
      <div class="a-main">
      <h1 class="h1">Account</h1>
      <h2 class="sec" id="devices">Signed-in devices</h2>
      <p class="hint">Apps that can open your wisps. Removing a computer’s device also takes it off the grid.</p>
      <div class="group" data-live="devices">{devices}</div>

      {route}<h2 class="sec" id="ways">How you sign in</h2>
      <div class="group">{ways}
      </div>

      <h2 class="sec" id="out">Sign out</h2>
      <div class="group">
        <div class="r wrap"><span class="ic">{GLOBE}</span><div class="tx"><b>This browser</b><small>Your cloud wisp keeps running.</small></div><form class="inline" method="post" action="/signout">{hidden}<button class="ghost line">Sign out</button></form></div>
        <div class="r wrap"><span class="ic">{SHIELD}</span><div class="tx"><b>Every browser</b><small>Signs this account out of the grid in every browser. Devices stay signed in: remove them above.</small></div><form class="inline" method="post" action="/signout?all=1">{hidden}<button class="ghost line">Sign out everywhere</button></form></div>
      </div>

      <h2 class="sec" id="delete">Delete your account</h2>
      <div class="group"><form class="r del" method="post" action="/account/delete"><span class="ic">{TRASH}</span><div class="tx"><b>Delete your account and your cloud wisp</b><small>Your cloud wisp, its files and your agents’ sign-ins there are deleted for good. Your computers keep their own wisp.</small></div>
        {hidden}<input class="input" name="confirm" placeholder="Type {handle}" aria-label="Type {handle} to confirm" autocomplete="off" autocapitalize="none" spellcheck="false" required pattern="{handle}"><button class="ghost line danger">Delete</button></form></div>
      </div></div>
      {LIVE}"##,
        flash = flash(&p.flash, p.tone),
        av = avatar(u),
        shown = esc(shown),
        sub = esc(sub),
        devices = devices(p, &hidden),
        ways = ways(p, &hidden),
    );
    app_page(&AppPage { user: Some(u), csrf: &p.csrf, tab: Tab::Account, ..AppPage::new(cfg, "Account", &body) })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page() -> AccountPage {
        AccountPage {
            user: PageUser { handle: "ada".into(), email: Some("ada@example.com".into()), ..PageUser::default() },
            identities: vec![IdentityView { provider: "github".into(), login: Some("ada".into()), email: None }],
            providers: vec![
                Provider { id: "github".into(), label: "GitHub".into() },
                Provider { id: "google".into(), label: "Google".into() },
                Provider { id: "dev".into(), label: "Dev".into() },
            ],
            now_ms: 1_793_000_000_000,
            ..AccountPage::default()
        }
    }

    #[test]
    fn one_way_in_cant_be_disconnected_and_others_can_be_linked() {
        let a = account_page(&PageCfg::default(), &page());
        assert!(!a.contains("Disconnect"));
        assert!(a.contains(r#"href="/auth/google/start?link=1""#));
        assert!(!a.contains("/auth/dev/start"));
        assert!(a.contains("No devices yet"));
        assert!(!a.contains(r##"href="#route""##));
        assert!(a.contains(r#"pattern="ada""#));
    }

    #[test]
    fn devices_say_which_computer_they_are() {
        let mut p = page();
        p.devices =
            vec![DeviceView { id: "d1".into(), name: "Ada’s iPhone".into(), created_at: Some(p.now_ms - 90_000), last_seen_at: None }];
        p.computers = vec![ComputerView { device_id: "d1".into(), name: "mac".into(), ..ComputerView::default() }];
        p.route =
            Some(RouteView { set: true, bot: Some("ada_bot".into()), senders: vec!["1".into(), "2".into()], moved: true, shared: false });
        let a = account_page(&PageCfg::default(), &p);
        assert!(a.contains("On the grid as mac · added 2 min ago · last used never"));
        assert!(a.contains("<b>@ada_bot</b><small>2 people can send: 1, 2</small>"));
        assert!(a.contains("The webhook moved"));
        assert!(!a.contains("also has this bot"));
    }
}
