//! The kernel services this install provides (plan §6.1): paths (`~/.wisp` or WISP_HOME), secrets
//! (`secrets.json`, 0600, atomic), net (one reqwest client), the clock, notify (the edge's hub), and,
//! as their crates land, proc (wisp-proc) and the store (wisp-store). The grid and tests swap any.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tokio::sync::Mutex;
use wisp_kernel::services::{Net, NetRequest, NetResponse, NetService, NotifyService, Paths, Secrets, SecretsService};
use wisp_kernel::{App, BoxFuture, Clock, Result, WireError};

/// `WISP_HOME`, else `~/.wisp`.
pub fn home(env_home: Option<&str>, user_home: Option<PathBuf>) -> PathBuf {
    match env_home.filter(|h| !h.is_empty()) {
        Some(h) => PathBuf::from(h),
        None => user_home.unwrap_or_else(|| PathBuf::from(".")).join(".wisp"),
    }
}

pub fn user_home() -> Option<PathBuf> {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from)
}

type Data = BTreeMap<String, BTreeMap<String, String>>;

/// `secrets.json` in v1's shape `{ns: {key: value}}`, so a v1 install's secrets read as they are:
/// `ns/key` is `data[ns][key]`, a key without `/` lives in `wisp`. Writes are serialised, go to a tmp
/// file made 0600 from the start (and chmod'ed in case it existed), then renamed over.
#[derive(Debug, Clone)]
pub struct FileSecrets {
    inner: Arc<Inner>,
}

#[derive(Debug)]
struct Inner {
    file: PathBuf,
    data: Mutex<Option<Data>>,
}

fn split(key: &str) -> (String, String) {
    match key.split_once('/') {
        Some((ns, k)) => (ns.to_owned(), k.to_owned()),
        None => ("wisp".to_owned(), key.to_owned()),
    }
}

fn io(e: &std::io::Error) -> WireError {
    WireError::internal(format!("secrets.json: {e}"))
}

impl FileSecrets {
    pub fn new(home: &Path) -> Self {
        Self { inner: Arc::new(Inner { file: home.join("secrets.json"), data: Mutex::new(None) }) }
    }
}

impl Inner {

    async fn load(&self, slot: &mut Option<Data>) -> Data {
        if let Some(d) = slot {
            return d.clone();
        }
        let d: Data = match tokio::fs::read(&self.file).await {
            // a value that isn't a string (a v1 bug, a hand edit) is dropped, not fatal
            Ok(b) => serde_json::from_slice::<BTreeMap<String, BTreeMap<String, Value>>>(&b)
                .map(|m| m.into_iter().map(|(ns, kv)| (ns, kv.into_iter().filter_map(|(k, v)| v.as_str().map(|s| (k, s.to_owned()))).collect())).collect())
                .unwrap_or_default(),
            Err(_) => Data::new(),
        };
        *slot = Some(d.clone());
        d
    }

    async fn save(&self, d: &Data) -> Result<()> {
        let dir = self.file.parent().unwrap_or(Path::new("."));
        tokio::fs::create_dir_all(dir).await.map_err(|e| io(&e))?;
        let tmp = self.file.with_extension("json.tmp");
        let text = serde_json::to_vec_pretty(d).map_err(|e| WireError::internal(e.to_string()))?;
        write_private(&tmp, &text).await.map_err(|e| io(&e))?;
        tokio::fs::rename(&tmp, &self.file).await.map_err(|e| io(&e))
    }

    async fn update(&self, f: impl FnOnce(&mut Data) -> bool) -> Result<()> {
        let mut slot = self.data.lock().await;
        let mut d = self.load(&mut slot).await;
        if f(&mut d) {
            self.save(&d).await?;
            *slot = Some(d);
        }
        Ok(())
    }
}

/// Writes `bytes` to `file`, readable by its owner only.
pub async fn write_private(file: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut o = tokio::fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    #[cfg(unix)]
    o.mode(0o600);
    let mut f = o.open(file).await?;
    tokio::io::AsyncWriteExt::write_all(&mut f, bytes).await?;
    f.sync_all().await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(file, std::fs::Permissions::from_mode(0o600)).await?;
    }
    Ok(())
}

impl Secrets for FileSecrets {
    fn get(&self, key: &str) -> BoxFuture<'static, Result<Option<String>>> {
        let (me, (ns, k)) = (self.inner.clone(), split(key));
        Box::pin(async move {
            let mut slot = me.data.lock().await;
            Ok(me.load(&mut slot).await.get(&ns).and_then(|m| m.get(&k)).cloned())
        })
    }
    fn set(&self, key: &str, value: &str) -> BoxFuture<'static, Result<()>> {
        let (me, (ns, k), v) = (self.inner.clone(), split(key), value.to_owned());
        Box::pin(async move {
            me.update(|d| {
                let slot = d.entry(ns).or_default();
                slot.insert(k, v.clone()) != Some(v)
            })
            .await
        })
    }
    fn delete(&self, key: &str) -> BoxFuture<'static, Result<()>> {
        let (me, (ns, k)) = (self.inner.clone(), split(key));
        Box::pin(async move {
            me.update(|d| {
                let Some(b) = d.get_mut(&ns) else { return false };
                let had = b.remove(&k).is_some();
                if b.is_empty() {
                    d.remove(&ns);
                }
                had
            })
            .await
        })
    }
    fn keys(&self, prefix: &str) -> BoxFuture<'static, Result<Vec<String>>> {
        let (me, prefix) = (self.inner.clone(), prefix.to_owned());
        Box::pin(async move {
            let mut slot = me.data.lock().await;
            let d = me.load(&mut slot).await;
            let mut out: Vec<String> = d.iter().flat_map(|(ns, kv)| kv.keys().map(move |k| if ns == "wisp" { k.clone() } else { format!("{ns}/{k}") })).filter(|k| k.starts_with(&prefix)).collect();
            out.sort();
            Ok(out)
        })
    }
}

/// HTTP out through one reqwest client (rustls), with a timeout on every request.
#[derive(Debug, Clone)]
pub struct ReqwestNet {
    client: reqwest::Client,
}

impl ReqwestNet {
    pub fn new(version: &str) -> Self {
        let client = reqwest::Client::builder().user_agent(format!("wisp/{version}")).connect_timeout(Duration::from_secs(10)).build().unwrap_or_default();
        Self { client }
    }
}

impl Net for ReqwestNet {
    fn fetch(&self, req: NetRequest) -> BoxFuture<'static, Result<NetResponse>> {
        let client = self.client.clone();
        Box::pin(async move {
            let method = reqwest::Method::from_bytes(req.method.to_ascii_uppercase().as_bytes()).map_err(|e| WireError::invalid(e.to_string()))?;
            let timeout = Duration::from_millis(if req.timeout_ms == 0 { 30_000 } else { req.timeout_ms });
            let mut b = client.request(method, &req.url).timeout(timeout).body(req.body);
            for (k, v) in &req.headers {
                b = b.header(k, v);
            }
            let r = b.send().await.map_err(|e| WireError::unavailable(format!("{}: {e}", req.url)))?;
            let status = r.status().as_u16();
            let headers = r.headers().iter().filter_map(|(k, v)| v.to_str().ok().map(|v| (k.as_str().to_owned(), v.to_owned()))).collect();
            let body = r.bytes().await.map_err(|e| WireError::unavailable(e.to_string()))?.to_vec();
            Ok(NetResponse { status, headers, body })
        })
    }
}

#[derive(Debug, Clone, Copy)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
    }
    fn sleep(&self, ms: u64) -> BoxFuture<'static, ()> {
        Box::pin(tokio::time::sleep(Duration::from_millis(ms)))
    }
}

/// Every service this install provides, on `app`.
pub fn provide(app: App, home: &Path, version: &str, notify: NotifyService) -> App {
    let secrets: SecretsService = Arc::new(FileSecrets::new(home));
    let net: NetService = Arc::new(ReqwestNet::new(version));
    let clock: Arc<dyn Clock> = Arc::new(SystemClock);
    let app = app.service(Paths::new(home)).service(secrets).service(net).service(clock).service(notify);
    #[cfg(feature = "proc")]
    let app = app.service::<wisp_proc::Proc>(wisp_proc::local());
    app
}

#[cfg(test)]
#[path = "services_tests.rs"]
mod tests;
