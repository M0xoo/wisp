//! A checked spell as the plugin the kernel loads (wisp-kernel's `convert_spell`, plan §6.0.1). What a
//! spell does to tasks (prompt rules, hooks) depends on its `when` scope, which a manifest can't say,
//! so wisp.plugins applies those itself and leaves them out of the manifest the kernel gets.
use serde_json::Value;
use wisp_kernel::Manifest;
use wisp_kernel::spell::convert_spell;

const APPLIED_HERE: &[&str] = &["runtime.prompt", "runtime.hooks"];

/// The manifest for a spell, or why it has none (each problem with its path).
pub fn spell_manifest(spell: &Value) -> Result<(Manifest, Vec<String>), String> {
    let c = convert_spell(spell).map_err(|errs| errs.iter().map(|e| format!("{}: {}", e.path, e.message)).collect::<Vec<_>>().join("; "))?;
    let mut m = c.manifest;
    for k in APPLIED_HERE {
        m.contributes.remove(*k);
    }
    Ok((m, c.warnings))
}
