//! Which protocol a peer link speaks (plan §7.3.2): the highest both sides speak, else the card
//! says who must update. The welcome carries the peer's window. v2 speaks v2 only: there is no
//! downgrade to v1's whole-stream relay (ADR-0031).

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Feed {
    /// a `PeerClient` on the channel, at this protocol
    Sync(u32),
    /// outside every window: `peer` or `client` must update
    Incompatible { update_peer: bool },
}

/// The highest protocol both speak.
pub fn choose(ours: (u32, u32), theirs: (u32, u32)) -> Feed {
    let lo = ours.0.max(theirs.0);
    let hi = ours.1.min(theirs.1);
    if lo <= hi {
        return Feed::Sync(hi);
    }
    Feed::Incompatible { update_peer: theirs.1 < ours.0 }
}

/// The card's words for an incompatible peer (plan §7.3.2: "Update wisp on <computer>").
pub fn update_words(name: &str, update_peer: bool) -> String {
    if update_peer { format!("Update wisp on {name}: it speaks an older protocol than this one.") } else { format!("Update wisp here: {name} runs a newer one this wisp can’t speak to.") }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_highest_both_speak_else_update() {
        assert_eq!(choose((2, 2), (2, 4)), Feed::Sync(2));
        assert_eq!(choose((2, 4), (3, 5)), Feed::Sync(4));
        assert_eq!(choose((2, 2), (1, 1)), Feed::Incompatible { update_peer: true }, "a v1 peer is refused, not relayed");
        assert_eq!(choose((4, 6), (2, 3)), Feed::Incompatible { update_peer: true });
        assert_eq!(choose((2, 2), (5, 7)), Feed::Incompatible { update_peer: false });
        assert!(update_words("studio", true).starts_with("Update wisp on studio"));
    }
}
