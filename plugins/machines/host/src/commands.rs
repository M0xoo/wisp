//! wisp.machines' commands (machines-api `commands.rs`): each writes through the store and answers
//! with the peer's card as it is now; connecting goes on in the plugin's scope and moves the card on
//! the `machines` topic.
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use wisp_kernel::{Setup, services};
use wisp_machines_api::commands as c;
use wisp_machines_api::{AddArgs, Done, LetInOut, PeerRow, PeerState, PeerView, RemoveOut, Removed, SSH, secret_key};
use wisp_machines_core::view::{self, DEFAULT_PORT};
use wisp_machines_core::{conn, route};
use wisp_store::Writer;

use crate::error::{MachinesError, Res};
use crate::manager::{self, PeerIo};
use crate::{Slot, State, link, lock, service, state, store, sys};

async fn write<F>(st: &State, f: F) -> Res<()>
where
    F: FnOnce(&mut Writer<'_>) -> wisp_store::Result<()> + Send + 'static,
{
    st.store.write(f).await.map_err(MachinesError::from)
}

async fn keep_token(st: &State, id: &str, token: Option<&str>) -> Res<()> {
    let Some(token) = token.filter(|t| !t.is_empty()) else { return Ok(()) };
    let secrets = services::secrets(&st.ctx).map_err(MachinesError::Wire)?;
    secrets.set(&secret_key(id), token).await.map_err(MachinesError::Wire)?;
    lock(&st.secrets).insert(id.to_owned(), token.to_owned());
    Ok(())
}

fn new_id(st: &State) -> String {
    loop {
        let id = view::handle(rand::random());
        if !lock(&st.peers).contains_key(&id) {
            return id;
        }
    }
}

async fn add(st: &Arc<State>, a: AddArgs) -> Res<PeerView> {
    let kind = a.transport.clone().filter(|k| !k.is_empty()).unwrap_or_else(|| SSH.to_owned());
    let t = st.transport(&kind)?;
    let cl = t.clean(&a, None)?;
    let id = new_id(st);
    let row = PeerRow {
        id: id.clone(),
        peer: None,
        name: cl.name.unwrap_or_else(|| id.clone()),
        transport: kind,
        address: cl.address.unwrap_or_default(),
        port: cl.port.unwrap_or(DEFAULT_PORT),
        command: cl.command.unwrap_or_default(),
        auto_connect: cl.auto_connect.unwrap_or(true),
        added_at: st.now(),
        data: a.data.clone(),
    };
    keep_token(st, &id, a.token.as_deref()).await?;
    let r = row.clone();
    write(st, move |w| store::put_peer(w, &r)).await?;
    st.add_link(&id, None);
    lock(&st.peers).insert(id.clone(), row);
    st.publish(&id);
    if a.connect != Some(false) {
        manager::connect(st, &id, false)?;
    }
    st.view(&id)
}

async fn update(st: &Arc<State>, a: c::UpdateArgs) -> Res<PeerView> {
    let prev = st.peer(&a.id)?;
    if a.set.transport.as_deref().is_some_and(|k| !k.is_empty() && k != prev.transport) {
        return Err(MachinesError::Invalid("A machine’s transport can’t change: remove it and add it again.".into()));
    }
    let t = st.transport(&prev.transport)?;
    let cl = t.clean(&a.set, Some(&prev))?;
    let mut row = prev.clone();
    row.name = cl.name.unwrap_or(row.name);
    row.address = cl.address.unwrap_or(row.address);
    row.port = cl.port.unwrap_or(row.port);
    row.command = cl.command.unwrap_or(row.command);
    row.auto_connect = cl.auto_connect.unwrap_or(row.auto_connect);
    row.data.extend(a.set.data.clone());
    keep_token(st, &row.id, a.set.token.as_deref()).await?;
    let r = row.clone();
    write(st, move |w| store::put_peer(w, &r)).await?;
    lock(&st.peers).insert(row.id.clone(), row.clone());
    let moved = row.address != prev.address || row.port != prev.port || row.command != prev.command;
    if moved && manager::active(st).contains(&row.id) {
        manager::connect(st, &row.id, false)?;
    } else {
        st.publish(&row.id);
    }
    st.view(&row.id)
}

/// The peer and what goes with it (an account's computers: the transport's `forget`).
async fn remove(st: &Arc<State>, id: String) -> Res<RemoveOut> {
    let row = st.peer(&id)?;
    let others = match st.transport(&row.transport) {
        Ok(t) => t.forget(row.clone(), st.peers()).await,
        Err(_) => Vec::new(),
    };
    let mut removed = vec![id];
    for o in others {
        if lock(&st.peers).contains_key(&o) && !removed.contains(&o) {
            removed.push(o);
        }
    }
    let secrets = services::secrets(&st.ctx).ok();
    for r in &removed {
        manager::disconnect(st, r);
        let Ok(gone) = st.peer(r) else { continue };
        let key = r.clone();
        write(st, move |w| store::forget(w, &key)).await?;
        lock(&st.links).remove(r);
        lock(&st.peers).remove(r);
        let _ = lock(&st.mirror).reset(r);
        let _ = lock(&st.mirror).take_dirty(); // the store rows went with `forget`
        if let Some(s) = &secrets {
            let _ = s.delete(&secret_key(r)).await;
        }
        st.ctx.emit(&st.ctx.root_call(), &Removed { id: r.clone(), row: gone });
    }
    Ok(RemoveOut { ok: true, removed })
}

async fn stop(st: &Arc<State>, a: c::StopArgs) -> Res<PeerView> {
    let row = st.peer(&a.id)?;
    let t = st.transport(&row.transport)?;
    let pid = st.with_link(&a.id, |l| l.conn.status.remote.as_ref().and_then(|r| r.pid).or(l.conn.status.stale)).flatten();
    manager::disconnect(st, &a.id);
    let secret = manager::secret_of(st, &a.id).await;
    t.stop_remote(row, pid, Arc::new(PeerIo::quiet_with(&a.id, secret))).await?;
    if a.restart {
        manager::connect(st, &a.id, false)?;
    }
    st.view(&a.id)
}

async fn let_in(st: &Arc<State>, a: c::LetInArgs) -> Res<LetInOut> {
    let row = st.peer(&a.id)?;
    let t = st.transport(&row.transport)?;
    let out = t.let_in(row, a.password).await?;
    manager::connect(st, &a.id, false)?;
    Ok(LetInOut { machine: st.view(&a.id).ok(), ..out })
}

async fn recheck(st: &Arc<State>, a: c::RecheckArgs) -> Res<Done> {
    let ids = match a.id {
        Some(id) => vec![id],
        None => {
            st.peers().into_iter().map(|p| p.id).filter(|id| st.with_link(id, |l| l.conn.status.state) == Some(PeerState::Online)).collect()
        }
    };
    let fresh = a.agent.unwrap_or_else(|| "all".into());
    for id in ids {
        let ch = st.channel(&id)?;
        let agents = manager::agents(ch.as_ref(), Some(&fresh)).await;
        st.with_link(&id, |l| l.conn.status.remote.get_or_insert_with(Default::default).agents = Some(agents));
        st.publish(&id);
    }
    Ok(Done::YES)
}

/// A v2 command for a row another peer owns: sent there with the same key, kept by the link until
/// its ack (resent after every welcome), so a flaky tunnel never runs it twice.
async fn route(st: &Arc<State>, a: c::RouteArgs) -> Res<Value> {
    let id = match a.id {
        Some(id) => id,
        None => route::owner_of_args(&a.args, &st.peers()).map(|p| p.id.clone()).ok_or(MachinesError::NoPeer)?,
    };
    let row = st.peer(&id)?;
    let (state, wakes) = st.with_link(&id, |l| (l.conn.status.state, l.conn.wakes())).ok_or(MachinesError::NoPeer)?;
    let on_its_way = matches!(state, PeerState::Online | PeerState::Connecting | PeerState::Reconnecting);
    // an asleep box that wakes on a real request (a cloud computer): the command goes straight there with
    // the same key, which wakes it (plan §7.2.3); the link then follows it up
    if !on_its_way && st.transport(&row.transport).is_ok_and(|t| t.wakes_on_request(&row)) {
        let body = serde_json::json!({ "cmd": a.cmd, "args": a.args });
        let mut req = wisp_machines_api::ChannelRequest::json("POST", "/cmd", &body);
        req.headers.push(("idempotency-key".into(), a.mid.clone()));
        req.timeout_ms = Some(120_000);
        let _ = manager::secret_of(st, &id).await;
        let ch = st.channel(&id)?;
        let r = ch.request(req).await.map_err(MachinesError::Wire)?;
        let status = r.status;
        let v = wisp_machines_core::reply::parse_reply(&r.bytes(16 * 1024 * 1024).await);
        let _ = manager::connect(st, &id, false);
        if v.get("ok") == Some(&Value::Bool(true)) {
            return Ok(v.get("result").cloned().unwrap_or(Value::Null));
        }
        let (message, hold) = wisp_machines_core::reply::reply_error(&row.name, status, &v);
        return Err(MachinesError::Peer { message, status, hold });
    }
    if !on_its_way && let Some(words) = conn::refuse(&row.name, state, wakes, row.computer().is_some(), false) {
        return Err(MachinesError::Offline(words));
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    lock(&st.waiters).entry(a.mid.clone()).or_default().push(tx);
    let outs = st.with_link(&id, |l| l.client.mutate(&a.mid, &a.cmd, a.args, None)).unwrap_or_default();
    let _ = link::carry(st, &id, outs);
    st.save_sync(&id, true);
    match tokio::time::timeout(Duration::from_secs(30), rx).await {
        Ok(Ok(out)) => out,
        _ => Err(MachinesError::Waiting(route::waiting_words(&row.name))),
    }
}

macro_rules! on {
    ($s:ident, $slot:ident, $C:ty, |$st:ident, $a:ident| $body:expr) => {{
        let slot = $slot.clone();
        $s.command::<$C, _, _>(move |_ctx, _call, $a| {
            let slot = slot.clone();
            async move {
                let $st = state(&slot)?;
                let out: Res<_> = $body;
                out.map_err(wisp_kernel::WireError::from)
            }
        });
    }};
}

pub(crate) fn register(s: &mut Setup, slot: &Slot) {
    on!(s, slot, c::Add, |st, a| add(&st, a).await);
    on!(s, slot, c::Update, |st, a| update(&st, a).await);
    on!(s, slot, c::Remove, |st, a| remove(&st, a.id).await);
    on!(s, slot, c::Connect, |st, a| manager::connect(&st, &a.id, false).and_then(|()| st.view(&a.id)));
    on!(s, slot, c::Disconnect, |st, a| st.peer(&a.id).and_then(|_| {
        manager::disconnect(&st, &a.id);
        st.view(&a.id)
    }));
    on!(s, slot, c::Stop, |st, a| stop(&st, a).await);
    on!(s, slot, c::LetIn, |st, a| let_in(&st, a).await);
    on!(s, slot, c::Follow, |st, a| manager::follow(&st, &a.id).map(|()| Done::YES));
    on!(s, slot, c::RecheckAgents, |st, a| recheck(&st, a).await);
    on!(s, slot, c::List, |st, _a| Ok(st.views()));
    on!(s, slot, c::Get, |st, a| st.view(&a.id));
    on!(s, slot, c::Sessions, |st, a| {
        if let Some(id) = &a.id {
            st.peer(id)?;
        }
        Ok(lock(&st.mirror).rows(a.id.as_deref()))
    });
    on!(s, slot, c::Hosts, |_st, _a| Ok(sys::hosts().await));
    on!(s, slot, c::Discover, |st, _a| Ok(sys::discover(&st.ctx).await));
    on!(s, slot, c::Reachable, |st, _a| Ok(sys::reachable(&st.ctx).await));
    on!(s, slot, c::CallPeer, |st, a| service::json(st.clone(), a.id, a.method, a.path, a.body, a.timeout_ms).await);
    on!(s, slot, c::Route, |st, a| route(&st, a).await);
}
