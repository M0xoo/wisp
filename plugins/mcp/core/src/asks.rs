//! The open asks, sans IO: per session a queue whose front is the one shown (a task holds one question at
//! a time; v1 chained a second `ask_user` behind the first rather than replace it, which would read as
//! cancelled). `W` is the host's waiter (a channel's sending half); ids come from the host too.

use std::collections::{BTreeMap, HashMap, VecDeque};

use wisp_mcp_api::{Ask, AskReply};

/// How many answers to asks nobody waits on yet are kept, for a waiter that attaches late (connectors
/// open a card, then the tool waits on it: the user may be quicker).
const SETTLED_KEPT: usize = 256;

#[derive(Debug)]
struct Entry<W> {
    ask: Ask,
    waiter: Option<W>,
}

/// An ask that closed: its waiter to wake, and the ask shown in its place, if any.
#[derive(Debug)]
pub struct Closed<W> {
    pub ask: Ask,
    pub waiter: Option<W>,
    pub next: Option<Ask>,
}

#[derive(Debug)]
pub struct Asks<W> {
    queues: BTreeMap<String, VecDeque<Entry<W>>>,
    session_of: HashMap<String, String>,
    /// answered (Some) or cancelled (None) before anyone waited, oldest first
    settled: VecDeque<(String, Option<AskReply>)>,
}

impl<W> Default for Asks<W> {
    fn default() -> Self {
        Self { queues: BTreeMap::new(), session_of: HashMap::new(), settled: VecDeque::new() }
    }
}

/// What attaching a waiter found.
#[derive(Debug)]
pub enum Attach<W> {
    /// the ask is open: the waiter is kept
    Waiting,
    /// it already ended: its answer (`None`: cancelled), and the waiter back
    Settled(Option<AskReply>, W),
    /// no such ask (never opened, or ended long ago): the waiter back
    Unknown(W),
}

impl<W> Asks<W> {
    pub fn new() -> Self {
        Self::default()
    }

    /// Opens `ask` (its id must be new); true when it is shown at once, false when it waits its turn.
    pub fn open(&mut self, ask: Ask, waiter: Option<W>) -> bool {
        self.session_of.insert(ask.id.clone(), ask.session.clone());
        let q = self.queues.entry(ask.session.clone()).or_default();
        q.push_back(Entry { ask, waiter });
        q.len() == 1
    }

    /// Waits on an ask a plugin opened.
    pub fn attach(&mut self, id: &str, waiter: W) -> Attach<W> {
        if let Some(at) = self.settled.iter().position(|(x, _)| x == id) {
            let (_, reply) = self.settled.remove(at).unwrap_or_default();
            return Attach::Settled(reply, waiter);
        }
        let Some(entry) = self.entry_mut(id) else { return Attach::Unknown(waiter) };
        entry.waiter = Some(waiter);
        Attach::Waiting
    }

    fn entry_mut(&mut self, id: &str) -> Option<&mut Entry<W>> {
        let session = self.session_of.get(id)?;
        self.queues.get_mut(session)?.iter_mut().find(|e| e.ask.id == id)
    }

    /// The id of the ask shown for a session.
    pub fn front(&self, session: &str) -> Option<&Ask> {
        self.queues.get(session).and_then(VecDeque::front).map(|e| &e.ask)
    }

    /// Closes one ask. `reply`: its answer, `None` when it was cancelled.
    pub fn close(&mut self, id: &str, reply: Option<&AskReply>) -> Option<Closed<W>> {
        let session = self.session_of.remove(id)?;
        let q = self.queues.get_mut(&session)?;
        let at = q.iter().position(|e| e.ask.id == id)?;
        let entry = q.remove(at)?;
        let next = if at == 0 { q.front().map(|e| e.ask.clone()) } else { None };
        if q.is_empty() {
            self.queues.remove(&session);
        }
        if entry.waiter.is_none() {
            self.keep_settled(id, reply.cloned());
        }
        Some(Closed { ask: entry.ask, waiter: entry.waiter, next })
    }

    fn keep_settled(&mut self, id: &str, reply: Option<AskReply>) {
        if self.settled.len() >= SETTLED_KEPT {
            self.settled.pop_front();
        }
        self.settled.push_back((id.to_owned(), reply));
    }

    /// Cancels every ask of a session (its turn ended, it was stopped or deleted).
    pub fn close_session(&mut self, session: &str) -> Vec<Closed<W>> {
        let ids: Vec<String> = self.queues.get(session).map(|q| q.iter().map(|e| e.ask.id.clone()).collect()).unwrap_or_default();
        // Back to front, so no ask is shown in between.
        ids.iter().rev().filter_map(|id| self.close(id, None)).map(|c| Closed { next: None, ..c }).collect()
    }

    /// The asks shown now, one per session.
    pub fn shown(&self, session: Option<&str>) -> Vec<Ask> {
        self.queues
            .iter()
            .filter(|(s, _)| session.is_none_or(|x| x == s.as_str()))
            .filter_map(|(_, q)| q.front().map(|e| e.ask.clone()))
            .collect()
    }

    pub fn is_empty(&self) -> bool {
        self.queues.is_empty()
    }
}
