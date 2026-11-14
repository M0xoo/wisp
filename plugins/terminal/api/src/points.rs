//! `terminal.folder@1`: who knows where a task works. wisp.worktrees contributes it (a task's worktree,
//! brought back from its branch if an archive took it away); without a contributor a task works in its
//! session's cwd. The first contributor that answers wins.

use wisp_kernel::{BoxFuture, Point};
use wisp_runtime_api::Session;

use crate::model::TaskFolder;

pub trait FolderSource: Send + Sync + 'static {
    fn id(&self) -> &str;
    /// `None`: not this source's task (no worktree); the next one, then the session's cwd, answers.
    fn folder(&self, session: &Session) -> BoxFuture<'static, Option<TaskFolder>>;
}

pub const FOLDER: Point<dyn FolderSource> = Point::new("terminal.folder", 1);
