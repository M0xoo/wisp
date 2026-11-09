//! wisp Cloud as the place shares go (ADR-0038): the `wisp-cloud` destination (`share.destination@1`), my
//! shares (list, access, revoke), and the other way: fetching a link (checking its signature), recording
//! what was taken in, and saying when a share moved on ("update available").
use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use ed25519_dalek::{Signature, Verifier as _, VerifyingKey};
use serde_json::{Value, json};
use wisp_grid_client_api::{AccessArgs, Fetched, Update};
use wisp_grid_client_core::{Link, grid_url, link};
use wisp_kernel::{BoxFuture, Result, WireError};
use wisp_share_api::{Outgoing, ShareDestination};

use crate::net;
use crate::state::{Import, St};

pub struct Cloud(pub Arc<St>);

impl std::fmt::Debug for Cloud {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Cloud")
    }
}

impl ShareDestination for Cloud {
    fn id(&self) -> &'static str {
        "wisp-cloud"
    }
    fn label(&self) -> &'static str {
        "wisp Cloud"
    }
    fn ready(&self) -> BoxFuture<'static, std::result::Result<(), String>> {
        let st = self.0.clone();
        Box::pin(async move { st.signed_in().await.map(|_| ()).map_err(|_| "Not signed in to wisp Cloud: run wisp cloud signin (or share to a file: --to file)".to_owned()) })
    }
    fn send(&self, out: Outgoing) -> BoxFuture<'static, Result<Value>> {
        let st = self.0.clone();
        Box::pin(async move {
            let (a, token) = st.signed_in().await.map_err(WireError::invalid)?;
            let body = json!({
                "kind": out.kind, "key": out.key, "title": out.title, "summary": out.summary, "tags": out.tags,
                "body": B64.encode(&out.body), "signer": out.signer, "sig": out.sig,
                "access": out.access, "expiresAt": out.expires_at, "publish": out.publish,
            });
            let (status, v) = net::call(&st.http, "POST", &format!("{}/api/shares", a.grid), Some(&token), Some(&body), &[]).await?;
            if status >= 400 {
                return Err(net::refused(status, &v));
            }
            Ok(v)
        })
    }
}

/// My shares on the grid: kind, access, views, imports, versions.
pub async fn mine(st: &St) -> Result<Value> {
    let (a, token) = st.signed_in().await.map_err(WireError::invalid)?;
    let (status, v) = net::call(&st.http, "GET", &format!("{}/api/shares", a.grid), Some(&token), None, &[]).await?;
    if status >= 400 {
        return Err(net::refused(status, &v));
    }
    Ok(v)
}

pub async fn access(st: &St, x: &AccessArgs) -> Result<Value> {
    let (a, token) = st.signed_in().await.map_err(WireError::invalid)?;
    let body = json!({ "access": x.access, "expiresAt": x.expires_at, "publish": x.publish });
    let (status, v) = net::call(&st.http, "PATCH", &format!("{}/api/shares/{}", a.grid, x.id), Some(&token), Some(&body), &[]).await?;
    if status >= 400 {
        return Err(net::refused(status, &v));
    }
    Ok(v)
}

pub async fn revoke(st: &St, id: &str) -> Result<Value> {
    let (a, token) = st.signed_in().await.map_err(WireError::invalid)?;
    let (status, v) = net::call(&st.http, "DELETE", &format!("{}/api/shares/{id}", a.grid), Some(&token), None, &[]).await?;
    if status >= 400 {
        return Err(net::refused(status, &v));
    }
    Ok(v)
}

/// Whether `sig` is `signer`'s over `body`.
pub fn verify(signer: &str, sig: &str, body: &[u8]) -> bool {
    let (Ok(k), Ok(s)) = (B64.decode(signer.trim()), B64.decode(sig.trim())) else { return false };
    let (Ok(k), Ok(s)) = (<[u8; 32]>::try_from(k.as_slice()), <[u8; 64]>::try_from(s.as_slice())) else { return false };
    VerifyingKey::from_bytes(&k).is_ok_and(|vk| vk.verify(body, &Signature::from_bytes(&s)).is_ok())
}

/// The grid a link names (its own origin), else the one signed in to.
fn grid_of(st: &St, l: &Link) -> Result<String> {
    if let Link::Id { grid: Some(g), .. } = l {
        return Ok(g.clone());
    }
    st.account().map(|a| a.grid).or_else(|| grid_url(wisp_grid_client_api::DEFAULT_GRID)).ok_or_else(|| WireError::invalid("which grid?"))
}

fn url_of(grid: &str, l: &Link) -> String {
    let q = |v: &Option<String>| v.as_ref().map(|r| format!("?ref={r}")).unwrap_or_default();
    match l {
        Link::Id { id, version, .. } => format!("{grid}/api/shares/{id}{}", q(version)),
        Link::Name { handle, name, version } => format!("{grid}/api/shares/by/{handle}/{name}{}", q(version)),
    }
}

/// A share, fetched and checked. Anyone may fetch an `anyone` link; signed in, people and teams shares too.
pub async fn fetch(st: &St, raw: &str, password: Option<&str>) -> Result<Fetched> {
    let l = link(raw).ok_or_else(|| WireError::invalid(format!("{raw} isn't a share link")))?;
    let grid = grid_of(st, &l)?;
    let token = st.token().await.filter(|_| st.account().is_some_and(|a| a.grid == grid));
    let headers: Vec<(&str, &str)> = password.map(|p| vec![("x-wisp-share-password", p)]).unwrap_or_default();
    let (status, v) = net::call(&st.http, "GET", &url_of(&grid, &l), token.as_deref(), None, &headers).await?;
    if status >= 400 {
        let mut e = net::refused(status, &v);
        if let Some(how) = v.get("locked").and_then(Value::as_str) {
            e.message = match how {
                "password" => "This share has a password: --password".into(),
                "people" => "This share is for some people only: sign in as one of them (wisp cloud signin)".into(),
                _ => "This share is for a team: sign in as a member (wisp cloud signin)".into(),
            };
        }
        return Err(e);
    }
    let body = B64.decode(v.get("body").and_then(Value::as_str).unwrap_or_default()).unwrap_or_default();
    let (sig, signer) = (v.get("sig").and_then(Value::as_str).unwrap_or_default(), v.get("signer").and_then(Value::as_str).unwrap_or_default());
    let content: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let n = |k: &str| v.get(k).and_then(Value::as_i64).unwrap_or(0);
    Ok(Fetched { card: v.get("card").cloned().unwrap_or(Value::Null), version: n("version"), latest: n("latest"), content, verified: verify(signer, sig, &body), signer: signer.to_owned() })
}

/// Taken in: counted on the grid, and remembered here for "update available".
pub async fn imported(st: &St, raw: &str, version: i64) -> Result<Value> {
    let f = fetch(st, raw, None).await?;
    let id = f.card.get("id").and_then(Value::as_str).unwrap_or_default().to_owned();
    let l = link(raw).ok_or_else(|| WireError::invalid("not a link"))?;
    let grid = grid_of(st, &l)?;
    let token = st.token().await.filter(|_| st.account().is_some_and(|a| a.grid == grid));
    let _ = net::call(&st.http, "POST", &format!("{grid}/api/shares/{id}/import"), token.as_deref(), Some(&json!({})), &[]).await;
    let s = |k: &str| f.card.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
    st.save_import(Import { id, grid, url: s("url"), title: s("title"), kind: s("kind"), version: if version > 0 { version } else { f.version } }).await?;
    Ok(json!({ "ok": true }))
}

/// The imports whose share has a newer version than the one taken.
pub async fn updates(st: &St) -> Result<Vec<Update>> {
    let mut out = Vec::new();
    for i in st.imports().await? {
        let Ok(f) = fetch(st, &i.url, None).await else { continue };
        if f.latest > i.version {
            out.push(Update { id: i.id, url: i.url, title: i.title, kind: i.kind, have: i.version, latest: f.latest });
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use ed25519_dalek::{Signer as _, SigningKey};

    use super::*;

    #[test]
    fn a_fetched_share_is_checked_against_its_signer() {
        let k = SigningKey::from_bytes(&[3; 32]);
        let (signer, sig) = (B64.encode(k.verifying_key().to_bytes()), B64.encode(k.sign(b"files").to_bytes()));
        assert!(verify(&signer, &sig, b"files"));
        assert!(!verify(&signer, &sig, b"other files"));
        assert!(!verify("nope", &sig, b"files"));
        let l = link("grid://ada/review?ref=v1").unwrap_or(Link::Id { grid: None, id: String::new(), version: None });
        assert_eq!(url_of("http://g", &l), "http://g/api/shares/by/ada/review?ref=v1");
    }
}
