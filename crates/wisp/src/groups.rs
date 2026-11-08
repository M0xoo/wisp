//! The product is a list (plan §6.3): the ONLY place wisp's features are named. Each group is plugin
//! names in order; a plugin is its host crate `wisp-<name>` (id `wisp.<name>`), compiled in behind the
//! cargo feature of the same name, so a build drops any plugin by leaving its feature out. A name whose
//! crate isn't in this build is skipped (and `wisp plugin` says so).
//!   `DefaultPlugins`   everything wisp ships: `wisp` on a laptop and the desktop app
//!   `BoxPlugins`       Default minus machines and update: a grid box (its proc is the grid's)
//!   `HeadlessPlugins`  runtime, the harnesses, git, mcp: CI, `wisp mcp`, servers
//!   `MinimalPlugins`   runtime, one harness: the smallest working wisp, and the base for tests
use std::path::PathBuf;

use wisp_kernel::PluginGroup;

/// What a plugin may need to be built: wisp's home and the user's.
#[derive(Debug, Clone)]
#[cfg_attr(not(feature = "worktrees"), allow(dead_code))]
pub struct Where {
    pub home: PathBuf,
    pub user_home: PathBuf,
}

pub const DEFAULT: [&str; 40] = [
    "settings", "runtime", "claude", "codex", "cursor", "opencode", "copilot", "grok", "antigravity", "accounts", "git", "worktrees", "ship", "review", "issues", "terminal", "lsp", "machine", "machines", "grid-client", "crew", "goal", "later", "budget", "router", "automations", "learn", "channels", "telegram", "slack", "discord", "github", "email", "ntfy", "mcp", "connectors", "stuff", "plugins", "telemetry", "update",
];
pub const BOX_OFF: [&str; 2] = ["machines", "update"];
pub const HEADLESS: [&str; 12] = ["settings", "runtime", "claude", "codex", "cursor", "opencode", "copilot", "grok", "antigravity", "git", "worktrees", "mcp"];
pub const MINIMAL: [&str; 3] = ["settings", "runtime", "claude"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Group {
    Default,
    Box,
    Headless,
    Minimal,
}

impl Group {
    /// `WISP_PLUGINS=default|box|headless|minimal` (a box defaults to `box`).
    pub fn named(name: &str) -> Option<Self> {
        match name {
            "default" => Some(Self::Default),
            "box" => Some(Self::Box),
            "headless" => Some(Self::Headless),
            "minimal" => Some(Self::Minimal),
            _ => None,
        }
    }

    pub fn names(self) -> Vec<&'static str> {
        let mut seen: Vec<&'static str> = Vec::new();
        let all: Vec<&'static str> = match self {
            Self::Default => DEFAULT.to_vec(),
            Self::Box => DEFAULT.iter().copied().filter(|n| !BOX_OFF.contains(n)).collect(),
            Self::Headless => HEADLESS.to_vec(),
            Self::Minimal => MINIMAL.to_vec(),
        };
        for n in all {
            if !seen.contains(&n) {
                seen.push(n);
            }
        }
        seen
    }

    /// The group with every plugin of it this build has.
    pub fn build(self, at: &Where) -> PluginGroup {
        self.names().into_iter().fold(PluginGroup::new(), |g, n| add(g, n, at))
    }
}

/// Adds plugin `name` if its crate is in this build.
#[allow(unused_variables)]
fn add(g: PluginGroup, name: &str, at: &Where) -> PluginGroup {
    match name {
        #[cfg(feature = "git")]
        "git" => g.add(wisp_git::GitPlugin::default()),
        #[cfg(feature = "worktrees")]
        "worktrees" => g.add(wisp_worktrees::WorktreesPlugin::new(at.home.display().to_string(), at.user_home.display().to_string())),
        #[cfg(feature = "ship")]
        "ship" => g.add(wisp_ship::ShipPlugin::default()),
        #[cfg(feature = "review")]
        "review" => g.add(wisp_review::ReviewPlugin::default()),
        #[cfg(feature = "issues")]
        "issues" => g.add(wisp_issues::IssuesPlugin),
        #[cfg(feature = "machine")]
        "machine" => g.add(wisp_machine::MachinePlugin),
        _ => g,
    }
}

/// The names of a group this build compiled in.
pub fn compiled(group: Group) -> Vec<&'static str> {
    group.names().into_iter().filter(|n| in_build(n)).collect()
}

pub fn in_build(name: &str) -> bool {
    match name {
        "git" => cfg!(feature = "git"),
        "worktrees" => cfg!(feature = "worktrees"),
        "ship" => cfg!(feature = "ship"),
        "review" => cfg!(feature = "review"),
        "issues" => cfg!(feature = "issues"),
        "machine" => cfg!(feature = "machine"),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HARNESSES: [&str; 7] = ["claude", "codex", "cursor", "opencode", "copilot", "grok", "antigravity"];

    #[test]
    fn groups_are_what_the_plan_says() {
        let d = Group::Default.names();
        assert!(d.iter().all(|n| d.iter().filter(|m| *m == n).count() == 1), "no plugin twice");
        let b = Group::Box.names();
        assert!(!b.contains(&"machines") && !b.contains(&"update") && b.contains(&"runtime"));
        assert!(HARNESSES.iter().all(|h| Group::Headless.names().contains(h)));
        assert_eq!(Group::Minimal.names(), ["settings", "runtime", "claude"]);
        for g in [Group::Box, Group::Headless, Group::Minimal] {
            assert!(g.names().iter().all(|n| d.contains(n)), "every group is part of Default");
        }
        assert!(compiled(Group::Default).iter().all(|n| in_build(n)));
    }
}
