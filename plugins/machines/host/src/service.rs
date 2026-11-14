//! `machines.peers@1` (machines-api `service.rs`): other plugins reach a peer's wisp through it
//! (crew, router, the terminal's Take over). Every method checks the caller's permission first.
use std::sync::Arc;

use serde_json::Value;
use wisp_kernel::{BoxFuture, Call, Result, WireError};
use wisp_machines_api::{ChannelRequest, ChannelResponse, MachinesService, MirrorRow, PeerRow, PeerState, RemoteAgent};
use wisp_machines_core::reply;

use crate::error::{MachinesError, Res};
use crate::{Slot, State, lock, state};

pub(crate) struct Service(pub Slot);

impl std::fmt::Debug for Service {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("machines.peers")
    }
}

/// A JSON call to the peer's API (path under `/api`); a peer's error keeps its status and words.
pub(crate) async fn json(
    st: Arc<State>,
    id: String,
    method: String,
    path: String,
    body: Option<Value>,
    timeout_ms: Option<u64>,
) -> Res<Value> {
    let row = st.peer(&id)?;
    let _ = crate::manager::secret_of(&st, &id).await;
    let ch = st.channel(&id)?;
    let mut req = match &body {
        Some(b) => ChannelRequest::json(&method, path, b),
        None => ChannelRequest { method, path, ..ChannelRequest::default() },
    };
    // `/api/cmd` takes a key: one per call made here
    req.headers.push(("idempotency-key".into(), format!("machines-{:016x}", rand::random::<u64>())));
    req.timeout_ms = Some(timeout_ms.unwrap_or(30_000));
    let r = ch.request(req).await.map_err(MachinesError::Wire)?;
    let status = r.status;
    let v = reply::parse_reply(&r.bytes(16 * 1024 * 1024).await);
    if status >= 400 {
        let (message, hold) = reply::reply_error(&row.name, status, &v);
        return Err(MachinesError::Peer { message, status, hold });
    }
    Ok(v)
}

impl Service {
    fn st(&self, call: &Call, permission: &str) -> Result<Arc<State>> {
        call.require(permission)?;
        state(&self.0)
    }
}

impl MachinesService for Service {
    fn json(
        &self,
        call: &Call,
        id: &str,
        method: &str,
        path: &str,
        body: Option<Value>,
        timeout_ms: Option<u64>,
    ) -> BoxFuture<'static, Result<Value>> {
        let st = self.st(call, "machines:call");
        let (id, method, path) = (id.to_owned(), method.to_owned(), path.to_owned());
        Box::pin(async move { json(st?, id, method, path, body, timeout_ms).await.map_err(WireError::from) })
    }
    fn stream(&self, call: &Call, id: &str, req: ChannelRequest) -> BoxFuture<'static, Result<ChannelResponse>> {
        let ch = self.st(call, "machines:call").and_then(|st| st.channel(id).map_err(WireError::from));
        Box::pin(async move { ch?.request(req).await })
    }
    fn usable(&self, call: &Call, id: &str) -> Result<bool> {
        let st = self.st(call, "machines:read")?;
        st.peer(id).map_err(WireError::from)?;
        Ok(st.channel(id).is_ok())
    }
    fn online(&self, call: &Call, id: &str) -> Result<bool> {
        let st = self.st(call, "machines:read")?;
        Ok(st.with_link(id, |l| l.conn.status.state == PeerState::Online).unwrap_or(false))
    }
    fn agents_of(&self, call: &Call, id: &str) -> Result<Option<Vec<RemoteAgent>>> {
        let st = self.st(call, "machines:read")?;
        Ok(st.with_link(id, |l| l.conn.status.remote.as_ref().and_then(|r| r.agents.clone())).flatten())
    }
    fn rows(&self, call: &Call, id: Option<&str>) -> Result<Vec<MirrorRow>> {
        let st = self.st(call, "machines:read")?;
        Ok(lock(&st.mirror).rows(id))
    }
    fn terminal_argv(&self, call: &Call, id: &str, command: &str) -> Result<Vec<String>> {
        let st = self.st(call, "machines:call")?;
        let row = st.peer(id).map_err(WireError::from)?;
        let t = st.transport(&row.transport).map_err(WireError::from)?;
        t.terminal_argv(&row, command).ok_or_else(|| WireError::invalid(format!("{} has no terminal from here.", row.name)))
    }
    fn peers(&self, call: &Call) -> Result<Vec<PeerRow>> {
        Ok(self.st(call, "machines:read")?.peers())
    }
}
