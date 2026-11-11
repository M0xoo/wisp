//! The grid's one HTTP server (v1 grid/server.js, the parts ported so far): every address of `hosts`, on
//! one port.
//!
//! - `<domain>`: the device API (RFC 8628 sign-in, computers and their tunnels), the shares API and their
//!   pages (`/s/<id>`), the gallery, teams, sign-in with GitHub, Google or OIDC (`edge_signin.rs`), and the dev
//!   sign-in when `auth.dev` is on.
//! - `<handle>.<domain>`: that user's wisp in its box, started by hostd on a real request; a passive one
//!   (`x-wisp-passive: 1`, or v1's `x-wisp-relay: 1`) to a stopped box answers 503 asleep and wakes
//!   nothing. `/_grid/state` says how the box is without waking it, `/_grid/stop` puts it to sleep.
//! - `<name>--<handle>.<domain>` and `p<port>--<name>--<handle>`: a computer, and a page on it, through
//!   the tunnel it holds open (a box's credential never reaches one: `trust`).
//!
//! Who's asking is a device token (`Authorization: Bearer wgd_…`) or the grid's session cookie; each check
//! names its reach in `trust`, so adding a route means choosing who reaches it.
use std::collections::HashSet;
use std::net::SocketAddr;
use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use bytes::Bytes;
use http::{HeaderMap, Method};
use http_body_util::BodyExt as _;
use hyper::body::Incoming;
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::{TokioExecutor, TokioIo};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

use crate::accounts::{Accounts, Poll};
use crate::boxhost::{BoxHost, BoxState};
use crate::clock::SharedClock;
use crate::config::GridConfig;
use crate::db::Db;
use crate::error::{GridError, Result, bad};
use crate::hostd::ProcessHost;
use crate::hosts::{HostKind, HostLookups, PreviewOf, host_kind, root_hosts};
use crate::http::{Body, Resp, cookies, empty, header_str, html, json, json_with, parse_body, read_bytes, redirect, safe_path};
use crate::pages::{self, ActivatePage, DeviceAsk, MessagePage, PageCfg, PageUser, ShareCard, Tone};
use crate::rows::{BoxUser, ComputerRow, SandboxRow, SiteRow, UserRow};
use crate::shares::{Patch, Put, Refused, Shares, parse_ref};
use crate::teams::Teams;
use crate::trust::{Credential, Reach, Verdict, may};
use crate::tunnels::{TUNNEL_PROTOCOL, Tunnels};

#[path = "edge_sandboxes.rs"]
mod sandboxes;
#[path = "edge_signin.rs"]
mod signin;
#[path = "edge_sites.rs"]
mod sites;
#[path = "edge_inbox.rs"]
mod inbox;
#[path = "edge_route.rs"]
mod route;
#[path = "edge_mail.rs"]
mod mail;
pub use signin::{Reqwest, SignIn};

/// The grid's session cookie.
pub const COOKIE: &str = "wisp_grid";
/// A request that mustn't count as use of a box (a watching peer's sync stream).
pub const PASSIVE: &str = "x-wisp-passive";

pub struct Grid {
    pub cfg: GridConfig,
    pub db: Arc<Db>,
    pub clock: SharedClock,
    pub accounts: Accounts,
    pub shares: Shares,
    pub teams: Teams,
    pub tunnels: Arc<Tunnels>,
    pub boxes: Arc<ProcessHost>,
    roots: HashSet<String>,
    page: PageCfg,
    client: Client<HttpConnector, Body>,
    /// sign-in with GitHub, Google or an OIDC issuer
    pub signin: SignIn,
    pub sandboxes: crate::sandboxes::Sandboxes,
    /// apps published from My Stuff (`sites.rs`)
    pub sites: crate::sites::Sites,
    /// channels' messages held for sleeping boxes (`inbox.rs`)
    pub inbox: crate::inbox::Inbox,
    /// `on laptop` through the grid's own bot (`route.rs`)
    pub routes: crate::route::Routes,
    /// mail to a box's secret address (`mail/service.rs`), when grid.json has `mail`
    pub mail: Option<Arc<crate::mail::service::MailService>>,
}

impl std::fmt::Debug for Grid {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Grid").field("domain", &self.cfg.domain).finish_non_exhaustive()
    }
}

impl HostLookups for Grid {
    fn domain(&self) -> &str {
        &self.cfg.domain
    }
    fn root_hosts(&self) -> &HashSet<String> {
        &self.roots
    }
    fn previews(&self) -> bool {
        false
    }
    fn site(&self, label: &str) -> Option<SiteRow> {
        self.sites.by_label(label).ok().flatten()
    }
    fn sandbox(&self, label: &str) -> Option<SandboxRow> {
        self.sandboxes.by_label(label).ok().flatten()
    }
    fn computer(&self, label: &str) -> Option<ComputerRow> {
        self.accounts.computer_by_label(label).ok().flatten()
    }
    fn handle(&self, label: &str) -> bool {
        self.accounts.user_by_handle(label).ok().flatten().is_some()
    }
}

/// Who's asking.
#[derive(Debug, Clone)]
enum Who {
    Nobody,
    /// a device token (wisp on a computer)
    Device(UserRow, crate::rows::DeviceRow),
    /// the grid's own cookie (a browser)
    Session(UserRow),
    /// `Box <handle> <secret>`: a box asking for itself (its user, the secret checked against the running box's)
    Box(UserRow),
}

impl Who {
    fn user(&self) -> Option<&UserRow> {
        match self {
            Self::Device(u, _) | Self::Session(u) | Self::Box(u) => Some(u),
            Self::Nobody => None,
        }
    }
    fn credential(&self) -> Option<Credential> {
        match self {
            Self::Device(..) => Some(Credential::Device),
            Self::Session(_) => Some(Credential::Session),
            Self::Box(_) => Some(Credential::Box),
            Self::Nobody => None,
        }
    }
}

fn err(e: &GridError) -> Resp {
    json(e.status(), &json!({ "error": e.to_string() }))
}

fn no(v: &Verdict) -> Option<Resp> {
    match v {
        Verdict::Ok => None,
        Verdict::No(why) => Some(json(403, &json!({ "error": why }))),
    }
}

/// `/a/b/c?x` → (`["a","b","c"]`, `"x"`).
fn split(path_q: &str) -> (Vec<&str>, &str) {
    let (p, q) = path_q.split_once('?').unwrap_or((path_q, ""));
    (p.split('/').filter(|s| !s.is_empty()).collect(), q)
}

fn query(q: &str, k: &str) -> Option<String> {
    q.split('&').filter_map(|kv| kv.split_once('=')).find(|(a, _)| *a == k).map(|(_, v)| url::form_urlencoded::parse(format!("x={v}").as_bytes()).next().map(|(_, v)| v.into_owned()).unwrap_or_default())
}

fn incoming(b: Incoming) -> Body {
    b.map_err(std::io::Error::other).boxed()
}

impl Grid {
    pub fn new(cfg: GridConfig, db: Arc<Db>, clock: SharedClock, boxes: Arc<ProcessHost>) -> Arc<Self> {
        let teams = Teams { db: db.clone(), clock: clock.clone() };
        let shares = Shares { db: db.clone(), clock: clock.clone(), teams: teams.clone(), public_url: cfg.public_url.clone() };
        let accounts = Accounts { db: db.clone(), clock: clock.clone() };
        let roots = root_hosts(&cfg.domain, &cfg.port_suffix, cfg.listen.port);
        let page = PageCfg::of(&cfg);
        let client = Client::builder(TokioExecutor::new()).build_http();
        let signin = SignIn::new(&cfg);
        // the master key seals a sandbox's token and sign-ins; without one, sandboxes are off and say why
        let secrets = crate::secrets::Secrets::open(db.clone(), &cfg.data_dir, &crate::config::process_env()).map(Arc::new).map_err(|e| tracing::warn!("grid: no master key, so no sandboxes: {e}")).ok();
        let sb_cfg = cfg.sandboxes.clone().unwrap_or_default();
        let sandboxes = crate::sandboxes::Sandboxes { db: db.clone(), clock: clock.clone(), secrets: secrets.clone(), enabled: sb_cfg.enabled != Some(false), per_user: sb_cfg.per_user.unwrap_or(10) };
        let sb = sandboxes.clone();
        // a sandbox's box starts with its owner's sandbox env and sign-ins; the user's own box never does
        boxes.set_env_for(Arc::new(move |u: &BoxUser| u.owner.as_deref().filter(|_| u.sandbox.is_some()).map(|o| sb.env_for(o)).unwrap_or_default()));
        let urls = cfg.clone();
        let sites = crate::sites::Sites::new(db.clone(), clock.clone(), &cfg.data_dir, cfg.file_cfg.sites.as_ref(), Arc::new(move |l: &str| urls.instance_url(l)));
        let inbox = crate::inbox::Inbox::new(db.clone(), clock.clone(), secrets.clone(), boxes.clone(), Arc::new(crate::inbox::HttpDeliver::default()), inbox_opts(cfg.file_cfg.channels.as_ref()), {
            let urls = cfg.clone();
            Arc::new(move |h: &str| urls.instance_url(h))
        });
        let tunnels = Arc::new(Tunnels::default());
        let ch = cfg.file_cfg.channels.clone().unwrap_or_default();
        let routes = crate::route::Routes {
            db: db.clone(),
            clock: clock.clone(),
            secrets: secrets.clone(),
            telegram: Arc::new(crate::route::HttpTelegram { base: ch.telegram_api.clone().unwrap_or_else(|| "https://api.telegram.org".into()), client: reqwest::Client::new() }),
            computers: Arc::new(route::TunnelComputers(tunnels.clone())),
            public_url: cfg.public_url.clone(),
            on: inbox.opts.enabled && ch.route == Some(true),
        };
        let mail = mail_of(&cfg, &db, &clock, &inbox);
        if let Some(m) = mail.clone() {
            let _ = inbox.delivered.set(Arc::new(move |user: &str, d: &crate::inbox::Delivery| {
                if d.channel == "email"
                    && let Err(e) = m.delivered(user, &d.headers, &d.body)
                {
                    tracing::warn!("grid: mail: a thread wasn’t kept: {e}");
                }
            }));
        }
        Arc::new(Self { cfg, db, clock, accounts, shares, teams, tunnels, boxes, roots, page, client, signin, sandboxes, sites, inbox, routes, mail })
    }

    fn who(&self, h: &HeaderMap) -> Who {
        let auth = header_str(h, "authorization");
        if let Some(rest) = auth.strip_prefix("Box ") {
            // the running box's own secret, never a stopped one's: a box asks only for itself
            let (handle, secret) = rest.trim().split_once(' ').unwrap_or((rest.trim(), ""));
            return match self.accounts.user_by_handle(handle).ok().flatten() {
                Some(u) if !secret.is_empty() && self.boxes.secret(&u.id).is_some_and(|s| crate::secrets::safe_equal(&s, secret)) => Who::Box(u),
                _ => Who::Nobody,
            };
        }
        if let Ok(Some((u, d))) = self.accounts.device(auth) {
            return Who::Device(u, d);
        }
        if let Some(c) = cookies(h).get(COOKIE)
            && let Ok(Some(u)) = self.accounts.session(c)
        {
            return Who::Session(u);
        }
        Who::Nobody
    }

    fn csrf(cookie: &str) -> String {
        crate::accounts::sha256_hex(&format!("csrf:{cookie}")).chars().take(24).collect()
    }

    fn instance(&self, u: &UserRow) -> Value {
        json!({ "url": self.cfg.instance_url(&u.handle), "name": "Cloud", "handle": u.handle })
    }

    /// One request, whatever its address.
    pub async fn handle(self: &Arc<Self>, req: http::Request<Incoming>) -> Resp {
        let host = req.headers().get("host").and_then(|h| h.to_str().ok()).unwrap_or_default().to_owned();
        let kind = host_kind(&host, self.as_ref());
        let out = match kind {
            HostKind::Root => self.root(req).await,
            HostKind::Edge { handle } => match req.uri().path().strip_prefix("/_in/").map(str::to_owned) {
                Some(tok) => self.inbox_in(req, &handle, &tok).await,
                None => self.edge(req, &handle).await,
            },
            HostKind::Computer(c) => self.computer_reach(req, &c, None).await,
            HostKind::Preview(p) => match p.of {
                PreviewOf::Computer(c) => self.computer_reach(req, &c, Some(p.port)).await,
                _ => Ok(json(404, &json!({ "error": "Pages in boxes aren't shown on this grid." }))),
            },
            HostKind::Sandbox(sb) => self.sandbox_reach(req, &sb).await,
            HostKind::Site(site) => Ok(self.site_reach(&req, site.as_ref())),
            HostKind::Unknown => Ok(json(421, &json!({ "error": "This grid doesn't serve that address." }))),
        };
        out.unwrap_or_else(|e| err(&e))
    }

    // --- <domain> -------------------------------------------------------------------------------------

    async fn root(self: &Arc<Self>, req: http::Request<Incoming>) -> Result<Resp> {
        let method = req.method().clone();
        let path_q = req.uri().path_and_query().map(|p| p.as_str().to_owned()).unwrap_or_default();
        let (parts, q) = split(&path_q);
        let who = self.who(req.headers());
        if parts.first() == Some(&"api") && parts.get(1) == Some(&"computers") && parts.len() == 4 && parts[3] == "tunnel" {
            return self.tunnel(req, &who, parts[2]);
        }
        // an app's bundle may be bigger than any other body: read up to the sites' own cap
        if parts.first() == Some(&"api") && parts.get(1) == Some(&"sites") && parts.len() <= 3 {
            let key = parts.get(2).map(|k| (*k).to_owned());
            let q = q.to_owned();
            return self.sites_route(req, &who, key.as_deref(), &q).await;
        }
        let (head, body) = req.into_parts();
        let bytes = read_bytes(body, crate::shares::MAX_BYTES * 2).await?;
        match (method.as_str(), parts.as_slice()) {
            ("POST", ["api", "device", "code"]) => {
                let b = parse_body(&head.headers, &bytes)?;
                let name = b.get("name").and_then(Value::as_str).unwrap_or_default();
                let mut v = self.accounts.device_code(name)?;
                let code = v["user_code"].as_str().unwrap_or_default().to_owned();
                v["verification_uri"] = json!(format!("{}/activate", self.cfg.public_url));
                v["verification_uri_complete"] = json!(format!("{}/activate?code={code}", self.cfg.public_url));
                Ok(json(200, &v))
            }
            ("POST", ["api", "device", "token"]) => self.device_token(&head.headers, &bytes),
            ("GET" | "POST", ["activate"]) => self.activate(&method, &head.headers, &bytes, q),
            ("GET", ["auth", "dev"]) => self.dev_sign_in(q),
            ("GET", ["signin"]) => Ok(self.signin_route(&head.headers, q)),
            ("GET", ["auth", id, "start"]) => self.auth_start(&head.headers, id, q).await,
            ("GET", ["auth", id, "callback"]) => Ok(self.auth_callback(&head.headers, id, q).await),
            ("GET", ["api", "me"]) => {
                let Who::Device(u, _) = &who else { return Err(bad("Sign in first.", 401)) };
                let computers: Vec<Value> = self.accounts.computers(&u.id)?.iter().map(|c| self.computer_view(c)).collect();
                Ok(json(200, &json!({ "user": { "handle": u.handle, "name": u.name }, "instance": self.instance(u), "computers": computers, "teams": self.teams.of(&u.id)? })))
            }
            ("POST", ["api", "computers"]) => {
                let Who::Device(user, device) = &who else { return Err(bad("Sign in with this computer first.", 401)) };
                if let Some(r) = no(&may(Credential::Device, Reach::GridDevice)) {
                    return Ok(r);
                }
                let body = parse_body(&head.headers, &bytes)?;
                let comp = self.accounts.add_computer(user, device, body.get("name").and_then(Value::as_str).unwrap_or_default())?;
                Ok(json(200, &self.computer_view(&comp)))
            }
            ("GET", ["api", "computers"]) => {
                let Some(u) = who.user() else { return Err(bad("Sign in first.", 401)) };
                let list: Vec<Value> = self.accounts.computers(&u.id)?.iter().map(|c| self.computer_view(c)).collect();
                Ok(json(200, &json!(list)))
            }
            (_, ["api", "shares", ..] | ["api", "gallery"] | ["s", ..]) | ("GET", ["gallery"]) => self.shares_route(&method, &parts, q, &head.headers, &bytes, &who),
            (_, ["api", "sandboxes", ..]) => self.sandboxes_route(&method, &parts, &head.headers, &bytes, &who).await,
            (_, ["api", "teams", ..]) => self.teams_route(&method, &parts, &head.headers, &bytes, &who),
            (_, ["api", "channels", which @ ("url" | "rotate")]) => self.channels_route(&method, which, q, &head.headers, &bytes, &who),
            (_, ["api", "channels", which @ ("route" | "reply")]) => self.route_api(&method, which, &head.headers, &bytes, &who).await,
            ("POST", ["_route", tok]) => self.route_in(&head.headers, tok, &bytes),
            ("POST", ["_mail", provider]) => self.mail_in(provider, &bytes).await,
            ("POST", ["api", "channels", "mail", "reply"]) => {
                let b = parse_body(&head.headers, &bytes)?;
                self.mail_reply(&Value::Object(b), &who).await
            }
            ("GET", []) => Ok(html(200, pages::message_page(&self.page, &MessagePage { title: self.cfg.name.clone(), text: "Share and reach your wisps from anywhere.".into(), link: Some(("/gallery".into(), "See what people are building".into())), tone: Tone::Plain }), &[])),
            _ => Ok(json(404, &json!({ "error": "not found" }))),
        }
    }

    fn computer_view(&self, c: &ComputerRow) -> Value {
        json!({ "id": c.id, "name": c.name, "label": c.label, "url": self.cfg.instance_url(&c.label), "online": self.tunnels.online(&c.id) })
    }

    fn device_token(&self, h: &HeaderMap, bytes: &[u8]) -> Result<Resp> {
        let b = parse_body(h, bytes)?;
        let code = b.get("device_code").and_then(Value::as_str).unwrap_or_default();
        Ok(match self.accounts.poll(code)? {
            Poll::Token { token, user } => json(200, &json!({ "token": token, "user": { "handle": user.handle, "name": user.name }, "instance": self.instance(&user) })),
            other => json(400, &json!({ "error": other.error().unwrap_or("invalid_grant") })),
        })
    }

    /// `/activate`: a signed-in person allows (or declines) a device's code.
    fn activate(&self, method: &Method, h: &HeaderMap, bytes: &[u8], q: &str) -> Result<Resp> {
        let cookie = cookies(h).get(COOKIE).cloned().unwrap_or_default();
        let Some(user) = self.accounts.session(&cookie)? else {
            let back = format!("/activate?{q}");
            let link = if self.cfg.auth.dev && self.signin.providers.is_empty() { format!("/auth/dev?next={}", crate::http::encode_component(&back)) } else { format!("/signin?return={}", crate::http::encode_component(&back)) };
            return Ok(html(401, pages::message_page(&self.page, &MessagePage { title: "Sign in first".into(), text: "Sign in to the grid to let a device in.".into(), link: Some((link, "Sign in".into())), tone: Tone::Plain }), &[]));
        };
        let pu = PageUser { handle: user.handle.clone(), name: user.name.clone(), ..PageUser::default() };
        let csrf = Self::csrf(&cookie);
        if *method == Method::POST {
            let b = parse_body(h, bytes)?;
            let field = |k: &str| b.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
            if field("csrf") != csrf {
                return Err(bad("That form is stale. Go back and try again.", 403));
            }
            let allow = field("answer") == "allow";
            self.accounts.decide(&field("code"), &user.id, allow)?;
            let text = if allow { "It's in. You can close this page and go back to it." } else { "It wasn't let in." };
            return Ok(html(200, pages::message_page(&self.page, &MessagePage { title: if allow { "Device connected".into() } else { "Not allowed".into() }, text: text.into(), link: None, tone: Tone::Plain }), &[]));
        }
        let code = query(q, "code").unwrap_or_default();
        let device = if code.is_empty() { None } else { self.accounts.pending(&code)?.map(|name| DeviceAsk { name, user_code: crate::accounts::normal_code(&code) }) };
        let error = if !code.is_empty() && device.is_none() { "That code expired or was already used. Start again on the device.".to_owned() } else { String::new() };
        Ok(html(200, pages::activate_page(&self.page, &pu, &ActivatePage { code, device, app: false, csrf, error }), &[]))
    }

    /// `/auth/dev?handle=…&next=…`: development sign-in (only with `auth.dev`).
    fn dev_sign_in(&self, q: &str) -> Result<Resp> {
        if !self.cfg.auth.dev {
            return Err(bad("This grid signs in with a provider, not by handle.", 404));
        }
        let Some(handle) = query(q, "handle").filter(|h| !h.is_empty()) else {
            let next = query(q, "next").unwrap_or_default();
            let body = format!(r#"<form method="get" action="/auth/dev"><input class="input" name="handle" placeholder="handle" autofocus required><input type="hidden" name="next" value="{}"><button class="primary tall">Sign in</button></form>"#, pages::esc(&next));
            return Ok(html(200, pages::message_page(&self.page, &MessagePage { title: "Sign in (development)".into(), text: String::new(), link: None, tone: Tone::Plain }).replace("</h1>", &format!("</h1>{body}")), &[]));
        };
        let user = self.accounts.dev_user(&handle)?;
        let t = self.accounts.new_session(&user.id)?;
        let next = query(q, "next").unwrap_or_default();
        let mut r = redirect(safe_path(&next, "/"), &[]);
        crate::http::add_cookie(&mut r, &crate::http::cookie(COOKIE, &t, crate::http::CookieOptions { secure: self.cfg.secure, max_age: Some(30 * 86_400), path: None, framed: false }));
        Ok(r)
    }

    // --- shares, the gallery, teams -------------------------------------------------------------------

    fn read_share(&self, id: &str, q: &str, h: &HeaderMap, who: &Who, password: Option<String>, count: bool) -> Result<std::result::Result<(crate::shares::Rec, crate::shares::Content), Refused>> {
        let s = self.shares.get(id)?.ok_or_else(|| bad("There's no share with that id.", 404))?;
        let pass = password.or_else(|| h.get("x-wisp-share-password").and_then(|v| v.to_str().ok()).map(str::to_owned));
        if let Err(r) = self.shares.may_read(&s, who.user(), pass.as_deref())? {
            return Ok(Err(r));
        }
        let version = query(q, "ref").and_then(|r| parse_ref(&r));
        Ok(self.shares.read(&s, who.user(), version, count)?.map(|c| (s, c)))
    }

    fn refused(r: &Refused) -> Resp {
        match r {
            Refused::Gone(why) => json(410, &json!({ "error": format!("This share is {why}."), "gone": why })),
            Refused::Locked(how) => json(403, &json!({ "error": "This share is locked.", "locked": how })),
            Refused::NoVersion => json(404, &json!({ "error": "There's no such version." })),
        }
    }

    fn content_json(&self, s: &crate::shares::Rec, c: &crate::shares::Content) -> Result<Value> {
        Ok(json!({ "card": self.shares.card(s), "version": c.version, "ref": format!("v{}", c.version), "latest": s.version, "body": B64.encode(&c.body), "sig": c.sig, "signer": c.signer, "versions": self.shares.versions(s)? }))
    }

    #[allow(clippy::too_many_lines)] // one match over the shares API, each arm a line or two
    fn shares_route(&self, method: &Method, parts: &[&str], q: &str, h: &HeaderMap, bytes: &[u8], who: &Who) -> Result<Resp> {
        let publisher = || -> Result<&UserRow> {
            let c = who.credential().ok_or_else(|| bad("Sign in first.", 401))?;
            if let Verdict::No(why) = may(c, Reach::GridPublish) {
                return Err(bad(why, 403));
            }
            who.user().ok_or_else(|| bad("A box shares through its owner's wisp.", 403))
        };
        match (method.as_str(), parts) {
            ("POST", ["api", "shares"]) => {
                let p: Put = serde_json::from_slice(bytes).map_err(|e| bad(format!("Bad share: {e}"), 400))?;
                Ok(json(200, &self.shares.put(publisher()?, &p)?))
            }
            ("GET", ["api", "shares"]) => Ok(json(200, &json!(self.shares.mine(&publisher()?.id)?))),
            ("PATCH", ["api", "shares", id]) => {
                let p: Patch = serde_json::from_slice(bytes).map_err(|e| bad(format!("Bad change: {e}"), 400))?;
                Ok(json(200, &self.shares.patch(publisher()?, id, &p)?))
            }
            ("DELETE", ["api", "shares", id]) => Ok(json(200, &self.shares.revoke(publisher()?, id)?)),
            ("GET", ["api", "shares", "by", handle, key]) => {
                let s = self.shares.by_name(handle, key)?.ok_or_else(|| bad(format!("There's no grid://{handle}/{key}."), 404))?;
                match self.read_share(&s.id, q, h, who, None, true)? {
                    Ok((s, c)) => Ok(json(200, &self.content_json(&s, &c)?)),
                    Err(r) => Ok(Self::refused(&r)),
                }
            }
            ("GET", ["api", "shares", id]) => match self.read_share(id, q, h, who, None, true)? {
                Ok((s, c)) => Ok(json(200, &self.content_json(&s, &c)?)),
                Err(r) => Ok(Self::refused(&r)),
            },
            ("POST", ["api", "shares", id, "import"]) => match self.read_share(id, q, h, who, None, false)? {
                Ok((s, _)) => {
                    self.shares.count_import(&s, who.user())?;
                    Ok(json(200, &json!({ "ok": true })))
                }
                Err(r) => Ok(Self::refused(&r)),
            },
            ("GET", ["api", "gallery"]) => Ok(json(200, &json!(self.shares.gallery(&query(q, "q").unwrap_or_default(), query(q, "kind").as_deref())?))),
            ("GET", ["gallery"]) => {
                let qs = query(q, "q").unwrap_or_default();
                Ok(html(200, pages::gallery_page(&self.page, &qs, &self.shares.gallery(&qs, None)?), &[]))
            }
            ("GET" | "POST", ["s", id]) => {
                let password = if *method == Method::POST { parse_body(h, bytes)?.get("password").and_then(Value::as_str).map(str::to_owned) } else { None };
                let tried = password.is_some();
                match self.read_share(id, q, h, who, password, true)? {
                    Ok((s, c)) => {
                        let content: Value = serde_json::from_slice(&c.body).unwrap_or(Value::Null);
                        let card = ShareCard { id: s.id.clone(), kind: s.kind.clone(), title: s.title.clone(), summary: s.summary.clone(), from: s.handle.clone(), version: c.version, source: format!("grid://{}/{}", s.handle, s.key) };
                        Ok(html(200, pages::share_page(&self.page, &card, &content), &[]))
                    }
                    Err(Refused::Gone(why)) => Ok(html(410, pages::gone_page(&self.page, why), &[])),
                    Err(Refused::Locked(how)) => Ok(html(403, pages::locked_page(&self.page, id, &how, tried), &[])),
                    Err(Refused::NoVersion) => Ok(json(404, &json!({ "error": "There's no such version." }))),
                }
            }
            _ => Ok(json(404, &json!({ "error": "not found" }))),
        }
    }

    fn teams_route(&self, method: &Method, parts: &[&str], h: &HeaderMap, bytes: &[u8], who: &Who) -> Result<Resp> {
        let me = who.user().ok_or_else(|| bad("Sign in first.", 401))?;
        let b = parse_body(h, bytes).unwrap_or_default();
        let f = |k: &str| b.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
        match (method.as_str(), parts) {
            ("POST", ["api", "teams"]) => Ok(json(200, &self.teams.create(me, &f("slug"), &f("name"))?)),
            ("GET", ["api", "teams"]) => Ok(json(200, &json!(self.teams.of(&me.id)?))),
            ("GET", ["api", "teams", slug]) => {
                if self.teams.role(&me.id, slug)?.is_none() {
                    return Err(bad(format!("You aren't in {slug}."), 403));
                }
                Ok(json(200, &json!({ "slug": slug, "members": self.teams.members(slug)? })))
            }
            ("POST", ["api", "teams", slug, "members"]) => {
                self.teams.add(me, slug, &f("handle"), &f("role"))?;
                Ok(json(200, &json!({ "ok": true })))
            }
            ("DELETE", ["api", "teams", slug, "members", handle]) => {
                self.teams.remove(me, slug, handle)?;
                Ok(json(200, &json!({ "ok": true })))
            }
            _ => Ok(json(404, &json!({ "error": "not found" }))),
        }
    }

    // --- tunnels and computers ------------------------------------------------------------------------

    /// `GET /api/computers/<id>/tunnel` with `Upgrade: wisp-tunnel`: the computer holds its tunnel open.
    fn tunnel(self: &Arc<Self>, req: http::Request<Incoming>, who: &Who, id: &str) -> Result<Resp> {
        let c = who.credential().ok_or_else(|| bad("This device isn't signed in.", 401))?;
        if let Some(r) = no(&may(c, Reach::GridTunnel)) {
            return Ok(r);
        }
        let Who::Device(u, d) = who else { return Err(bad("This device isn't signed in.", 401)) };
        let comp = self.accounts.computer(id)?.filter(|c| c.user_id == u.id && c.device_id == d.id).ok_or_else(|| bad("The grid doesn't know this computer any more.", 404))?;
        if !header_str(req.headers(), "upgrade").eq_ignore_ascii_case(TUNNEL_PROTOCOL) {
            return Err(bad(format!("Upgrade: {TUNNEL_PROTOCOL}"), 400));
        }
        let me = self.clone();
        let cid = comp.id.clone();
        let now = self.clock.now_ms();
        tokio::spawn(async move {
            match hyper::upgrade::on(req).await {
                Ok(up) => {
                    let _ = me.accounts.seen_computer(&cid);
                    let _ = me.tunnels.accept(&cid, up, now).await;
                }
                Err(e) => tracing::warn!("grid: tunnel {cid}: {e}"),
            }
        });
        let mut r = crate::http::respond(101, "", empty(), &[("upgrade", TUNNEL_PROTOCOL.to_owned()), ("connection", "Upgrade".to_owned()), ("cache-control", String::new())]);
        *r.status_mut() = http::StatusCode::SWITCHING_PROTOCOLS;
        Ok(r)
    }

    /// A computer (or a page on it, `preview`) through its tunnel: only its own user's device reaches it.
    async fn computer_reach(&self, req: http::Request<Incoming>, c: &ComputerRow, preview: Option<u16>) -> Result<Resp> {
        let who = self.who(req.headers());
        let cred = who.credential().ok_or_else(|| bad("Sign in first.", 401))?;
        if let Some(r) = no(&may(cred, if preview.is_some() { Reach::Preview } else { Reach::Computer })).filter(|_| !(preview.is_some() && cred == Credential::Device)) {
            return Ok(r);
        }
        if who.user().is_none_or(|u| u.id != c.user_id) {
            return Err(bad("That computer isn't yours.", 403));
        }
        let (mut head, body) = req.into_parts();
        let path = head.uri.path_and_query().map_or("/", |p| p.as_str()).to_owned();
        head.uri = format!("http://{}{path}", c.label).parse().map_err(|_| bad("Bad path.", 400))?;
        head.headers.remove("authorization");
        head.headers.remove("cookie");
        head.headers.remove("x-wisp-tunnel");
        head.headers.remove("x-wisp-preview");
        // only the grid's own route marks a request to a computer as a routed message (`route.rs`)
        head.headers.remove(crate::route::ROUTE_MARK);
        if let Some(p) = preview
            && let Ok(v) = p.to_string().parse()
        {
            head.headers.insert("x-wisp-preview", v);
        }
        let req = http::Request::from_parts(head, incoming(body));
        Ok(self.tunnels.forward(&c.id, req, preview.is_some()).await.unwrap_or_else(|| json(503, &json!({ "error": "This computer isn’t online.", "offline": true }))))
    }

    // --- <handle>.<domain>: a user's box -----------------------------------------------------------

    async fn edge(&self, req: http::Request<Incoming>, handle: &str) -> Result<Resp> {
        let Some(user) = self.accounts.user_by_handle(handle)? else { return Ok(json(404, &json!({ "error": "There's nobody with that handle here." }))) };
        let who = self.who(req.headers());
        let cred = who.credential().ok_or_else(|| bad("Sign in first.", 401))?;
        if let Some(r) = no(&may(cred, Reach::Box)).filter(|_| cred != Credential::Session) {
            return Ok(r);
        }
        if who.user().is_none_or(|u| u.id != user.id) {
            return Err(bad("That wisp isn't yours.", 403));
        }
        self.proxy(req, &BoxUser::user(&user), handle).await
    }

    /// A request into a box (the user's own, or a sandbox): woken unless passive, counted as use until answered.
    async fn proxy(&self, req: http::Request<Incoming>, bu: &BoxUser, handle: &str) -> Result<Resp> {
        let path = req.uri().path().to_owned();
        if path == "/_grid/state" {
            return Ok(json(200, &json!({ "state": self.boxes.state(&bu.id).as_str() })));
        }
        if path == "/_grid/stop" && req.method() == Method::POST {
            let was = self.boxes.stop(&bu.id, "stopped").await?;
            return Ok(json(200, &json!({ "stopped": was })));
        }
        let h = req.headers();
        let passive = header_str(h, PASSIVE) == "1" || header_str(h, "x-wisp-relay") == "1";
        if passive && self.boxes.state(&bu.id) != BoxState::Running {
            return Ok(json_with(503, &json!({ "error": "This box is asleep.", "asleep": true }), &[("retry-after", "20".into())]));
        }
        let running = self.boxes.ensure(bu, false).await?;
        let busy = std::sync::Mutex::new(self.boxes.begin(&bu.id, !passive));
        let secret = self.boxes.secret(&bu.id).unwrap_or_default();
        let (mut head, body) = req.into_parts();
        let pq = head.uri.path_and_query().map_or("/", |p| p.as_str()).to_owned();
        head.uri = format!("http://127.0.0.1:{}{pq}", running.port).parse().map_err(|_| bad("Bad path.", 400))?;
        let public = self.cfg.instance_url(handle);
        let fwd_host = public.split("://").nth(1).unwrap_or_default().to_owned();
        for k in ["authorization", "cookie", "x-wisp-proxy-secret", "x-wisp-proxy-via", "x-forwarded-host", "x-forwarded-proto", PASSIVE, "x-wisp-relay"] {
            head.headers.remove(k);
        }
        let set = |h: &mut HeaderMap, k: &'static str, v: &str| {
            if let Ok(v) = v.parse() {
                h.insert(k, v);
            }
        };
        set(&mut head.headers, "x-wisp-proxy-secret", &secret);
        set(&mut head.headers, "x-forwarded-host", &fwd_host);
        set(&mut head.headers, "x-forwarded-proto", &self.cfg.scheme);
        set(&mut head.headers, "host", &format!("127.0.0.1:{}", running.port));
        let up = self.client.request(http::Request::from_parts(head, incoming(body))).await.map_err(|e| bad(format!("Your wisp didn't answer: {e}"), 502))?;
        let (parts, b) = up.into_parts();
        // the request counts as open (and, unless passive, as use) until its answer has been read
        let b = b.map_err(std::io::Error::other).map_frame(move |f| {
            let _ = &busy;
            f
        });
        Ok(http::Response::from_parts(parts, b.boxed()))
    }
}

/// The inbox's settings from grid.json's `channels` (off unless `enabled: true`).
/// Mail, when grid.json has it, channels are held, and there's a master key (the addresses are sealed).
fn mail_of(cfg: &GridConfig, db: &Arc<crate::db::Db>, clock: &crate::clock::SharedClock, inbox: &crate::inbox::Inbox) -> Option<Arc<crate::mail::service::MailService>> {
    use crate::mail::service::{Http, MailService, Opts, Outbound};
    let m = cfg.file_cfg.mail.as_ref()?;
    if !inbox.opts.enabled || inbox.secrets.is_none() || m.inbound.provider != "ses" || m.outbound.provider != "ses" {
        return None;
    }
    let out = Outbound { region: m.outbound.region.clone(), access_key_id: m.outbound.access_key_id.clone(), secret_access_key: m.outbound.secret_access_key.clone().unwrap_or_default(), endpoint: m.outbound.extra.get("endpoint").and_then(Value::as_str).map(str::to_owned) };
    let opts = Opts { domain: m.domain.to_lowercase(), topic_arn: m.inbound.topic_arn.clone(), keys: m.inbound.keys.clone().unwrap_or_default(), outbound: out.clone(), send_per_hour: m.send_per_hour.unwrap_or(30), thread_days: m.thread_days.unwrap_or(7) };
    // a dev grid has no real senders, so grid.json can name their keys; nothing else skips DNS
    let txt: Arc<crate::dkim::Txt> = if let (true, Some(keys)) = (cfg.file_cfg.auth.dev, m.inbound.dkim_keys.clone()) {
        Arc::new(move |name: String| {
            let k = keys.get(&name).cloned();
            Box::pin(async move { k.map(|r| vec![vec![r]]).ok_or(crate::dkim::Lookup::NoSuchKey) })
        })
    } else {
        let Some(t) = crate::mail::service::system_txt() else {
            tracing::warn!("grid: mail: no DNS resolver, so no mail");
            return None;
        };
        t
    };
    let wire = Arc::new(Http { client: reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().ok()?, out, clock: clock.clone() });
    Some(Arc::new(MailService::new(db.clone(), clock.clone(), opts, txt, wire)))
}

fn inbox_opts(c: Option<&crate::config::ChannelsConfig>) -> crate::inbox::Opts {
    let d = crate::inbox::Opts::default();
    let Some(c) = c else { return d };
    crate::inbox::Opts {
        enabled: c.enabled == Some(true),
        max_rows: c.max_rows.unwrap_or(d.max_rows),
        max_bytes: c.max_bytes.unwrap_or(d.max_bytes),
        ttl_ms: c.ttl_ms.unwrap_or(d.ttl_ms),
        retry_ms: c.retry_ms.unwrap_or(d.retry_ms),
        wake_retry_ms: c.wake_retry_ms.unwrap_or(d.wake_retry_ms),
        ..d
    }
}

/// After a restart, everyone with something held is drained; every minute what's past its hour goes.
fn inbox_loop(grid: &Arc<Grid>, stop: CancellationToken) {
    if !grid.inbox.opts.enabled {
        return;
    }
    for uid in grid.inbox.waiting().unwrap_or_default() {
        if let Ok(Some(u)) = grid.accounts.user_by_id(&uid) {
            grid.drain_later(u);
        }
    }
    let g = grid.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                () = stop.cancelled() => return,
                () = tokio::time::sleep(std::time::Duration::from_secs(60)) => {}
            }
            if let Err(e) = g.inbox.sweep() {
                tracing::warn!("grid: inbox sweep: {e}");
            }
            if let Err(e) = g.routes.sweep() {
                tracing::warn!("grid: route sweep: {e}");
            }
        }
    });
}

/// Serves `grid` on `listener` until `stop`.
pub async fn serve(grid: Arc<Grid>, listener: TcpListener, stop: CancellationToken) {
    inbox_loop(&grid, stop.clone());
    loop {
        let (sock, _addr): (tokio::net::TcpStream, SocketAddr) = tokio::select! {
            () = stop.cancelled() => return,
            a = listener.accept() => match a { Ok(a) => a, Err(_) => continue },
        };
        let g = grid.clone();
        tokio::spawn(async move {
            let svc = hyper::service::service_fn(move |req| {
                let g = g.clone();
                async move { Ok::<_, std::convert::Infallible>(g.handle(req).await) }
            });
            let _ = hyper_util::server::conn::auto::Builder::new(TokioExecutor::new()).serve_connection_with_upgrades(TokioIo::new(sock), svc).await;
        });
    }
}

/// A grid on this machine for development and tests: `auth.dev` on, boxes as `wisp serve` processes.
pub async fn dev(data: &std::path::Path, port: u16, wisp_bin: std::path::PathBuf, env: Vec<(String, String)>, idle_ms: i64) -> Result<(Arc<Grid>, u16, CancellationToken)> {
    let listener = TcpListener::bind(("127.0.0.1", port)).await.map_err(|e| bad(format!("can't listen on {port}: {e}"), 500))?;
    let port = listener.local_addr().map_err(|e| bad(e.to_string(), 500))?.port();
    let cfg = crate::config::for_test(data, json!({ "domain": "wisp.localhost", "listen": { "host": "127.0.0.1", "port": port }, "auth": { "dev": true } }))?;
    let clock = crate::clock::system();
    let db = Arc::new(Db::open(data, clock.now_ms())?);
    let url_cfg = cfg.clone();
    let boxes = ProcessHost::new(
        crate::hostd::ProcessOptions { bin: wisp_bin, data: data.to_owned(), idle_ms, check_ms: 1000, start_ms: 30_000, max_running: 8, env, url_of: Arc::new(move |h| url_cfg.instance_url(h)), boxd: None },
        clock.clone(),
    );
    let grid = Grid::new(cfg, db, clock, boxes);
    let stop = CancellationToken::new();
    tokio::spawn(serve(grid.clone(), listener, stop.clone()));
    Ok((grid, port, stop))
}

/// Bytes, for tests that want a request body.
pub fn bytes_body(b: impl Into<Bytes>) -> Body {
    crate::http::full(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queries_decode() {
        assert_eq!(query("a=1&next=%2Factivate%3Fcode%3DX", "next").as_deref(), Some("/activate?code=X"));
        assert_eq!(split("/api/shares/x?ref=v2"), (vec!["api", "shares", "x"], "ref=v2"));
    }
}
