//! `issues.projects@1`: the issue picker's view of the declared projects.

use serde_json::Value;

use super::project::ProjectSpec;

/// `issues.projects@1` from the declared projects: a project by its name (the picker's id), its folder here.
/// A project declares no repo of its own: issues reads it from the folder's origin.
pub struct IssueProjects(pub std::sync::Arc<wisp_resources_api::StoredKind>);

/// The issue picker's view of a project named `id`.
pub fn issue_project(projects: &[(String, Value)], id: &str) -> Option<wisp_issues_api::ProjectRef> {
    let (name, v) = projects.iter().find(|(n, _)| n == id)?;
    let p = serde_json::from_value::<ProjectSpec>(v.clone()).ok()?;
    Some(wisp_issues_api::ProjectRef { id: name.clone(), name: name.clone(), repo: String::new(), dir: (!p.path.is_empty()).then_some(p.path) })
}

impl wisp_issues_api::Projects for IssueProjects {
    fn project(&self, _call: &wisp_kernel::Call, id: &str) -> wisp_kernel::BoxFuture<'static, wisp_kernel::Result<Option<wisp_issues_api::ProjectRef>>> {
        let (kind, id) = (self.0.clone(), id.to_owned());
        Box::pin(async move {
            let list = kind.specs().await.unwrap_or_default();
            Ok(issue_project(&list, &id))
        })
    }
}

#[cfg(test)]
mod issue_tests {
    use super::*;

    #[test]
    fn the_issue_picker_finds_a_declared_project_by_name() {
        let list = vec![("api".to_owned(), serde_json::json!({ "path": "/work/api" })), ("bare".to_owned(), serde_json::json!({ "path": "" }))];
        let p = issue_project(&list, "api").unwrap();
        assert_eq!((p.id.as_str(), p.dir.as_deref()), ("api", Some("/work/api")));
        assert_eq!(issue_project(&list, "bare").unwrap().dir, None, "no folder here");
        assert!(issue_project(&list, "web").is_none());
    }
}
