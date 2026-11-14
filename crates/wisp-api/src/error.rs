//! The edge's one error enum (plan §9.2), mapped to the wire shape v1 clients read: `{error}` plus the
//! v2 `{code, message, retry}`, and v1's extras a client acts on (`hold`, `sandboxLogin`).
use serde_json::{Map, Value, json};
use wisp_kernel::{Code, WireError};

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("forbidden host")]
    ForbiddenHost,
    #[error("forbidden origin")]
    ForbiddenOrigin,
    /// a write from a page on another port of this computer: a pane or an app of My Stuff (F-stuff-8)
    #[error(
        "Refused: a page on another port of this computer (a pane or an app in My Stuff) can't start or send anything in wisp. A pane can only propose a prompt: wisp's page shows it on a card and you send it."
    )]
    PaneOrigin,
    #[error("json only")]
    JsonOnly,
    #[error("body too large")]
    TooLarge,
    #[error("invalid json")]
    InvalidJson,
    #[error("bad token")]
    BadToken,
    #[error("not found")]
    NotFound,
    #[error("{0}")]
    Wire(#[from] WireError),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("http: {0}")]
    Http(String),
}

impl ApiError {
    pub fn status(&self) -> u16 {
        match self {
            Self::ForbiddenHost | Self::ForbiddenOrigin | Self::PaneOrigin | Self::BadToken => 403,
            Self::JsonOnly => 415,
            Self::TooLarge => 413,
            Self::InvalidJson => 400,
            Self::NotFound => 404,
            Self::Wire(w) => w.status(),
            Self::Io(_) | Self::Http(_) => 500,
        }
    }

    pub fn to_wire(&self) -> WireError {
        let code = match self {
            Self::ForbiddenHost | Self::ForbiddenOrigin | Self::PaneOrigin | Self::BadToken => Code::Forbidden,
            Self::JsonOnly | Self::InvalidJson => Code::Invalid,
            Self::TooLarge => Code::TooLarge,
            Self::NotFound => Code::NotFound,
            Self::Wire(w) => return w.clone(),
            Self::Io(_) | Self::Http(_) => Code::Internal,
        };
        WireError::new(code, self.to_string())
    }

    /// A refusal (< 500) is an answer, never logged or reported as an error (v1 edge case 4).
    pub fn is_refusal(&self) -> bool {
        self.status() < 500
    }
}

/// The JSON body of an error answer.
pub fn error_body(e: &WireError) -> Value {
    let mut out = Map::new();
    out.insert("error".into(), json!(e.message));
    out.insert("code".into(), serde_json::to_value(e.code).unwrap_or(Value::Null));
    out.insert("message".into(), json!(e.message));
    out.insert("retry".into(), json!(e.retry));
    if let Some(d) = &e.details {
        // v1's extras stay top-level where v1 clients look for them (guard.js `hold`, /sandbox's login)
        if let Some(obj) = d.as_object() {
            for k in ["hold", "sandboxLogin"] {
                if let Some(v) = obj.get(k) {
                    out.insert(k.into(), v.clone());
                }
            }
        }
        out.insert("details".into(), d.clone());
    }
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extras_stay_top_level() {
        let e = WireError::conflict("near the limit").with_details(json!({"hold": {"window": "5h"}, "sandboxLogin": true}));
        let b = error_body(&e);
        assert_eq!(b["error"], "near the limit");
        assert_eq!(b["code"], "conflict");
        assert_eq!(b["hold"]["window"], "5h");
        assert_eq!(b["sandboxLogin"], true);
        assert_eq!(b["retry"], false);
    }

    #[test]
    fn statuses() {
        assert_eq!(ApiError::JsonOnly.status(), 415);
        assert_eq!(ApiError::TooLarge.status(), 413);
        assert_eq!(ApiError::BadToken.status(), 403);
        assert!(ApiError::NotFound.is_refusal());
        assert!(!ApiError::Http("x".into()).is_refusal());
        assert!(ApiError::Wire(WireError::unavailable("x")).to_wire().retry);
    }
}
