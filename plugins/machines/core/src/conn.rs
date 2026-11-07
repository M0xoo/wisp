//! One peer's connection, as v1's `machines.js` ran it (`connect`, `#line`, `#fail`, `#closed`,
//! `#asleep`, `#streamLost`, `disconnect`), as pure transitions. The host owns the ssh child, the
//! channel and the timers; it tells a `Conn` what happened and does what the answer says.
//!
//! The rules (docs/v1-edge-cases.md → Machines):
//! - reconnect only once it has worked: 2/5/15/30/60 s; `@@wisp fail` and a grid 401/403 give up (4)
//! - an asleep box is watched every 20 s without waking it; a request wakes it (5)
//! - stopping wisp mid-wake ends the 90 s health loop: every later answer is ignored (6)
use wisp_machines_api::{Hint, PeerState, PeerStatus, RemoteAgent, RemoteInfo, Step, StepStatus};

use crate::bootstrap::{AGENTS, BootLine, TUNNEL, WISP};

pub const RETRY_MS: [u64; 5] = [2_000, 5_000, 15_000, 30_000, 60_000];
/// the first download of wisp there can take a while
pub const READY_TIMEOUT_MS: u64 = 6 * 60_000;
pub const GRID_WAKE_MS: u64 = 90_000;
/// how often an asleep cloud computer is checked, without waking it
pub const GRID_WATCH_MS: u64 = 20_000;
/// tunnel health: this many tries, this far apart, once the script says ready
pub const TUNNEL_TRIES: u32 = 40;
pub const TUNNEL_GAP_MS: u64 = 250;
pub const MAX_LOG: usize = 80;
/// lines of the log a view shows
pub const VIEW_LOG: usize = 30;
pub const GRID_STEPS: &[(&str, &str)] = &[("wake", "Wake it up"), ("agents", "Find harnesses")];

/// What the host does next.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Next {
    Nothing,
    /// kill the child / close the channel (a failure, or `disconnect`)
    HangUp,
    /// the script says wisp answers there: check it through the tunnel
    CheckTunnel,
    /// connect again after this long
    RetryIn(u64),
    /// watch it, without waking it, after this long
    WatchIn(u64),
}

#[derive(Debug, Clone)]
pub struct Conn {
    pub status: PeerStatus,
    pub log: Vec<String>,
    stderr: String,
    /// retrying won't change the answer (`@@wisp fail`, a revoked sign-in, a disconnect)
    pub give_up: bool,
    pub was_online: bool,
    /// disconnected by hand
    pub stopped: bool,
    /// a wake or tunnel check still going stops asking (`stop()`: wisp is quitting)
    pub hung_up: bool,
    /// a grid peer asking `/health` until it wakes
    pub waking: bool,
    /// grid peers have no ssh child whose exit would say it failed
    pub grid: bool,
}

pub fn fresh_steps(steps: &[(&str, &str)]) -> Vec<Step> {
    steps.iter().enumerate().map(|(i, (id, label))| Step { id: (*id).into(), label: (*label).into(), status: if i == 0 { StepStatus::Run } else { StepStatus::Pending }, detail: String::new() }).collect()
}

/// v1 `#step`: set one step; a step done starts the next pending one.
pub fn move_step(steps: &mut [Step], id: &str, status: StepStatus, detail: Option<&str>) -> bool {
    let Some(i) = steps.iter().position(|s| s.id == id) else { return false };
    steps[i].status = status;
    if let Some(d) = detail {
        d.clone_into(&mut steps[i].detail);
    }
    if status == StepStatus::Done {
        if let Some(next) = steps.get_mut(i + 1).filter(|n| n.status == StepStatus::Pending) {
            next.status = StepStatus::Run;
        }
    }
    true
}

impl Conn {
    /// A new attempt. `retry`: after a lost connection (keeps the attempt count and the remote info).
    pub fn start(id: &str, steps: &[(&str, &str)], grid: bool, retry: bool, prev: Option<&Conn>) -> Self {
        let mut status = PeerStatus::off(id);
        status.state = if retry { PeerState::Reconnecting } else { PeerState::Connecting };
        status.steps = fresh_steps(steps);
        status.attempt = if retry { prev.map_or(0, |p| p.status.attempt) } else { 0 };
        status.remote = prev.and_then(|p| p.status.remote.clone());
        Self { status, log: Vec::new(), stderr: String::new(), give_up: false, was_online: retry && prev.is_some_and(|p| p.was_online), stopped: false, hung_up: false, waking: grid, grid }
    }

    pub fn push_log(&mut self, line: &str) {
        self.log.push(line.to_owned());
        if self.log.len() > MAX_LOG {
            self.log.drain(..self.log.len() - MAX_LOG);
        }
    }

    pub fn step(&mut self, id: &str, status: StepStatus, detail: Option<&str>) -> bool {
        move_step(&mut self.status.steps, id, status, detail)
    }

    /// ssh's stderr: kept (the last 4000 bytes) for the hint, each line in the log.
    pub fn stderr(&mut self, chunk: &str) {
        self.stderr.push_str(chunk);
        if self.stderr.len() > 4000 {
            let cut = self.stderr.len() - 4000;
            let cut = (cut..self.stderr.len()).find(|i| self.stderr.is_char_boundary(*i)).unwrap_or(cut);
            self.stderr.drain(..cut);
        }
        for l in chunk.lines().filter(|l| !l.trim().is_empty()) {
            self.push_log(l);
        }
    }

    /// One line of the bootstrap's stdout.
    pub fn line(&mut self, line: &BootLine) -> Next {
        match line {
            BootLine::Blank => Next::Nothing,
            BootLine::Log(l) => {
                self.push_log(l);
                Next::Nothing
            }
            BootLine::Step { id, status, detail } => {
                self.push_log(&format!("{id}: {}", if detail.is_empty() { format!("{status:?}").to_lowercase() } else { detail.clone() }));
                self.step(id, *status, Some(detail));
                Next::Nothing
            }
            BootLine::Stale(pid) => {
                self.status.stale = *pid;
                Next::Nothing
            }
            BootLine::Fail { id, message } => {
                self.step(id, StepStatus::Fail, Some(message));
                self.give_up = true; // retrying won't change the answer
                self.fail(message, crate::hint::step_hint(id), true)
            }
            BootLine::Ready { version, pid } => {
                let r = self.status.remote.get_or_insert_with(RemoteInfo::default);
                r.version = Some(version.clone());
                r.pid = *pid;
                self.step(TUNNEL, StepStatus::Run, None);
                Next::CheckTunnel
            }
        }
    }

    /// v1 `#fail`: the first error wins (unless `keep`); the running step fails with it.
    pub fn fail(&mut self, msg: &str, hint: Option<Hint>, keep: bool) -> Next {
        if self.hung_up && !keep {
            return Next::Nothing;
        }
        if !self.status.error.is_empty() && !keep {
            return Next::Nothing;
        }
        msg.clone_into(&mut self.status.error);
        if hint.is_some() {
            self.status.hint = hint;
        }
        if let Some(s) = self.status.steps.iter_mut().find(|s| s.status == StepStatus::Run) {
            s.status = StepStatus::Fail;
            if s.detail.is_empty() {
                msg.clone_into(&mut s.detail);
            }
        }
        if self.grid {
            self.status.state = PeerState::Error;
        }
        self.waking = false;
        self.hung_up = true;
        Next::HangUp
    }

    /// v1 `#closed`: the ssh child exited. `target` for the hint.
    pub fn closed(&mut self, code: Option<i32>, target: &str) -> Next {
        if self.stopped {
            self.status.state = PeerState::Off;
            return Next::Nothing;
        }
        let lost = self.status.state == PeerState::Online || self.was_online;
        if self.status.error.is_empty() {
            let last = self.stderr.lines().rev().find(|l| !l.trim().is_empty()).map(str::trim);
            self.status.error = if lost { "Connection lost.".into() } else { last.map_or_else(|| format!("ssh exited ({}).", code.map_or_else(|| "signal".into(), |c| c.to_string())), str::to_owned) };
            self.status.hint = crate::hint::ssh_hint(&self.stderr, target);
            let words = self.status.hint.as_ref().and_then(|h| h.title.clone()).unwrap_or_else(|| self.status.error.clone());
            if let Some(s) = self.status.steps.iter_mut().find(|s| s.status == StepStatus::Run) {
                s.status = StepStatus::Fail;
                s.detail = words; // the raw ssh line stays under Details
            }
        }
        // once it has worked, keep trying (laptop lid, Wi-Fi, VPN); a first connect that fails stops
        if lost && !self.give_up {
            self.status.state = PeerState::Reconnecting;
            let wait = RETRY_MS[usize::try_from(self.status.attempt).unwrap_or(usize::MAX).min(RETRY_MS.len() - 1)];
            self.status.attempt += 1;
            Next::RetryIn(wait)
        } else {
            self.status.state = PeerState::Error;
            Next::Nothing
        }
    }

    /// The tunnel answered `/health`, with the peer's harnesses: online.
    pub fn online(&mut self, label: &str, agents: Vec<RemoteAgent>, home: Option<String>, version: Option<String>, pid: Option<u32>, proto: u32, now: i64) {
        self.step(if self.grid { "wake" } else { TUNNEL }, StepStatus::Done, Some(label));
        let ready: Vec<&str> = agents.iter().filter(|a| a.available).map(|a| a.name.as_str()).collect();
        let (st, detail) = if ready.is_empty() { (StepStatus::Warn, "No coding agent installed there yet. Install Claude Code, Codex or opencode on that computer and sign in once.".to_owned()) } else { (StepStatus::Done, ready.join(", ")) };
        self.step(AGENTS, st, Some(&detail));
        let r = self.status.remote.get_or_insert_with(RemoteInfo::default);
        r.version = version.or(r.version.take());
        r.pid = pid.or(r.pid);
        r.home = home;
        r.agents = Some(agents);
        r.proto = Some(proto);
        self.status.state = PeerState::Online;
        self.status.error.clear();
        self.status.hint = None;
        self.status.attempt = 0;
        self.status.since = Some(now);
        self.status.wakes = false;
        self.was_online = true;
        self.waking = false;
    }

    /// v1 `#streamLost`: the event stream ended while online. A grid box went to sleep (watch it); an
    /// ssh peer's wisp stopped answering (hang up: the child's exit reconnects).
    pub fn stream_lost(&mut self) -> Next {
        if self.status.state != PeerState::Online || self.stopped {
            return Next::Nothing;
        }
        if self.grid {
            return self.asleep(GRID_WATCH_MS);
        }
        "wisp stopped answering there.".clone_into(&mut self.status.error);
        self.hung_up = true;
        Next::HangUp
    }

    /// The grid stopped it (idle): the last rows stay, it is watched without waking it.
    pub fn asleep(&mut self, first_ms: u64) -> Next {
        self.status.state = PeerState::Asleep;
        self.status.error.clear();
        self.status.wakes = true;
        self.waking = false;
        Next::WatchIn(first_ms)
    }

    /// v1 `disconnect`: by hand. Nothing reconnects it.
    pub fn disconnect(&mut self, has_child: bool) -> Next {
        self.stopped = true;
        self.give_up = true;
        self.hung_up = true;
        self.waking = false;
        self.status.wakes = false;
        if !has_child {
            self.status.state = PeerState::Off;
        }
        Next::HangUp
    }

    /// v1 `wakes(c)`: a request gets through (the grid starts it): asleep, or a wake still going.
    pub fn wakes(&self) -> bool {
        self.status.state == PeerState::Asleep || (self.waking && !self.stopped)
    }

    /// The card's log: its last lines.
    pub fn view_log(&self) -> Vec<String> {
        self.log[self.log.len().saturating_sub(VIEW_LOG)..].to_vec()
    }
}

/// What a grid `/health` failure means while waking (v1 `#connectGrid`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WakeAnswer {
    /// another of your computers isn't on the grid: nothing here can wake it
    Asleep,
    /// signed out: stop for good
    SignedOut(Hint),
    /// ask again in a second, saying this on the wake step
    Again(String),
}

pub fn wake_answer(status: Option<u16>, message: &str, computer: bool) -> WakeAnswer {
    match status {
        Some(503) if computer => WakeAnswer::Asleep,
        Some(401 | 403) => WakeAnswer::SignedOut(Hint::titled("Signed out", "The device was revoked or expired. Settings → Cloud → Sign in again.")),
        Some(503) => WakeAnswer::Again("Starting…".into()),
        _ => WakeAnswer::Again(message.to_owned()),
    }
}

pub const SIGNED_OUT: &str = "The grid didn’t accept this computer’s sign-in.";
pub const NO_TOKEN: &str = "Signed out of this cloud computer.";
pub const NOT_WOKEN: &str = "It didn’t wake up in time.";
pub const NO_TUNNEL: &str = "The tunnel opened, but wisp doesn’t answer through it.";
pub const TOO_LONG: &str = "It took too long to start wisp there.";

pub fn no_token_hint() -> Hint {
    Hint::titled("Sign in again", "Settings → Cloud → Sign in, with the same grid.")
}

/// ssh itself couldn't run.
pub fn no_ssh(err: &str) -> (String, Hint) {
    (format!("Could not run ssh: {err}"), Hint { text: "wisp needs the OpenSSH client (`ssh`) on this computer.".into(), ..Hint::default() })
}

/// Why a request to a peer can't go now (v1 `#online`), with its 503 words; `None`: it can go.
pub fn refuse(name: &str, state: PeerState, wakes: bool, computer: bool, wakes_on_request: bool) -> Option<String> {
    if computer && state != PeerState::Online {
        return Some(format!("{name} is offline: it comes back when that computer is on and wisp runs there."));
    }
    if state == PeerState::Online || (wakes && wakes_on_request) {
        return None;
    }
    Some(format!("{name} is offline. Connect it from Machines."))
}

/// The detail of the `wisp` step that says a reconnect found it running.
pub fn already_running(detail: &str) -> bool {
    detail.starts_with("already running")
}

pub const WISP_STEP: &str = WISP;

#[cfg(test)]
#[path = "conn_tests.rs"]
mod tests;
