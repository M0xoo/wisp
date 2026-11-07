//! POSIX shell quoting, and the one target grammar every ssh argv is built from.

/// Single-quotes for a POSIX shell: `it's` → `'it'\''s'`.
pub fn shq(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// v1's `TARGET`: `/^(?!-)[\w.%+-]+(@[\w.%:[\]-]+)?$/`. `user@host`, `host`, an alias, `[v6]`. Never an
/// option: `-oProxyCommand=…` as a target would run code (edge case Machines 1).
pub fn is_target(s: &str) -> bool {
    if s.is_empty() || s.starts_with('-') {
        return false;
    }
    let word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let (user, host) = match s.split_once('@') {
        Some((u, h)) => (u, Some(h)),
        None => (s, None),
    };
    let user_ok = !user.is_empty()
        && user
            .chars()
            .all(|c| word(c) || matches!(c, '.' | '%' | '+' | '-'));
    let host_ok = host.is_none_or(|h| {
        !h.is_empty()
            && h.chars()
                .all(|c| word(c) || matches!(c, '.' | '%' | ':' | '[' | ']' | '-'))
    });
    user_ok && host_ok
}

/// The host part of a target (`me@box` → `box`).
pub fn host_of(target: &str) -> &str {
    target.rsplit_once('@').map_or(target, |(_, h)| h)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting() {
        assert_eq!(
            shq("npx -y wisp-agents@1.2.3 # it's"),
            r"'npx -y wisp-agents@1.2.3 # it'\''s'"
        );
        assert_eq!(shq(""), "''");
    }

    #[test]
    fn targets_never_become_options() {
        for ok in [
            "devbox",
            "me@devbox",
            "me@10.0.0.5",
            "me@[fe80::1]",
            "a.b-c_d%e+f",
            "studio.tail1.ts.net",
        ] {
            assert!(is_target(ok), "{ok}");
        }
        for bad in [
            "-oProxyCommand=touch /tmp/x",
            "a b",
            "",
            "me@",
            "@box",
            "me@box@x",
            "a;b",
            "me@box/x",
            "$(x)",
            "a\nb",
            "é",
        ] {
            assert!(!is_target(bad), "{bad}");
        }
        assert_eq!(host_of("me@box"), "box");
        assert_eq!(host_of("box"), "box");
    }
}
