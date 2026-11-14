//! Signing in to a remote connector with OAuth, the way MCP specifies it (v1 connector-auth.js), as
//! pure steps: where to look for metadata (protected resource, then RFC 8414 / `OpenID`), what to
//! register (RFC 7591), the PKCE pair and the authorize URL, the pending sign-ins, the token forms and
//! replies, and when a token must be refreshed. The host does the fetches between the steps.

use std::collections::BTreeMap;

use base64::Engine as _;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use wisp_connectors_api::OAuthMeta;

use crate::error::{ConnectorError, Result};
use crate::text::{host_of, origin_of};

/// A sign-in left open in the browser this long is forgotten.
pub const PENDING_MS: i64 = 10 * 60_000;
/// A token that runs out sooner than this is refreshed first.
pub const FRESH_MS: i64 = 60_000;
pub const PROTOCOL_VERSION: &str = "2025-06-18";

pub fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// PKCE S256: `b64url(sha256(verifier))`.
pub fn challenge(verifier: &str) -> String {
    b64url(&Sha256::digest(verifier.as_bytes()))
}

/// RFC 8414 puts the path after the well-known part: `https://h/.well-known/<name>/path`, then the root.
pub fn well_known(base: &str, name: &str) -> Vec<String> {
    let Ok(u) = url::Url::parse(base) else { return Vec::new() };
    let origin = u.origin().ascii_serialization();
    let path = u.path().trim_end_matches('/');
    let mut out = Vec::new();
    if !path.is_empty() {
        out.push(format!("{origin}/.well-known/{name}{path}"));
    }
    out.push(format!("{origin}/.well-known/{name}"));
    out
}

/// `new URL(rel, base).href`
pub fn resolve(base: &str, rel: &str) -> Option<String> {
    url::Url::parse(base).and_then(|b| b.join(rel)).ok().map(String::from)
}

/// A 401's `WWW-Authenticate: Bearer resource_metadata="…"`, resolved against the server's URL.
pub fn resource_metadata(www_authenticate: &str, server_url: &str) -> Option<String> {
    let start = www_authenticate.find("resource_metadata=\"")? + "resource_metadata=\"".len();
    let end = www_authenticate[start..].find('"')?;
    resolve(server_url, &www_authenticate[start..start + end])
}

/// The probe that makes a protected server name its metadata (an `initialize` POST).
pub fn initialize_body(version: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": 0, "method": "initialize", "params": { "protocolVersion": PROTOCOL_VERSION, "capabilities": {}, "clientInfo": { "name": "wisp", "version": version } } })
}

fn string(m: Option<&Map<String, Value>>, k: &str) -> Option<String> {
    m?.get(k)?.as_str().filter(|s| !s.is_empty()).map(str::to_owned)
}

/// The issuer: the protected resource metadata's first authorization server, else the server's origin.
pub fn issuer(prm: Option<&Map<String, Value>>, server_url: &str) -> String {
    prm.and_then(|p| p.get("authorization_servers")?.as_array()?.first()?.as_str().filter(|s| !s.is_empty()).map(str::to_owned))
        .unwrap_or_else(|| origin_of(server_url))
}

/// Where to look for the issuer's metadata, in order.
pub fn meta_urls(issuer: &str) -> Vec<String> {
    let mut out = well_known(issuer, "oauth-authorization-server");
    out.extend(well_known(issuer, "openid-configuration"));
    out
}

/// Where to sign in. Servers from before metadata: the endpoints at their default paths (MCP 2025-03-26).
pub fn meta_from(prm: Option<&Map<String, Value>>, meta: Option<&Map<String, Value>>, issuer: &str, server_url: &str) -> OAuthMeta {
    let at = |p: &str| resolve(issuer, p).unwrap_or_default();
    // v1 `prm?.scopes_supported || meta?.scopes_supported`: an array (even empty) from the resource wins
    let scopes = [prm, meta].into_iter().flatten().find_map(|m| m.get("scopes_supported")?.as_array().cloned()).unwrap_or_default();
    OAuthMeta {
        issuer: issuer.to_owned(),
        authorize: string(meta, "authorization_endpoint").unwrap_or_else(|| at("/authorize")),
        token: string(meta, "token_endpoint").unwrap_or_else(|| at("/token")),
        register: string(meta, "registration_endpoint").or_else(|| meta.is_none().then(|| at("/register"))),
        scopes: scopes.iter().map(|s| s.as_str().map_or_else(|| s.to_string(), str::to_owned)).collect(),
        resource: string(prm, "resource").unwrap_or_else(|| server_url.to_owned()),
        ..OAuthMeta::default()
    }
}

/// Registered once per place the browser comes back to: keep the client when it still fits.
pub fn reuse_client(had: Option<&OAuthMeta>, found: &OAuthMeta, redirect: &str) -> Option<OAuthMeta> {
    let had = had?;
    let fits = had.client_id.is_some() && had.redirect.as_deref() == Some(redirect) && had.issuer == found.issuer;
    fits.then(|| OAuthMeta {
        client_id: had.client_id.clone(),
        redirect: had.redirect.clone(),
        expires_at: had.expires_at,
        signed_in_at: had.signed_in_at,
        ..found.clone()
    })
}

/// The RFC 7591 registration wisp sends: a public client (PKCE, no secret needed).
pub fn registration_body(redirect: &str) -> Value {
    json!({ "client_name": "wisp", "client_uri": "https://trywisp.dev", "redirect_uris": [redirect], "grant_types": ["authorization_code", "refresh_token"], "response_types": ["code"], "token_endpoint_auth_method": "none" })
}

pub fn no_registration(issuer: &str) -> ConnectorError {
    ConnectorError::invalid(format!(
        "{} doesn’t let apps register themselves, so wisp can’t sign in there. Add its API key as a header instead",
        host_of(issuer)
    ))
}

/// A registration reply (`None`: the request failed) → (client id, client secret).
pub fn registered(issuer: &str, status: Option<u16>, body: Option<&Value>) -> Result<(String, Option<String>)> {
    let ok = status.is_some_and(|s| (200..300).contains(&s));
    let field = |k: &str| body.and_then(|b| b.get(k)).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
    if let (true, Some(id)) = (ok, field("client_id")) {
        Ok((id, field("client_secret")))
    } else {
        let why = status.map(|s| format!(" (HTTP {s})")).unwrap_or_default();
        Err(ConnectorError::Upstream(format!("{} didn’t register wisp{why}. Add its API key as a header instead", host_of(issuer))))
    }
}

/// The browser's sign-in page: the authorize endpoint with v1's query, set over whatever it had.
pub fn authorize_url(o: &OAuthMeta, redirect: &str, challenge: &str, state: &str) -> Result<String> {
    let mut u = url::Url::parse(&o.authorize).map_err(|_| ConnectorError::invalid("The sign-in server gave no address to sign in at"))?;
    let scope = o.scopes.join(" ");
    let mut ours: Vec<(&str, &str)> = vec![
        ("response_type", "code"),
        ("client_id", o.client_id.as_deref().unwrap_or("")),
        ("redirect_uri", redirect),
        ("code_challenge", challenge),
        ("code_challenge_method", "S256"),
        ("state", state),
        ("resource", &o.resource),
    ];
    if !o.scopes.is_empty() {
        ours.push(("scope", &scope));
    }
    let kept: Vec<(String, String)> =
        u.query_pairs().filter(|(k, _)| !ours.iter().any(|(o, _)| o == k)).map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
    u.query_pairs_mut().clear().extend_pairs(kept).extend_pairs(ours);
    Ok(u.into())
}

/// Where the browser comes back to on this wisp: the page's own origin (so it works through a grid).
pub fn redirect_for(origin: &str) -> Result<String> {
    resolve(origin, wisp_connectors_api::OAUTH_CALLBACK)
        .ok_or_else(|| ConnectorError::invalid("origin: the page’s own address, where the browser comes back to"))
}

/// A sign-in waiting for the browser to come back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pending {
    pub id: String,
    pub verifier: String,
    pub redirect: String,
    pub at: i64,
}

/// state → pending sign-in, in memory (a restart forgets them, as v1 did).
#[derive(Debug, Default)]
pub struct PendingSignins {
    map: BTreeMap<String, Pending>,
}

impl PendingSignins {
    pub fn begin(&mut self, state: String, p: Pending) {
        let now = p.at;
        self.map.retain(|_, x| now - x.at <= PENDING_MS);
        self.map.insert(state, p);
    }

    /// One use only, and not once it's too old.
    pub fn take(&mut self, state: &str, now: i64) -> Result<Pending> {
        match self.map.remove(state) {
            Some(p) if now - p.at <= PENDING_MS => Ok(p),
            _ => Err(ConnectorError::invalid("This sign-in is too old or was already used. Start it again from Settings → Connectors")),
        }
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
}

/// The callback's own refusal (`error`, `error_description`), checked after the state.
pub fn callback_refusal(q: &BTreeMap<String, String>) -> Result<()> {
    match q.get("error").filter(|e| !e.is_empty()) {
        None => Ok(()),
        Some(e) => Err(ConnectorError::invalid(match q.get("error_description").filter(|d| !d.is_empty()) {
            Some(d) => d.clone(),
            None if e == "access_denied" => "You didn’t allow it".to_owned(),
            None => e.clone(),
        })),
    }
}

/// The code for tokens.
pub fn code_form(o: &OAuthMeta, code: &str, p: &Pending, secret: Option<&str>) -> Vec<(String, String)> {
    let mut f = vec![
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", &p.redirect),
        ("client_id", o.client_id.as_deref().unwrap_or("")),
        ("code_verifier", &p.verifier),
        ("resource", &o.resource),
    ];
    f.extend(secret.map(|s| ("client_secret", s)));
    f.into_iter().map(|(k, v)| (k.to_owned(), v.to_owned())).collect()
}

pub fn refresh_form(o: &OAuthMeta, refresh: &str, secret: Option<&str>) -> Vec<(String, String)> {
    let mut f = vec![
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh),
        ("client_id", o.client_id.as_deref().unwrap_or("")),
        ("resource", &o.resource),
    ];
    f.extend(secret.map(|s| ("client_secret", s)));
    f.into_iter().map(|(k, v)| (k.to_owned(), v.to_owned())).collect()
}

pub fn form_encode(pairs: &[(String, String)]) -> String {
    url::form_urlencoded::Serializer::new(String::new()).extend_pairs(pairs).finish()
}

/// What the token endpoint gave.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tokens {
    pub access: String,
    pub refresh: Option<String>,
    /// seconds
    pub expires_in: Option<i64>,
}

/// A token reply: JSON, or a form (GitHub-style). Refused, or no access token: why, in v1's words.
pub fn token_reply(status: u16, text: &str) -> Result<Tokens> {
    let body: Map<String, Value> = match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(m)) => m,
        _ => url::form_urlencoded::parse(text.as_bytes()).map(|(k, v)| (k.into_owned(), Value::String(v.into_owned()))).collect(),
    };
    let s = |k: &str| body.get(k).and_then(Value::as_str).filter(|v| !v.is_empty()).map(str::to_owned);
    if !(200..300).contains(&status) || s("error").is_some() {
        let why = s("error_description").or_else(|| s("error")).unwrap_or_else(|| format!("HTTP {status}"));
        return Err(ConnectorError::Upstream(format!("The sign-in was refused: {why}")));
    }
    let access = s("access_token").ok_or_else(|| ConnectorError::Upstream("The sign-in gave no token".into()))?;
    let expires_in = body.get("expires_in").and_then(|v| v.as_i64().or_else(|| v.as_str()?.parse().ok())).filter(|n| *n > 0);
    Ok(Tokens { access, refresh: s("refresh_token"), expires_in })
}

/// The metadata after new tokens: when they run out, and since when it is signed in.
pub fn after_tokens(o: &OAuthMeta, t: &Tokens, now: i64) -> OAuthMeta {
    OAuthMeta { expires_at: t.expires_in.map(|s| now + s * 1000), signed_in_at: Some(o.signed_in_at.unwrap_or(now)), ..o.clone() }
}

/// What a token request does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TokenStep {
    /// this one works for the next minute at least (or none: sign in again)
    Use(Option<String>),
    Refresh(String),
}

/// v1 `auth.token`: the saved one unless it runs out within a minute or the server refused it (`force`).
pub fn token_step(o: Option<&OAuthMeta>, access: Option<String>, refresh: Option<String>, now: i64, force: bool) -> TokenStep {
    let Some(o) = o else { return TokenStep::Use(None) };
    let fresh = o.expires_at.is_none_or(|t| t > now + FRESH_MS);
    if access.is_some() && !force && fresh {
        return TokenStep::Use(access);
    }
    match refresh {
        Some(r) => TokenStep::Refresh(r),
        None if force => TokenStep::Use(None),
        None => TokenStep::Use(access),
    }
}
