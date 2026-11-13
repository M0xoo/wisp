//! An account's folder (v1 accounts.js `prepare`): everything in the CLI's own folder except the
//! login is linked in, so settings, skills, MCP servers and transcripts are the same on every
//! account. Cheap enough to run before every run, so a link a CLI replaced with a file is mended.
//! These are the CLI's own files, not wisp's state: they sit outside the store by design.

use std::path::{Path, PathBuf};

use wisp_runtime_api::harness::HarnessAccounts;

/// The CLI's own folder: its env override, else under the user's home.
pub fn default_home(a: &HarnessAccounts) -> PathBuf {
    if let Some(d) = std::env::var_os(&a.env).filter(|d| !d.is_empty()) {
        return PathBuf::from(d);
    }
    std::env::var_os("HOME").map_or_else(|| PathBuf::from("."), PathBuf::from).join(&a.home_dir)
}

pub fn home_of(wisp_home: &Path, agent: &str, a: &HarnessAccounts, id: &str) -> PathBuf {
    if id.is_empty() || id == wisp_accounts_core::accounts::DEFAULT {
        default_home(a)
    } else {
        wisp_home.join("accounts").join(agent).join(id)
    }
}

async fn link(target: &Path, at: &Path) -> std::io::Result<()> {
    match tokio::fs::symlink_metadata(at).await {
        Ok(m) if m.file_type().is_symlink() => {
            if tokio::fs::read_link(at).await.ok().as_deref() == Some(target) {
                return Ok(());
            }
            tokio::fs::remove_file(at).await?;
        }
        Ok(m) if m.is_file() => {
            // the CLI replaced the link with a file of its own: the newer one wins, then it's a link again
            let mine = m.modified().ok();
            let theirs = tokio::fs::metadata(target).await.ok().and_then(|t| t.modified().ok());
            if mine > theirs {
                let _ = tokio::fs::copy(at, target).await;
            }
            tokio::fs::remove_file(at).await?;
        }
        Ok(_) => return Ok(()), // a real folder: left alone
        Err(_) => {}
    }
    #[cfg(unix)]
    {
        tokio::fs::symlink(target, at).await
    }
    #[cfg(not(unix))]
    {
        let _ = (target, at);
        Ok(())
    }
}

/// Makes an extra account's folder ready. The default account needs nothing.
pub async fn prepare(wisp_home: &Path, agent: &str, a: &HarnessAccounts, id: &str) -> std::io::Result<PathBuf> {
    let dir = home_of(wisp_home, agent, a, id);
    if id.is_empty() || id == wisp_accounts_core::accounts::DEFAULT {
        return Ok(dir);
    }
    link_all(&default_home(a), &dir, &a.own).await?;
    Ok(dir)
}

#[allow(clippy::case_sensitive_file_extension_comparisons)] // the CLIs' own lock and temp names
/// Links everything in `base` but `own` (and lock and temp files) into `dir`.
pub async fn link_all(base: &Path, dir: &Path, own: &[String]) -> std::io::Result<()> {
    tokio::fs::create_dir_all(&dir).await?;
    tokio::fs::create_dir_all(base).await?;
    let mut rd = tokio::fs::read_dir(&base).await?;
    while let Some(e) = rd.next_entry().await? {
        let name = e.file_name().to_string_lossy().into_owned();
        if own.contains(&name) || name.ends_with(".lock") || name.ends_with(".tmp") || name.starts_with(".tmp") {
            continue;
        }
        let _ = link(&e.path(), &dir.join(&name)).await;
    }
    Ok(())
}

/// Forgets an extra account's folder: only what's in it; links are removed, never followed.
pub async fn remove(wisp_home: &Path, agent: &str, a: &HarnessAccounts, id: &str) {
    let dir = home_of(wisp_home, agent, a, id);
    if dir.starts_with(wisp_home.join("accounts")) {
        let _ = tokio::fs::remove_dir_all(dir).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn an_extra_account_links_all_but_the_login() {
        let t = std::env::temp_dir().join(format!("wisp-acc-{}", std::process::id()));
        let base = t.join("user/.fake");
        tokio::fs::create_dir_all(base.join("projects")).await.unwrap();
        tokio::fs::write(base.join("settings.json"), "{}").await.unwrap();
        tokio::fs::write(base.join("auth.json"), "secret").await.unwrap();
        let a = HarnessAccounts { env: "X".into(), home_dir: ".fake".into(), own: vec!["auth.json".into()], ..HarnessAccounts::default() };
        let dir = home_of(&t.join("wisp"), "fake", &a, "w1");
        link_all(&base, &dir, &a.own).await.unwrap();
        link_all(&base, &dir, &a.own).await.unwrap(); // again: nothing to mend
        assert!(tokio::fs::symlink_metadata(dir.join("settings.json")).await.unwrap().file_type().is_symlink());
        assert!(tokio::fs::symlink_metadata(dir.join("projects")).await.unwrap().file_type().is_symlink());
        assert!(tokio::fs::symlink_metadata(dir.join("auth.json")).await.is_err(), "the login stays the account's own");
        remove(&t.join("wisp"), "fake", &a, "w1").await;
        assert!(tokio::fs::metadata(&dir).await.is_err());
        assert!(tokio::fs::metadata(base.join("settings.json")).await.is_ok(), "links are removed, never followed");
        let _ = tokio::fs::remove_dir_all(t).await;
    }
}
