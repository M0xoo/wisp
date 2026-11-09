//! Commands for rows another peer owns (plan §7.2.1, §7.2.3): routed to the owner with the **same**
//! idempotency key. A command for a box that's asleep waits here, shown as "waiting for <box> to
//! wake", and goes after its welcome; the peer's own `mutation` table makes a resend run once.
use std::collections::BTreeMap;

use serde_json::Value;
use wisp_machines_api::{PeerRow, owner_of};

/// The peer an id belongs to: its `<peer>:` origin matched against each row's learned `peer`. The id
/// goes there unchanged (a v2 id is the same everywhere).
pub fn owner<'a>(id: &str, peers: &'a [PeerRow]) -> Option<&'a PeerRow> {
    let peer = owner_of(id)?;
    peers.iter().find(|p| p.peer.as_deref() == Some(peer))
}

/// The peer a routed command's args name (`id`, `sessionId`, `parentId`, first that has an owner).
pub fn owner_of_args<'a>(args: &Value, peers: &'a [PeerRow]) -> Option<&'a PeerRow> {
    ["id", "sessionId", "parentId"].iter().find_map(|k| args.get(*k).and_then(Value::as_str).and_then(|id| owner(id, peers)))
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
        assert_eq!(owner("laptop:0190", &peers).map(|p| p.id.as_str()), Some("ab12cd"));
        assert!(owner("studio:0190", &peers).is_none());
        assert!(owner("local", &peers).is_none());
        assert!(owner("s1@ef34ab", &peers).is_none(), "v1's qualified ids are gone (ADR-0031)");
        assert_eq!(owner_of_args(&json!({"text": "hi", "sessionId": "laptop:0190"}), &peers).map(|p| p.id.as_str()), Some("ab12cd"));
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
