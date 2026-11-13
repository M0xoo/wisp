//! wisp.runtime's other resource kinds (ADR-0028): projects, harnesses, teams and skills, kept as declared
//! (`StoredKind`) and acted on when a task starts (`specs::prepare`):
//! - a **project** whose path holds the task's folder gives its agent (when the task names none), its
//!   worktree default, runs its setup commands first, and its instructions go in the system prompt;
//! - a **harness** that is off refuses the task; its model and effort fill what the task left out;
//! - a **team** the task names becomes its subagents;
//! - the **skills** its agent profile names go in the system prompt.
//!
//! One module per kind; this one holds the stored kinds and registers them.

mod brief;
mod harness;
mod issues;
mod project;
mod team;

use wisp_kernel::Setup;
use wisp_resources_api::{KindInfo, stored, stored_published_tidied};

pub use brief::Brief;
pub use harness::{HarnessSpec, declared};
pub use issues::IssueProjects;
pub use project::{ProjectSpec, project_for, with_test};
pub use team::{SkillSpec, TeamSpec};

/// The stored kinds, for `prepare` to read.
#[derive(Debug)]
pub struct Kinds {
    pub project: std::sync::Arc<wisp_resources_api::StoredKind>,
    pub harness: std::sync::Arc<wisp_resources_api::StoredKind>,
    pub skill: std::sync::Arc<wisp_resources_api::StoredKind>,
    pub team: std::sync::Arc<wisp_resources_api::StoredKind>,
}

pub fn register(s: &mut Setup) -> std::sync::Arc<Kinds> {
    let owner = "wisp.runtime";
    std::sync::Arc::new(Kinds {
        // every screen shows projects (chips, New task's "in", Home): published as `project` on `config`
        // its path canonical whoever applies it (`wisp add .` sent "/repo/.", a pasted "C:\\x\\" or "\\\\?\\C:\\x")
        project: stored_published_tidied::<ProjectSpec>(s, "project", |sc| KindInfo::new("project", "projects", owner, sc).order(10), project::tidy_project),
        harness: harness::harness_kind(s),
        skill: stored::<SkillSpec>(s, |sc| KindInfo::new("skill", "skills", owner, sc).order(15)),
        team: stored::<TeamSpec>(s, |sc| KindInfo::new("team", "teams", owner, sc).order(25)),
    })
}
