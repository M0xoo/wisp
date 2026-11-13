//! Sign-in with a provider on `<domain>` (v1 grid/server.js `/signin`, `/auth/:id/start`, `/auth/:id/callback`):
//! out to the provider with state + PKCE (+ nonce), back with a code, in as a user ([`Accounts::sign_in`]).
//! `?link=1` on start, signed in, adds a second way in to that account instead.

use std::sync::Arc;

use http::HeaderMap;

use super::{COOKIE, Grid, query};
use crate::auth::{AuthHttp, FLOW_COOKIE, Flows, Provider};
use crate::error::{Result, bad};
use crate::http::{CookieOptions, Resp, add_cookie, cookie, cookies, html, redirect, safe_path};
use crate::pages::{self, MessagePage, SignInPage, Tone};

/// The providers this grid signs in with, the flows on their way, and how they're reached.
pub struct SignIn {
    pub providers: Vec<Provider>,
    pub flows: Flows,
    pub http: Arc<dyn AuthHttp>,
}

impl std::fmt::Debug for SignIn {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SignIn").field("providers", &self.providers.iter().map(|p| &p.id).collect::<Vec<_>>()).finish_non_exhaustive()
    }
}

/// The providers' calls, through reqwest (10 s each).
#[derive(Debug)]
pub struct Reqwest(pub reqwest::Client);

impl AuthHttp for Reqwest {
    fn call(
        &self,
        method: &str,
        url: &str,
        headers: Vec<(String, String)>,
        body: Option<(String, Vec<u8>)>,
    ) -> futures::future::BoxFuture<'static, std::result::Result<(u16, Vec<u8>), String>> {
        let m = reqwest::Method::from_bytes(method.as_bytes()).unwrap_or(reqwest::Method::GET);
        let mut rq = self.0.request(m, url).timeout(std::time::Duration::from_secs(10));
        for (k, v) in headers {
            rq = rq.header(k, v);
        }
        if let Some((ct, b)) = body {
            rq = rq.header("content-type", ct).body(b);
        }
        Box::pin(async move {
            let r = rq.send().await.map_err(|e| e.to_string())?;
            let status = r.status().as_u16();
            let bytes = r.bytes().await.map_err(|e| e.to_string())?;
            Ok((status, bytes.to_vec()))
        })
    }
}

impl SignIn {
    pub fn new(cfg: &crate::config::GridConfig) -> Self {
        let providers = crate::auth::providers(cfg).unwrap_or_else(|e| {
            tracing::warn!("grid: sign-in providers: {e}");
            Vec::new()
        });
        Self { providers, flows: Flows::default(), http: Arc::new(Reqwest(reqwest::Client::new())) }
    }
}

impl Grid {
    fn redirect_uri(&self, id: &str) -> String {
        format!("{}/auth/{}/callback", self.cfg.public_url, crate::http::encode_component(id))
    }

    pub(super) fn page_providers(&self) -> Vec<pages::Provider> {
        let mut out: Vec<pages::Provider> =
            self.signin.providers.iter().map(|p| pages::Provider { id: p.id.clone(), label: p.label.clone() }).collect();
        if self.cfg.auth.dev {
            out.push(pages::Provider { id: "dev".into(), label: "Dev sign-in (by handle)".into() });
        }
        out
    }

    pub(super) fn sign_in_page(&self, h: &HeaderMap, ret: &str, error: &str, linking: bool, status: u16) -> Resp {
        let a = &self.cfg.auth;
        let seats = pages::Seats {
            left: None,
            invite: !(a.allow.emails.is_empty()
                && a.allow.domains.is_empty()
                && a.allow.github_orgs.is_empty()
                && a.allow.accounts.is_empty()),
            closed: a.signup == "closed",
        };
        let ua = crate::http::header_str(h, "user-agent").to_owned();
        let p = SignInPage {
            providers: self.page_providers(),
            seats,
            ret: ret.to_owned(),
            error: error.to_owned(),
            linking,
            waitlisted: false,
            analytics: None,
            ua,
        };
        html(status, pages::sign_in_page(&self.page, &p), &[])
    }

    /// `GET /signin?return=…`
    pub(super) fn signin_route(&self, h: &HeaderMap, q: &str) -> Resp {
        let ret = query(q, "return").unwrap_or_default();
        let signed_in = cookies(h).get(COOKIE).is_some_and(|c| self.accounts.session(c).ok().flatten().is_some());
        if signed_in && query(q, "link").is_none() {
            return redirect(safe_path(&ret, "/"), &[]);
        }
        self.sign_in_page(h, safe_path(&ret, ""), "", false, 200)
    }

    /// `GET /auth/<id>/start?return=…[&link=1]`
    #[allow(clippy::many_single_char_names)] // h, q, p, f: the request's parts and the flow
    pub(super) async fn auth_start(&self, h: &HeaderMap, id: &str, q: &str) -> Result<Resp> {
        if id == "dev" && self.cfg.auth.dev {
            return Ok(redirect(
                &format!("/auth/dev?next={}", crate::http::encode_component(safe_path(&query(q, "return").unwrap_or_default(), "/"))),
                &[],
            ));
        }
        let Some(p) = self.signin.providers.iter().find(|p| p.id == id) else {
            return Ok(html(
                404,
                pages::message_page(
                    &self.page,
                    &MessagePage {
                        title: "Not available".into(),
                        text: "That way of signing in isn't set up on this grid.".into(),
                        link: Some(("/signin".into(), "Back".into())),
                        tone: Tone::Plain,
                    },
                ),
                &[],
            ));
        };
        let link = query(q, "link").as_deref() == Some("1");
        let me = cookies(h).get(COOKIE).and_then(|c| self.accounts.session(c).ok().flatten());
        if link && me.is_none() {
            return Err(bad("Sign in first.", 401));
        }
        let ret = query(q, "return").unwrap_or_default();
        let f = self.signin.flows.begin(&p.id, safe_path(&ret, "/"), if link { me.map(|u| u.id) } else { None }, self.clock.now_ms());
        let to = p.start(self.signin.http.as_ref(), &self.redirect_uri(&p.id), &f).await?;
        let mut r = redirect(&to, &[]);
        add_cookie(
            &mut r,
            &cookie(
                FLOW_COOKIE,
                &f.state,
                CookieOptions { secure: self.cfg.secure, max_age: Some(600), path: Some("/auth"), framed: false },
            ),
        );
        Ok(r)
    }

    /// `GET /auth/<id>/callback?code=…&state=…`
    #[allow(clippy::many_single_char_names)] // h, q, p, f, t: the request's parts, the flow, the session
    pub(super) async fn auth_callback(&self, h: &HeaderMap, id: &str, q: &str) -> Resp {
        let clear =
            cookie(FLOW_COOKIE, "", CookieOptions { secure: self.cfg.secure, max_age: Some(0), path: Some("/auth"), framed: false });
        let state = query(q, "state").unwrap_or_default();
        let held = cookies(h).get(FLOW_COOKIE).cloned().unwrap_or_default();
        let linking = std::sync::atomic::AtomicBool::new(false);
        let out: Result<Resp> = async {
            let p = self
                .signin
                .providers
                .iter()
                .find(|p| p.id == id)
                .ok_or_else(|| bad("That way of signing in isn't set up on this grid.", 404))?;
            let f = self.signin.flows.finish(id, &state, &held, self.clock.now_ms())?;
            linking.store(f.link_to.is_some(), std::sync::atomic::Ordering::Relaxed);
            if let Some(e) = query(q, "error") {
                return Err(bad(query(q, "error_description").unwrap_or_else(|| format!("{} said: {e}", p.label)), 400));
            }
            let idn = p
                .finish(self.signin.http.as_ref(), &query(q, "code").unwrap_or_default(), &self.redirect_uri(id), &f, self.clock.now_ms())
                .await?;
            let me = cookies(h).get(COOKIE).and_then(|c| self.accounts.session(c).ok().flatten());
            if f.link_to.is_some() && me.as_ref().map(|u| &u.id) != f.link_to.as_ref() {
                return Err(bad("You were signed out while connecting it. Sign in and try again.", 401));
            }
            let user = self.accounts.sign_in(&self.cfg.auth, &idn, f.link_to.as_deref())?;
            if f.link_to.is_some() {
                return Ok(redirect(&format!("/?m={}", crate::http::encode_component(&format!("{} connected.", p.label))), &[]));
            }
            let t = self.accounts.new_session(&user.id)?;
            let mut r = redirect(safe_path(&f.ret, "/"), &[]);
            add_cookie(
                &mut r,
                &cookie(
                    COOKIE,
                    &t,
                    CookieOptions { secure: self.cfg.secure, max_age: Some(self.cfg.session_days * 86_400), path: None, framed: false },
                ),
            );
            Ok(r)
        }
        .await;
        let mut r = out.unwrap_or_else(|e| {
            tracing::info!("grid: sign-in with {id} failed: {e}");
            let status = e.status();
            self.sign_in_page(
                h,
                "",
                &e.to_string(),
                linking.load(std::sync::atomic::Ordering::Relaxed),
                if status < 500 { status } else { 400 },
            )
        });
        add_cookie(&mut r, &clear);
        r
    }
}
