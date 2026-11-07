//! How this copy of wisp was installed, from where its binary lives (v1 `installMethod`, now for the Rust
//! binary). The npm package `wisp-agents` is a launcher (`bin/wisp.js`) plus a per-platform binary package
//! (`@wisp/core-<os>-<arch>`), so the binary sits in a `node_modules` folder next to (or inside) the
//! launcher; the launcher's folder is the install root, and its `package.json` says which version npm put
//! there.
//!   global  npm install -g wisp-agents@<tag> (also what install.sh does)
//!   npx     nothing to install: relaunch through `npx -y wisp-agents@<tag>`
//!   brew    brew upgrade m0xoo/tap/wisp-agents, then rerun it from the keg's opt/ link
//!   app     the desktop app from GitHub Releases (`wisp.app`, the Windows installer, the `AppImage`)
//!   git     a build of a clone (working on wisp itself): never offers an update

pub const PKG: &str = "wisp-agents";
pub const TAP: &str = "m0xoo/tap/wisp-agents";
pub const RELEASES: &str = "https://api.github.com/repos/M0xoo/wisp/releases";
pub const DOWNLOADS: &str = "https://github.com/M0xoo/wisp/releases/latest";
pub const REGISTRY: &str = "https://registry.npmjs.org/-/package/wisp-agents/dist-tags";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Global,
    Npx,
    Brew,
    App,
    Git,
}

impl Method {
    pub fn name(self) -> &'static str {
        match self {
            Self::Global => "global",
            Self::Npx => "npx",
            Self::Brew => "brew",
            Self::App => "app",
            Self::Git => "git",
        }
    }
}

/// The OS and CPU, in Node's names (v1 used `process.platform` / `process.arch`, and so do release
/// assets and telemetry): darwin | win32 | linux, arm64 | x64.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Platform {
    pub os: String,
    pub arch: String,
}

impl Platform {
    pub fn new(os: &str, arch: &str) -> Self {
        Self {
            os: os.to_owned(),
            arch: arch.to_owned(),
        }
    }
    /// From Rust's names (`std::env::consts::{OS, ARCH}`).
    pub fn from_rust(os: &str, arch: &str) -> Self {
        let os = match os {
            "macos" => "darwin",
            "windows" => "win32",
            o => o,
        };
        let arch = match arch {
            "aarch64" => "arm64",
            "x86_64" => "x64",
            "x86" => "ia32",
            "arm" => "arm",
            a => a,
        };
        Self::new(os, arch)
    }
    pub fn windows(&self) -> bool {
        self.os == "win32"
    }
    pub fn sep(&self) -> char {
        if self.windows() { '\\' } else { '/' }
    }
    /// Joins path parts with this platform's separator (paths are the target's, not the build host's).
    pub fn join(&self, base: &str, parts: &[&str]) -> String {
        let sep = self.sep();
        let mut out = base.trim_end_matches(['/', '\\']).to_owned();
        for p in parts {
            for seg in p.split(['/', '\\']).filter(|s| !s.is_empty()) {
                out.push(sep);
                out.push_str(seg);
            }
        }
        out
    }
}

/// Where this copy is installed, worked out from the binary's path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Install {
    pub method: Method,
    /// npm/brew/npx: the launcher package folder; app: the bundle or file the update replaces; git: the clone
    pub root: String,
    /// brew: Homebrew's prefix (`/opt/homebrew`)
    pub brew: Option<String>,
}

fn segments(p: &str) -> Vec<&str> {
    p.split(['/', '\\']).collect()
}

/// The prefix of `p` before the segment at `idx` (exclusive), keeping `p`'s own separators.
fn prefix_before(p: &str, idx: usize) -> String {
    let mut seen = 0;
    for (i, c) in p.char_indices() {
        if c == '/' || c == '\\' {
            seen += 1;
            if seen == idx {
                return p[..i].to_owned();
            }
        }
    }
    p.to_owned()
}

/// The launcher package folder for a binary inside `node_modules`: `…/node_modules/wisp-agents` when the
/// binary package is nested in it or hoisted next to it.
fn launcher_root(exe: &str, platform: &Platform) -> Option<String> {
    let segs = segments(exe);
    if let Some(i) = segs.iter().rposition(|s| *s == PKG) {
        return (i > 0 && segs[i - 1] == "node_modules").then(|| prefix_before(exe, i + 1));
    }
    let i = segs.iter().rposition(|s| *s == "@wisp")?;
    (i > 0 && segs[i - 1] == "node_modules").then(|| platform.join(&prefix_before(exe, i), &[PKG]))
}

/// How this copy was installed. `exe`: the binary's path; `appimage`: `$APPIMAGE`; `desktop`: started by
/// the desktop shell (`WISP_DESKTOP=tauri`); `clone`: the folder of a clone this binary was built in, when
/// the host found one (a `target/` dir whose parent has `.git`), or a debug build's.
pub fn detect(
    exe: &str,
    platform: &Platform,
    appimage: Option<&str>,
    desktop: bool,
    clone: Option<&str>,
) -> Install {
    let segs = segments(exe);
    if let Some(i) = segs.iter().position(|s| *s == "Cellar")
        && segs.get(i + 1) == Some(&PKG)
    {
        let brew = prefix_before(exe, i);
        let root = launcher_root(exe, platform).unwrap_or_else(|| exe.to_owned());
        return Install {
            method: Method::Brew,
            root,
            brew: Some(brew),
        };
    }
    if let Some(bundle) = app_bundle(exe, appimage, desktop) {
        return Install {
            method: Method::App,
            root: bundle,
            brew: None,
        };
    }
    if let Some(dir) = clone {
        return Install {
            method: Method::Git,
            root: dir.to_owned(),
            brew: None,
        };
    }
    let root = launcher_root(exe, platform).unwrap_or_else(|| exe.to_owned());
    let method = if segs.contains(&"_npx") {
        Method::Npx
    } else {
        Method::Global
    };
    Install {
        method,
        root,
        brew: None,
    }
}

/// The desktop app's own file: macOS the `.app` bundle, Linux the `AppImage`, Windows the install folder.
fn app_bundle(exe: &str, appimage: Option<&str>, desktop: bool) -> Option<String> {
    let segs = segments(exe);
    if let Some(i) = segs.iter().rposition(|s| {
        std::path::Path::new(s)
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("app"))
    }) && segs.get(i + 1) == Some(&"Contents")
    {
        return Some(prefix_before(exe, i + 1));
    }
    if let Some(image) = appimage.filter(|s| !s.is_empty()) {
        return Some(image.to_owned());
    }
    if desktop {
        // Windows (NSIS) or a .deb: the folder the binary is in
        let n = segs.len().saturating_sub(1);
        return Some(prefix_before(exe, n));
    }
    None
}

/// The folder a cargo build of `exe` came from: `<clone>/target/<profile>/wisp` → `<clone>`.
pub fn cargo_clone(exe: &str) -> Option<String> {
    let segs = segments(exe);
    let i = segs.iter().rposition(|s| *s == "target")?;
    (i > 0 && segs.len() >= i + 3).then(|| prefix_before(exe, i))
}

/// The release download for this copy of the app (names without a version, desktop/scripts/package.mjs).
/// A .deb (no `$APPIMAGE`) updates through apt or a new .deb, so it gets none.
pub fn asset_name(platform: &Platform, appimage: Option<&str>) -> Option<String> {
    let arch = if platform.arch == "arm64" {
        "arm64"
    } else {
        "x64"
    };
    match platform.os.as_str() {
        "darwin" => Some(format!("wisp-mac-{arch}.zip")),
        "win32" => Some(format!("wisp-windows-{arch}-setup.exe")),
        "linux" if appimage.is_some_and(|s| !s.is_empty()) => {
            Some(format!("wisp-linux-{arch}.AppImage"))
        }
        _ => None,
    }
}

/// The version in a launcher package's package.json, if it has one.
pub fn installed_version(package_json: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(package_json).ok()?;
    v.get("version")?.as_str().map(str::to_owned)
}
