//! Sign-in providers (v1 grid/auth/providers.js, jwt.js). Each turns "send the browser here" and "it came back with
//! a code" into an [`Identity`]:
//!
//! - `google`: `OpenID` Connect at accounts.google.com (a preset of `oidc`);
//! - `github`: OAuth 2 + the REST API (GitHub has no OIDC for users); the subject is the numeric id, never the
//!   login, which can change;
//! - `oidc:<name>`: any `OpenID` Connect issuer (GitLab, Microsoft, Keycloak, your company's).
//!
//! Every redirect carries `state` and PKCE (S256); OIDC adds a `nonce`, checked in the ID token with its
//! signature (RS256 or ES256, from the issuer's JWKS), issuer, audience and expiry. A flow is kept here, in
//! memory, for 10 minutes, under its state; the browser holds the state in a cookie, so a callback from another
//! browser, an old one, or a second use, finds nothing. The HTTP calls go through [`AuthHttp`] (tests fake it).

use std::collections::HashMap;
use std::sync::Mutex;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64URL;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::config::{GridConfig, ProviderConfig};
use crate::error::{Result, bad};

/// How long a sign-in may take, from the redirect out to the callback.
pub const FLOW_TTL_MS: i64 = 10 * 60_000;
/// The cookie holding the flow's state.
pub const FLOW_COOKIE: &str = "wisp_grid_oauth";

/// Who a provider says signed in.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Identity {
    pub provider: String,
    pub subject: String,
    /// lower-case; "" when none
    pub email: String,
    pub email_verified: bool,
    pub name: String,
    pub login: String,
    pub avatar: String,
    /// GitHub orgs (lower-case), read only when an allow list names orgs
    pub orgs: Option<Vec<String>>,
}

/// The HTTP a provider needs. `Err` is a transport failure; any status is an answer.
pub trait AuthHttp: Send + Sync {
    fn call(&self, method: &str, url: &str, headers: Vec<(String, String)>, body: Option<(String, Vec<u8>)>) -> futures::future::BoxFuture<'static, std::result::Result<(u16, Vec<u8>), String>>;
}

/// A JSON answer, or the provider's own error words.
pub async fn get_json(http: &dyn AuthHttp, method: &str, url: &str, headers: Vec<(String, String)>, body: Option<(String, Vec<u8>)>) -> Result<Value> {
    let host = url::Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_owned)).unwrap_or_default();
    let mut h = vec![("accept".to_owned(), "application/json".to_owned()), ("user-agent".to_owned(), "wisp-grid".to_owned())];
    h.extend(headers);
    let (status, bytes) = http.call(method, url, h, body).await.map_err(|e| bad(format!("Couldn't reach {host}: {e}"), 502))?;
    let v: Value = serde_json::from_slice(&bytes).map_err(|_| bad(format!("{host} answered with something that isn't JSON (HTTP {status})."), 502))?;
    if !(200..300).contains(&status) {
        let s = |p: &str| v.pointer(p).and_then(Value::as_str).map(str::to_owned);
        let why = s("/error_description").or_else(|| s("/error/message")).or_else(|| s("/message")).or_else(|| s("/error")).unwrap_or_else(|| format!("{host}: HTTP {status}"));
        return Err(bad(why, 502));
    }
    Ok(v)
}

/// RFC 7636 S256: base64url(SHA-256(verifier)).
pub fn challenge(verifier: &str) -> String {
    B64URL.encode(Sha256::digest(verifier.as_bytes()))
}

fn random(n: usize) -> String {
    use rand::RngCore as _;
    let mut b = vec![0u8; n];
    rand::rng().fill_bytes(&mut b);
    B64URL.encode(b)
}

/// One sign-in on its way: what the callback must match.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Flow {
    pub provider: String,
    pub state: String,
    pub verifier: String,
    pub nonce: String,
    /// where to go once in (a safe path)
    pub ret: String,
    /// linking a second way to this signed-in user
    pub link_to: Option<String>,
    pub at: i64,
}

/// The flows on their way, by state: each used once, none older than [`FLOW_TTL_MS`].
#[derive(Debug, Default)]
pub struct Flows(Mutex<HashMap<String, Flow>>);

impl Flows {
    pub fn begin(&self, provider: &str, ret: &str, link_to: Option<String>, now: i64) -> Flow {
        let f = Flow { provider: provider.to_owned(), state: random(24), verifier: random(48), nonce: random(24), ret: ret.to_owned(), link_to, at: now };
        let mut m = self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        m.retain(|_, x| now - x.at <= FLOW_TTL_MS);
        // a bound on what's kept: an attacker starting sign-ins in a loop can't fill memory
        if m.len() >= 10_000 {
            m.clear();
        }
        m.insert(f.state.clone(), f.clone());
        f
    }

    /// The flow a callback finishes: its state from the query must be the one this browser's cookie holds, for the
    /// same provider, within its time. Taken out: a second callback with it finds nothing.
    pub fn finish(&self, provider: &str, query_state: &str, cookie_state: &str, now: i64) -> Result<Flow> {
        let stale = || bad("This sign-in timed out or was started elsewhere. Start again.", 400);
        if query_state.is_empty() || !crate::secrets::safe_equal(query_state, cookie_state) {
            return Err(stale());
        }
        let f = self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(query_state).ok_or_else(stale)?;
        if f.provider != provider || now - f.at > FLOW_TTL_MS {
            return Err(stale());
        }
        Ok(f)
    }
}

/// A provider, as the config sets it up.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Kind {
    Github { auth_base: String, api_base: String, want_orgs: bool },
    Oidc { issuer: String, scope: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Provider {
    pub id: String,
    pub label: String,
    pub client_id: String,
    pub client_secret: String,
    pub kind: Kind,
}

/// The config's providers, in its order (`github`, `google`, `oidc:<name>`); an unknown one is refused at load.
pub fn providers(cfg: &GridConfig) -> Result<Vec<Provider>> {
    let want_orgs = !cfg.auth.allow.github_orgs.is_empty();
    cfg.auth.providers.iter().map(|(id, p)| provider(id, p, want_orgs)).collect()
}

fn provider(id: &str, p: &ProviderConfig, want_orgs: bool) -> Result<Provider> {
    let trim = |s: &str| s.trim_end_matches('/').to_owned();
    let (label, kind) = match id {
        "github" => ("GitHub".to_owned(), Kind::Github { auth_base: trim(p.auth_base.as_deref().unwrap_or("https://github.com")), api_base: trim(p.api_base.as_deref().unwrap_or("https://api.github.com")), want_orgs }),
        "google" => ("Google".to_owned(), Kind::Oidc { issuer: trim(p.issuer.as_deref().unwrap_or("https://accounts.google.com")), scope: "openid email profile".into() }),
        o if o.starts_with("oidc:") => {
            let issuer = p.issuer.as_deref().filter(|i| !i.is_empty()).ok_or_else(|| crate::GridError::Config(format!("auth.providers.{id}: issuer is missing.")))?;
            let scope = p.extra.get("scope").and_then(Value::as_str).unwrap_or("openid email profile").to_owned();
            (p.label.clone().unwrap_or_else(|| o["oidc:".len()..].to_owned()), Kind::Oidc { issuer: trim(issuer), scope })
        }
        _ => return Err(crate::GridError::Config(format!("auth.providers.{id}: unknown provider (github, google, or oidc:<name>)."))),
    };
    Ok(Provider { id: id.to_owned(), label: p.label.clone().unwrap_or(label), client_id: p.client_id.clone(), client_secret: p.client_secret.clone().unwrap_or_default(), kind })
}

fn with_query(base: &str, q: &[(&str, &str)]) -> String {
    let qs = url::form_urlencoded::Serializer::new(String::new()).extend_pairs(q).finish();
    format!("{base}{}{qs}", if base.contains('?') { '&' } else { '?' })
}

impl Provider {
    async fn discovery(&self, http: &dyn AuthHttp) -> Result<Value> {
        let Kind::Oidc { issuer, .. } = &self.kind else { return Ok(Value::Null) };
        get_json(http, "GET", &format!("{issuer}/.well-known/openid-configuration"), Vec::new(), None).await
    }

    /// Where the browser goes to sign in.
    pub async fn start(&self, http: &dyn AuthHttp, redirect_uri: &str, f: &Flow) -> Result<String> {
        let ch = challenge(&f.verifier);
        match &self.kind {
            Kind::Github { auth_base, want_orgs, .. } => {
                let scope = if *want_orgs { "read:user user:email read:org" } else { "read:user user:email" };
                Ok(with_query(&format!("{auth_base}/login/oauth/authorize"), &[("client_id", &self.client_id), ("redirect_uri", redirect_uri), ("scope", scope), ("state", &f.state), ("code_challenge", &ch), ("code_challenge_method", "S256"), ("allow_signup", "true"), ("prompt", "select_account")]))
            }
            Kind::Oidc { scope, .. } => {
                let d = self.discovery(http).await?;
                let at = d.get("authorization_endpoint").and_then(Value::as_str).ok_or_else(|| bad(format!("{} has no authorization endpoint.", self.label), 502))?;
                Ok(with_query(at, &[("response_type", "code"), ("client_id", &self.client_id), ("redirect_uri", redirect_uri), ("scope", scope), ("state", &f.state), ("nonce", &f.nonce), ("code_challenge", &ch), ("code_challenge_method", "S256"), ("prompt", "select_account")]))
            }
        }
    }

    /// The callback's code → who signed in.
    pub async fn finish(&self, http: &dyn AuthHttp, code: &str, redirect_uri: &str, f: &Flow, now: i64) -> Result<Identity> {
        if code.is_empty() {
            return Err(bad(format!("{} sent no code back.", self.label), 400));
        }
        match &self.kind {
            Kind::Github { auth_base, api_base, want_orgs } => {
                let body = json!({ "client_id": self.client_id, "client_secret": self.client_secret, "code": code, "redirect_uri": redirect_uri, "code_verifier": f.verifier });
                let t = get_json(http, "POST", &format!("{auth_base}/login/oauth/access_token"), Vec::new(), Some(("application/json".into(), body.to_string().into_bytes()))).await?;
                let Some(tok) = t.get("access_token").and_then(Value::as_str) else {
                    return Err(bad(t.get("error_description").and_then(Value::as_str).unwrap_or("GitHub didn't send an access token."), 502));
                };
                let auth = vec![("authorization".to_owned(), format!("Bearer {tok}")), ("x-github-api-version".to_owned(), "2022-11-28".to_owned())];
                let user = get_json(http, "GET", &format!("{api_base}/user"), auth.clone(), None).await?;
                let emails = get_json(http, "GET", &format!("{api_base}/user/emails"), auth.clone(), None).await.unwrap_or_default();
                let orgs = if *want_orgs { Some(get_json(http, "GET", &format!("{api_base}/user/orgs"), auth, None).await.unwrap_or_default()) } else { None };
                github_identity(&user, &emails, orgs.as_ref())
            }
            Kind::Oidc { issuer, .. } => {
                let d = self.discovery(http).await?;
                let token_at = d.get("token_endpoint").and_then(Value::as_str).ok_or_else(|| bad(format!("{} has no token endpoint.", self.label), 502))?;
                let form = url::form_urlencoded::Serializer::new(String::new()).extend_pairs([("grant_type", "authorization_code"), ("code", code), ("redirect_uri", redirect_uri), ("client_id", &self.client_id), ("client_secret", &self.client_secret), ("code_verifier", &f.verifier)]).finish();
                let t = get_json(http, "POST", token_at, Vec::new(), Some(("application/x-www-form-urlencoded".into(), form.into_bytes()))).await?;
                let id_token = t.get("id_token").and_then(Value::as_str).ok_or_else(|| bad(format!("{} didn't send an ID token.", self.label), 502))?;
                let jwks_at = d.get("jwks_uri").and_then(Value::as_str).unwrap_or_default().to_owned();
                let jwks = get_json(http, "GET", &jwks_at, Vec::new(), None).await?;
                let issuers = [d.get("issuer").and_then(Value::as_str).unwrap_or(issuer).to_owned(), issuer.clone()];
                let claims = verify_id_token(id_token, &jwks, &issuers, &self.client_id, &f.nonce, now)?;
                Ok(oidc_identity(&self.id, &claims))
            }
        }
    }
}

/// GitHub's user (and verified emails, and orgs) as an identity: the subject is the numeric id.
pub fn github_identity(user: &Value, emails: &Value, orgs: Option<&Value>) -> Result<Identity> {
    let id = user.get("id").and_then(Value::as_u64).ok_or_else(|| bad("GitHub didn't say who you are.", 502))?;
    let list = emails.as_array().cloned().unwrap_or_default();
    let verified = |e: &&Value| e.get("verified").and_then(Value::as_bool) == Some(true);
    let primary = list.iter().filter(verified).find(|e| e.get("primary").and_then(Value::as_bool) == Some(true)).or_else(|| list.iter().find(verified));
    let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
    let login = s(user, "login");
    let name = s(user, "name");
    Ok(Identity {
        provider: "github".into(),
        subject: id.to_string(),
        email: primary.map(|e| s(e, "email").to_lowercase()).unwrap_or_default(),
        email_verified: primary.is_some(),
        name: if name.is_empty() { login.clone() } else { name },
        login,
        avatar: s(user, "avatar_url"),
        orgs: orgs.map(|o| o.as_array().into_iter().flatten().filter_map(|x| x.get("login").and_then(Value::as_str)).map(str::to_lowercase).collect()),
    })
}

fn oidc_identity(provider: &str, c: &Value) -> Identity {
    let s = |k: &str| c.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
    let verified = c.get("email_verified").is_some_and(|v| v.as_bool() == Some(true) || v.as_str() == Some("true"));
    Identity { provider: provider.to_owned(), subject: c.get("sub").map(|v| v.as_str().map_or_else(|| v.to_string(), str::to_owned)).unwrap_or_default(), email: s("email").to_lowercase(), email_verified: verified, name: s("name"), login: s("preferred_username"), avatar: s("picture"), orgs: None }
}

fn b64(part: &str) -> Result<Vec<u8>> {
    B64URL.decode(part.trim_end_matches('=')).map_err(|_| bad("The ID token isn't readable.", 401))
}

/// An OIDC ID token's claims, once its signature (RS256 or ES256, by `kid` in `jwks`), issuer, audience, nonce and
/// times check out (a minute of clock skew).
pub fn verify_id_token(token: &str, jwks: &Value, issuers: &[String], audience: &str, nonce: &str, now_ms: i64) -> Result<Value> {
    let refuse = |why: &str| bad(format!("The sign-in couldn't be checked: {why}."), 401);
    let parts: Vec<&str> = token.split('.').collect();
    let [h, p, sig] = parts.as_slice() else { return Err(refuse("not a JWT")) };
    let header: Value = serde_json::from_slice(&b64(h)?).map_err(|_| refuse("its header isn't JSON"))?;
    let claims: Value = serde_json::from_slice(&b64(p)?).map_err(|_| refuse("its claims aren't JSON"))?;
    let alg = header.get("alg").and_then(Value::as_str).unwrap_or_default();
    let kid = header.get("kid").and_then(Value::as_str);
    let keys = jwks.get("keys").and_then(Value::as_array).cloned().unwrap_or_default();
    let key = keys.iter().find(|k| kid.is_none_or(|kid| k.get("kid").and_then(Value::as_str) == Some(kid))).ok_or_else(|| refuse("its key isn't the issuer's"))?;
    let signed = format!("{h}.{p}");
    let sig = b64(sig)?;
    let ok = match alg {
        "RS256" => rs256(key, signed.as_bytes(), &sig),
        "ES256" => es256(key, signed.as_bytes(), &sig),
        _ => return Err(refuse(&format!("it's signed with {alg}, not RS256 or ES256"))),
    };
    if !ok {
        return Err(refuse("its signature is wrong"));
    }
    let iss = claims.get("iss").and_then(Value::as_str).unwrap_or_default();
    if !issuers.iter().any(|i| i == iss) {
        return Err(refuse("another issuer signed it"));
    }
    let aud_ok = match claims.get("aud") {
        Some(Value::String(a)) => a == audience,
        Some(Value::Array(a)) => a.iter().any(|x| x.as_str() == Some(audience)),
        _ => false,
    };
    if !aud_ok {
        return Err(refuse("it's for another app"));
    }
    if claims.get("nonce").and_then(Value::as_str) != Some(nonce) {
        return Err(refuse("its nonce isn't this sign-in's"));
    }
    let now = now_ms / 1_000;
    let skew = 60;
    if claims.get("exp").and_then(Value::as_i64).is_none_or(|e| e + skew < now) {
        return Err(refuse("it expired"));
    }
    if claims.get("iat").and_then(Value::as_i64).is_some_and(|i| i - skew > now) {
        return Err(refuse("it's from the future"));
    }
    Ok(claims)
}

fn rs256(jwk: &Value, msg: &[u8], sig: &[u8]) -> bool {
    use rsa::signature::Verifier as _;
    let n = jwk.get("n").and_then(Value::as_str).and_then(|s| B64URL.decode(s).ok());
    let e = jwk.get("e").and_then(Value::as_str).and_then(|s| B64URL.decode(s).ok());
    let (Some(n), Some(e)) = (n, e) else { return false };
    let Ok(key) = rsa::RsaPublicKey::new(rsa::BigUint::from_bytes_be(&n), rsa::BigUint::from_bytes_be(&e)) else { return false };
    let Ok(sig) = rsa::pkcs1v15::Signature::try_from(sig) else { return false };
    rsa::pkcs1v15::VerifyingKey::<Sha256>::new(key).verify(msg, &sig).is_ok()
}

fn es256(jwk: &Value, msg: &[u8], sig: &[u8]) -> bool {
    use p256::ecdsa::signature::Verifier as _;
    let coord = |k: &str| jwk.get(k).and_then(Value::as_str).and_then(|s| B64URL.decode(s).ok()).filter(|b| b.len() == 32);
    let (Some(x), Some(y)) = (coord("x"), coord("y")) else { return false };
    let point = p256::EncodedPoint::from_affine_coordinates(x.as_slice().into(), y.as_slice().into(), false);
    let Ok(key) = p256::ecdsa::VerifyingKey::from_encoded_point(&point) else { return false };
    let Ok(sig) = p256::ecdsa::Signature::from_slice(sig) else { return false };
    key.verify(msg, &sig).is_ok()
}

#[cfg(test)]
#[path = "auth_tests.rs"]
mod tests;
