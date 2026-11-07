//! Socket Mode (v1 `Slack#listen`): the frames Slack sends, the ack each envelope needs, and one
//! connection's rules: a hello in time, Slack's own disconnect, and when to dial again. Every envelope
//! is acked the moment it arrives (Slack resends after 3 s); the work goes behind the ack.
use serde_json::Value;

use crate::{SlackError, backoff_ms, for_good};

/// The longest wait for Slack's hello before the socket is given up on.
pub const HELLO_MS: u64 = 30_000;

#[derive(Debug, Clone, PartialEq)]
pub enum Frame {
    Hello,
    /// Slack wants this socket gone: a refresh (dial again now), or a reason it won't come back
    Disconnect {
        reason: String,
    },
    Events {
        envelope_id: Option<String>,
        payload: Value,
    },
    Interactive {
        envelope_id: Option<String>,
        payload: Value,
    },
    /// slash commands and whatever else: acked and ignored
    Other {
        envelope_id: Option<String>,
    },
    /// not JSON, or not an object
    Junk,
}

impl Frame {
    pub fn envelope_id(&self) -> Option<&str> {
        match self {
            Self::Events { envelope_id, .. }
            | Self::Interactive { envelope_id, .. }
            | Self::Other { envelope_id } => envelope_id.as_deref(),
            Self::Hello | Self::Disconnect { .. } | Self::Junk => None,
        }
    }
}

pub fn parse(text: &str) -> Frame {
    let Ok(Value::Object(mut m)) = serde_json::from_str::<Value>(text) else {
        return Frame::Junk;
    };
    let ty = m
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    match ty.as_str() {
        "hello" => return Frame::Hello,
        "disconnect" => {
            return Frame::Disconnect {
                reason: m
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
            };
        }
        _ => {}
    }
    let envelope_id = m
        .get("envelope_id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let payload = m.remove("payload").unwrap_or(Value::Null);
    match ty.as_str() {
        "events_api" => Frame::Events {
            envelope_id,
            payload,
        },
        "interactive" => Frame::Interactive {
            envelope_id,
            payload,
        },
        _ => Frame::Other { envelope_id },
    }
}

/// The ack for one envelope: its id and nothing else.
pub fn ack(envelope_id: &str) -> String {
    serde_json::json!({ "envelope_id": envelope_id }).to_string()
}

/// What one frame asks of the host, in order.
#[derive(Debug, Clone, PartialEq)]
pub enum Step {
    Send(String),
    /// Slack said hello: Connected
    Hello,
    Close,
    Event(Value),
    Click(Value),
}

/// How one connection ended.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct End {
    /// Slack said hello: the failures in a row start over
    pub heard: bool,
    /// Slack asked for a new socket
    pub again: bool,
    /// a reason it won't come back
    pub code: Option<String>,
}

impl End {
    /// Nobody asked for it to end: Settings says it dropped.
    pub fn dropped(&self) -> bool {
        !self.again && self.code.is_none()
    }
}

/// One connection, from open to close.
#[derive(Debug, Clone)]
pub struct Listen {
    hello_by: i64,
    end: End,
}

impl Listen {
    /// `ping_ms`: the beat the host keeps; a hello takes no longer than two of them.
    pub fn new(now_ms: i64, ping_ms: u64) -> Self {
        let wait = HELLO_MS.min(ping_ms.saturating_mul(2));
        Self {
            hello_by: now_ms.saturating_add(i64::try_from(wait).unwrap_or(i64::MAX)),
            end: End::default(),
        }
    }

    pub fn frame(&mut self, text: &str) -> Vec<Step> {
        let f = parse(text);
        let mut out = Vec::new();
        match &f {
            Frame::Hello => {
                self.end.heard = true;
                out.push(Step::Hello);
                return out;
            }
            Frame::Disconnect { reason } => {
                if for_good(reason) {
                    self.end.code = Some(reason.clone());
                } else {
                    self.end.again = true;
                }
                out.push(Step::Close);
                return out;
            }
            _ => {}
        }
        if let Some(id) = f.envelope_id() {
            out.push(Step::Send(ack(id))); // first, always
        }
        match f {
            Frame::Events { payload, .. } => out.push(Step::Event(payload)),
            Frame::Interactive { payload, .. } => out.push(Step::Click(payload)),
            _ => {}
        }
        out
    }

    /// When the host must look again (`tick`), or None: nothing is waited on.
    pub fn deadline(&self) -> Option<i64> {
        (!self.end.heard).then_some(self.hello_by)
    }

    /// Why the socket must close now, if it must.
    pub fn tick(&self, now_ms: i64) -> Option<&'static str> {
        (!self.end.heard && now_ms >= self.hello_by).then_some("Slack never said hello.")
    }

    pub fn end(&self) -> End {
        self.end.clone()
    }
}

/// After a connection or a failed dial.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Next {
    /// Slack asked for it: a new socket, now
    Now,
    Wait(u64),
    /// new tokens start it again; hammering these won't. The line is for Settings.
    Stop(String),
}

/// The dialling loop's memory: failures in a row.
#[derive(Debug, Clone, Default)]
pub struct Dial {
    pub fails: u32,
}

impl Dial {
    pub fn ended(&mut self, end: &End, base_ms: u64) -> Next {
        if end.heard {
            self.fails = 0;
        }
        if let Some(code) = &end.code {
            return Next::Stop(SlackError::Api(code.clone()).line());
        }
        if end.again {
            return Next::Now;
        }
        self.fails += 1;
        Next::Wait(backoff_ms(base_ms, self.fails))
    }

    pub fn failed(&mut self, e: &SlackError, base_ms: u64) -> Next {
        if e.for_good() {
            return Next::Stop(e.line());
        }
        let wait = match e {
            SlackError::RateLimited { retry_after_s } => retry_after_s.saturating_mul(1000),
            _ => 0,
        };
        self.fails += 1;
        Next::Wait(wait.max(backoff_ms(base_ms, self.fails)))
    }
}
