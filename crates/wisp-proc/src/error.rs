//! wisp-proc's one error enum, mapped to the wire's `{code, message, retry}` at the edge.

#[derive(Debug, thiserror::Error)]
pub enum ProcError {
    /// v1: spawn's ENOENT, reported, never thrown
    #[error("{0}: not found")]
    NotFound(String),
    #[error("no such folder: {0}")]
    NoFolder(String),
    #[error("couldn't start {bin}: {message}")]
    Spawn { bin: String, message: String },
    #[error("the process has exited")]
    Exited,
    #[error("its input is closed")]
    StdinClosed,
    #[error("{0} is not supported here")]
    Unsupported(&'static str),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

impl ProcError {
    pub(crate) fn spawn(bin: &str, e: impl std::fmt::Display) -> Self {
        Self::Spawn { bin: bin.to_owned(), message: e.to_string() }
    }

    /// A std spawn error: a missing program is `NotFound`, the rest say what happened.
    pub(crate) fn from_spawn(bin: &str, e: &std::io::Error) -> Self {
        if e.kind() == std::io::ErrorKind::NotFound { Self::NotFound(bin.to_owned()) } else { Self::spawn(bin, e) }
    }
}

#[cfg(feature = "wire")]
impl From<ProcError> for wisp_kernel::WireError {
    fn from(e: ProcError) -> Self {
        use wisp_kernel::WireError;
        let message = e.to_string();
        match e {
            ProcError::NotFound(_) | ProcError::NoFolder(_) => WireError::not_found(message),
            ProcError::Exited | ProcError::StdinClosed => WireError::conflict(message),
            ProcError::Unsupported(_) => WireError::invalid(message),
            ProcError::Spawn { .. } | ProcError::Io(_) => WireError::internal(message),
        }
    }
}

pub type Result<T, E = ProcError> = std::result::Result<T, E>;
