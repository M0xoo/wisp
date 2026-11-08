//! `.worktreeinclude`: gitignore-style lines naming the ignored files and folders a new worktree gets
//! copied over (without the file: the root's `.env` files). The host lists ignored paths with
//! `git ls-files --others --ignored --exclude-standard --directory -z` (an ignored folder is one entry,
//! `node_modules/`, not its thousands of files) and keeps those `included` accepts.

pub const DEFAULT_INCLUDE: &[&str] = &[".env", ".env.*"];

/// One pattern line. None for blanks, comments and negations (not supported: v1 ignored them too).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pattern {
    /// `/`-separated segments; `**` matches any number of folders
    segs: Vec<String>,
    anchored: bool,
    dir_only: bool,
}

impl Pattern {
    pub fn parse(line: &str) -> Option<Self> {
        let p = line.trim();
        if p.is_empty() || p.starts_with('#') || p.starts_with('!') {
            return None;
        }
        let dir_only = p.ends_with('/');
        let p = p.trim_end_matches('/');
        let anchored = p.contains('/');
        let p = p.strip_prefix('/').unwrap_or(p);
        if p.is_empty() {
            return None;
        }
        Some(Self {
            segs: p.split('/').map(str::to_owned).collect(),
            anchored,
            dir_only,
        })
    }

    /// `rel` relative to the root (`a/b.txt`, `dir/`); `is_dir` when git listed it as a folder.
    pub fn matches(&self, rel: &str, is_dir: bool) -> bool {
        let rel = rel.trim_end_matches('/');
        if self.dir_only && !is_dir && !rel.contains('/') {
            return false;
        }
        let parts: Vec<&str> = rel.split('/').collect();
        let segs: Vec<&str> = self.segs.iter().map(String::as_str).collect();
        // the pattern may match a prefix of the path (a folder and what's under it), and unanchored at any depth
        let starts = if self.anchored {
            0..=0
        } else {
            0..=parts.len()
        };
        starts
            .into_iter()
            .any(|s| (s..=parts.len()).any(|e| e > s && seq(&segs, &parts[s..e])))
    }
}

/// Do the segments match exactly these path parts?
fn seq(segs: &[&str], parts: &[&str]) -> bool {
    match segs.split_first() {
        None => parts.is_empty(),
        Some((&"**", rest)) => (0..=parts.len()).any(|k| seq(rest, &parts[k..])),
        Some((first, rest)) => parts
            .split_first()
            .is_some_and(|(p, more)| glob(first.as_bytes(), p.as_bytes()) && seq(rest, more)),
    }
}

/// One segment: `*` any run of non-'/' chars, `?` one char.
fn glob(pat: &[u8], s: &[u8]) -> bool {
    match pat.split_first() {
        None => s.is_empty(),
        Some((b'*', rest)) => (0..=s.len()).any(|k| glob(rest, &s[k..])),
        Some((b'?', rest)) => s.split_first().is_some_and(|(_, more)| glob(rest, more)),
        Some((c, rest)) => s
            .split_first()
            .is_some_and(|(d, more)| c == d && glob(rest, more)),
    }
}

/// The patterns of a `.worktreeinclude` (None: the file isn't there, so the default).
pub fn patterns(file: Option<&str>) -> Vec<Pattern> {
    match file {
        Some(text) => text.lines().filter_map(Pattern::parse).collect(),
        None => DEFAULT_INCLUDE
            .iter()
            .filter_map(|l| Pattern::parse(l))
            .collect(),
    }
}

/// The ignored paths (from `ls-files ... -z`) the patterns name, as listed (folders keep their '/').
pub fn included(patterns: &[Pattern], ls_files_z: &str) -> Vec<String> {
    if patterns.is_empty() {
        return Vec::new();
    }
    ls_files_z
        .split('\0')
        .filter(|r| !r.is_empty())
        .filter(|r| patterns.iter().any(|p| p.matches(r, r.ends_with('/'))))
        .map(str::to_owned)
        .collect()
}

/// How to copy `from` to `to` copy-on-write where the file system has it: `cp -c -R` (clonefile) on
/// macOS, `cp -R --reflink=always` on Linux (which fails where there's none), else none: a plain copy.
pub fn cow_args(platform: &str) -> Option<&'static [&'static str]> {
    match platform {
        "macos" | "darwin" => Some(&["-c", "-R"]),
        "linux" => Some(&["-R", "--reflink=always"]),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testrand::Rng;

    fn m(line: &str, rel: &str, dir: bool) -> bool {
        Pattern::parse(line).is_some_and(|p| p.matches(rel, dir))
    }

    #[test]
    fn gitignore_style_lines() {
        assert!(m(".env", ".env", false));
        assert!(m(".env.*", ".env.local", false));
        assert!(!m(".env.*", ".env", false));
        assert!(m("config/local.json", "config/local.json", false));
        assert!(
            !m("/local.json", "config/local.json", false),
            "anchored at the root"
        );
        assert!(
            m("local.json", "config/local.json", false),
            "unanchored matches at any depth"
        );
        assert!(m("node_modules/", "node_modules/", true));
        assert!(
            !m("node_modules/", "node_modules", false),
            "a folder pattern skips a file"
        );
        assert!(m("**/secrets.txt", "a/b/secrets.txt", false));
        assert!(m("**/secrets.txt", "secrets.txt", false));
        assert!(
            m("local/", "local/x.json", false),
            "what's under a named folder"
        );
        assert!(m("a?c", "abc", false) && !m("a?c", "abbc", false));
        assert_eq!(Pattern::parse("# a comment"), None);
        assert_eq!(Pattern::parse("!keep"), None);
        assert_eq!(Pattern::parse("   "), None);
    }

    #[test]
    fn default_is_the_root_env_files_and_listing_keeps_folders_whole() {
        let ls = ".env\0.env.local\0local/\0big/\0";
        assert_eq!(included(&patterns(None), ls), [".env", ".env.local"]);
        assert_eq!(
            included(&patterns(Some("local/\n# not big\n")), ls),
            ["local/"]
        );
        assert!(included(&patterns(Some("# nothing\n")), ls).is_empty());
    }

    #[test]
    fn copy_on_write_per_platform() {
        assert_eq!(cow_args("macos"), Some(&["-c", "-R"][..]));
        assert_eq!(cow_args("linux"), Some(&["-R", "--reflink=always"][..]));
        assert_eq!(cow_args("windows"), None);
    }

    #[test]
    fn prop_star_matches_itself_and_literals_match_only_themselves() {
        let mut r = Rng::new(5);
        for _ in 0..2000 {
            let name = r.ident(8);
            let dir = r.ident(4);
            let rel = format!("{dir}/{name}");
            assert!(m(&name, &rel, false), "unanchored {name} in {rel}");
            assert!(m(&rel, &rel, false));
            assert!(m("*", &rel, false));
            assert!(m(&format!("/{dir}/*"), &rel, false));
            assert!(!m(&format!("/{name}X"), &rel, false));
            assert!(m(&format!("**/{name}"), &rel, false));
        }
    }
}
