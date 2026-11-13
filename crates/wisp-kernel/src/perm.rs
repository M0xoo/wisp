//! Permissions (plan §6.5): `ns:action{k:v,…}`. `proc:spawn{bin:claude}`, `git:worktree.add`,
//! `topic:read{topic:session:*}`, `*`. A grant covers a request when its namespace and action match
//! (`*` globs allowed) and every scope key the grant names is in the request with a matching value. A
//! grant without a scope covers every scope; a request without a scope is not covered by a scoped grant.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Permission {
    pub ns: String,
    pub action: String,
    /// in the order written; keys are unique
    pub scope: Vec<(String, String)>,
}

fn ns_ok(s: &str) -> bool {
    s == "*"
        || (s.starts_with(|c: char| c.is_ascii_lowercase()) && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'))
}

fn action_ok(s: &str) -> bool {
    !s.is_empty() && s.split('.').all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'*' | b'_' | b'-')))
}

fn key_ok(s: &str) -> bool {
    s.starts_with(|c: char| c.is_ascii_lowercase()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

fn value_ok(s: &str) -> bool {
    !s.is_empty() && !s.starts_with(char::is_whitespace) && !s.contains(['{', '}', ','])
}

/// Why `s` isn't a permission, or `None` when it is one.
pub fn problem(s: &str) -> Option<String> {
    parse_inner(s).err()
}

pub fn parse(s: &str) -> Option<Permission> {
    parse_inner(s).ok()
}

fn parse_inner(s: &str) -> Result<Permission, String> {
    if s == "*" {
        return Ok(Permission { ns: "*".into(), action: "*".into(), scope: Vec::new() });
    }
    let (head, body) = match s.find('{') {
        Some(b) => (&s[..b], Some(&s[b + 1..])),
        None => (s, None),
    };
    let Some((ns, action)) = head.split_once(':') else {
        return Err(format!("\"{s}\" is not ns:action{{k:v,…}} (no ':')"));
    };
    if !ns_ok(ns) {
        return Err(format!("\"{ns}\" is not a namespace (lowercase letters, digits, dashes)"));
    }
    if !action_ok(action) {
        return Err(format!("\"{action}\" is not an action (letters, digits, dots, *)"));
    }
    let mut scope: Vec<(String, String)> = Vec::new();
    if let Some(body) = body {
        let Some(body) = body.strip_suffix('}') else {
            return Err(format!("\"{s}\": the scope must end with '}}'"));
        };
        if body.trim().is_empty() {
            return Err(format!("\"{s}\": an empty scope; leave out {{}} instead"));
        }
        for pair in body.split(',') {
            let Some((k, v)) = pair.split_once(':') else {
                return Err(format!("\"{}\" is not k:v in \"{s}\"", pair.trim()));
            };
            let (k, v) = (k.trim(), v.trim());
            if !key_ok(k) {
                return Err(format!("\"{}\" is not k:v in \"{s}\"", pair.trim()));
            }
            if !value_ok(v) {
                return Err(format!("\"{k}\" has no value in \"{s}\""));
            }
            if scope.iter().any(|(x, _)| x == k) {
                return Err(format!("\"{k}\" appears twice in \"{s}\""));
            }
            scope.push((k.to_owned(), v.to_owned()));
        }
    }
    Ok(Permission { ns: ns.to_owned(), action: action.to_owned(), scope })
}

impl std::fmt::Display for Permission {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.ns == "*" && self.action == "*" && self.scope.is_empty() {
            return f.write_str("*");
        }
        write!(f, "{}:{}", self.ns, self.action)?;
        if !self.scope.is_empty() {
            f.write_str("{")?;
            for (i, (k, v)) in self.scope.iter().enumerate() {
                if i > 0 {
                    f.write_str(",")?;
                }
                write!(f, "{k}:{v}")?;
            }
            f.write_str("}")?;
        }
        Ok(())
    }
}

/// `*` matches any run of characters; everything else is literal. No allocation.
pub fn glob(pattern: &str, value: &str) -> bool {
    if pattern == "*" {
        return true;
    }
    let Some(first) = pattern.find('*') else {
        return pattern == value;
    };
    let (p, v) = (pattern.as_bytes(), value.as_bytes());
    if !v.starts_with(&p[..first]) {
        return false;
    }
    // classic two-pointer wildcard match with backtracking to the last star
    let (mut pi, mut vi) = (first, first);
    let (mut star, mut mark) = (None, 0);
    while vi < v.len() {
        if pi < p.len() && p[pi] == b'*' {
            star = Some(pi);
            mark = vi;
            pi += 1;
        } else if pi < p.len() && p[pi] == v[vi] {
            pi += 1;
            vi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            vi = mark;
        } else {
            return false;
        }
    }
    p[pi..].iter().all(|&b| b == b'*')
}

impl Permission {
    /// Does this grant cover `request`?
    pub fn covers(&self, r: &Self) -> bool {
        glob(&self.ns, &r.ns)
            && glob(&self.action, &r.action)
            && self.scope.iter().all(|(k, gv)| r.scope.iter().any(|(rk, rv)| rk == k && glob(gv, rv)))
    }
}

/// Does `grant` cover `request`? Both are strings; one that doesn't parse covers nothing.
pub fn covers(grant: &str, request: &str) -> bool {
    match (parse(grant), parse(request)) {
        (Some(g), Some(r)) => g.covers(&r),
        _ => false,
    }
}

/// A command's default permission: its id with the first '.' as ':' (`runtime.start` → `runtime:start`).
pub fn of_command(id: &str) -> String {
    match id.split_once('.') {
        Some((ns, rest)) => format!("{ns}:{rest}"),
        None => format!("{id}:*"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grammar() {
        for ok in [
            "*",
            "runtime:start",
            "proc:spawn{bin:claude}",
            "topic:read{topic:session:*}",
            "git:worktree.add",
            "fs:write{scope:workspace,mode:rw}",
            "*:*",
        ] {
            assert_eq!(problem(ok), None, "{ok}");
        }
        for bad in ["runtime", "Runtime:start", "a:", "a:b{", "a:b{}", "a:b{k}", "a:b{k:}", "a:b{k:1,k:2}", "a:b{K:v}", "a:b..c"] {
            assert!(problem(bad).is_some(), "{bad}");
        }
        assert_eq!(parse("a:b{x:1, y:2}").map(|p| p.to_string()).as_deref(), Some("a:b{x:1,y:2}"));
    }

    #[test]
    fn matching() {
        assert!(covers("*", "runtime:start{mode:auto}"));
        assert!(covers("runtime:*", "runtime:start"));
        assert!(covers("runtime:start", "runtime:start{mode:auto}"));
        assert!(!covers("runtime:start{mode:auto}", "runtime:start"));
        assert!(covers("runtime:start{mode:auto}", "runtime:start{mode:auto,harness:claude}"));
        assert!(!covers("runtime:start{mode:auto}", "runtime:start{mode:plan}"));
        assert!(covers("proc:spawn{bin:*}", "proc:spawn{bin:claude}"));
        assert!(covers("topic:read{topic:session:*}", "topic:read{topic:session:abc}"));
        assert!(!covers("topic:read{topic:session:*}", "topic:read{topic:list}"));
        assert!(covers("secrets:read{key:claude.*}", "secrets:read{key:claude.token}"));
        assert!(!covers("git:*", "gh:read"));
        assert!(!covers("nonsense", "a:b"));
    }

    #[test]
    fn globs() {
        assert!(glob("a*c", "abc"));
        assert!(glob("a*c", "ac"));
        assert!(glob("*b*", "abc"));
        assert!(!glob("a*c", "abd"));
        assert!(glob("a**", "a"));
        assert!(glob("s*:*", "session:abc"));
        assert!(!glob("abc", "abcd"));
    }

    #[test]
    fn command_permission() {
        assert_eq!(of_command("runtime.start"), "runtime:start");
        assert_eq!(of_command("git.worktree.add"), "git:worktree.add");
    }
}
