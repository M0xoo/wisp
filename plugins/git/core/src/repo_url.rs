//! A repo the user pasted (v1 parseRepo): `https://github.com/o/r(/tree/…)`, `github.com/o/r`,
//! `git@host:o/r.git`, `ssh://` `git://` `file://` URLs, and (shorthand) `o/r` for GitHub. None when
//! it isn't a repo, e.g. a path. Hand-parsed: the forms are few and a URL crate isn't worth a dependency.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoUrl {
    pub url: String,
    /// lowercased, without `www.`; "" for file URLs
    pub host: String,
    pub name: String,
    /// `owner/repo` on GitHub
    pub gh: Option<String>,
    pub path: String,
}

fn strip(p: &str) -> &str {
    let p = p.trim_end_matches('/');
    if p.len() >= 4 && p[p.len() - 4..].eq_ignore_ascii_case(".git") {
        &p[..p.len() - 4]
    } else {
        p
    }
}

fn of(url: String, host: &str, repo_path: &str) -> Option<RepoUrl> {
    let parts: Vec<&str> = strip(repo_path)
        .split('/')
        .filter(|s| !s.is_empty())
        .collect();
    let last = *parts.last()?;
    let gh =
        (host == "github.com" && parts.len() >= 2).then(|| format!("{}/{}", parts[0], parts[1]));
    let name = if gh.is_some() { parts[1] } else { last }.to_owned();
    Some(RepoUrl {
        url,
        host: host.to_owned(),
        name,
        gh,
        path: parts.join("/"),
    })
}

fn word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `scheme://[user@]host[:port]/path` → (scheme lowercased, host, path).
fn split_url(s: &str) -> Option<(String, String, String)> {
    let (scheme, rest) = s.split_once("://")?;
    let (auth, path) = rest
        .find('/')
        .map_or((rest, ""), |i| (&rest[..i], &rest[i..]));
    let host_port = auth.rsplit_once('@').map_or(auth, |(_, h)| h);
    let host = if host_port.starts_with('[') {
        host_port
            .split_once(']')
            .map_or(host_port, |(h, _)| h)
            .trim_start_matches('[')
    } else {
        host_port.split(':').next().unwrap_or("")
    };
    let path = path.split(['?', '#']).next().unwrap_or("");
    Some((
        scheme.to_ascii_lowercase(),
        host.to_ascii_lowercase(),
        path.to_owned(),
    ))
}

fn is_url(s: &str) -> bool {
    let low = s.to_ascii_lowercase();
    ["http://", "https://", "ssh://", "git://", "file://"]
        .iter()
        .any(|p| low.starts_with(p))
        || low.starts_with("github.com/")
        || low.starts_with("www.github.com/")
}

pub fn parse_repo(input: &str, shorthand: bool) -> Option<RepoUrl> {
    let s = input.trim();
    if is_url(s) {
        let full = if s.contains("://") {
            s.to_owned()
        } else {
            format!("https://{s}")
        };
        let (scheme, host, path) = split_url(&full)?;
        let host = host.strip_prefix("www.").unwrap_or(&host).to_owned();
        if scheme == "file" {
            return of(full.clone(), "", &path);
        }
        if host.is_empty() {
            return None;
        }
        if host == "github.com" {
            let mut seg = path.split('/').filter(|x| !x.is_empty());
            let (o, r) = (seg.next()?, seg.next()?);
            return of(
                format!("https://github.com/{o}/{}.git", strip(r)),
                &host,
                &format!("{o}/{r}"),
            );
        }
        let segments = path.split('/').filter(|x| !x.is_empty()).count();
        return if segments >= 2 || scheme != "https" {
            of(s.to_owned(), &host, &path)
        } else {
            None
        };
    }
    if let Some(r) = scp(s) {
        return Some(r);
    }
    if shorthand {
        let (o, r) = s.split_once('/')?;
        let ok_o = !o.is_empty() && o.chars().all(|c| word(c) || c == '-');
        let ok_r = !r.is_empty() && r.chars().all(|c| word(c) || c == '-' || c == '.');
        if ok_o && ok_r {
            return of(
                format!("https://github.com/{o}/{}.git", strip(r)),
                "github.com",
                &format!("{o}/{r}"),
            );
        }
    }
    None
}

/// `user@host:path` (scp form), not `user@host://…`.
fn scp(s: &str) -> Option<RepoUrl> {
    let (user, rest) = s.split_once('@')?;
    let (host, path) = rest.split_once(':')?;
    let ok = |x: &str| !x.is_empty() && x.chars().all(|c| word(c) || c == '.' || c == '-');
    if !ok(user) || !ok(host) || path.is_empty() || path.starts_with("//") {
        return None;
    }
    of(s.to_owned(), &host.to_ascii_lowercase(), path)
}

/// `parse_repo`, plus a plain absolute path to a repo on disk (an origin can be one).
pub fn repo_of(u: &str) -> Option<RepoUrl> {
    parse_repo(u, false).or_else(|| {
        u.starts_with('/')
            .then(|| parse_repo(&format!("file://{u}"), false))
            .flatten()
    })
}

/// The same repo however it was spelled (https vs ssh, .git or not, the host's case).
pub fn same_repo(a: &str, b: &str) -> bool {
    let key = |u: &str| {
        repo_of(u).map(|r| {
            r.gh.map_or_else(
                || format!("{}/{}", r.host, r.path),
                |g| format!("github.com/{}", g.to_lowercase()),
            )
        })
    };
    matches!((key(a), key(b)), (Some(x), Some(y)) if x == y)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gh(s: &str, short: bool) -> Option<String> {
        parse_repo(s, short).and_then(|r| r.gh)
    }

    #[test]
    fn github_forms() {
        for s in [
            "https://github.com/WispAgents/wisp",
            "https://github.com/WispAgents/wisp.git",
            "https://github.com/WispAgents/wisp/tree/main/server",
            "github.com/WispAgents/wisp/",
            "git@github.com:WispAgents/wisp.git",
        ] {
            assert_eq!(gh(s, false).as_deref(), Some("WispAgents/wisp"), "{s}");
        }
        assert_eq!(gh("WispAgents/wisp", true).as_deref(), Some("WispAgents/wisp"));
        assert_eq!(
            parse_repo("https://github.com/WispAgents/wisp/pull/3", false)
                .map(|r| r.url)
                .as_deref(),
            Some("https://github.com/WispAgents/wisp.git")
        );
    }

    #[test]
    fn other_hosts_and_ssh() {
        let r = parse_repo("https://gitlab.com/group/sub/app.git", false);
        assert_eq!(
            r.map(|r| (r.host, r.name, r.gh)),
            Some(("gitlab.com".into(), "app".into(), None))
        );
        assert_eq!(
            parse_repo("ssh://git@example.org:2222/team/tool.git", false)
                .map(|r| r.name)
                .as_deref(),
            Some("tool")
        );
        assert_eq!(
            parse_repo("file:///srv/git/proj.git", false).map(|r| (r.host, r.name)),
            Some((String::new(), "proj".into()))
        );
    }

    #[test]
    fn paths_are_not_repos() {
        for p in [
            "~/code/app",
            "/Users/me/app",
            "./app",
            "app",
            "WispAgents/wisp",
            "https://github.com/M0xoo",
            "C:\\code\\app",
            "",
        ] {
            assert_eq!(parse_repo(p, false), None, "{p}");
        }
    }

    #[test]
    fn same_repo_across_spellings() {
        assert!(same_repo(
            "https://github.com/M0xoo/Wisp.git",
            "git@github.com:m0xoo/wisp"
        ));
        assert!(same_repo("/srv/git/proj.git", "file:///srv/git/proj"));
        assert!(!same_repo(
            "https://github.com/a/b",
            "https://github.com/a/c"
        ));
        assert!(!same_repo("not a repo", "not a repo"));
    }
}
