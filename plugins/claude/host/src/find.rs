//! Where `claude` lives when it isn't on PATH (v1 adapters/claude.js `fallbackBins`): the native installer's folders
//! (an app started from the Dock never reads the shell profile that adds them), then the copies the Claude desktop
//! app downloads for its Code tab into `<userData>/claude-code/<version>/<sha12>/` (older builds: straight into
//! `<version>/`; macOS builds may wrap it in `claude.app`), newest version first. That copy is signed in only while
//! the app runs it, so on its own it needs one sign-in.

use std::cmp::Ordering;

use wisp_runtime_api::harness::HarnessSys;

/// The Store (MSIX) packages of the Windows app, whose `AppData` writes land in their own `LocalCache`.
const STORE_PACKAGES: [&str; 2] = ["Claude_pzs8sxrjxfjjc", "AnthropicPBC.Claude_fnn82j28hfe8t"];

fn join(platform: &str, parts: &[&str]) -> String {
    parts.join(if platform == "win32" { "\\" } else { "/" })
}

/// "2.1.10" before "2.1.9": numeric runs compare as numbers (v1 `localeCompare(…, { numeric: true })`), descending.
fn newest_first(mut names: Vec<String>) -> Vec<String> {
    fn chunks(s: &str) -> Vec<Result<u64, String>> {
        let mut out = Vec::new();
        let mut cur = String::new();
        let mut digits = false;
        for ch in s.chars() {
            let d = ch.is_ascii_digit();
            if !cur.is_empty() && d != digits {
                out.push(if digits { cur.parse().map_err(|_| cur.clone()) } else { Err(cur.clone()) });
                cur.clear();
            }
            digits = d;
            cur.push(ch);
        }
        if !cur.is_empty() {
            out.push(if digits { cur.parse().map_err(|_| cur.clone()) } else { Err(cur) });
        }
        out
    }
    let cmp = |a: &String, b: &String| -> Ordering {
        for (x, y) in chunks(a).iter().zip(chunks(b).iter()) {
            let o = match (x, y) {
                (Ok(m), Ok(n)) => m.cmp(n),
                (Ok(_), Err(_)) => Ordering::Less,
                (Err(_), Ok(_)) => Ordering::Greater,
                (Err(m), Err(n)) => m.cmp(n),
            };
            if o != Ordering::Equal {
                return o;
            }
        }
        a.len().cmp(&b.len())
    };
    names.sort_by(|a, b| cmp(b, a));
    names
}

/// The desktop app's userData folders on this OS.
fn user_data(sys: &dyn HarnessSys, platform: &str, home: &str) -> Vec<String> {
    match platform {
        "darwin" => vec![join(platform, &[home, "Library", "Application Support", "Claude"])],
        "win32" => {
            let roaming = sys.env("APPDATA").filter(|v| !v.is_empty()).unwrap_or_else(|| join(platform, &[home, "AppData", "Roaming"]));
            let local = sys.env("LOCALAPPDATA").filter(|v| !v.is_empty()).unwrap_or_else(|| join(platform, &[home, "AppData", "Local"]));
            let mut out = vec![join(platform, &[&roaming, "Claude"])];
            out.extend(STORE_PACKAGES.iter().map(|p| join(platform, &[&local, "Packages", p, "LocalCache", "Roaming", "Claude"])));
            out
        }
        _ => Vec::new(),
    }
}

/// Every place to try after PATH, in order.
pub async fn fallback_bins(sys: &dyn HarnessSys) -> Vec<String> {
    let (home, platform) = (sys.home(), sys.platform());
    let p = platform.as_str();
    let exe = if p == "win32" { "claude.exe" } else { "claude" };
    let mut out = vec![join(p, &[&home, ".local", "bin", exe])];
    if p != "win32" {
        out.push(join(p, &[&home, ".claude", "local", "claude"]));
    }
    for d in user_data(sys, p, &home) {
        let root = join(p, &[&d, "claude-code"]);
        for v in newest_first(sys.list_dir(&root).await) {
            let dir = join(p, &[&root, &v]);
            for h in newest_first(sys.list_dir(&dir).await) {
                out.push(join(p, &[&dir, &h, exe]));
                out.push(join(p, &[&dir, &h, "claude.app", "Contents", "MacOS", "claude"]));
            }
            out.push(join(p, &[&dir, exe]));
        }
    }
    out
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use std::collections::BTreeMap;

    use wisp_kernel::{BoxFuture, Result};
    use wisp_runtime_api::harness::{ExecOut, ExecReq, HarnessSys};

    use super::{fallback_bins, newest_first};

    /// A computer with only the files and folders it's given.
    struct Fake {
        platform: &'static str,
        dirs: BTreeMap<String, Vec<String>>,
        env: BTreeMap<String, String>,
    }
    impl HarnessSys for Fake {
        fn exec(&self, _req: ExecReq) -> BoxFuture<'_, Result<ExecOut>> {
            Box::pin(async { Ok(ExecOut::default()) })
        }
        fn which(&self, _program: &str) -> BoxFuture<'_, Option<String>> {
            Box::pin(async { None })
        }
        fn read_file(&self, _path: &str) -> BoxFuture<'_, Option<String>> {
            Box::pin(async { None })
        }
        fn write_file(&self, _path: &str, _contents: String) -> BoxFuture<'_, Result<()>> {
            Box::pin(async { Ok(()) })
        }
        fn list_dir(&self, path: &str) -> BoxFuture<'_, Vec<String>> {
            let v = self.dirs.get(path).cloned().unwrap_or_default();
            Box::pin(async move { v })
        }
        fn env(&self, name: &str) -> Option<String> {
            self.env.get(name).cloned()
        }
        fn home(&self) -> String {
            if self.platform == "win32" { "C:\\Users\\me".into() } else { "/Users/me".into() }
        }
        fn platform(&self) -> String {
            self.platform.into()
        }
    }

    #[test]
    fn versions_sort_newest_first_by_number() {
        let v = newest_first(vec!["2.1.9".into(), "2.1.10".into(), "1.9.99".into(), "2.0.0".into()]);
        assert_eq!(v, ["2.1.10", "2.1.9", "2.0.0", "1.9.99"]);
    }

    #[tokio::test]
    async fn only_the_claude_desktop_app_installed_uses_its_bundled_cli() {
        let root = "/Users/me/Library/Application Support/Claude/claude-code";
        let mut dirs = BTreeMap::new();
        dirs.insert(root.to_owned(), vec!["2.1.9".to_owned(), "2.1.10".to_owned()]);
        dirs.insert(format!("{root}/2.1.10"), vec!["a1b2c3d4e5f6".to_owned()]);
        let sys = Fake { platform: "darwin", dirs, env: BTreeMap::new() };
        let bins = fallback_bins(&sys).await;
        // the native installer's folders first, then the app's newest copy (its hash folder, the .app wrap), then older
        assert_eq!(bins[0], "/Users/me/.local/bin/claude");
        assert_eq!(bins[1], "/Users/me/.claude/local/claude");
        assert_eq!(bins[2], format!("{root}/2.1.10/a1b2c3d4e5f6/claude"));
        assert_eq!(bins[3], format!("{root}/2.1.10/a1b2c3d4e5f6/claude.app/Contents/MacOS/claude"));
        assert_eq!(bins[4], format!("{root}/2.1.10/claude"));
        assert_eq!(bins[5], format!("{root}/2.1.9/claude"));
        // Windows: the direct install's AppData, then the Store packages'; Linux has no desktop app
        let win = Fake { platform: "win32", dirs: BTreeMap::new(), env: BTreeMap::from([("APPDATA".to_owned(), "R:\\Roam".to_owned())]) };
        assert_eq!(fallback_bins(&win).await, ["C:\\Users\\me\\.local\\bin\\claude.exe"]);
        let mut d = BTreeMap::new();
        d.insert("R:\\Roam\\Claude\\claude-code".to_owned(), vec!["1.0.0".to_owned()]);
        let win = Fake { platform: "win32", dirs: d, env: BTreeMap::from([("APPDATA".to_owned(), "R:\\Roam".to_owned())]) };
        assert_eq!(fallback_bins(&win).await.last().unwrap(), "R:\\Roam\\Claude\\claude-code\\1.0.0\\claude.exe");
        let linux = Fake { platform: "linux", dirs: BTreeMap::new(), env: BTreeMap::new() };
        assert_eq!(fallback_bins(&linux).await, ["/Users/me/.local/bin/claude", "/Users/me/.claude/local/claude"]);
    }
}
