//! Commands for rows another peer owns (plan §7.2.1, §7.2.3): routed to the owner with the **same**
//! idempotency key. A command for a box that's asleep waits here, shown as "waiting for <box> to
//! wake", and goes after its welcome; the peer's own `mutation` table makes a resend run once.
use std::collections::BTreeMap;

use serde_json::Value;
use wisp_machines_api::{OwnerOf, PeerRow, owner_of};

/// The local handle of the peer an id belongs to: `<id>@<machine>` names it, `<peer>:<uuid>` is
/// matched against each row's learned `peer`.
pub fn owner<'a>(id: &str, peers: &'a [PeerRow]) -> Option<&'a PeerRow> {
    match owner_of(id)? {
        OwnerOf::Machine { machine, .. } => peers.iter().find(|p| p.id == machine),
        OwnerOf::Peer { peer, .. } => peers.iter().find(|p| p.peer.as_deref() == Some(peer)),
    }
}

/// The id as its owner knows it.
pub fn there(id: &str) -> &str {
    match owner_of(id) {
        Some(OwnerOf::Machine { id, .. } | OwnerOf::Peer { id, .. }) => id,
        None => id,
    }
}

/// `args` with its ids (`id`, `sessionId`, `parentId`) as the owner knows them.
pub fn args_there(args: &Value) -> Value {
    let mut a = args.clone();
    if let Some(o) = a.as_object_mut() {
        for k in ["id", "sessionId", "parentId"] {
            if let Some(Value::String(s)) = o.get_mut(k) {
                *s = there(s).to_owned();
            }
        }
    }
    a
}

#[derive(Debug, Clone, PartialEq)]
pub struct Waiting {
    pub mid: String,
    pub cmd: String,
    pub args: Value,
    pub at: i64,
}

/// Commands waiting for their peer, by peer then mid. Adding the same mid twice keeps one.
#[derive(Debug, Default)]
pub struct Pending {
    by_peer: BTreeMap<String, Vec<Waiting>>,
}

impl Pending {
    pub fn add(&mut self, peer: &str, w: Waiting) -> bool {
        let list = self.by_peer.entry(peer.to_owned()).or_default();
        if list.iter().any(|x| x.mid == w.mid) {
            return false;
        }
        list.push(w);
        true
    }

    /// What goes after the peer's welcome, oldest first.
    pub fn take(&mut self, peer: &str) -> Vec<Waiting> {
        self.by_peer.remove(peer).unwrap_or_default()
    }

    pub fn settle(&mut self, peer: &str, mid: &str) {
        if let Some(l) = self.by_peer.get_mut(peer) {
            l.retain(|w| w.mid != mid);
        }
    }

    pub fn waiting(&self, peer: &str) -> usize {
        self.by_peer.get(peer).map_or(0, Vec::len)
    }

    /// A peer removed: its commands are dropped (they'd never go).
    pub fn forget(&mut self, peer: &str) -> Vec<Waiting> {
        self.take(peer)
    }
}

pub fn waiting_words(name: &str) -> String {
    format!("waiting for {name} to wake")
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use serde_json::json;

    use super::*;

    fn row(id: &str, peer: Option<&str>) -> PeerRow {
        PeerRow { id: id.into(), peer: peer.map(str::to_owned), name: id.into(), transport: "ssh".into(), address: "box".into(), port: 4477, command: String::new(), auto_connect: true, added_at: 0, data: BTreeMap::new() }
    }

    #[test]
    fn commands_go_to_the_owner() {
        let peers = [row("ab12cd", Some("laptop")), row("ef34ab", None)];
        assert_eq!(owner("s1@ef34ab", &peers).map(|p| p.id.as_str()), Some("ef34ab"));
        assert_eq!(owner("laptop:0190", &peers).map(|p| p.id.as_str()), Some("ab12cd"));
        assert!(owner("studio:0190", &peers).is_none());
        assert!(owner("local", &peers).is_none());
        assert_eq!(there("s1@ef34ab"), "s1");
        assert_eq!(there("laptop:0190"), "laptop:0190", "a v2 id is the same everywhere");
        assert_eq!(args_there(&json!({"id": "s1@m1", "text": "hi", "parentId": "p@m1"})), json!({"id": "s1", "text": "hi", "parentId": "p"}));
    }

    #[test]
    fn a_command_for_a_sleeping_box_waits_once_by_its_key() {
        let mut p = Pending::default();
        let w = Waiting { mid: "m1".into(), cmd: "session.followUp".into(), args: json!({"id": "s1"}), at: 1 };
        assert!(p.add("g", w.clone()));
        assert!(!p.add("g", w.clone()), "a retry from the client is the same command");
        assert!(p.add("g", Waiting { mid: "m2".into(), ..w.clone() }));
        assert_eq!(p.waiting("g"), 2);
        p.settle("g", "m2");
        assert_eq!(p.take("g"), [w]);
        assert_eq!(p.waiting("g"), 0);
        assert_eq!(waiting_words("wisp Cloud"), "waiting for wisp Cloud to wake");
    }
}
