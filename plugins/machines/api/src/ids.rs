//! Ids across peers. v1 qualified a remote session as `<remote id>@<machine>`; v2 ids carry their
//! origin as `<peer>:<uuid>` (plan §7.2.1). Both resolve to the peer that owns them.

/// v1: a remote session is `<remote id>@<machine id>` here. Local ids never contain '@'.
pub fn qualify(id: &str, machine: &str) -> String {
    if id.is_empty() {
        String::new()
    } else {
        format!("{id}@{machine}")
    }
}

/// Splits at the **last** '@' (a remote id may itself hold one: an email-ish branch name).
pub fn split_id(id: &str) -> Option<(&str, &str)> {
    let i = id.rfind('@')?;
    (i > 0 && i + 1 < id.len()).then(|| (&id[..i], &id[i + 1..]))
}

/// The key a peer's token is kept under in `~/.wisp/secrets.json` (v1: `machines` → `<id>`).
pub fn secret_key(id: &str) -> String {
    format!("machines.{id}")
}

/// Who owns an id, and the id as the owner knows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OwnerOf<'a> {
    /// `<id>@<machine>`: the local handle of a (v1-relayed) machine
    Machine { machine: &'a str, id: &'a str },
    /// `<peer>:<uuid>`: a v2 peer's own id, sent there unchanged
    Peer { peer: &'a str, id: &'a str },
}

/// The owner of an id, or `None` for a local one. A v1 qualified id wins over an origin prefix
/// (`abc:def@m1` is machine m1's `abc:def`).
pub fn owner_of(id: &str) -> Option<OwnerOf<'_>> {
    if let Some((id, machine)) = split_id(id) {
        return Some(OwnerOf::Machine { machine, id });
    }
    match wisp_kernel::ids::split_origin(id) {
        (Some(peer), _) => Some(OwnerOf::Peer { peer, id }),
        (None, _) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v1_ids_split_at_the_last_at() {
        assert_eq!(qualify("abc123", "m1"), "abc123@m1");
        assert_eq!(qualify("", "m1"), "");
        assert_eq!(split_id("abc123@m1"), Some(("abc123", "m1")));
        assert_eq!(split_id("a@b@m1"), Some(("a@b", "m1")));
        assert_eq!(split_id("abc123"), None);
        assert_eq!(split_id("@m1"), None);
        assert_eq!(split_id("abc@"), None);
    }

    #[test]
    fn owners() {
        assert_eq!(
            owner_of("s1@m1"),
            Some(OwnerOf::Machine {
                machine: "m1",
                id: "s1"
            })
        );
        assert_eq!(
            owner_of("laptop:0190"),
            Some(OwnerOf::Peer {
                peer: "laptop",
                id: "laptop:0190"
            })
        );
        assert_eq!(owner_of("0190"), None);
        assert_eq!(
            owner_of("laptop:0190@m2"),
            Some(OwnerOf::Machine {
                machine: "m2",
                id: "laptop:0190"
            })
        );
        assert_eq!(secret_key("ab12cd"), "machines.ab12cd");
    }
}
