//! What the host reads off this computer for Settings → Machines (core parses it all): the hosts in
//! `~/.ssh/config` and `known_hosts`, the tailnet (`tailscale status --json`), and whether other
//! devices could reach this one (its SSH port's banner, its authorized keys). Files are read off the
//! runtime's workers; programs run through the proc service.
use std::path::{Path, PathBuf};
use std::time::Duration;

use tokio::io::AsyncReadExt;
use wisp_kernel::Ctx;
use wisp_machines_api::{FoundHost, Reachability, SshHost};
use wisp_machines_core::hosts::{self, SshFiles};
use wisp_machines_core::reachable::{self, Facts};
use wisp_proc::{ExecOpts, Proc};

use crate::letin::user_home;

/// `~/.ssh/config` and its Includes, read from disk.
#[derive(Debug)]
struct Disk;

impl SshFiles for Disk {
    fn read(&self, path: &Path) -> Option<String> {
        std::fs::read_to_string(path).ok()
    }
    fn list(&self, dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir).map(|d| d.filter_map(|e| e.ok()?.file_name().into_string().ok()).collect()).unwrap_or_default()
    }
}

fn ssh_dir() -> PathBuf {
    user_home().join(".ssh")
}

pub async fn hosts() -> Vec<SshHost> {
    tokio::task::spawn_blocking(|| {
        let (home, dir) = (user_home(), ssh_dir());
        hosts::ssh_hosts(&Disk, &dir.join("config"), &dir, &home)
    })
    .await
    .unwrap_or_default()
}

/// What a program printed, or `None` when it isn't there or failed (the tailscale CLI is optional).
async fn run(ctx: &Ctx, bin: &str, args: &[&str]) -> Option<String> {
    let proc = ctx.service::<Proc>().ok()?;
    let args: Vec<String> = args.iter().map(|a| (*a).to_owned()).collect();
    let opts = ExecOpts { timeout: Some(Duration::from_secs(3)), max_output: 4 * 1024 * 1024, scope: Some(ctx.scope().clone()), ..ExecOpts::default() };
    let r = proc.exec(bin, &args, opts).await.ok()?;
    (r.exit.success() && !r.timed_out).then(|| r.stdout_text())
}

pub async fn discover(ctx: &Ctx) -> Vec<FoundHost> {
    let config = hosts().await;
    let tail = run(ctx, "tailscale", &["status", "--json"]).await.map(|s| hosts::tailscale_peers(&s)).unwrap_or_default();
    let known = tokio::fs::read_to_string(ssh_dir().join("known_hosts")).await.map(|t| hosts::known_hosts(&t)).unwrap_or_default();
    hosts::discover(&config, &tail, &known)
}

/// The first line this computer's SSH port says, within a second.
async fn banner(port: u16) -> Option<String> {
    let knock = async {
        let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.ok()?;
        let mut buf = Vec::new();
        let mut chunk = [0_u8; 256];
        loop {
            let n = s.read(&mut chunk).await.ok()?;
            if n == 0 {
                return reachable::banner(&buf).flatten();
            }
            buf.extend_from_slice(&chunk[..n]);
            if let Some(b) = reachable::banner(&buf) {
                return b;
            }
        }
    };
    tokio::time::timeout(Duration::from_secs(1), knock).await.ok().flatten()
}

pub async fn reachable(ctx: &Ctx) -> Reachability {
    let status = run(ctx, "tailscale", &["status", "--json"]).await;
    let prefs = if status.is_some() { run(ctx, "tailscale", &["debug", "prefs"]).await } else { None };
    let keys = tokio::fs::read_to_string(ssh_dir().join("authorized_keys")).await.map_or(0, |t| reachable::authorized_keys(&t));
    let hostname = run(ctx, "hostname", &[]).await.map(|h| h.trim().to_owned()).filter(|h| !h.is_empty()).unwrap_or_else(|| "localhost".into());
    let user = std::env::var("USER").or_else(|_| std::env::var("USERNAME")).unwrap_or_default();
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        o => o,
    };
    reachable::reachability(Facts { os, user: &user, hostname: &hostname, ssh_port: 22, banner: banner(22).await, tailscale: reachable::tailscale_self(status.as_deref(), prefs.as_deref()), keys })
}
