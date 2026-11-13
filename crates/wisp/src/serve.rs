//! Running wisp here: the kernel with this build's plugin group and services, then the edge on
//! 127.0.0.1:<port> (`WISP_HOST` in a grid container), until Ctrl-C or SIGTERM. Env read once here:
//!   `WISP_HOME`, `WISP_PORT`, `WISP_HOST`, `WISP_WEB_DIR`, `WISP_EXIT_WITH_STDIN` (the desktop app's child),
//!   `WISP_BOX` (a grid box: the `box` set, `BoxPlugins`),
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

/// How a task's agent reaches this wisp: the edge's address, and the task's own token (HMAC of the
/// master token, `agent:session` for that task only; wisp-api's auth checks it).
struct Access {
    url: String,
    master: String,
}

impl wisp_runtime_api::points::AgentAccess for Access {
    fn url(&self) -> String {
        self.url.clone()
    }
    fn token(&self, session: &str) -> String {
        wisp_api::auth::session_token(&self.master, session)
    }
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
        // the projects (wisp.runtime's `project` kind, `StoredKind::published`): read in full while runtime is on
        .chain(std::iter::once(wisp_api::v2_store::TopicSource { kind: "project", key: "id", matches: config, query: |_| wisp_store::Query::new() }))
        .collect()
}

/// The topics a plugin reads itself for a first look: wisp.runtime's task window (v1 #788: the latest turns
/// whole, older ones as stubs, only the whole ones' events), so a long task never sends every event it had; a
/// change to a stubbed turn goes as its stub (ADR-0051).
fn snapshot_readers() -> Vec<wisp_api::v2_store::TopicReader> {
    #[cfg(feature = "runtime")]
    {
        use wisp_runtime::turn_window as w;
        let live = wisp_api::v2_store::Live { kinds: w::LIVE_KINDS, change: w::live, delta: w::delta };
        vec![wisp_api::v2_store::TopicReader { matches: w::matches, read: w::read, live: Some(live) }]
    }
    #[cfg(not(feature = "runtime"))]
    {
        Vec::new()
    }
}

/// The user's own plugins (`<home>/plugins/<slug>`, ADR-0046) join the group, each off at start: the plugin manager
/// switches back on the ones you switched on.
fn with_user_plugins(g: wisp_kernel::PluginGroup, home: &Path) -> wisp_kernel::PluginGroup {
    #[cfg(feature = "plugins")]
    {
        let mut g = g;
        for p in wisp_plugins::user_plugins(&home.join("plugins")) {
            let id = wisp_kernel::Plugin::manifest(&p).id;
            g = g.add(p).disable(&id);
        }
        g
    }
    #[cfg(not(feature = "plugins"))]
    {
        let _ = home;
        g
    }
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
    // bound first: the agents' runs are told this address before the edge serves it
    let ip: IpAddr = host.or(env("WISP_HOST").as_deref()).unwrap_or("127.0.0.1").parse().map_err(|_| CliError::said("WISP_HOST is not an IP address"))?;
    let listener = tokio::net::TcpListener::bind((ip, port)).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::AddrInUse { CliError::said(format!("port {port} is in use: is wisp already running? (wisp --port N picks another)")) } else { CliError::Io(e) }
    })?;
    let master = master_token();
    let access: Arc<dyn wisp_runtime_api::points::AgentAccess> = Arc::new(Access { url: format!("http://127.0.0.1:{}", listener.local_addr().map_or(port, |a| a.port())), master: master.clone() });
    // settings outlive a restart: the kernel's registry saves them through the store
    let settings = crate::settings_store::StoreSettings::open(&store).map_err(|e| CliError::said(format!("wisp could not read its settings: {e}")))?;
    let log = wisp_kernel::durable::EventLogService(std::sync::Arc::new(store.clone()));
    let app = crate::services::provide(App::new(), home, VERSION, notify).service(store.clone()).service(log).service(access).service(settings).plugins(with_user_plugins(group.build(&at), home));
    let kernel = app.start().await.map_err(|e| CliError::said(format!("wisp could not start: {}", e.message)))?;
    for s in kernel.status().iter().filter(|s| s.state == "refused") {
        tracing::warn!("plugin {} refused: {}", s.id, s.reason.as_deref().unwrap_or(""));
    }
    let proxy = TrustedProxy::new(env("WISP_TRUSTED_PROXY_SECRET").as_deref(), env("WISP_PUBLIC_URL").as_deref());
    let mut cfg = EdgeConfig::new(master, VERSION);
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
    // every row leaves through its owner's `kernel.egress` view (ADR-0050: .env values never leave)
    let views: Arc<dyn wisp_api::egress::ViewSource> = Arc::new(kernel.clone());
    let readers = snapshot_readers();
    let snaps = wisp_api::v2_store::StoreSnapshots::new(store.clone(), snapshot_sources(), Vec::new()).with_readers(readers.clone()).with_views(views.clone());
    let driver = wisp_api::v2::Driver::start(Arc::new(snaps), backend.clone(), peer(&kernel));
    let feed = wisp_api::v2_store::feed_read(&store, driver.clone(), views, readers.into());
    hub.mount(driver);
    let edge = Edge::new(cfg, backend, hub);

    let server = wisp_api::serve(edge, listener).await?;
    Ok(Running { server, kernel, started, store, feed })
}

/// With `WISP_EXIT_WITH_STDIN` set (the desktop app's child): done once stdin closes. Only the app holds the pipe,
/// so when it quits, crashes or is killed -9 the server stops too and never outlives it (v1 desktop/entry.mjs).
async fn stdin_closed() {
    if std::env::var_os("WISP_EXIT_WITH_STDIN").is_none() {
        return std::future::pending().await;
    }
    let _ = tokio::task::spawn_blocking(|| std::io::copy(&mut std::io::stdin().lock(), &mut std::io::sink())).await;
}

/// Until Ctrl-C, SIGTERM or (the desktop app's child) stdin closing, then a clean stop (server.json removed if it
/// is ours).
pub async fn until_signal(r: Running) {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut term = signal(SignalKind::terminate()).ok();
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            () = async { match term.as_mut() { Some(t) => { t.recv().await; } None => std::future::pending().await } } => {}
            () = stdin_closed() => {}
        }
    }
    #[cfg(not(unix))]
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        () = stdin_closed() => {}
    }
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
