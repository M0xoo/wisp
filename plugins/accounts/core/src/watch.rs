//! The harness watch's decisions (v1 harness-watch.js): the first run of a harness pins its program
//! (where it resolved to, its size, sha256 and version); a different program later is a change: an
//! update (a newer version in the same install folder) or a warning. Trusting pins what's there now.

use serde::{Deserialize, Serialize};
use wisp_accounts_api::{ChangeKind, Fingerprint, WatchChange, WatchView};

/// A harness's pin and its open change (v1 harnesses.json `pins[id]`, `changes[id]`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Watched {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pin: Option<Fingerprint>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub change: Option<WatchChange>,
}

/// "2.1.3 (Claude Code)" → [2, 1, 3]; [] when it names none.
pub fn version_parts(v: &str) -> Vec<u64> {
    let start = v.char_indices().find(|(i, c)| c.is_ascii_digit() && v[*i..].chars().find(|c| !c.is_ascii_digit()) == Some('.'));
    let Some((i, _)) = start else { return Vec::new() };
    let run: String = v[i..].chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
    run.trim_end_matches('.').split('.').filter(|s| !s.is_empty()).map(|s| s.parse().unwrap_or(0)).collect()
}

pub fn version_up(from: &str, to: &str) -> bool {
    let (a, b) = (version_parts(from), version_parts(to));
    if a.is_empty() || b.is_empty() {
        return false;
    }
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0));
        if x != y {
            return y > x;
        }
    }
    false
}

/// The folder a program is installed in, version folders as a wildcard (Cellar/codex/0.1.2/bin).
pub fn install_dir(real: &str) -> String {
    let dir = real.rsplit_once(['/', '\\']).map_or("", |(d, _)| d);
    dir.split(['/', '\\'])
        .map(|seg| {
            let s = seg.strip_prefix('v').unwrap_or(seg);
            let mut parts = s.splitn(2, '.');
            let numeric = |p: Option<&str>| p.is_some_and(|x| x.starts_with(|c: char| c.is_ascii_digit()));
            if numeric(parts.next()) && numeric(parts.next()) { "*" } else { seg }
        })
        .collect::<Vec<_>>()
        .join("/")
}

pub fn classify(pin: &Fingerprint, now: &Fingerprint) -> ChangeKind {
    if version_up(&pin.version, &now.version) && install_dir(&pin.real) == install_dir(&now.real) {
        ChangeKind::Update
    } else {
        ChangeKind::Warn
    }
}

/// Without hashing: whether `size`/`mtime` at `real` may not be the pinned program.
pub fn suspect(w: &Watched, real: &str, size: u64, mtime_ms: f64) -> bool {
    let Some(pin) = &w.pin else { return false };
    w.change.is_some() || pin.real != real || pin.size != size || pin.mtime_ms != Some(mtime_ms)
}

/// Looks at the program now (`fp`, hashed): pins it the first time, keeps the pin current for the
/// same bytes, records a change otherwise. Returns (the new state, whether it changed).
pub fn observe(w: &Watched, mut fp: Fingerprint, now: i64) -> (Watched, bool) {
    let mut next = w.clone();
    let Some(pin) = &w.pin else {
        fp.at = Some(now);
        next.pin = Some(fp);
        return (next, true);
    };
    if pin.sha256 == fp.sha256 && pin.real == fp.real {
        // the same program (touched, or a version we didn't know yet): keep the pin current
        let fresh = pin.mtime_ms != fp.mtime_ms || (!fp.version.is_empty() && pin.version != fp.version) || w.change.is_some();
        if fresh {
            let mut p = pin.clone();
            p.mtime_ms = fp.mtime_ms;
            if !fp.version.is_empty() {
                p.version = fp.version;
            }
            next.pin = Some(p);
            next.change = None;
        }
        return (next, fresh);
    }
    if w.change.as_ref().is_some_and(|c| c.to.sha256 == fp.sha256 && c.to.real == fp.real) {
        return (next, false);
    }
    // a change on top of an untrusted change still compares with what you last trusted
    next.change = Some(WatchChange { kind: classify(pin, &fp), from: pin.clone(), to: fp, at: now });
    (next, true)
}

/// Trust this version: what's there now becomes the pin. None when nothing changed.
pub fn trust(w: &Watched, now: i64) -> Option<Watched> {
    let c = w.change.as_ref()?;
    let mut pin = c.to.clone();
    pin.at = Some(now);
    Some(Watched { pin: Some(pin), change: None })
}

pub fn view(w: &Watched) -> WatchView {
    WatchView { pinned_at: w.pin.as_ref().and_then(|p| p.at), changed: w.change.clone() }
}

/// "Claude Code changed since 2026-11-02: 2.0.1 → 2.0.2" (`date` formats the pin's time).
pub fn change_line(name: &str, c: &WatchChange, date: &str) -> String {
    let label = |x: &Fingerprint| if x.version.is_empty() { x.path.clone() } else { x.version.clone() };
    let from = label(&c.from);
    let to = if c.kind == ChangeKind::Update || c.from.real == c.to.real || c.from.path == c.to.path {
        label(&c.to)
    } else {
        format!("{} at {}", label(&c.to), c.to.path)
    };
    let what = if from == to {
        format!("{from} (other bytes: {}…)", c.to.sha256.chars().take(12).collect::<String>())
    } else {
        format!("{from} → {to}")
    };
    format!("{name} changed since {date}: {what}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fp(real: &str, sha: &str, version: &str) -> Fingerprint {
        Fingerprint {
            path: "/usr/local/bin/codex".into(),
            real: real.into(),
            size: 10,
            sha256: sha.into(),
            version: version.into(),
            mtime_ms: Some(1.0),
            at: None,
        }
    }

    #[test]
    fn versions_and_install_folders() {
        assert_eq!(version_parts("2.1.3 (Claude Code)"), [2, 1, 3]);
        assert_eq!(version_parts("codex-cli 0.53.0"), [0, 53, 0]);
        assert!(version_up("0.1.2", "0.1.10") && !version_up("1.0", "1.0.0") && !version_up("", "1.0"));
        assert_eq!(install_dir("/opt/homebrew/Cellar/codex/0.1.2/bin/codex"), "/opt/homebrew/Cellar/codex/*/bin");
    }

    #[test]
    fn pin_then_update_then_warn_then_trust() {
        // v1 harness-watch.test.js: the first run pins; an update in place is info; other bytes warn
        let (w, _) = observe(&Watched::default(), fp("/c/0.1.2/bin/codex", "a", "0.1.2"), 1);
        assert_eq!(w.pin.as_ref().and_then(|p| p.at), Some(1));
        let (same, changed) = observe(&w, fp("/c/0.1.2/bin/codex", "a", "0.1.2"), 2);
        assert!(!changed && same.change.is_none());
        let (up, _) = observe(&w, fp("/c/0.1.3/bin/codex", "b", "0.1.3"), 3);
        assert_eq!(up.change.as_ref().map(|c| c.kind), Some(ChangeKind::Update));
        let (other, _) = observe(&w, fp("/c/0.1.2/bin/codex", "c", "0.1.2"), 3);
        let c = other.change.clone().unwrap_or_else(|| panic!("a change"));
        assert_eq!(c.kind, ChangeKind::Warn);
        assert_eq!(change_line("Codex", &c, "2026-11-02"), "Codex changed since 2026-11-02: 0.1.2 (other bytes: c…)");
        let t = trust(&other, 9).unwrap_or_default();
        assert_eq!((t.pin.as_ref().map(|p| p.sha256.as_str()), t.change.is_none()), (Some("c"), true));
        assert!(trust(&t, 10).is_none());
        assert!(suspect(&w, "/c/0.1.2/bin/codex", 11, 1.0) && !suspect(&w, "/c/0.1.2/bin/codex", 10, 1.0));
    }
}
