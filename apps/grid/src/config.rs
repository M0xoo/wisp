//! wisp Grid's settings: grid.json in the data folder, then `GRID_*` environment variables, then what
//! the command line passes. Secrets never sit in grid.json itself: a provider's client secret is a file
//! (`clientSecretFile`, mode 0600) or an env var, and `*_FILE` env vars point at files (Docker and
//! systemd credentials), so they stay out of `ps` and env dumps.
//!
//! Read once at start (blocking fs is fine here: nothing is serving yet).
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::error::{GridError, Result};

mod check;
use check::{resolve_providers, validate_auth, validate_channels, validate_hostd};

/// Handles nobody may take: they name the grid's own addresses.
pub const RESERVED: &[&str] = &[
    "www", "api", "app", "admin", "auth", "grid", "mail", "static", "status", "docs", "help",
    "root", "wisp", "edge", "login", "signin",
];

pub type Env = HashMap<String, String>;

/// The process environment, as a map (tests pass their own).
pub fn process_env() -> Env {
    std::env::vars().collect()
}

mod sections;
pub use sections::*;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Listen {
    pub host: String,
    pub port: u16,
}

/// grid.json as written: what `load` reads and `write` keeps.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GridFile {
    pub domain: String,
    pub scheme: String,
    pub listen: Listen,
    pub public_port: Option<u16>,
    pub name: String,
    pub auth: AuthConfig,
    pub hostd: HostdConfig,
    pub session_days: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub telemetry: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channels: Option<ChannelsConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mail: Option<MailConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sites: Option<FeatureConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shares: Option<FeatureConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandboxes: Option<FeatureConfig>,
}

/// The settings in force: grid.json, the environment and the command line, checked.
#[derive(Debug, Clone, PartialEq)]
pub struct GridConfig {
    pub file_cfg: GridFile,
    pub data_dir: PathBuf,
    pub file: PathBuf,
    pub port_suffix: String,
    pub public_url: String,
    pub secure: bool,
}

impl std::ops::Deref for GridConfig {
    type Target = GridFile;
    fn deref(&self) -> &GridFile {
        &self.file_cfg
    }
}

impl std::ops::DerefMut for GridConfig {
    fn deref_mut(&mut self) -> &mut GridFile {
        &mut self.file_cfg
    }
}

impl GridConfig {
    /// `<scheme>://<label>.<domain><port>`: a user's wisp, a computer, a preview, a site.
    pub fn instance_url(&self, label: &str) -> String {
        format!(
            "{}://{label}.{}{}",
            self.scheme, self.domain, self.port_suffix
        )
    }

    /// Whether channels (the inbox) are on.
    pub fn channels_on(&self) -> bool {
        self.channels
            .as_ref()
            .and_then(|c| c.enabled)
            .unwrap_or(false)
    }

    /// Whether the container driver runs the boxes.
    pub fn containers(&self) -> bool {
        self.hostd.driver == "container"
    }

    /// Previews in boxes (`p<port>--<handle>`): on by default for containers.
    pub fn previews(&self) -> bool {
        self.hostd.previews.unwrap_or_else(|| self.containers())
    }
}

fn defaults() -> Value {
    json!({
        "domain": "wisp.localhost",
        "scheme": "http",
        "listen": { "host": "127.0.0.1", "port": 8080 },
        // the port in public URLs; null: the listen port for http, none for https
        "publicPort": null,
        "name": "wisp Grid",
        // seats: how maxUsers "auto" grows (accounts), and how long a waitlist seat is held.
        "auth": {
            "dev": false, "providers": {}, "signup": "open",
            "allow": { "emails": [], "domains": [], "githubOrgs": [], "accounts": [] },
            "admins": [],
            "seats": { "min": 5, "cap": 20, "target": 0.7, "everyHours": 24, "holdDays": 7 }
        },
        "hostd": { "driver": "process", "idleMs": 120_000, "checkMs": 5_000, "startMs": 45_000, "maxRunning": 50, "env": {}, "path": "" },
        "sessionDays": 30
    })
}

/// Deep merge of plain objects; arrays and everything else in `b` replace `a`'s.
pub fn merge(a: &Value, b: &Value) -> Value {
    let (Value::Object(ao), Value::Object(bo)) = (a, b) else {
        return if b.is_object() { b.clone() } else { a.clone() };
    };
    let mut out = ao.clone();
    for (k, v) in bo {
        let merged = match (out.get(k), v) {
            (Some(av @ Value::Object(_)), Value::Object(_)) => merge(av, v),
            _ => v.clone(),
        };
        out.insert(k.clone(), merged);
    }
    Value::Object(out)
}

/// A secret from a value, a file, or an env var (VAR, then `VAR_FILE`).
pub fn read_secret(
    value: Option<&str>,
    file: Option<&Path>,
    env_name: Option<&str>,
    env: &Env,
) -> Result<String> {
    if let Some(v) = value.filter(|v| !v.is_empty()) {
        return Ok(v.to_owned());
    }
    if let Some(v) = env_name.and_then(|n| env.get(n)).filter(|v| !v.is_empty()) {
        return Ok(v.clone());
    }
    let from_env = env_name
        .and_then(|n| env.get(&format!("{n}_FILE")))
        .map(PathBuf::from);
    let Some(f) = file.map(Path::to_path_buf).or(from_env) else {
        return Ok(String::new());
    };
    std::fs::read_to_string(&f)
        .map(|s| s.trim().to_owned())
        .map_err(|e| GridError::Config(format!("Can’t read the secret file {}: {e}", f.display())))
}

fn read_file(file: &Path) -> Result<Value> {
    match std::fs::read_to_string(file) {
        Ok(text) => serde_json::from_str(&text)
            .map_err(|e| GridError::Config(format!("grid.json isn’t valid JSON: {e}"))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(e.into()),
    }
}

fn from_env(env: &Env) -> Value {
    let mut out = Map::new();
    if let Some(d) = env.get("GRID_DOMAIN") {
        out.insert("domain".into(), json!(d));
    }
    if let Some(s) = env.get("GRID_SCHEME") {
        out.insert("scheme".into(), json!(s));
    }
    let mut listen = Map::new();
    if let Some(p) = env.get("GRID_PORT").and_then(|p| p.parse::<u16>().ok()) {
        listen.insert("port".into(), json!(p));
    }
    if let Some(h) = env.get("GRID_HOST") {
        listen.insert("host".into(), json!(h));
    }
    if !listen.is_empty() {
        out.insert("listen".into(), Value::Object(listen));
    }
    // Providers from env: GRID_GITHUB_CLIENT_ID + GRID_GITHUB_CLIENT_SECRET(_FILE), same for GOOGLE.
    let mut providers = Map::new();
    for id in ["github", "google"] {
        let up = id.to_uppercase();
        if let Some(cid) = env.get(&format!("GRID_{up}_CLIENT_ID")) {
            providers.insert(
                id.into(),
                json!({ "clientId": cid, "clientSecretEnv": format!("GRID_{up}_CLIENT_SECRET") }),
            );
        }
    }
    if !providers.is_empty() {
        out.insert("auth".into(), json!({ "providers": providers }));
    }
    Value::Object(out)
}

/// What `load` is given.
#[derive(Debug, Default, Clone)]
pub struct LoadOptions {
    pub data_dir: Option<PathBuf>,
    pub overrides: Option<Value>,
    pub env: Option<Env>,
}

fn home() -> PathBuf {
    std::env::var_os("HOME").map_or_else(|| PathBuf::from("."), PathBuf::from)
}

fn absolute(p: &Path) -> PathBuf {
    if p.is_absolute() {
        return p.to_path_buf();
    }
    std::env::current_dir().map_or_else(|_| p.to_path_buf(), |c| c.join(p))
}

/// Read grid.json, the environment and the overrides, and check them.
pub fn load(opts: LoadOptions) -> Result<GridConfig> {
    let env = opts.env.unwrap_or_else(process_env);
    let dir = opts
        .data_dir
        .or_else(|| env.get("GRID_DATA").map(PathBuf::from))
        .unwrap_or_else(|| home().join(".wisp-grid"));
    let dir = absolute(&dir);
    let file = dir.join("grid.json");
    let merged = merge(
        &merge(&merge(&defaults(), &read_file(&file)?), &from_env(&env)),
        &opts.overrides.unwrap_or(Value::Null),
    );
    from_value(merged, dir, file, &env)
}

fn config_error(e: &serde_json::Error) -> GridError {
    let text = e.to_string();
    // serde's text for MaxUsers is already ours; anything else names the field that's wrong.
    GridError::Config(if text.starts_with("auth.") {
        text
    } else {
        format!("grid.json: {text}")
    })
}

/// Check a merged config value (`load` without the files).
#[allow(clippy::needless_pass_by_value)] // callers hand over the merged value and paths they built
pub fn from_value(merged: Value, dir: PathBuf, file: PathBuf, env: &Env) -> Result<GridConfig> {
    let mut f: GridFile = serde_json::from_value(merged).map_err(|e| config_error(&e))?;
    f.domain.to_lowercase().trim_matches('.').clone_into(&mut f.domain);
    if f.domain.is_empty()
        || !f
            .domain
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-')
    {
        return Err(GridError::Config(format!(
            "domain: \"{}\" isn’t a host name.",
            f.domain
        )));
    }
    if f.scheme != "http" && f.scheme != "https" {
        return Err(GridError::Config("scheme: http or https.".into()));
    }
    let port = f.public_port.or(if f.scheme == "http" {
        Some(f.listen.port)
    } else {
        None
    });
    let port_suffix = match port {
        Some(p)
            if (f.scheme != "http" || p != 80) && (f.scheme != "https" || p != 443) && p != 0 =>
        {
            format!(":{p}")
        }
        _ => String::new(),
    };
    let secure = f.scheme == "https";
    let public_url = format!("{}://{}{port_suffix}", f.scheme, f.domain);
    let mut cfg = GridConfig {
        file_cfg: f,
        data_dir: dir.clone(),
        file,
        port_suffix,
        public_url,
        secure,
    };
    resolve_providers(&mut cfg, &dir, env)?;
    validate_auth(&cfg)?;
    validate_hostd(&cfg)?;
    validate_channels(&mut cfg, &dir, env)?;
    Ok(cfg)
}

/// What `wisp grid init` writes. Secrets go next to it, in secrets/, never inside it: resolved
/// provider and mail secrets that came from a file or env var are left out.
pub fn write(cfg: &GridConfig) -> Result<()> {
    let mut f = cfg.file_cfg.clone();
    for p in f.auth.providers.values_mut() {
        if p.client_secret_file.is_some() || p.client_secret_env.is_some() {
            p.client_secret = None;
        }
    }
    if let Some(m) = f.mail.as_mut()
        && (m.outbound.secret_access_key_file.is_some()
            || m.outbound.secret_access_key_env.is_some())
    {
        m.outbound.secret_access_key = None;
    }
    std::fs::create_dir_all(&cfg.data_dir)?;
    std::fs::write(
        &cfg.file,
        format!("{}\n", serde_json::to_string_pretty(&f)?),
    )?;
    Ok(())
}

/// A config for tests: defaults plus `overrides`, in `dir`, with no environment.
#[allow(clippy::needless_pass_by_value)] // tests write `for_test(dir, json!({..}))`
pub fn for_test(dir: &Path, overrides: Value) -> Result<GridConfig> {
    from_value(
        merge(&defaults(), &overrides),
        dir.to_path_buf(),
        dir.join("grid.json"),
        &Env::new(),
    )
}

#[cfg(test)]
mod tests;
