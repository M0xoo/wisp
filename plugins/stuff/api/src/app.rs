//! `wisp-app.json`: what a My Stuff app (a folder of static files an agent built) says about itself.
//! `{ "name", "description", "entry", "uses", "db", "was" }`, every field optional. Parsing is
//! lenient like v1 (an unreadable file is `{}`), but a `uses` or `db` that can't be honoured is an
//! error the agent is told, so it can fix it.

use serde_json::Value;

use crate::pane::{PANE_USES, is_scope};

/// An app's database (v1 app-db.js `dbSpec`): its seed file inside the app, or `""` for none.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
pub struct DbSpec {
    pub seed: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AppManifest {
    pub name: Option<String>,
    pub description: Option<String>,
    /// the page it opens on, `index.html` unless it says otherwise (leading `/` dropped)
    pub entry: String,
    pub uses: Vec<String>,
    /// the raw `db` field: decided with `db_spec` once the folder is known
    pub db: Value,
    /// a starter's earlier folder hashes, oldest first
    pub was: Vec<String>,
}

fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn text(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

impl AppManifest {
    /// Parses the file's text; anything that isn't a JSON object reads as `{}` (v1 did the same).
    pub fn parse(json: &str) -> Result<Self, String> {
        let v: Value = serde_json::from_str(json).unwrap_or(Value::Null);
        Self::from_value(&v)
    }

    pub fn from_value(v: &Value) -> Result<Self, String> {
        let entry = v.get("entry").filter(|e| truthy(e)).map_or_else(
            || "index.html".to_owned(),
            |e| match e {
                Value::String(s) => s.trim_start_matches('/').to_owned(),
                other => other.to_string().trim_start_matches('/').to_owned(),
            },
        );
        let was = v
            .get("was")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        Ok(Self {
            name: text(v.get("name")),
            description: text(v.get("description")),
            entry,
            uses: uses_of(v)?,
            db: v.get("db").cloned().unwrap_or(Value::Null),
            was,
        })
    }

    /// What `db` asks for, given whether a file exists in the app's folder.
    pub fn db_spec(&self, exists: impl Fn(&str) -> bool) -> Result<Option<DbSpec>, String> {
        db_spec(&self.db, exists)
    }
}

/// wisp-app.json's `uses`: a clean list (deduped, in order), or an error for a scope wisp doesn't know.
pub fn uses_of(manifest: &Value) -> Result<Vec<String>, String> {
    let u = match manifest.get("uses") {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Array(a)) => a,
        Some(_) => {
            return Err("\"uses\" in wisp-app.json is a list, like [\"tasks:read\"].".into());
        }
    };
    let mut out: Vec<String> = Vec::new();
    for x in u {
        let Some(s) = x.as_str().filter(|s| is_scope(s)) else {
            let known: Vec<&str> = PANE_USES.iter().map(|(k, _)| *k).collect();
            return Err(format!(
                "\"uses\" in wisp-app.json: {x} isn't something an app can use ({}).",
                known.join(", ")
            ));
        };
        if !out.iter().any(|o| o == s) {
            out.push(s.to_owned());
        }
    }
    Ok(out)
}

/// What `db` asks for: None (off), or the seed (a file in the app, or none).
pub fn db_spec(d: &Value, exists: impl Fn(&str) -> bool) -> Result<Option<DbSpec>, String> {
    if !truthy(d) {
        return Ok(None);
    }
    if let Value::String(s) = d {
        return bundle_path(s.trim_start_matches('/'))
            .map(|seed| Some(DbSpec { seed }))
            .ok_or_else(|| {
                "\"db\" in wisp-app.json names its seed file inside the app, like \"seed.sql\"."
                    .into()
            });
    }
    Ok(Some(DbSpec {
        seed: if exists("seed.sql") {
            "seed.sql".into()
        } else {
            String::new()
        },
    }))
}

/// A relative path inside an app: forward slashes, no `.`/`..`/empty segments, no control
/// characters or backslashes, at most 400 bytes. None when it isn't one.
pub fn bundle_path(p: &str) -> Option<String> {
    if p.is_empty()
        || p.len() > 400
        || p.starts_with('/')
        || p.chars().any(|c| c == '\\' || (c as u32) < 0x20)
    {
        return None;
    }
    p.split('/')
        .all(|x| !x.is_empty() && x != "." && x != "..")
        .then(|| p.to_owned())
}

fn is_env(name: &str) -> bool {
    name == ".env" || name.strip_prefix(".env.").is_some()
}

fn ext_in(name: &str, list: &[&str]) -> bool {
    name.rsplit_once('.')
        .is_some_and(|(_, e)| list.contains(&e))
}

/// v1 bundle.js PRIVATE: a file name that holds secrets (or hands out the source, like a `.map`).
fn private_name(n: &str) -> bool {
    let stem_ext = |prefix: &str, exts: &[&str]| {
        n.strip_prefix(prefix)
            .is_some_and(|r| r.is_empty() || r.strip_prefix('.').is_some_and(|e| exts.contains(&e)))
    };
    is_env(n)
        || n.ends_with(".env")
        || n == ".envrc"
        || stem_ext(
            "credentials",
            &["json", "yaml", "yml", "toml", "ini", "txt", "csv", "xml"],
        )
        || stem_ext(
            ".credentials",
            &["json", "yaml", "yml", "toml", "ini", "txt", "csv", "xml"],
        )
        || (n.starts_with("client_secret") && n.ends_with(".json"))
        || (["serviceaccount", "service-account", "service_account"]
            .iter()
            .any(|p| n.starts_with(p))
            && n.ends_with(".json"))
        || ["secret", "secrets"].iter().any(|s| {
            n.strip_prefix(s)
                .is_some_and(|r| [".json", ".yaml", ".yml", ".toml"].contains(&r))
        })
        || [
            ".npmrc",
            ".netrc",
            ".pgpass",
            ".pypirc",
            ".htpasswd",
            ".git-credentials",
            ".dockercfg",
        ]
        .contains(&n)
        || ext_in(n, &["pem", "key", "p12", "pfx", "jks", "keystore", "ppk"])
        || ["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"].contains(&n)
        || n.ends_with(".map")
}

/// What never goes in an app, saved or published: files that hold secrets, and source maps. One list
/// for My Stuff, Publish and the grid (v1 bundle.js `privateFile`). Case-insensitive.
pub fn private_file(rel: &str) -> bool {
    let lower = rel.to_lowercase();
    let mut segs: Vec<&str> = lower.split(['/', '\\']).collect();
    let name = segs.pop().unwrap_or_default();
    private_name(name) || segs.iter().any(|d| is_env(d))
}

/// May a visitor of a published app open this file? Nothing private and no dotfile, but a top-level
/// `.well-known`.
pub fn public_file(rel: &str) -> bool {
    let lower = rel.to_lowercase();
    !private_file(rel)
        && lower
            .split(['/', '\\'])
            .enumerate()
            .all(|(i, s)| !s.starts_with('.') || (i == 0 && s == ".well-known"))
}
