//! What the handlers and the links share: the peers, one link per peer (its connection state, its
//! sync client, its channel), the mirror of their lists and the commands waiting for an answer.
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde_json::Value;
use tokio::sync::{mpsc, oneshot};
use wisp_kernel::{CancellationToken, Ctx};
use wisp_machines_api::{Changed, Channel, PeerRow, PeerView, TRANSPORT, Transport};
use wisp_machines_core::conn::Conn;
use wisp_machines_core::mirror::Mirror;
use wisp_machines_core::peer_client::{Opts, PeerClient, Saved};
use wisp_machines_core::{bootstrap, view};
use wisp_protocol::{ClientMessage, Topic};
use wisp_store::Store;

use crate::error::{MachinesError, Res};
use crate::store::{self, Loaded, SyncRow};

pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// One peer's link.
pub(crate) struct Link {
    pub conn: Conn,
    pub client: PeerClient,
    pub client_id: String,
    pub channel: Option<Arc<dyn Channel>>,
    /// the running attempt (connect, link, retries); cancelled to hang up
    pub token: Option<CancellationToken>,
    /// the open stream's poster: messages go there in order
    pub post: Option<mpsc::UnboundedSender<ClientMessage>>,
    /// when the resume point was last written (cursor-only moves are written at most every 5 s)
    pub saved_at: i64,
}

pub(crate) type Waiter = oneshot::Sender<Res<Value>>;

pub(crate) struct State {
    pub ctx: Ctx,
    pub store: Store,
    pub peers: Mutex<BTreeMap<String, PeerRow>>,
    pub links: Mutex<HashMap<String, Link>>,
    pub mirror: Mutex<Mirror>,
    /// routed commands waiting for their ack, by mid
    pub waiters: Mutex<HashMap<String, Vec<Waiter>>>,
}

impl std::fmt::Debug for State {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("State").field("peers", &lock(&self.peers).len()).finish_non_exhaustive()
    }
}

fn new_client_id() -> String {
    let n: u64 = rand::random();
    format!("machines-{n:016x}")
}

impl State {
    pub fn new(ctx: Ctx, store: Store, loaded: Loaded) -> Arc<Self> {
        let mut mirror = Mirror::new();
        for (peer, e, id, v) in loaded.mirror {
            mirror.load(&peer, &e, &id, v);
        }
        let mut sync: HashMap<String, SyncRow> = loaded.sync.into_iter().collect();
        let st = Arc::new(Self { ctx, store, peers: Mutex::new(BTreeMap::new()), links: Mutex::new(HashMap::new()), mirror: Mutex::new(mirror), waiters: Mutex::new(HashMap::new()) });
        for p in loaded.peers {
            let s = sync.remove(&p.id);
            st.add_link(&p.id, s);
            lock(&st.peers).insert(p.id.clone(), p);
        }
        st
    }

    /// A link for a new (or loaded) peer, subscribed to its `list` (passive: watching never wakes it).
    pub fn add_link(&self, id: &str, saved: Option<SyncRow>) {
        let s = saved.unwrap_or_else(|| SyncRow { client_id: new_client_id(), saved: Saved::default() });
        let mut client = PeerClient::new(Opts::new(s.client_id.clone(), crate::VERSION), Some(s.saved));
        let _ = client.subscribe(&Topic::list(), true);
        let conn = Conn::start(id, &[], false, false, None);
        let mut link = Link { conn, client, client_id: s.client_id, channel: None, token: None, post: None, saved_at: 0 };
        link.conn.status = wisp_machines_api::PeerStatus::off(id);
        lock(&self.links).insert(id.to_owned(), link);
    }

    pub fn now(&self) -> i64 {
        self.ctx.clock().map_or(0, |c| c.now_ms())
    }

    pub fn peer(&self, id: &str) -> Res<PeerRow> {
        lock(&self.peers).get(id).cloned().ok_or(MachinesError::NoPeer)
    }

    pub fn peers(&self) -> Vec<PeerRow> {
        let mut v: Vec<PeerRow> = lock(&self.peers).values().cloned().collect();
        v.sort_by(|a, b| a.added_at.cmp(&b.added_at).then_with(|| a.id.cmp(&b.id)));
        v
    }

    pub fn transport(&self, kind: &str) -> Res<Arc<dyn Transport>> {
        self.ctx.contributions(&TRANSPORT).into_iter().find(|t| t.kind() == kind).ok_or_else(|| MachinesError::NoTransport(kind.to_owned()))
    }

    /// Runs `f` on the peer's link (`None` once the peer is gone).
    pub fn with_link<T>(&self, id: &str, f: impl FnOnce(&mut Link) -> T) -> Option<T> {
        lock(&self.links).get_mut(id).map(f)
    }

    /// Writes the peer's status (the `machines` topic carries it) and says it changed.
    pub fn publish(&self, id: &str) {
        let Some(status) = self.with_link(id, |l| l.conn.status.clone()) else { return };
        self.store.write_detached(move |w| store::put_status(w, &status));
        self.ctx.emit(&self.ctx.root_call(), &Changed { id: id.to_owned() });
    }

    pub fn save_peer(&self, row: &PeerRow) {
        let r = row.clone();
        lock(&self.peers).insert(r.id.clone(), r.clone());
        self.store.write_detached(move |w| store::put_peer(w, &r));
    }

    /// Writes the link's resume point; `force: false` skips it when it was written under 5 s ago.
    pub fn save_sync(&self, id: &str, force: bool) {
        let now = self.now();
        let row = self.with_link(id, |l| {
            if !force && now - l.saved_at < 5_000 {
                return None;
            }
            l.saved_at = now;
            Some(SyncRow { client_id: l.client_id.clone(), saved: l.client.save() })
        });
        if let Some(Some(row)) = row {
            let id = id.to_owned();
            self.store.write_detached(move |w| store::put_sync(w, &id, &row));
        }
    }

    pub fn view(&self, id: &str) -> Res<PeerView> {
        let row = self.peer(id)?;
        let (status, log) = self.with_link(id, |l| (l.conn.status.clone(), l.conn.view_log())).ok_or(MachinesError::NoPeer)?;
        let working = lock(&self.mirror).working(id);
        let x = view::Extras { version: crate::VERSION.to_owned(), default_command: bootstrap::default_command(crate::VERSION), log, projects: 0, working };
        Ok(view::view(&row, &status, x))
    }

    pub fn views(&self) -> Vec<PeerView> {
        self.peers().iter().filter_map(|p| self.view(&p.id).ok()).collect()
    }

    /// The channel of a peer that takes requests now, or the words why not.
    pub fn channel(&self, id: &str) -> Res<Arc<dyn Channel>> {
        let row = self.peer(id)?;
        let t = self.transport(&row.transport).ok();
        let (state, wakes, ch) = self.with_link(id, |l| (l.conn.status.state, l.conn.wakes(), l.channel.clone())).ok_or(MachinesError::NoPeer)?;
        let wakes_on_request = t.as_ref().is_some_and(|t| t.wakes_on_request(&row));
        if let Some(words) = wisp_machines_core::conn::refuse(&row.name, state, wakes, row.computer().is_some(), wakes_on_request) {
            return Err(MachinesError::Offline(words));
        }
        ch.or_else(|| t.and_then(|t| t.direct(&row, Arc::new(crate::manager::PeerIo::quiet(id))))).ok_or_else(|| MachinesError::Offline(format!("{} is offline. Connect it from Machines.", row.name)))
    }

    /// Settles a routed command's waiters.
    pub fn settle(&self, mid: &str, out: &Res<Value>) {
        for w in lock(&self.waiters).remove(mid).unwrap_or_default() {
            let _ = w.send(match out {
                Ok(v) => Ok(v.clone()),
                Err(MachinesError::Rejected { code, message }) => Err(MachinesError::Rejected { code: code.clone(), message: message.clone() }),
                Err(e) => Err(MachinesError::Invalid(e.to_string())),
            });
        }
    }
}
