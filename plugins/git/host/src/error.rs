//! wisp-git's one error enum, mapped to `WireError` at the boundary.

use wisp_kernel::{Code, WireError};

#[derive(Debug, thiserror::Error)]
pub enum GitError {
    #[error("git isn’t installed here ({0})")]
    NotInstalled(String),
    #[error("no such folder: {0}")]
    NoFolder(String),
    #[error("{0} isn’t in a git repo")]
    NotARepo(String),
    #[error("{why}")]
    Failed { code: Option<i32>, why: String },
    #[error("git took too long and was stopped")]
    TimedOut,
    #[error("couldn’t start git: {0}")]
    Spawn(String),
    #[error("{0}")]
    Refused(String),
    #[error("{0}")]
    Stale(String),
    #[error("{0}")]
    Io(String),
}

impl From<std::io::Error> for GitError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e.to_string())
    }
}

impl From<GitError> for WireError {
    fn from(e: GitError) -> Self {
        let message = e.to_string();
        match e {
            GitError::NotInstalled(_) => WireError::unavailable(message),
            GitError::NoFolder(_) | GitError::NotARepo(_) => WireError::not_found(message),
            GitError::Failed { .. } | GitError::Stale(_) => WireError::conflict(message),
            GitError::Refused(_) => WireError::invalid(message),
            GitError::TimedOut => WireError::new(Code::Timeout, message),
            GitError::Spawn(_) | GitError::Io(_) => WireError::internal(message),
        }
    }
}

pub type Result<T, E = GitError> = std::result::Result<T, E>;
