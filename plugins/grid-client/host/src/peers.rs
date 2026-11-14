//! The grid's machines as wisp.machines peers (through its commands, as any plugin would): the cloud box
//! (transport `grid`) and the other computers on the account (transport `grid-tunnel`), each with the
//! device token as its secret. This computer's own entry is never added as a peer of itself.
use std::sync::Arc;

use serde_json::{Value, json};
use wisp_kernel::Result;
use wisp_machines_api::{AddArgs, GRID, GRID_TUNNEL};

use crate::calls::{self, Peer};
use crate::net;
use crate::state::St;

/// The origin's host and port (`http://ada.wisp.localhost:8080` → (`ada.wisp.localhost`, 8080)).
pub fn host_port(url: &str) -> (String, u16) {
    let https = url.starts_with("https:");
    let host = net::host_of(url);
    match host.rsplit_once(':') {
        Some((h, p)) if p.bytes().all(|b| b.is_ascii_digit()) && !p.is_empty() => {
            (h.to_owned(), p.parse().unwrap_or(if https { 443 } else { 80 }))
        }
        _ => (host.to_owned(), if https { 443 } else { 80 }),
    }
}

/// The cloud box's peer among `have`: the one it was, or this grid's `grid` peer.
pub(crate) fn cloud_of<'a>(have: &'a [Peer], prev: &str, grid: &str) -> Option<&'a Peer> {
    have.iter().find(|p| p.id == prev || (p.field("grid") == Some(grid) && p.transport == GRID))
}

/// A grid peer's transport fields.
fn data(pairs: &[(&str, &str)]) -> std::collections::BTreeMap<String, Value> {
    pairs.iter().map(|(k, v)| ((*k).to_owned(), json!(v))).collect()
}

/// The cloud box's peer: added, or its token renewed. → its id.
pub async fn cloud_box(st: &Arc<St>, prev: &str, grid: &str, handle: &str, url: &str, token: &str) -> Result<String> {
    let have = calls::peers(&st.ctx).await;
    if let Some(p) = cloud_of(&have, prev, grid) {
        calls::update(&st.ctx, &p.id, AddArgs { token: Some(token.to_owned()), ..AddArgs::default() }).await?;
        return Ok(p.id.clone());
    }
    let (host, port) = host_port(url);
    let add = AddArgs {
        name: Some("Cloud".into()),
        transport: Some(GRID.into()),
        address: Some(host),
        port: Some(json!(port)),
        token: Some(token.to_owned()),
        data: data(&[("url", url), ("grid", grid), ("handle", handle)]),
        connect: Some(false),
        ..AddArgs::default()
    };
    let id = calls::add(&st.ctx, add).await?;
    // a cloud computer is watched, not woken, until it's used
    calls::warn("machines.follow (the cloud box)", calls::follow(&st.ctx, &id).await);
    Ok(id)
}

/// The account's other computers as `grid-tunnel` peers (new ones added, renamed ones renamed).
pub async fn sync_computers(st: &Arc<St>) -> Result<usize> {
    let Ok((a, token)) = st.signed_in().await else { return Ok(0) };
    let (status, list) = net::call(&st.http, "GET", &format!("{}/api/computers", a.grid), Some(&token), None, &[]).await?;
    if status >= 400 {
        return Err(net::refused(status, &list));
    }
    let have = calls::peers(&st.ctx).await;
    let mut n = 0;
    for c in list.as_array().into_iter().flatten() {
        let (Some(cid), Some(url)) = (c.get("id").and_then(Value::as_str), c.get("url").and_then(Value::as_str)) else { continue };
        if cid == a.computer_id {
            continue;
        }
        let name = c.get("name").and_then(Value::as_str).unwrap_or("Computer");
        if let Some(p) = have.iter().find(|p| p.field("computer") == Some(cid)) {
            if p.name != name {
                calls::warn(
                    "machines.update (a computer's name)",
                    calls::update(&st.ctx, &p.id, AddArgs { name: Some(name.to_owned()), ..AddArgs::default() }).await,
                );
            }
            continue;
        }
        let (host, port) = host_port(url);
        let label = c.get("label").and_then(Value::as_str).unwrap_or_default();
        let add = AddArgs {
            name: Some(name.to_owned()),
            transport: Some(GRID_TUNNEL.into()),
            address: Some(host),
            port: Some(json!(port)),
            token: Some(token.clone()),
            data: data(&[("url", url), ("grid", &a.grid), ("handle", &a.handle), ("computer", cid), ("label", label)]),
            ..AddArgs::default()
        };
        calls::add(&st.ctx, add).await?;
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

    /// machines.list flattens a peer's transport fields (`grid`, not `data.grid`): read by pointer at
    /// `/data/grid`, a renewed sign-in never found its cloud box and computers were added again each sync.
    #[test]
    fn the_cloud_box_and_computers_are_found_by_their_flattened_fields() {
        let peer =
            |id: &str, t: &str, k: &str, v: &str| Peer { id: id.into(), transport: t.into(), data: data(&[(k, v)]), ..Peer::default() };
        let have = vec![peer("m1", GRID_TUNNEL, "computer", "c1"), peer("m2", GRID, "grid", "https://g.test")];
        assert_eq!(cloud_of(&have, "gone", "https://g.test").map(|p| p.id.as_str()), Some("m2"));
        assert_eq!(cloud_of(&have, "m1", "https://other.test").map(|p| p.id.as_str()), Some("m1"), "the one it was");
        assert!(cloud_of(&have, "gone", "https://other.test").is_none());
    }
}
