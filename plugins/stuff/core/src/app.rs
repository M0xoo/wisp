//! An app's code: which files of its folder are kept, the hash a write grant is tied to (byte for byte
//! v1's `appHash`, so a starter's shipped `was` hashes and imported grants still match), what the
//! Allow card warns about, and whether a starter's copy follows wisp's newer one.
//!
//! v1 hashed a live folder and cached by stat signatures, because agents could edit it in place. In
//! v2 an app's files are immutable blobs in the CAS, so its code hash is computed once, at save time.

use sha2::{Digest, Sha256};
use wisp_stuff_api::private_file;

/// Left out of an app's copy: what a build or a package manager makes again.
pub const SKIP: &[&str] = &[
    "node_modules",
    ".git",
    ".hg",
    ".svn",
    ".DS_Store",
    ".next",
    ".cache",
    ".turbo",
    ".venv",
    "__pycache__",
];

/// Is a folder entry skipped? `rel` is its path inside the app, for the private-file rule.
pub fn skipped(name: &str, rel: &str, is_file: bool) -> bool {
    SKIP.contains(&name) || (is_file && private_file(rel))
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes
        .iter()
        .fold(String::with_capacity(bytes.len() * 2), |mut s, b| {
            let _ = write!(s, "{b:02x}");
            s
        })
}

/// v1 `appHash`'s inner hash over a folder: each file in path order, as `rel\0link\0size\0` and its
/// bytes. Files must be added sorted by `rel` (`sort_rels`). A kept copy has no links.
#[derive(Debug, Clone, Default)]
pub struct CodeHasher {
    h: Sha256,
}

impl CodeHasher {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn file(&mut self, rel: &str, size: u64, bytes: &[u8]) {
        self.h.update(format!("{rel}\0\0{size}\0").as_bytes());
        self.h.update(bytes);
    }
    pub fn finish(self) -> String {
        hex(&self.h.finalize())
    }
}

/// The order v1 hashed in (JavaScript's `<` on the paths).
pub fn sort_rels<T>(files: &mut [T], rel: impl Fn(&T) -> &str) {
    files.sort_by(|a, b| rel(a).encode_utf16().cmp(rel(b).encode_utf16()));
}

/// The grant hash: the code and the sorted uses (asking for more is new code too).
pub fn app_hash(code: &str, uses: &[String]) -> String {
    let mut u: Vec<&str> = uses.iter().map(String::as_str).collect();
    u.sort_unstable();
    hex(&Sha256::digest(
        format!("{code}\0{}", u.join("\0")).as_bytes(),
    ))
}

/// The hash of a folder given as `(rel, bytes)`, any order: for tests and starters.
pub fn folder_hash(files: &[(&str, &[u8])], uses: &[String]) -> String {
    let mut f: Vec<&(&str, &[u8])> = files.iter().collect();
    sort_rels(&mut f, |x| x.0);
    let mut h = CodeHasher::new();
    for (rel, bytes) in f {
        h.file(rel, bytes.len() as u64, bytes);
    }
    app_hash(&h.finish(), uses)
}

/// Code the Allow card should warn about. Literal names only, so it can miss code that builds them
/// at run time: a warning when found, no promise when not.
pub fn scans_for_risk(rel: &str) -> bool {
    let e = crate::kind::ext(rel);
    matches!(e.as_str(), "html" | "htm" | "js" | "cjs" | "mjs")
}

pub fn webrtc_in(text: &[u8]) -> bool {
    const NEEDLES: [&[u8]; 3] = [b"RTCPeerConnection", b"RTCDataChannel", b"webkitRTC"];
    NEEDLES
        .iter()
        .any(|n| text.windows(n.len()).any(|w| w == *n))
}

/// A starter is copied in once, so wisp's newer one follows only a copy nobody changed: its hash is
/// a version wisp shipped (`was`, oldest first). A copy you went back to with Restore stays: its
/// previous version is later than what's there. `shipped`: the hash of what wisp ships now.
pub fn follows_starter(now: &str, prev: Option<&str>, was: &[String], shipped: &str) -> bool {
    if now.is_empty() || !was.iter().any(|w| w == now) {
        return false;
    }
    let pos = |h: &str| {
        was.iter()
            .position(|w| w == h)
            .or_else(|| (h == shipped).then_some(was.len()))
    };
    match (prev.and_then(pos), pos(now)) {
        (Some(p), Some(n)) => p <= n,
        _ => true,
    }
}
