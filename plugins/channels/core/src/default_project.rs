//! The project a channel message that names none runs in (v1 remote.js `defaultProject`): the one picked in
//! the channels' settings (`channels.project`), else the last used, else the first. Pure: the hub hands in the
//! projects, the setting and the tasks (the runtime's list) and gets one back.

use wisp_channels_api::{ProjectView, SessionView};

/// The setting a channel's default project is picked with ('' or unset: the last used).
pub const SETTING: &str = "channels.project";

/// A project's folder as one string, as the list reads it (`@wisp/shell` `projectList`): `wisp add .` kept
/// "/repo/." and a trailing "/", which then held none of its tasks.
fn root(path: &str) -> &str {
    let mut r = path;
    loop {
        let t = r.strip_suffix("/.").unwrap_or(r).trim_end_matches('/');
        if t == r {
            return r;
        }
        r = t;
    }
}

/// The project a folder is in (v1 `projectFor`): the one whose path holds it, the deepest when they nest.
pub fn project_of<'a>(cwd: &str, projects: &'a [ProjectView]) -> Option<&'a ProjectView> {
    projects
        .iter()
        .filter(|p| {
            let root = root(&p.path);
            !root.is_empty() && (cwd == root || cwd.strip_prefix(root).is_some_and(|rest| rest.starts_with('/')))
        })
        .max_by_key(|p| root(&p.path).len())
}

/// Each project's `last_used_at`: when its newest task started (v1 kept `lastUsedAt` on the project; v2 derives
/// it from the runtime's tasks, so there is nothing more to keep). A project with no task keeps what it had.
pub fn with_last_used(mut projects: Vec<ProjectView>, tasks: &[SessionView]) -> Vec<ProjectView> {
    let mut last: Vec<Option<i64>> = vec![None; projects.len()];
    for t in tasks {
        let (Some(cwd), Some(at)) = (t.cwd.as_deref(), t.created_at) else { continue };
        if let Some(i) = project_of(cwd, &projects).and_then(|p| projects.iter().position(|q| q.id == p.id)) {
            last[i] = Some(last[i].map_or(at, |had| had.max(at)));
        }
    }
    for (p, at) in projects.iter_mut().zip(last) {
        if at.is_some() {
            p.last_used_at = at;
        }
    }
    projects
}

/// v1's order exactly: the picked project if it still exists (a deleted one falls through), else the most
/// recently used or added (`lastUsedAt || addedAt`, the first on a tie), else none.
pub fn default_project(projects: &[ProjectView], picked: Option<&str>) -> Option<ProjectView> {
    if let Some(p) = picked.filter(|id| !id.is_empty()).and_then(|id| projects.iter().find(|p| p.id == id)) {
        return Some(p.clone());
    }
    projects.iter().min_by_key(|p| std::cmp::Reverse(p.last_used_at.or(p.added_at).unwrap_or(0))).cloned()
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn p(id: &str, path: &str) -> ProjectView {
        ProjectView { id: id.into(), name: id.into(), path: path.into(), ..ProjectView::default() }
    }
    fn task(cwd: &str, at: i64) -> SessionView {
        SessionView { cwd: Some(cwd.into()), created_at: Some(at), ..SessionView::default() }
    }

    /// v1 test/channel-legacy.test.js 'findProject, mask and defaultProject', on v2's names.
    #[test]
    fn the_picked_project_then_the_last_used_then_the_first() {
        let ps = vec![p("api", "/w/api"), p("web", "/w/web"), p("docs", "/w/docs")];
        assert_eq!(default_project(&ps, None).unwrap().id, "api", "no task yet: the first");
        let used = with_last_used(ps, &[task("/w/web", 9), task("/w/api", 5), task("/elsewhere", 99)]);
        assert_eq!(default_project(&used, None).unwrap().id, "web", "the most recently used");
        assert_eq!(default_project(&used, Some("")).unwrap().id, "web", "'' is Last used");
        assert_eq!(default_project(&used, Some("docs")).unwrap().id, "docs", "the picked one, even never used");
        assert_eq!(default_project(&used, Some("gone")).unwrap().id, "web", "a deleted pick falls through to the last used");
        assert_eq!(default_project(&[], Some("docs")), None, "no projects: none");
    }

    #[test]
    fn a_task_counts_for_the_deepest_project_that_holds_its_folder() {
        let ps = vec![p("mono", "/w/mono/"), p("ui", "/w/mono/ui"), p("monolith", "/w/monolith")];
        assert_eq!(project_of("/w/mono/ui/src", &ps).unwrap().id, "ui");
        assert_eq!(project_of("/w/mono", &ps).unwrap().id, "mono", "a trailing / on the project's path");
        assert_eq!(project_of("/w/monolith/x", &ps).unwrap().id, "monolith", "a prefix of the name isn't inside");
        assert_eq!(project_of("/w", &ps), None);
        let added_dot = [p("repo", "/w/repo/./")];
        assert_eq!(project_of("/w/repo", &added_dot).unwrap().id, "repo", "`wisp add .` kept /repo/.");
        let used = with_last_used(ps, &[task("/w/mono/ui/src", 7), task("/w/monolith", 3), task("/w/mono/ui", 4)]);
        assert_eq!(
            used.iter().map(|p| p.last_used_at).collect::<Vec<_>>(),
            [None, Some(7), Some(3)],
            "its newest task, not its latest-listed"
        );
        assert_eq!(default_project(&used, None).unwrap().id, "ui");
    }
}
