//! The few files that stay files (plan §4.8: `secrets.json`, 0600, kept out of the database and its
//! backups). Written temp + fsync + rename, so a crash mid-write never leaves a cut-off file (v1 once
//! loaded a truncated config.json as the defaults). Of two background saves only the newer lands: an
//! older one that finishes late is dropped instead of overwriting it.

use std::fs;
use std::io::Write as _;
use std::marker::PhantomData;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::error::{Result, StoreError};

pub struct JsonFile<T> {
    path: PathBuf,
    mode: u32,
    pretty: bool,
    /// the newest write's number; a save whose number is older at rename time is dropped
    latest: Arc<AtomicU64>,
    /// held across "is mine still the newest?" and the rename
    rename: Arc<Mutex<()>>,
    _t: PhantomData<fn() -> T>,
}

impl<T> std::fmt::Debug for JsonFile<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("JsonFile")
            .field("path", &self.path)
            .finish_non_exhaustive()
    }
}

impl<T> Clone for JsonFile<T> {
    fn clone(&self) -> Self {
        Self {
            path: self.path.clone(),
            mode: self.mode,
            pretty: self.pretty,
            latest: self.latest.clone(),
            rename: self.rename.clone(),
            _t: PhantomData,
        }
    }
}

impl<T: Serialize + DeserializeOwned + 'static> JsonFile<T> {
    /// mode 0600 by default: these files hold secrets
    pub fn new(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        let path = std::path::absolute(&path).unwrap_or(path);
        Self {
            path,
            mode: 0o600,
            pretty: false,
            latest: Arc::new(AtomicU64::new(0)),
            rename: Arc::new(Mutex::new(())),
            _t: PhantomData,
        }
    }
    #[must_use]
    pub fn mode(mut self, mode: u32) -> Self {
        self.mode = mode;
        self
    }
    #[must_use]
    pub fn pretty(mut self) -> Self {
        self.pretty = true;
        self
    }
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The value, or `None` when there is no file. A file that isn't valid JSON fails: never guess.
    pub fn read(&self) -> Result<Option<T>> {
        let text = match fs::read(&self.path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        serde_json::from_slice(&text).map(Some).map_err(|e| {
            StoreError::Invalid(format!("{} is not valid JSON: {e}", self.path.display()))
        })
    }

    /// Writes now (blocking). Any background save still on its way is dropped when it lands.
    pub fn write(&self, value: &T) -> Result<()> {
        let n = self.latest.fetch_add(1, Ordering::SeqCst) + 1;
        let tmp = self.stage(n, &self.text(value)?)?;
        let _g = self.rename.lock().unwrap_or_else(PoisonError::into_inner);
        rename_retrying(&tmp, &self.path)
    }

    /// Writes on tokio's blocking pool. `Ok(false)` when a newer write made this one moot.
    pub fn save(
        &self,
        value: &T,
    ) -> impl std::future::Future<Output = Result<bool>> + Send + 'static {
        // Numbered now, not when first polled: a `write` made after this call always wins.
        let n = self.latest.fetch_add(1, Ordering::SeqCst) + 1;
        let text = self.text(value);
        let me = self.clone();
        async move {
            let text = text?;
            tokio::task::spawn_blocking(move || {
                let tmp = me.stage(n, &text)?;
                let _g = me.rename.lock().unwrap_or_else(PoisonError::into_inner);
                if me.latest.load(Ordering::SeqCst) != n {
                    let _ = fs::remove_file(&tmp);
                    return Ok(false);
                }
                rename_retrying(&tmp, &me.path).map(|()| true)
            })
            .await
            .map_err(|e| StoreError::Internal(e.to_string()))?
        }
    }

    /// Removes temp files a crash left behind, older than a minute so no live write is touched.
    pub fn clean_temps(&self, now_ms: i64) -> Result<u64> {
        let (Some(dir), Some(base)) = (
            self.path.parent(),
            self.path
                .file_name()
                .map(|b| b.to_string_lossy().into_owned()),
        ) else {
            return Ok(0);
        };
        let Ok(entries) = fs::read_dir(dir) else {
            return Ok(0);
        };
        let mut n = 0;
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if !name.starts_with(&format!("{base}."))
                || !Path::new(&name)
                    .extension()
                    .is_some_and(|e| e.eq_ignore_ascii_case("tmp"))
            {
                continue;
            }
            let age = e
                .metadata()?
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| {
                    now_ms - i64::try_from(d.as_millis()).unwrap_or(i64::MAX)
                });
            if age > 60_000 && fs::remove_file(e.path()).is_ok() {
                n += 1;
            }
        }
        Ok(n)
    }

    fn text(&self, value: &T) -> Result<Vec<u8>> {
        let mut out = if self.pretty {
            serde_json::to_vec_pretty(value)?
        } else {
            serde_json::to_vec(value)?
        };
        out.push(b'\n');
        Ok(out)
    }

    fn stage(&self, n: u64, text: &[u8]) -> Result<PathBuf> {
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir)?;
        }
        let mut name = self.path.file_name().unwrap_or_default().to_os_string();
        name.push(format!(".{}.{n}.tmp", std::process::id()));
        let tmp = self.path.with_file_name(name);
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut opts, self.mode);
        let mut f = opts.open(&tmp)?;
        f.write_all(text)?;
        f.sync_all()?;
        Ok(tmp)
    }
}

// On Windows a rename over a file someone holds open for a moment (a reader, antivirus, the search
// indexer) fails with a permission error: wait it out briefly instead of failing (v1 util.js).
fn rename_retrying(from: &Path, to: &Path) -> Result<()> {
    for i in 1..=10u64 {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied && i < 10 => {
                std::thread::sleep(std::time::Duration::from_millis(i * 10));
            }
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}
