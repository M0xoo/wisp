//! What a v1 route body asks for (routes/sessions.js `/term`, routes/workspace.js `/shell`). Bodies are
//! loose JSON as the page sent them; the decision is pure, the host carries it out.

use serde_json::Value;
use wisp_terminal_api::InputOrder;

use crate::error::TerminalError;
use crate::size::{number, truthy};

/// A new size, when the body has one (`cols` and `rows` both truthy, as v1's `body.cols && body.rows`).
/// Either may still be nonsense (`"wide"`): the clamp keeps the size it had.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Size {
    pub cols: Option<f64>,
    pub rows: Option<f64>,
}

pub fn size(body: &Value) -> Option<Size> {
    (truthy(body.get("cols")) && truthy(body.get("rows"))).then(|| Size {
        cols: body.get("cols").and_then(number),
        rows: body.get("rows").and_then(number),
    })
}

/// Numbered when `seq` is a whole number and `from` a string; plain otherwise (an older page).
pub fn order(body: &Value) -> InputOrder {
    let seq = body.get("seq").and_then(|v| {
        v.as_i64().or_else(|| {
            v.as_f64()
                .filter(|f| f.fract() == 0.0 && f.is_finite())
                .map(|f| {
                    #[allow(
                        clippy::cast_possible_truncation,
                        reason = "a whole, finite number; out-of-range saturates"
                    )]
                    let n = f as i64;
                    n
                })
        })
    });
    let from = body.get("from").and_then(Value::as_str).map(str::to_owned);
    match (seq, from) {
        (Some(seq), Some(from)) => InputOrder {
            seq: Some(seq),
            from: Some(from),
        },
        _ => InputOrder::default(),
    }
}

fn data(body: &Value) -> Option<String> {
    body.get("data").and_then(Value::as_str).map(str::to_owned)
}

/// `POST /sessions/:id/term`: type and/or resize, only while it runs.
#[derive(Debug, Clone, PartialEq)]
pub struct TermPost {
    pub data: Option<(String, InputOrder)>,
    pub size: Option<Size>,
}

pub fn term_post(body: &Value, live: bool) -> Result<TermPost, TerminalError> {
    if !live {
        return Err(TerminalError::NoTerminal);
    }
    Ok(TermPost {
        data: data(body).map(|d| (d, order(body))),
        size: size(body),
    })
}

/// `POST /sessions/:id/shell`.
#[derive(Debug, Clone, PartialEq)]
pub enum ShellPost {
    /// `{data}`: typed into the running shell (and resized), `{ok}`
    Type {
        data: String,
        order: InputOrder,
        size: Option<Size>,
    },
    /// it runs and no `restart`: resized at most, `{ok, started: false}`
    Keep { size: Option<Size> },
    /// a fresh one (the old one hung up first on `restart`), `{ok, started: true, dir, gone}`
    Start {
        restart: bool,
        cols: Option<f64>,
        rows: Option<f64>,
    },
}

pub fn shell_post(
    body: &Value,
    live: bool,
    pty_supported: bool,
) -> Result<ShellPost, TerminalError> {
    if let Some(d) = data(body) {
        if !live {
            return Err(TerminalError::ShellEnded);
        }
        return Ok(ShellPost::Type {
            data: d,
            order: order(body),
            size: size(body),
        });
    }
    let restart = truthy(body.get("restart"));
    if live && !restart {
        return Ok(ShellPost::Keep { size: size(body) });
    }
    if !pty_supported {
        return Err(TerminalError::NoPty);
    }
    Ok(ShellPost::Start {
        restart,
        cols: body.get("cols").and_then(number),
        rows: body.get("rows").and_then(number),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn term_post_types_and_resizes_only_while_it_runs() {
        assert_eq!(
            term_post(&json!({"data": "x"}), false),
            Err(TerminalError::NoTerminal)
        );
        let p = term_post(
            &json!({"data": "hi there\r", "seq": 0, "from": "page"}),
            true,
        )
        .unwrap();
        assert_eq!(
            p.data,
            Some((
                "hi there\r".into(),
                InputOrder {
                    seq: Some(0),
                    from: Some("page".into())
                }
            ))
        );
        assert_eq!(p.size, None);
        let r = term_post(&json!({"cols": 120, "rows": 30}), true).unwrap();
        assert_eq!(
            (r.data, r.size),
            (
                None,
                Some(Size {
                    cols: Some(120.0),
                    rows: Some(30.0)
                })
            )
        );
        assert_eq!(
            term_post(&json!({"cols": 120}), true).unwrap().size,
            None,
            "both or nothing"
        );
    }

    #[test]
    fn numbered_only_with_a_whole_seq_and_a_page() {
        assert_eq!(order(&json!({"seq": 2, "from": "p"})).seq, Some(2));
        assert_eq!(order(&json!({"seq": 2.0, "from": "p"})).seq, Some(2));
        assert_eq!(
            order(&json!({"seq": 2.5, "from": "p"})),
            InputOrder::default()
        );
        assert_eq!(
            order(&json!({"seq": "2", "from": "p"})),
            InputOrder::default()
        );
        assert_eq!(order(&json!({"seq": 2})), InputOrder::default());
    }

    // TS plugin.test "shell: started …, again without a restart only resizes, typed into, ended" (the
    // decisions; the host test runs them).
    #[test]
    fn shell_post_decides_as_v1() {
        assert_eq!(
            shell_post(&json!({"data": "x"}), false, true),
            Err(TerminalError::ShellEnded)
        );
        assert!(matches!(
            shell_post(&json!({"data": "ls\r", "cols": 80, "rows": 24}), true, true),
            Ok(ShellPost::Type { size: Some(_), .. })
        ));
        assert_eq!(
            shell_post(&json!({"cols": 100, "rows": 30}), true, true),
            Ok(ShellPost::Keep {
                size: Some(Size {
                    cols: Some(100.0),
                    rows: Some(30.0)
                })
            })
        );
        assert_eq!(
            shell_post(&json!({"restart": true}), true, true),
            Ok(ShellPost::Start {
                restart: true,
                cols: None,
                rows: None
            })
        );
        assert_eq!(
            shell_post(&json!({"cols": 80, "rows": 24}), false, true),
            Ok(ShellPost::Start {
                restart: false,
                cols: Some(80.0),
                rows: Some(24.0)
            })
        );
        assert_eq!(
            shell_post(&json!({}), false, false),
            Err(TerminalError::NoPty),
            "no PTY on Windows"
        );
        assert_eq!(
            shell_post(&json!({}), true, false),
            Ok(ShellPost::Keep { size: None }),
            "a running one is kept even there"
        );
        assert!(
            matches!(
                shell_post(&json!(null), false, true),
                Ok(ShellPost::Start { .. })
            ),
            "no body: start one"
        );
    }
}
