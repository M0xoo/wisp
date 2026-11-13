//! wisp-plugins-core: pure, sans-IO logic of wisp.plugins. What an agent writing an untrusted plugin (ADR-0048) reads
//! and runs: the reference made from the real types (`reference`), the check that validates a plugin without
//! installing it (`check`), a sample of a data source's answer (`sample`) and the plugins the user has in plain
//! words (`summary`). v1's spell data (`data/v1-*`, `examples.json`, `fields.json`) stays as the port's record.

pub mod check;
pub mod kit;
pub mod reference;
pub mod sample;
pub mod summary;

/// A module's path inside its plugin's folder, from `component` (`./ui.js#default`): relative, a `.js` file, no way
/// out. None: not one.
pub fn module_path(component: &str) -> Option<String> {
    let path = component.split('#').next().unwrap_or_default();
    let path = path.strip_prefix("./").unwrap_or(path);
    let p = std::path::Path::new(path);
    let ok = p.extension().is_some_and(|e| e == "js")
        && !path.starts_with('/')
        && !path.contains('\\')
        && p.components().all(|c| matches!(c, std::path::Component::Normal(_)));
    ok.then(|| path.to_owned())
}

/// `user.my-tool` → `my-tool`: the folder a plugin goes in.
pub fn slug(id: &str) -> String {
    id.trim_start_matches("user.").chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' }).collect()
}
