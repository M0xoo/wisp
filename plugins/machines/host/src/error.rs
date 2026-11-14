//! wisp.machines' one error enum, mapped to `WireError {code, message, retry}` at the edge.
use wisp_kernel::{Code, WireError};
use wisp_machines_api::{TransportFailure, peer_error};

#[derive(Debug, thiserror::Error)]
pub enum MachinesError {
    #[error("No such machine.")]
    NoPeer,
    #[error("No transport named {0} is installed.")]
    NoTransport(String),
    #[error("{0}")]
    Invalid(String),
    /// the peer can't take requests now (offline, connecting)
    #[error("{0}")]
    Offline(String),
    /// a command routed there wasn't answered in time; it stays queued with its key
    #[error("{0}")]
    Waiting(String),
    /// the peer answered with an error: its status and words
    #[error("{message}")]
    Peer { message: String, status: u16, hold: Option<serde_json::Value> },
    /// the peer refused a routed command
    #[error("{message}")]
    Rejected { code: String, message: String },
    #[error("{0}")]
    Transport(Box<TransportFailure>),
    #[error("{0}")]
    Store(#[from] wisp_store::StoreError),
    #[error("{0}")]
    Wire(WireError),
}

impl From<TransportFailure> for MachinesError {
    fn from(f: TransportFailure) -> Self {
        Self::Transport(Box::new(f))
    }
}

fn code_of(code: &str) -> Code {
    serde_json::from_value(serde_json::Value::String(code.to_owned())).unwrap_or(Code::Internal)
}

impl From<MachinesError> for WireError {
    fn from(e: MachinesError) -> Self {
        let msg = e.to_string();
        match e {
            MachinesError::NoPeer => WireError::not_found(msg),
            MachinesError::NoTransport(_) | MachinesError::Invalid(_) => WireError::invalid(msg),
            MachinesError::Offline(_) => peer_error(msg, 503, None),
            MachinesError::Waiting(_) => WireError { retry: true, ..WireError::new(Code::Unavailable, msg) },
            MachinesError::Peer { message, status, hold } => peer_error(message, status, hold),
            MachinesError::Rejected { code, message } => WireError::new(code_of(&code), message),
            MachinesError::Transport(f) => peer_error(f.message, f.status.unwrap_or(502), None),
            MachinesError::Store(e) => WireError::from(e),
            MachinesError::Wire(w) => w,
        }
    }
}

pub type Res<T> = std::result::Result<T, MachinesError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_map_to_wire_codes() {
        assert_eq!(WireError::from(MachinesError::NoPeer).code, Code::NotFound);
        assert_eq!(WireError::from(MachinesError::NoTransport("x".into())).code, Code::Invalid);
        let off = WireError::from(MachinesError::Offline("box is offline".into()));
        assert!(off.retry && off.code == Code::Unavailable);
        let w = WireError::from(MachinesError::Waiting("waiting for box to wake".into()));
        assert!(w.retry);
        let r = WireError::from(MachinesError::Rejected { code: "not_found".into(), message: "gone".into() });
        assert_eq!((r.code, r.message.as_str()), (Code::NotFound, "gone"));
        let t = WireError::from(MachinesError::from(TransportFailure { status: Some(400), ..TransportFailure::new("no") }));
        assert_eq!(t.code, Code::Invalid);
    }
}
