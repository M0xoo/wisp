//! The grid's signed-in pages and their forms (v1 grid/server.js: `/`, `/account`, `/go`, and the POSTs under
//! them). Only on the grid's own origin, with the session cookie and its CSRF token: never at
//! `<handle>/_grid/*`, which a page a box serves could reach.
//!
//! - `GET /`: home (your cloud wisp, your computers, your published apps), or the public page when signed out.
//! - `GET /account`: signed-in devices, the Telegram bot for `on laptop` (when this grid routes), how you
//!   sign in, sign out, delete.
//! - `GET /go[?computer=]`: to your cloud wisp, or one of your computers.
//! - `POST /instance/stop`, `/computers/:id/remove`, `/sites/:key/remove`, `/devices/:id/revoke`,
//!   `/identities/unlink`, `/channels/route`, `/channels/route/remove`, `/signout[?all=1]`, `/account/delete`:
//!   each answers with a redirect back and a flash line (`?m=…&tone=bad`), as v1 did.

use std::sync::Arc;

use http::HeaderMap;
use rusqlite::{OptionalExtension, params};
use serde_json::Value;

use super::{COOKIE, Grid, Who, query};
use crate::boxhost::BoxHost;
use crate::error::{Result, bad};
use crate::http::{CookieOptions, Resp, add_cookie, cookie, cookies, encode_component, html, parse_body, redirect};
use crate::pages::{self, AccountPage, ComputerView, DeviceView, HomePage, IdentityView, InstanceView, MachineView, MessagePage, Offers, PageUser, RouteView, SiteView, Tone};
use crate::rows::{BoxUser, UserRow};

/// Where a form goes back to, with what happened.
fn back(to: &str, msg: &str, bad_tone: bool) -> Resp {
    let tone = if bad_tone { "&tone=bad" } else { "" };
    redirect(&format!("{to}?m={}{tone}", encode_component(msg)), &[])
}

fn page_user(u: &UserRow) -> PageUser {
    PageUser { handle: u.handle.clone(), name: u.name.clone(), email: u.email.clone(), avatar: u.avatar.clone() }
}

impl Grid {
    /// The signed-in pages' routes, or None for any other path.
    pub(super) async fn pages_route(self: &Arc<Self>, method: &str, parts: &[&str], q: &str, h: &HeaderMap, bytes: &[u8], who: &Who) -> Option<Result<Resp>> {
        let user = match who {
            Who::Session(u) => Some(u.clone()),
            _ => None,
        };
        let r = match (method, parts) {
            ("GET", []) => match &user {
                Some(u) => self.home(u, h, q),
                None => Ok(html(200, pages::message_page(&self.page, &MessagePage { title: self.cfg.name.clone(), text: "Share and reach your wisps from anywhere.".into(), link: Some(("/gallery".into(), "See what people are building".into())), tone: Tone::Plain }), &[])),
            },
            ("GET", ["account"]) => match &user {
                Some(u) => self.account(u, h, q),
                None => Ok(redirect("/signin?return=%2Faccount", &[])),
            },
            ("GET", ["go"]) => match &user {
                Some(u) => self.go(u, q),
                None => Ok(redirect("/signin", &[])),
            },
            ("POST", ["instance", "stop"] | ["computers" | "sites", _, "remove"] | ["devices", _, "revoke"] | ["identities", "unlink"] | ["channels", "route", ..] | ["signout"] | ["account", "delete"]) => match &user {
                Some(u) => self.form(u, parts, q, h, bytes).await,
                None => Ok(redirect("/signin", &[])),
            },
            _ => return None,
        };
        Some(r)
    }

    fn csrf_of(h: &HeaderMap) -> String {
        Self::csrf(&cookies(h).get(COOKIE).cloned().unwrap_or_default())
    }

    fn flash_of(q: &str) -> (String, Tone) {
        (query(q, "m").unwrap_or_default(), if query(q, "tone").as_deref() == Some("bad") { Tone::Bad } else { Tone::Plain })
    }

    fn devices_of(&self, uid: &str) -> Result<Vec<DeviceView>> {
        self.accounts.db.with(|c| {
            let mut st = c.prepare("SELECT id, name, created_at, last_seen_at FROM devices WHERE user_id = ?1 AND revoked_at IS NULL ORDER BY created_at")?;
            let rows = st.query_map([uid], |r| Ok(DeviceView { id: r.get(0)?, name: r.get(1)?, created_at: r.get(2)?, last_seen_at: r.get(3)? }))?;
            rows.collect()
        })
    }

    fn identities_of(&self, uid: &str) -> Result<Vec<IdentityView>> {
        self.accounts.db.with(|c| {
            let mut st = c.prepare("SELECT provider, login, email FROM identities WHERE user_id = ?1 ORDER BY created_at")?;
            let rows = st.query_map([uid], |r| Ok(IdentityView { provider: r.get(0)?, login: r.get(1)?, email: r.get(2)? }))?;
            rows.collect()
        })
    }

    fn computers_of(&self, uid: &str) -> Result<Vec<ComputerView>> {
        Ok(self
            .accounts
            .computers(uid)?
            .iter()
            .map(|c| ComputerView { id: c.id.clone(), device_id: c.device_id.clone(), name: c.name.clone(), url: self.cfg.instance_url(&c.label), online: self.tunnels.online(&c.id), last_seen_at: c.last_seen_at })
            .collect())
    }

    /// Your cloud wisp, as the instances table and the box host have it now.
    fn instance_of(&self, uid: &str) -> Result<InstanceView> {
        let row: Option<(Option<i64>, Option<i64>, Option<i64>)> = self.accounts.db.with(|c| c.query_row("SELECT started_at, stopped_at, next_wake_at FROM instances WHERE user_id = ?1", [uid], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).optional())?;
        let (started_at, stopped_at, next_wake_at) = row.unwrap_or_default();
        Ok(InstanceView { state: self.boxes.state(uid).as_str().to_owned(), started_at, stopped_at, next_wake_at })
    }

    fn home(&self, u: &UserRow, h: &HeaderMap, q: &str) -> Result<Resp> {
        let (flash, tone) = Self::flash_of(q);
        let sites = self
            .sites
            .list(&u.id)?
            .iter()
            .map(|s| SiteView { key: s.key.clone(), title: s.title.clone(), url: self.sites.view(s).get("url").and_then(Value::as_str).unwrap_or_default().to_owned(), files: u32::try_from(s.files).unwrap_or(0), updated_at: Some(s.updated_at) })
            .collect();
        let p = HomePage {
            user: page_user(u),
            url: self.cfg.instance_url(&u.handle),
            instance: self.instance_of(&u.id)?,
            machine: MachineView::default(),
            devices: self.devices_of(&u.id)?,
            computers: self.computers_of(&u.id)?,
            sites,
            offers: Offers { sites: self.sites.enabled, sandboxes: self.sandboxes.enabled && self.sandboxes.secrets.is_some() },
            csrf: Self::csrf_of(h),
            flash,
            tone,
            now_ms: self.clock.now_ms(),
        };
        Ok(html(200, pages::home_page(&self.page, &p), &[]))
    }

    fn account(&self, u: &UserRow, h: &HeaderMap, q: &str) -> Result<Resp> {
        let (flash, tone) = Self::flash_of(q);
        let route = if self.routes.on {
            let v = self.routes.view(&u.id).unwrap_or(Value::Null);
            Some(RouteView {
                set: v["set"].as_bool().unwrap_or(false),
                bot: v["bot"].as_str().filter(|b| !b.is_empty()).map(str::to_owned),
                senders: v["senders"].as_array().map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_owned).or_else(|| s.as_i64().map(|n| n.to_string()))).collect()).unwrap_or_default(),
                moved: v["moved"].as_bool().unwrap_or(false),
                shared: v["shared"].as_bool().unwrap_or(false),
            })
        } else {
            None
        };
        let p = AccountPage {
            user: page_user(u),
            devices: self.devices_of(&u.id)?,
            computers: self.computers_of(&u.id)?,
            identities: self.identities_of(&u.id)?,
            providers: self.page_providers(),
            route,
            csrf: Self::csrf_of(h),
            flash,
            tone,
            now_ms: self.clock.now_ms(),
        };
        Ok(html(200, pages::account_page(&self.page, &p), &[]))
    }

    /// `/go`: your cloud wisp, or `?computer=<id>` one of your computers (online or not: its own page says).
    fn go(&self, u: &UserRow, q: &str) -> Result<Resp> {
        if let Some(id) = query(q, "computer") {
            let c = self.accounts.computer(&id)?.filter(|c| c.user_id == u.id).ok_or_else(|| bad("No such computer.", 404))?;
            return Ok(redirect(&self.cfg.instance_url(&c.label), &[]));
        }
        Ok(redirect(&self.cfg.instance_url(&u.handle), &[]))
    }

    #[allow(clippy::many_single_char_names)] // u the user, q the query, h the headers, b the body
    async fn form(self: &Arc<Self>, u: &UserRow, parts: &[&str], q: &str, h: &HeaderMap, bytes: &[u8]) -> Result<Resp> {
        let b = parse_body(h, bytes)?;
        let field = |k: &str| b.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
        let session = cookies(h).get(COOKIE).cloned().unwrap_or_default();
        if field("csrf") != Self::csrf(&session) {
            return Err(bad("That form is stale. Go back and try again.", 403));
        }
        match parts {
            ["instance", "stop"] => {
                let was = self.boxes.stop(&u.id, "user").await?;
                Ok(back("/", if was { "Your cloud wisp went to sleep. Opening it wakes it." } else { "Your cloud wisp was already asleep." }, false))
            }
            ["computers", id, "remove"] => {
                let n = self.accounts.db.with(|c| c.execute("DELETE FROM computers WHERE id = ?1 AND user_id = ?2", params![id, u.id]))?;
                Ok(back("/", if n > 0 { "Taken off the grid. wisp on it keeps running." } else { "That computer was already off the grid." }, n == 0))
            }
            ["sites", key, "remove"] => {
                let gone = self.sites.remove(&u.id, key)?;
                Ok(back("/", if gone { "Unpublished: that link no longer works." } else { "That app was already unpublished." }, !gone))
            }
            ["devices", id, "revoke"] => {
                let gone = self.accounts.revoke_device(&u.id, id)?;
                Ok(back("/account", if gone { "Removed. That device is signed out." } else { "That device was already removed." }, !gone))
            }
            ["identities", "unlink"] => {
                let provider = field("provider");
                let ways = self.identities_of(&u.id)?.len();
                if ways < 2 {
                    return Ok(back("/account", "That's your only way in: link another before you disconnect it.", true));
                }
                self.accounts.db.with(|c| c.execute("DELETE FROM identities WHERE user_id = ?1 AND provider = ?2", params![u.id, provider]))?;
                Ok(redirect("/account", &[]))
            }
            ["channels", "route"] => match self.routes.set(u, &field("token"), &field("senders")).await {
                Ok(name) => Ok(back("/account", &if name.is_empty() { "Your bot is connected.".to_owned() } else { format!("@{name} is connected.") }, false)),
                Err(e) if e.status() == 400 || e.status() == 404 => Ok(back("/account", &e.to_string(), true)),
                Err(e) => {
                    tracing::warn!("grid: route for {}: {e}", u.handle);
                    Ok(back("/account", "That didn’t work: Telegram couldn’t be reached. Try again.", true))
                }
            },
            ["channels", "route", "remove"] => {
                self.routes.remove(u).await?;
                Ok(back("/account", "Removed. That bot no longer reaches your computers.", false))
            }
            ["signout"] => {
                let all = query(q, "all").as_deref() == Some("1");
                self.accounts.db.with(|c| {
                    if all {
                        c.execute("DELETE FROM sessions WHERE user_id = ?1", [&u.id])
                    } else {
                        c.execute("DELETE FROM sessions WHERE id_hash = ?1", [crate::accounts::sha256_hex(&session)])
                    }
                })?;
                Ok(self.cleared(redirect("/", &[])))
            }
            ["account", "delete"] => {
                if field("confirm").trim().to_lowercase() != u.handle {
                    return Ok(back("/account", &format!("Type {} to delete your account.", u.handle), true));
                }
                let bu = BoxUser { id: u.id.clone(), handle: u.handle.clone(), sandbox: None, owner: None };
                if let Err(e) = self.boxes.remove(&bu).await {
                    tracing::warn!("grid: deleting {}'s box: {e}", u.handle);
                }
                self.sites.remove_all(&u.id)?;
                self.accounts.db.with(|c| c.execute("DELETE FROM users WHERE id = ?1", [&u.id]))?;
                Ok(self.cleared(redirect(&format!("/signin?m={}", encode_component("Your account is deleted.")), &[])))
            }
            _ => Err(bad("not found", 404)),
        }
    }

    /// The response with this browser's session cookie dropped.
    fn cleared(&self, mut r: Resp) -> Resp {
        add_cookie(&mut r, &cookie(COOKIE, "", CookieOptions { secure: self.cfg.secure, max_age: Some(0), path: None, framed: false }));
        r
    }
}
