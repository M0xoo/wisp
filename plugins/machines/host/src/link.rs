//! The sync link to one peer (plan §4.5, §7.2.1): one `GET /api/events` stream there, opened with
//! the hello core's `PeerClient` builds (resuming from its cursor), its frames fed back to it, and
//! what it returns carried out: messages posted to `POST /api/events` in order, snapshots and ops
//! applied to the mirror (flushed to the store once per frame), acks and rejects handed to the
//! routed commands waiting on them.
use std::sync::Arc;

use tokio::sync::mpsc;
use wisp_kernel::CancellationToken;
use wisp_machines_api::{Channel, ChannelRequest, PeerState, Remote};
use wisp_machines_core::mirror::Touched;
use wisp_machines_core::negotiate::update_words;
use wisp_machines_core::peer_client::{Out, State as LinkState, Update, decode_frame};
use wisp_machines_core::sse::SseParser;
use wisp_protocol::{ClientMessage, ServerMessage};

use crate::error::MachinesError;
use crate::{State, lock, store};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum End {
    /// hung up here
    Cancelled,
    /// outside the protocol window: the card says who must update
    Incompatible,
    /// the stream ended: reconnect
    Lost,
}

/// `k=v&…`, percent-encoding all but the unreserved characters (and `,` between topics).
pub(crate) fn query(params: &[(String, String)]) -> String {
    let enc = |s: &str| {
        s.bytes()
            .map(|b| if b.is_ascii_alphanumeric() || b"-_.~,".contains(&b) { char::from(b).to_string() } else { format!("%{b:02X}") })
            .collect::<String>()
    };
    params.iter().map(|(k, v)| format!("{}={}", enc(k), enc(v))).collect::<Vec<_>>().join("&")
}

/// Posts the link's messages in the order they were made; ends with the stream.
async fn poster(ch: Arc<dyn Channel>, client_id: String, mut rx: mpsc::UnboundedReceiver<ClientMessage>, token: CancellationToken) {
    loop {
        let m = tokio::select! {
            () = token.cancelled() => return,
            m = rx.recv() => m,
        };
        let Some(m) = m else { return };
        let Ok(body) = serde_json::to_value(&m) else { continue };
        let mut req = ChannelRequest::json("POST", "/events", &body);
        req.headers.push(("x-wisp-client".into(), client_id.clone()));
        req.timeout_ms = Some(30_000);
        if let Ok(r) = ch.request(req).await {
            let _ = r.bytes(64 * 1024).await;
        }
    }
}

/// Carries out what the peer's client returned. `true`: the link must end (incompatible).
pub(crate) fn carry(st: &State, id: &str, outs: Vec<Out>) -> bool {
    let mut touched: Vec<Touched> = Vec::new();
    let mut save = false;
    let mut stop = false;
    for out in outs {
        match out {
            Out::Send(m) => {
                st.with_link(id, |l| l.post.as_ref().map(|p| p.send(m)));
            }
            Out::Reset => touched.extend(lock(&st.mirror).reset(id)),
            Out::Snapshot { topic, rows } => {
                touched.extend(lock(&st.mirror).snapshot(id, &topic, rows));
                save = true;
            }
            Out::EntityOps(ops) => {
                let (t, drifted) = lock(&st.mirror).apply(id, ops);
                touched.extend(t);
                for topic in drifted {
                    let more = st.with_link(id, |l| l.client.drifted(&topic)).unwrap_or_default();
                    stop |= carry(st, id, more);
                }
            }
            Out::Ack { mid, result, .. } => {
                st.settle(&mid, &Ok(result.unwrap_or(serde_json::Value::Null)));
                save = true;
            }
            Out::Reject { mid, code, message } => {
                st.settle(&mid, &Err(MachinesError::Rejected { code, message }));
                save = true;
            }
            Out::State(LinkState::Incompatible, update) => {
                incompatible(st, id, update);
                stop = true;
            }
            Out::Denied { topic, code } => tracing::warn!(peer = id, topic = %topic.as_str(), code, "the peer refused a topic"),
            Out::Request(_) | Out::Rows { .. } | Out::NeedResubscribe(_) | Out::Notice(_) | Out::State(..) | Out::Retry { .. } => {}
        }
    }
    flush(st, touched);
    st.save_sync(id, save);
    stop
}

fn incompatible(st: &State, id: &str, update: Option<Update>) {
    let name = st.peer(id).map(|p| p.name).unwrap_or_default();
    let words = update_words(&name, update == Some(Update::Peer));
    st.with_link(id, |l| {
        l.conn.give_up = true;
        l.conn.status.state = PeerState::Incompatible;
        l.conn.status.error.clone_from(&words);
        l.conn.status.update = Some(words);
    });
    st.publish(id);
}

/// The mirror's changes to the store (one transaction) and to `machines.remote`.
fn flush(st: &State, touched: Vec<Touched>) {
    if touched.is_empty() {
        return;
    }
    let dirty = lock(&st.mirror).take_dirty();
    st.store.write_detached(move |w| store::put_mirror(w, dirty));
    let call = st.ctx.root_call();
    for t in touched {
        st.ctx.emit(&call, &Remote { id: t.peer, op: t.op, row_id: t.id });
    }
}

/// The welcome names the peer: its `peer_id` is learned (v2 ids carry it as their origin).
fn learn(st: &State, id: &str, messages: &[ServerMessage]) {
    for m in messages {
        if let ServerMessage::Welcome(w) = m
            && let Ok(mut row) = st.peer(id)
            && row.peer.as_deref() != Some(w.peer.peer.as_str())
        {
            row.peer = Some(w.peer.peer.clone());
            st.save_peer(&row);
        }
    }
}

/// Runs the stream until it ends.
pub(crate) async fn run(st: &State, id: &str, ch: &Arc<dyn Channel>, token: &CancellationToken) -> End {
    let Some((outs, client_id)) = st.with_link(id, |l| (l.client.open(), l.client_id.clone())) else { return End::Cancelled };
    let params = outs.iter().find_map(|o| if let Out::Request(p) = o { Some(p.clone()) } else { None }).unwrap_or_default();
    let (tx, rx) = mpsc::unbounded_channel();
    st.with_link(id, |l| l.post = Some(tx));
    let _ = carry(st, id, outs);
    let req = ChannelRequest { headers: vec![("accept".into(), "text/event-stream".into())], passive: true, ..ChannelRequest::get(format!("/events?{}", query(&params))) };
    let resp = tokio::select! {
        () = token.cancelled() => return End::Cancelled,
        r = ch.request(req) => r,
    };
    let mut resp = match resp {
        Ok(r) if r.status == 200 => r,
        _ => return lost(st, id),
    };
    let stream = token.child_token();
    tokio::spawn(poster(ch.clone(), client_id, rx, stream.clone()));
    let _stop = stream.drop_guard();
    let mut parser = SseParser::new();
    loop {
        let chunk = tokio::select! {
            () = token.cancelled() => {
                resp.cancel.cancel();
                return End::Cancelled;
            }
            c = resp.body.recv() => c,
        };
        let Some(chunk) = chunk else { break };
        for ev in parser.push(&chunk) {
            let Some((at, messages)) = decode_frame(&ev.event, ev.id.as_deref(), &ev.data) else { continue };
            learn(st, id, &messages);
            let outs = st.with_link(id, |l| l.client.frame(at, messages)).unwrap_or_default();
            if carry(st, id, outs) {
                resp.cancel.cancel();
                return End::Incompatible;
            }
        }
    }
    lost(st, id)
}

fn lost(st: &State, id: &str) -> End {
    let now = st.now();
    st.with_link(id, |l| {
        l.post = None;
        let _ = l.client.lost(now); // the manager owns the reconnect (and its backoff)
    });
    End::Lost
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_hello_is_encoded() {
        let p = vec![("topics".to_owned(), "list,session:a b".to_owned()), ("build".to_owned(), "2.0.0".to_owned())];
        assert_eq!(query(&p), "topics=list,session%3Aa%20b&build=2.0.0");
    }
}
