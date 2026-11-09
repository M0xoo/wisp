//! Ids across peers: v2 ids carry their origin as `<peer>:<uuid>` (plan §7.2.1), so an id names the
//! peer that owns it. (v1's `<id>@<machine>` qualified ids are gone with the v1 relay, ADR-0031.)

/// The key a peer's token is kept under in `~/.wisp/secrets.json`.
pub fn secret_key(id: &str) -> String {
    format!("machines.{id}")
}

/// The peer that owns an id (its `peer_id`), or `None` for a local one. The id goes there unchanged.
pub fn owner_of(id: &str) -> Option<&str> {
    wisp_kernel::ids::split_origin(id).0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owners() {
        assert_eq!(owner_of("laptop:0190"), Some("laptop"));
        assert_eq!(owner_of("0190"), None);
        assert_eq!(owner_of(":0190"), None);
        assert_eq!(secret_key("ab12cd"), "machines.ab12cd");
    }
}
