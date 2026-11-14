//! wisp-terminal-core's one error enum: v1's refusals, word for word, mapped to the wire's
//! `{code, message}` (and so to v1's HTTP statuses) at the edge.

use wisp_kernel::WireError;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TerminalError {
    #[error("no such session")]
    NoSession,
    #[error("This task has no terminal open.")]
    NoTerminal,
    #[error("The shell has ended.")]
    ShellEnded,
    #[error("A shell inside wisp needs macOS or Linux on the computer the task runs on.")]
    NoPty,
    #[error("Taking over inside wisp needs macOS or Linux on the computer the task runs on. Pick a terminal app in Settings → General.")]
    NoPtyTakeover,
    #[error("There’s no terminal app on the computer this task runs on: use the one in the panel.")]
    NoApp,
    #[error("In wisp: the page opens the terminal, not a terminal app.")]
    InWisp,
    #[error("{0}")]
    NoCustom(&'static str),
    #[error("{}", wisp_terminal_api::BUSY_MESSAGE)]
    Busy,
}

impl TerminalError {
    /// v1's HTTP status for it.
    pub fn status(&self) -> u16 {
        WireError::from(self.clone()).status()
    }
}

impl From<TerminalError> for WireError {
    fn from(e: TerminalError) -> Self {
        let m = e.to_string();
        match e {
            TerminalError::NoSession | TerminalError::NoTerminal | TerminalError::ShellEnded => WireError::not_found(m),
            TerminalError::NoPty | TerminalError::NoPtyTakeover | TerminalError::InWisp | TerminalError::NoCustom(_) => {
                WireError::invalid(m)
            }
            TerminalError::NoApp | TerminalError::Busy => WireError::conflict(m),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statuses_are_v1s() {
        assert_eq!([TerminalError::NoSession, TerminalError::NoTerminal, TerminalError::ShellEnded].map(|e| e.status()), [404; 3]);
        assert_eq!((TerminalError::NoPty.status(), TerminalError::NoApp.status(), TerminalError::Busy.status()), (400, 409, 409));
    }
}
