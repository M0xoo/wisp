//! Lean Claude Code runs (v1 server/lean.js, setting `runtime.leanRuns`): no telemetry, error reporting
//! or update checks, 5 connections at start instead of 12. It also turns the claude.ai connectors and
//! every server-rolled feature off, so by default ('on') it is only for wisp's own side runs (judges,
//! the scout, review, the retro); 'all' makes every Claude run lean, 'off' none. A task's own `lean`
//! ('on' | 'off') wins for that task's runs.

/// The env a lean run gets.
pub const LEAN_ENV: [(&str, &str); 1] = [("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1")];
pub const LEAN_VALUES: [&str; 3] = ["off", "on", "all"];

/// The setting as one of its values; anything else reads as the default, 'on'.
fn mode(setting: Option<&str>) -> &str {
    setting.filter(|s| LEAN_VALUES.contains(s)).unwrap_or("on")
}

/// A side run wisp makes for itself: lean unless the setting is off.
pub fn lean_on(setting: Option<&str>) -> bool {
    mode(setting) != "off"
}

/// A task's run: lean only when the task asked for it (`task`: its own 'on' | 'off') or the setting is 'all'.
pub fn lean_task(task: Option<&str>, setting: Option<&str>) -> bool {
    match task {
        Some("on") => true,
        Some("off") => false,
        _ => mode(setting) == "all",
    }
}
