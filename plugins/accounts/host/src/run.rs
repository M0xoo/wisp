//! `before:run`: the account a run gets (and its folder in the env), then the harness watch: the
//! program the harness runs is pinned the first time; a changed one is recorded, and holds the turn
//! when Ask before running a changed harness is on.

use std::path::{Path, PathBuf};

use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;
use wisp_accounts_api::{Fingerprint, HOLD_KIND, PLUGIN_ID};
use wisp_accounts_core::{accounts, watch};
use wisp_kernel::{Call, Ctx, Verdict};
use wisp_runtime_api::hooks::BeforeRunCtx;
use wisp_runtime_api::model::Held;

use crate::{State, folders, harness, lock, now, store};

/// Where `bin` resolves: the path itself when it names a folder, else the first match on the PATH runs start with
/// (`wisp_proc::search_path`: the login shell's, once the desktop app handed it over; ADR-0057).
async fn resolve(bin: &str) -> Option<(PathBuf, PathBuf)> {
    let candidates: Vec<PathBuf> = if bin.contains(['/', '\\']) {
        vec![PathBuf::from(bin)]
    } else {
        wisp_proc::search_path().map(|p| std::env::split_paths(&p).map(|d| d.join(bin)).collect()).unwrap_or_default()
    };
    for p in candidates {
        if let Ok(real) = tokio::fs::canonicalize(&p).await
            && tokio::fs::metadata(&real).await.is_ok_and(|m| m.is_file())
        {
            return Some((p, real));
        }
    }
    None
}

async fn sha256(p: &Path) -> Option<String> {
    let mut f = tokio::fs::File::open(p).await.ok()?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = f.read(&mut buf).await.ok()?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Some(h.finalize().iter().fold(String::with_capacity(64), |mut s, b| {
        use std::fmt::Write;
        let _ = write!(s, "{b:02x}");
        s
    }))
}

/// The program as it is now, hashed once per real path + size + mtime.
pub(crate) async fn fingerprint(st: &State, bin: &str) -> Option<Fingerprint> {
    let (path, real) = resolve(bin).await?;
    let m = tokio::fs::metadata(&real).await.ok()?;
    #[allow(clippy::cast_precision_loss)] // ms since 1970 fit an f64 exactly
    let mtime = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0.0, |d| d.as_millis() as f64);
    let key = real.to_string_lossy().into_owned();
    let hit = lock(&st.hashes).get(&key).filter(|(s, t, _)| *s == m.len() && (*t - mtime).abs() < f64::EPSILON).map(|(_, _, h)| h.clone());
    let sha = if let Some(h) = hit {
        h
    } else {
        let h = sha256(&real).await?;
        lock(&st.hashes).insert(key.clone(), (m.len(), mtime, h.clone()));
        h
    };
    Some(Fingerprint {
        path: path.to_string_lossy().into_owned(),
        real: key,
        size: m.len(),
        sha256: sha,
        version: String::new(),
        mtime_ms: Some(mtime),
        at: None,
    })
}

/// Looks at harness `agent`'s program now and records what the watch makes of it.
pub(crate) async fn observe(ctx: &Ctx, st: &State, agent: &str, bin: &str) -> Option<wisp_accounts_api::WatchChange> {
    let fp = fingerprint(st, bin).await?;
    let was = lock(&st.watch).get(agent).cloned().unwrap_or_default();
    let (next, changed) = watch::observe(&was, fp, now(ctx));
    if changed {
        lock(&st.watch).insert(agent.to_owned(), next.clone());
        let (a, n) = (agent.to_owned(), next.clone());
        let _ = st.store.write(move |w| store::put_watch(w, &a, &n)).await;
    }
    next.change
}

/// v1 `byHand`: a launch you start yourself (no `by`), not the crew, a schedule or a subagent.
fn by_hand(c: &BeforeRunCtx) -> bool {
    c.by.as_deref().is_none_or(|b| b == "user" || b.is_empty())
}

pub(crate) async fn before_run(ctx: &Ctx, _call: &Call, st: &std::sync::Arc<State>, mut c: BeforeRunCtx) -> Verdict<BeforeRunCtx> {
    let Some(h) = harness(ctx, &c.agent) else { return Verdict::Continue };
    let mut changed = false;
    if let Some(spec) = h.accounts() {
        let list = lock(&st.accounts).get(&c.agent).cloned().unwrap_or_default();
        let pick = accounts::pick(&list, c.account.as_deref().unwrap_or(""), by_hand(&c), now(ctx));
        if !pick.is_empty() {
            if pick != accounts::DEFAULT
                && let Ok(dir) = folders::prepare(&st.home, &c.agent, spec, &pick).await
            {
                c.account_env.insert(spec.env.clone(), dir.to_string_lossy().into_owned());
            }
            c.account = Some(pick);
            changed = true;
        }
    }
    if let Some(bin) = h.program() {
        if st.ask() {
            if let Some(change) = observe(ctx, st, &c.agent, &bin).await {
                let line = watch::change_line(&h.info().name, &change, "the pin");
                c.hold = Some(Held {
                    by: PLUGIN_ID.into(),
                    kind: HOLD_KIND.into(),
                    until: None,
                    data: json!({ "agent": c.agent, "change": change, "line": line }),
                });
                lock(&st.held).entry(c.agent.clone()).or_default().push((c.session_id.0.clone(), c.turn_id.0.clone()));
                changed = true;
            }
        } else {
            // only noted: off the run's way
            let (ctx2, agent) = (ctx.clone(), c.agent.clone());
            let st2 = st.clone();
            ctx.spawn(async move {
                observe(&ctx2, &st2, &agent, &bin).await;
            });
        }
    }
    if changed { Verdict::Modify { ctx: c } } else { Verdict::Continue }
}

#[cfg(all(test, unix))]
#[allow(clippy::unwrap_used)]
mod tests {
    // ADR-0057: the desktop app hands its server the login shell's PATH after start; the harness watch must look at the
    // program `wisp-proc` starts on it, not at whatever the inherited PATH (launchd's) has. The handed PATH is the
    // inherited one with a folder in front, so the other tests in this binary find what they found before.
    #[tokio::test]
    async fn the_harness_watch_finds_the_program_on_the_path_the_desktop_app_handed_over() {
        let dir = std::env::temp_dir().join(format!("wisp-accounts-handed-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("wisp-accounts-handed-cli");
        std::fs::write(&bin, "#!/bin/sh\n").unwrap();
        assert_eq!(super::resolve("wisp-accounts-handed-cli").await, None, "not on the inherited PATH");
        wisp_proc::set_path(&format!("{}:{}", dir.display(), std::env::var("PATH").unwrap_or_default()));
        let (path, _) = super::resolve("wisp-accounts-handed-cli").await.unwrap();
        assert_eq!(path, bin);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
