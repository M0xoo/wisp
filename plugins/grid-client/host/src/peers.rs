//! The grid's machines as wisp.machines peers (through its commands, as any plugin would): the cloud box
//! (transport `grid`) and the other computers on the account (transport `grid-tunnel`), each with the
//! device token as its secret. This computer's own entry is never added as a peer of itself.
use std::sync::Arc;

use serde_json::{Value, json};
use wisp_kernel::{Result, WireError};

use crate::net;
use crate::state::St;

/// The origin's host and port (`http://ada.wisp.localhost:8080` → (`ada.wisp.localhost`, 8080)).
pub fn host_port(url: &str) -> (String, u16) {
    let https = url.starts_with("https:");
    let host = net::host_of(url);
    match host.rsplit_once(':') {
        Some((h, p)) if p.bytes().all(|b| b.is_ascii_digit()) && !p.is_empty() => (h.to_owned(), p.parse().unwrap_or(if https { 443 } else { 80 })),
        _ => (host.to_owned(), if https { 443 } else { 80 }),
    }
}

async fn peers(st: &St) -> Vec<Value> {
    let call = st.ctx.root_call();
    st.ctx.run_json(&call, "machines.list", json!({})).await.ok().and_then(|v| v.as_array().cloned()).unwrap_or_default()
}

/// The cloud box's peer: added, or its token renewed. → its id.
pub async fn cloud_box(st: &Arc<St>, prev: &str, grid: &str, handle: &str, url: &str, token: &str) -> Result<String> {
    let call = st.ctx.root_call();
    let have = peers(st).await.into_iter().find(|p| p.get("id").and_then(Value::as_str) == Some(prev) || (p.pointer("/data/grid").and_then(Value::as_str) == Some(grid) && p.get("transport").and_then(Value::as_str) == Some("grid")));
    if let Some(id) = have.as_ref().and_then(|p| p.get("id").and_then(Value::as_str)) {
        st.ctx.run_json(&call, "machines.update", json!({ "id": id, "token": token })).await?;
        return Ok(id.to_owned());
    }
    let (host, port) = host_port(url);
    let made = st
        .ctx
        .run_json(&call, "machines.add", json!({ "name": "Cloud", "transport": "grid", "address": host, "port": port, "token": token, "data": { "url": url, "grid": grid, "handle": handle }, "connect": false }))
        .await?;
    let id = made.get("id").and_then(Value::as_str).ok_or_else(|| WireError::internal("machines.add gave no id"))?.to_owned();
    // a cloud computer is watched, not woken, until it's used
    let _ = st.ctx.run_json(&call, "machines.follow", json!({ "id": id })).await;
    Ok(id)
}

/// The account's other computers as `grid-tunnel` peers (new ones added, renamed ones renamed).
pub async fn sync_computers(st: &Arc<St>) -> Result<usize> {
    let Ok((a, token)) = st.signed_in().await else { return Ok(0) };
    let (status, list) = net::call(&st.http, "GET", &format!("{}/api/computers", a.grid), Some(&token), None, &[]).await?;
    if status >= 400 {
        return Err(net::refused(status, &list));
    }
    let call = st.ctx.root_call();
    let have = peers(st).await;
    let mut n = 0;
    for c in list.as_array().into_iter().flatten() {
        let (Some(cid), Some(url)) = (c.get("id").and_then(Value::as_str), c.get("url").and_then(Value::as_str)) else { continue };
        if cid == a.computer_id {
            continue;
        }
        let name = c.get("name").and_then(Value::as_str).unwrap_or("Computer");
        if let Some(p) = have.iter().find(|p| p.pointer("/data/computer").and_then(Value::as_str) == Some(cid)) {
            if p.get("name").and_then(Value::as_str) != Some(name) {
                let _ = st.ctx.run_json(&call, "machines.update", json!({ "id": p["id"], "name": name })).await;
            }
            continue;
        }
        let (host, port) = host_port(url);
        let label = c.get("label").and_then(Value::as_str).unwrap_or_default();
        st.ctx
            .run_json(&call, "machines.add", json!({ "name": name, "transport": "grid-tunnel", "address": host, "port": port, "token": token, "data": { "url": url, "grid": a.grid, "handle": a.handle, "computer": cid, "label": label } }))
            .await?;
        n += 1;
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins_split_into_host_and_port() {
        assert_eq!(host_port("http://ada.wisp.localhost:8080"), ("ada.wisp.localhost".into(), 8080));
        assert_eq!(host_port("https://ada.grid.trywisp.dev"), ("ada.grid.trywisp.dev".into(), 443));
    }
}
