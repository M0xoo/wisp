//! Running wisp here: the kernel with this build's plugin group and services, then the edge on
//! 127.0.0.1:<port> (`WISP_HOST` in a grid container), until Ctrl-C or SIGTERM. Env read once here:
//!   `WISP_HOME`, `WISP_PORT`, `WISP_HOST`, `WISP_WEB_DIR`, `WISP_BOX` (a grid box: the `box` set, `BoxPlugins`),
//!   `WISP_TRUSTED_PROXY_SECRET`, `WISP_PUBLIC_URL`, `WISP_PREVIEW_URL`.
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use wisp_api::{Edge, EdgeConfig, Hub, Server, TrustedProxy};
use wisp_kernel::services::NotifyService;
use wisp_kernel::{App, Kernel};

use crate::client::{CliError, Result};
use crate::groups::{Group, Where};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

fn env(k: &str) -> Option<String> {
    std::env::var(k).ok().filter(|v| !v.is_empty())
}

/// The built web app: `WISP_WEB_DIR`, else `web/` beside or above the binary, else (a dev build) the
/// checkout's apps/web/dist.
pub fn web_dir() -> Option<PathBuf> {
    if let Some(d) = env("WISP_WEB_DIR") {
        return Some(PathBuf::from(d));
    }
    let exe = std::env::current_exe().ok()?;
    let at = exe.parent()?;
    let mut tries = vec![at.join("web"), at.join("../web")];
    if cfg!(debug_assertions) {
        tries.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../apps/web/dist"));
    }
    tries.into_iter().find(|d| d.join("index.html").is_file())
}

fn master_token() -> String {
    let b: [u8; 16] = rand::random();
    crate::services::hex(&b)
}

/// Who this wisp is to a client: features come from its plugins, not its version number.
fn peer(kernel: &Kernel) -> wisp_protocol::PeerInfo {
    let name = env("HOSTNAME").or_else(|| env("COMPUTERNAME")).unwrap_or_else(|| "this computer".into());
    let plugins = kernel
        .status()
        .into_iter()
        .filter(|s| s.state == "active")
        .map(|s| wisp_protocol::PeerPlugin { id: s.id, version: s.version, commands: Vec::new(), topics: Vec::new(), blocks: Vec::new() })
        .collect();
    wisp_protocol::PeerInfo { peer: name.clone(), name, build: VERSION.into(), version: VERSION.into(), proto_min: 2, proto_max: 2, plugins }
}

#[derive(Debug)]
pub struct Running {
    pub server: Server,
    pub kernel: Kernel,
    pub started: Instant,
    pub store: wisp_store::Store,
    /// the store's commits feeding the v2 stream: dropped, the feed stops
    pub feed: wisp_store::Subscription,
}

/// What `config` reads in full: the kernel's own kinds (settings, plugins). Plugins add theirs.
fn snapshot_sources() -> Vec<wisp_api::v2_store::TopicSource> {
    let config = |t: &str| t == "config";
    [wisp_store::SETTING, wisp_store::PLUGIN]
        .into_iter()
        .map(|d| wisp_api::v2_store::TopicSource { kind: d.kind, key: d.key, matches: config, query: |_| wisp_store::Query::new() })
        .collect()
}

/// `<home>/wisp.db`, opened before the kernel so every plugin finds it as a service. Startup only:
/// opening and migrating block, which is fine here and nowhere else.
fn open_store(home: &Path) -> Result<wisp_store::Store> {
    wisp_store::Store::open(wisp_store::Location::Path(home.join("wisp.db")), Arc::new(wisp_store::SystemClock))
        .map_err(|e| CliError::said(format!("wisp could not open its database: {e}")))
}

pub async fn boot(home: &Path, port: u16, host: Option<&str>) -> Result<Running> {
    let started = Instant::now();
    let box_mode = env("WISP_BOX").is_some_and(|v| v != "0");
    let hub = Hub::new();
    let notify: NotifyService = hub.clone();
    let at = Where { home: home.to_owned(), user_home: crate::services::user_home().unwrap_or_else(|| home.to_owned()) };
    let fallback = if box_mode { Group::Box } else { Group::Default };
    let group = env("WISP_PLUGINS").and_then(|g| Group::named(&g)).unwrap_or(fallback);
    tracing::info!("plugins in this build: {:?}", crate::groups::compiled(group));
    let store = open_store(home)?;
    let app = crate::services::provide(App::new(), home, VERSION, notify).service(store.clone()).plugins(group.build(&at));
    let kernel = app.start().await.map_err(|e| CliError::said(format!("wisp could not start: {}", e.message)))?;
    for s in kernel.status().iter().filter(|s| s.state == "refused") {
        tracing::warn!("plugin {} refused: {}", s.id, s.reason.as_deref().unwrap_or(""));
    }
    let proxy = TrustedProxy::new(env("WISP_TRUSTED_PROXY_SECRET").as_deref(), env("WISP_PUBLIC_URL").as_deref());
    let mut cfg = EdgeConfig::new(master_token(), VERSION);
    cfg.previews = proxy.on() && env("WISP_PREVIEW_URL").is_some();
    cfg.proxy = proxy;
    cfg.web_dir = web_dir();
    cfg.home = Some(home.to_owned());
    if box_mode {
        "box".clone_into(&mut cfg.user_set);
    }
    if cfg.web_dir.is_none() {
        tracing::warn!("no web build found (WISP_WEB_DIR, or npm run build): serving the API only");
    }
    let backend: Arc<dyn wisp_api::Backend> = Arc::new(kernel.clone());
    // the v2 stream on the store: snapshots and deltas from its tables and change feed (under its
    // epoch), and every commit streamed as it lands (Store::on_commit → Driver::committed)
    let snaps = wisp_api::v2_store::StoreSnapshots::new(store.clone(), snapshot_sources(), Vec::new());
    let driver = wisp_api::v2::Driver::start(Arc::new(snaps), backend.clone(), peer(&kernel));
    let feed = wisp_api::v2_store::feed(&store, driver.clone());
    hub.mount(driver);
    let edge = Edge::new(cfg, backend, hub);
    let ip: IpAddr = host.or(env("WISP_HOST").as_deref()).unwrap_or("127.0.0.1").parse().map_err(|_| CliError::said("WISP_HOST is not an IP address"))?;
    let listener = tokio::net::TcpListener::bind((ip, port)).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::AddrInUse { CliError::said(format!("port {port} is in use: is wisp already running? (wisp --port N picks another)")) } else { CliError::Io(e) }
    })?;
    let server = wisp_api::serve(edge, listener).await?;
    Ok(Running { server, kernel, started, store, feed })
}

/// Until Ctrl-C or SIGTERM, then a clean stop (server.json removed if it is ours).
pub async fn until_signal(r: Running) {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut term = signal(SignalKind::terminate()).ok();
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            () = async { match term.as_mut() { Some(t) => { t.recv().await; } None => std::future::pending().await } } => {}
        }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
    r.server.shutdown().await;
    // every plugin off, in reverse order: their scopes end their tasks and children
    let ids: Vec<String> = r.kernel.status().into_iter().filter(|s| s.state == "active").map(|s| s.id).collect();
    for id in ids.iter().rev() {
        let _ = r.kernel.set_enabled(id, false).await;
    }
    drop(r.feed);
    r.store.close();
}

/// The page in the user's browser (no shell: the address is ours).
pub fn open_url(url: &str) {
    let (cmd, args): (&str, Vec<&str>) = if cfg!(target_os = "macos") {
        ("open", vec![url])
    } else if cfg!(windows) {
        ("rundll32", vec!["url.dll,FileProtocolHandler", url])
    } else {
        ("xdg-open", vec![url])
    };
    let _ = std::process::Command::new(cmd).args(args).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn();
}
