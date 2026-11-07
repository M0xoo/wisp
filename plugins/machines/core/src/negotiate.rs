//! Which feed keeps a peer's rows (plan §7.2.1, §7.3.2): the sync protocol when both sides speak
//! it, else v1's whole-stream relay (the downgrade path), else the card says who must update. The
//! peer's `/health` says its window; a stream that answers with v1 events instead of a welcome is
//! a v1 peer whatever `/health` said.
use serde_json::Value;

/// The oldest peer this side still reaches: 1, through the relay.
pub const PROTO_RELAY: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Feed {
    /// a `PeerClient` on the channel, at this protocol
    Sync(u32),
    /// a v1 wisp: `/api/events` read whole, ids rewritten
    Relay,
    /// outside every window: `peer` or `client` must update
    Incompatible { update_peer: bool },
}

/// The peer's window from its `/health`: `(proto_min, proto_max)`. A v1 wisp says only `apiVersion: 1`.
pub fn window(health: &Value) -> (u32, u32) {
    let n = |k: &str| health.get(k).and_then(Value::as_u64).and_then(|v| u32::try_from(v).ok());
    let max = n("proto_max").or_else(|| n("apiVersion")).unwrap_or(1);
    let min = n("proto_min").unwrap_or(max).min(max);
    (min, max)
}

/// The highest protocol both speak; v1 peers through the relay.
pub fn choose(ours: (u32, u32), theirs: (u32, u32)) -> Feed {
    let lo = ours.0.max(theirs.0);
    let hi = ours.1.min(theirs.1);
    if lo <= hi {
        return Feed::Sync(hi);
    }
    if theirs.1 <= PROTO_RELAY && theirs.1 >= 1 {
        return Feed::Relay;
    }
    Feed::Incompatible { update_peer: theirs.1 < ours.0 }
}

/// The first event of a stream opened as sync: `event: sync` keeps it; any other named event
/// (v1 starts with `hello` and summaries) means a v1 peer.
pub fn first_event_is_v1(event: &str) -> bool {
    event != "sync" && event != "message"
}

/// The card's words for an incompatible peer (plan §7.3.2: "Update wisp on <computer>").
pub fn update_words(name: &str, update_peer: bool) -> String {
    if update_peer { format!("Update wisp on {name}: it speaks an older protocol than this one.") } else { format!("Update wisp here: {name} runs a newer one this wisp can’t speak to.") }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn windows_from_health() {
        assert_eq!(window(&json!({"name": "wisp", "version": "0.40.0", "apiVersion": 1})), (1, 1));
        assert_eq!(window(&json!({"proto_min": 2, "proto_max": 4, "apiVersion": 1})), (2, 4));
        assert_eq!(window(&json!({})), (1, 1));
        assert_eq!(window(&json!({"proto_min": 9, "proto_max": 3})), (3, 3));
    }

    #[test]
    fn the_highest_both_speak_else_the_relay_else_update() {
        assert_eq!(choose((2, 2), (2, 4)), Feed::Sync(2));
        assert_eq!(choose((2, 4), (3, 5)), Feed::Sync(4));
        assert_eq!(choose((2, 2), (1, 1)), Feed::Relay, "a v1 peer: today's whole-stream relay");
        assert_eq!(choose((4, 6), (2, 3)), Feed::Incompatible { update_peer: true });
        assert_eq!(choose((2, 2), (5, 7)), Feed::Incompatible { update_peer: false });
        assert!(first_event_is_v1("summary") && first_event_is_v1("hello") && !first_event_is_v1("sync"));
        assert!(update_words("studio", true).starts_with("Update wisp on studio"));
    }
}
