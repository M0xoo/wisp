//! A user's plugin folder: `~/.wisp/plugins/<folder>/wisp-plugin.json`, checked with the kernel's own
//! manifest checks plus the rules for plugins that don't ship with wisp, and described for Settings →
//! Plugins and the review dialog.
use serde_json::Value;
use wisp_kernel::Manifest;
use wisp_plugins_api::{Risk, SPELL_PREFIX, Trust};

use crate::check::Refused;

pub const MANIFEST: &str = "wisp-plugin.json";

fn refused(problems: Vec<String>) -> Refused {
    let n = problems.len();
    Refused { message: format!("This plugin has {n} problem{}:\n- {}", if n > 1 { "s" } else { "" }, problems.join("\n- ")), problems }
}

/// Why an exec command can't run from a plugin's folder: a bare program on PATH, or a path inside it.
fn exec_problem(server: &Value) -> Option<String> {
    let exec = server.get("exec")?;
    let Some(args) = exec.as_array().filter(|a| !a.is_empty() && a.iter().all(Value::is_string)) else {
        return Some("server.exec: a list of strings, the program first".into());
    };
    let bin = args[0].as_str().unwrap_or_default();
    let escapes = bin.starts_with('/') || bin.starts_with('\\') || bin.split(['/', '\\']).any(|s| s == "..") || bin.get(1..2) == Some(":");
    (bin.is_empty() || escapes).then(|| format!("server.exec: {bin} must be a program name or a path inside the plugin's folder"))
}

/// The manifest of a user plugin, checked, or every problem in one refusal.
pub fn check_user_manifest(raw: &Value) -> Result<Manifest, Refused> {
    let mut problems: Vec<String> = Manifest::check(raw).into_iter().map(|e| format!("{}: {}", if e.path.is_empty() { "(root)" } else { &e.path }, e.message)).collect();
    if problems.is_empty() {
        let id = raw.get("id").and_then(Value::as_str).unwrap_or_default();
        if id.starts_with("wisp.") {
            problems.push(format!("id: {id} is the name of a plugin that ships with wisp; pick your own prefix (acme.{})", &id[5..]));
        }
        if id.starts_with(SPELL_PREFIX) {
            problems.push(format!("id: {SPELL_PREFIX}… is where converted spells live; pick your own prefix"));
        }
        if let Some(server) = raw.get("server") {
            if server.get("builtin").is_some() {
                problems.push("server.builtin: only plugins that ship with wisp are built in; use server.exec".into());
            }
            problems.extend(exec_problem(server));
        }
    }
    if !problems.is_empty() {
        return Err(refused(problems));
    }
    Manifest::from_value(raw.clone()).map_err(|e| refused(vec![e.message]))
}

/// How much a manifest can do: code runs, permissions read, a manifest alone is safe.
pub fn manifest_risk(m: &Manifest) -> Risk {
    if m.server.is_some() {
        Risk::Runs
    } else if m.permissions.is_empty() {
        Risk::Safe
    } else {
        Risk::Reads
    }
}

/// Trust is the user's to give, never the manifest's: a plugin with code is untrusted until then.
pub fn manifest_trust(m: &Manifest, trusted_by_user: bool) -> Trust {
    if m.server.is_none() {
        Trust::Declarative
    } else if trusted_by_user {
        Trust::Trusted
    } else {
        Trust::Untrusted
    }
}

fn count(v: Option<&Value>) -> usize {
    match v {
        Some(Value::Array(a)) => a.len(),
        Some(Value::Object(o)) => o.len(),
        _ => 0,
    }
}

/// What a manifest does, in plain words.
pub fn manifest_lines(m: &Manifest) -> Vec<String> {
    let mut out: Vec<String> = m.description.iter().filter(|d| !d.is_empty()).cloned().collect();
    for (k, what) in [("ui", "Adds to the UI"), ("commands", "Commands"), ("partStyles", "Restyles parts"), ("setSettings", "Sets settings")] {
        let n = count(m.contributes.get(k));
        if n > 0 {
            out.push(format!("{what}: {n}"));
        }
    }
    if let Some(exec) = m.exec() {
        out.push(format!("Runs its own code: `{}`", exec.join(" ")));
    } else if m.server.is_some() {
        out.push("Runs its own code".into());
    }
    if !m.permissions.is_empty() {
        out.push(format!("Asks for {}", m.permissions.join(", ")));
    }
    out
}

/// A folder name for a manifest-only plugin installed from its JSON: its id, made safe.
pub fn folder_for(id: &str) -> String {
    id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '-' }).collect()
}
