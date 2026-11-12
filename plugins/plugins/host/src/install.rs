//! ADR-0046: a user's plugin installed while wisp runs, from a folder or a git URL, into `~/.wisp/plugins/<slug>`,
//! and the ones already there loaded at start. A plugin's id starts with `user.`; it is validated before anything
//! is kept, and it starts off: switching it on (`plugins.setEnabled`) is the consent to the permissions it asks for.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use wisp_kernel::{Ctx, Declarative, ExecPlugin, Manifest, Plugin, Result, Setup, WireError};
use wisp_proc::{ExecOpts, Proc};

pub const MANIFEST: &str = "wisp-plugin.json";

/// A user's plugin as the kernel runs it: a child process (an `exec` server) rooted at its folder, or its manifest
/// alone (a theme, settings, contributions).
#[derive(Debug, Clone)]
pub enum UserPlugin {
    Exec(ExecPlugin),
    Declarative(Declarative),
}

impl Plugin for UserPlugin {
    fn manifest(&self) -> Manifest {
        match self {
            Self::Exec(p) => p.manifest(),
            Self::Declarative(p) => p.manifest(),
        }
    }
    fn setup(&self, s: &mut Setup) -> Result<()> {
        match self {
            Self::Exec(p) => p.setup(s),
            Self::Declarative(p) => p.setup(s),
        }
    }
}

/// The mark a plugin you trusted keeps beside its manifest (ADR-0048).
pub const TRUSTED: &str = ".wisp-trusted";

/// The plugin in `dir` (its `wisp-plugin.json`), checked: a `user.` id and a valid manifest. Untrusted whatever the
/// manifest says (ADR-0048), unless you trusted it (`trusted`: its mark is there).
pub fn read(dir: &Path, text: &str, trusted: bool) -> Result<UserPlugin> {
    let mut m = Manifest::parse(text)?;
    m.trust = Some(if trusted { "trusted" } else { "untrusted" }.to_owned());
    if !m.id.starts_with("user.") {
        return Err(WireError::invalid(format!("{} isn't a user plugin's id: a plugin you install is named user.<something> (built-in ids are wisp's own)", m.id)));
    }
    m.validate()?;
    Ok(if m.exec().is_some() { UserPlugin::Exec(ExecPlugin::new(m, Some(dir.to_owned()))) } else { UserPlugin::Declarative(Declarative(m)) })
}

/// The folder a plugin goes in: `user.my-tool` → `my-tool`.
pub fn slug(id: &str) -> String {
    id.trim_start_matches("user.").chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' }).collect()
}

/// Every plugin under `<home>/plugins` (startup: blocking reads are fine there). A folder that doesn't read as a
/// plugin is skipped with a warning; it never stops wisp starting.
pub fn at_start(plugins: &Path) -> Vec<UserPlugin> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(plugins) else { return out };
    let mut dirs: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.is_dir() && !p.file_name().is_some_and(|n| n.to_string_lossy().starts_with('.'))).collect();
    dirs.sort();
    for d in dirs {
        let Ok(text) = std::fs::read_to_string(d.join(MANIFEST)) else { continue };
        match read(&d, &text, d.join(TRUSTED).is_file()) {
            Ok(p) => out.push(p),
            Err(e) => tracing::warn!(folder = %d.display(), "a plugin there isn't loaded: {}", e.message),
        }
    }
    out
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstallArgs {
    /// a folder on this computer, or a git URL
    pub source: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Installed {
    pub id: String,
    pub name: String,
    pub version: String,
    /// what it asks for: switching it on gives it these
    pub permissions: Vec<String>,
    pub folder: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct UninstallArgs {
    pub id: String,
}

const IS_URL: [&str; 4] = ["https://", "http://", "git@", "ssh://"];

/// Copies `from` into `to` (no `.git`, `node_modules` or `target`).
async fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut stack = vec![(from.to_owned(), to.to_owned())];
    while let Some((src, dst)) = stack.pop() {
        tokio::fs::create_dir_all(&dst).await?;
        let mut rd = tokio::fs::read_dir(&src).await?;
        while let Some(e) = rd.next_entry().await? {
            let name = e.file_name();
            if [".git", "node_modules", "target"].iter().any(|x| name == *x) {
                continue;
            }
            let p = e.path();
            if e.file_type().await?.is_dir() {
                stack.push((p, dst.join(&name)));
            } else {
                tokio::fs::copy(&p, dst.join(&name)).await?;
            }
        }
    }
    Ok(())
}

/// A folder as typed: `~/code/my-plugin` is under your home (the box's own example; the folder picker's suggestions
/// keep the `~` you typed). Anything else as it is.
pub fn local_path(source: &str, home: Option<&Path>) -> PathBuf {
    match (source.strip_prefix('~'), home) {
        (Some(rest), Some(h)) if rest.is_empty() || rest.starts_with(['/', '\\']) => h.join(rest.trim_start_matches(['/', '\\'])),
        _ => PathBuf::from(source),
    }
}

/// `plugins.install`: the source fetched into a staging folder, checked, then moved into place and added (off).
pub async fn install(ctx: &Ctx, a: &InstallArgs) -> Result<Installed> {
    let home = ctx.service::<wisp_kernel::services::Paths>()?;
    let root = home.join("plugins");
    let source = a.source.trim();
    if source.is_empty() {
        return Err(WireError::invalid("say where the plugin is: a folder or a git URL"));
    }
    let staging = root.join(format!(".incoming-{}", wisp_kernel::ids::uuid7()));
    let fetched: std::result::Result<(), String> = if IS_URL.iter().any(|p| source.starts_with(p)) {
        let proc = ctx.service::<Proc>()?;
        let opts = ExecOpts { cwd: Some(root.clone()), timeout: Some(Duration::from_secs(120)), max_output: 1 << 20, ..ExecOpts::default() };
        let _ = tokio::fs::create_dir_all(&root).await;
        let args: Vec<String> = ["clone", "--depth", "1", "--", source, &staging.display().to_string()].iter().map(|x| (*x).to_owned()).collect();
        match proc.exec("git", &args, opts).await {
            Ok(r) if r.exit.success() => Ok(()),
            Ok(r) => Err(format!("git couldn't clone it: {}", r.stderr_text().trim())),
            Err(e) => Err(format!("git couldn't run: {e}")),
        }
    } else {
        let user = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from);
        let from = local_path(source, user.as_deref());
        if tokio::fs::metadata(from.join(MANIFEST)).await.is_ok_and(|m| m.is_file()) {
            copy_dir(&from, &staging).await.map_err(|e| format!("couldn't copy it: {e}"))
        } else {
            Err(format!("{source} has no {MANIFEST}"))
        }
    };
    let gone = |why: String| {
        let staging = staging.clone();
        async move {
            let _ = tokio::fs::remove_dir_all(&staging).await;
            Err(WireError::invalid(why))
        }
    };
    if let Err(why) = fetched {
        return gone(why).await;
    }
    let text = tokio::fs::read_to_string(staging.join(MANIFEST)).await.unwrap_or_default();
    let m = match Manifest::parse(&text).and_then(|m| read(&staging, &text, false).map(|_| m)) {
        Ok(m) => m,
        Err(e) => return gone(e.message).await,
    };
    // the same plugin again replaces the one here, once the new one checked out
    if ctx.plugins()?.iter().any(|p| p.id == m.id) {
        ctx.uninstall_plugin(&m.id).await?;
    }
    let dir = root.join(slug(&m.id));
    let _ = tokio::fs::remove_dir_all(&dir).await;
    tokio::fs::rename(&staging, &dir).await.map_err(|e| WireError::internal(format!("couldn't move it into place: {e}")))?;
    let text = tokio::fs::read_to_string(dir.join(MANIFEST)).await.unwrap_or_default();
    // what's installed starts untrusted, a reinstall too: trusting it again is your call
    ctx.install_plugin(Arc::new(read(&dir, &text, false)?)).await?;
    Ok(Installed { id: m.id.clone(), name: m.name.clone().unwrap_or_else(|| m.id.clone()), version: m.version.clone(), permissions: m.permissions.clone(), folder: dir.display().to_string() })
}

/// `plugins.uninstall`: off, out of the kernel, and its folder deleted.
pub async fn uninstall(ctx: &Ctx, a: &UninstallArgs) -> Result<serde_json::Value> {
    ctx.uninstall_plugin(&a.id).await?;
    let home = ctx.service::<wisp_kernel::services::Paths>()?;
    let _ = tokio::fs::remove_dir_all(home.join("plugins").join(slug(&a.id))).await;
    Ok(serde_json::json!({ "ok": true, "id": a.id }))
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrustArgs {
    pub id: String,
    pub trusted: bool,
}

/// `plugins.trust` (ADR-0048): a plugin of yours trusted (its own process with your environment) or back to
/// untrusted; it reloads, and is on again if it was.
pub async fn trust(ctx: &Ctx, a: &TrustArgs) -> Result<serde_json::Value> {
    if !a.id.starts_with("user.") {
        return Err(WireError::invalid("Only a plugin you installed has a trust to change."));
    }
    let home = ctx.service::<wisp_kernel::services::Paths>()?;
    let dir = home.join("plugins").join(slug(&a.id));
    let text = tokio::fs::read_to_string(dir.join(MANIFEST)).await.map_err(|_| WireError::not_found(format!("{} isn't installed.", a.id)))?;
    let was_on = ctx.plugins()?.iter().any(|p| p.id == a.id && p.state != "off");
    if a.trusted {
        tokio::fs::write(dir.join(TRUSTED), b"").await.map_err(|e| WireError::internal(e.to_string()))?;
    } else {
        let _ = tokio::fs::remove_file(dir.join(TRUSTED)).await;
    }
    ctx.uninstall_plugin(&a.id).await?;
    ctx.install_plugin(Arc::new(read(&dir, &text, a.trusted)?)).await?;
    if was_on {
        ctx.set_plugin_enabled(&a.id, true).await?;
    }
    Ok(serde_json::json!({ "id": a.id, "trusted": a.trusted }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The box says "~/code/my-plugin": that is a folder under your home, not a folder named `~` (it was refused as
    /// "has no wisp-plugin.json"). `~bob` and plain paths stay as typed.
    #[test]
    fn a_folder_typed_from_home_is_found_under_home() {
        let h = Path::new("/home/ada");
        assert_eq!(local_path("~/code/my-plugin", Some(h)), Path::new("/home/ada/code/my-plugin"));
        assert_eq!(local_path("~", Some(h)), Path::new("/home/ada"));
        assert_eq!(local_path("~bob/x", Some(h)), Path::new("~bob/x"));
        assert_eq!(local_path("/opt/p", Some(h)), Path::new("/opt/p"));
        assert_eq!(local_path("~/x", None), Path::new("~/x"));
    }
}
