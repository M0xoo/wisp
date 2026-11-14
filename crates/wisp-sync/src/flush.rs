//! Flushing a connection's outbox (plan §4.4): at most every `flush_ms`, at once when the stream was
//! idle; acks first (once the effects they report are out), then control messages, then topics by
//! priority; past the high-water mark the busy topics are dropped and resynced.

use std::fmt::Write as _;

use wisp_protocol::{Resync, tag};

use crate::conn::{Conn, Core, SubState, json};
use crate::outbox::Taken;
use crate::sse::{HEARTBEAT, encode_frame};
use crate::{ConnId, Output};

impl<C> Core<C> {
    pub(crate) fn maybe_flush(&mut self, c: &mut Conn<C>, now: u64) {
        let due = c.last_flush_at.is_none_or(|at| now.saturating_sub(at) >= self.opts.flush_ms);
        if due && self.pending(c) {
            self.flush(c, now);
        }
    }

    /// When `tick` next has work for this stream: a due flush or heartbeat.
    pub(crate) fn wake_at(&self, c: &Conn<C>) -> u64 {
        let beat = c.last_write_at + self.opts.heartbeat_ms;
        if !self.pending(c) {
            return beat;
        }
        beat.min(c.last_flush_at.map_or(0, |at| at + self.opts.flush_ms))
    }

    pub(crate) fn flush(&mut self, c: &mut Conn<C>, now: u64) {
        c.last_flush_at = Some(now);
        let high = self.opts.high_water_bytes;
        if c.buffered > high {
            self.shed(c);
        }
        let taken = if c.buffered > high { Taken::default() } else { c.out.take(high - c.buffered) };
        let w = self.watermark(c);
        let mut parts: Vec<String> = Vec::with_capacity(c.control.len() + taken.fronts.len() + 2);
        c.acks.retain_mut(|a| {
            if a.seq > w {
                return true;
            }
            let ack = wisp_protocol::Ack { t: tag::Ack, mid: std::mem::take(&mut a.mid), seq: a.seq, result: a.result.take() };
            parts.push(json(&ack));
            false
        });
        parts.append(&mut c.control);
        parts.extend(taken.fronts);
        if !taken.ops.is_empty() {
            let len: usize = taken.ops.iter().map(|o| o.json().len() + 1).sum();
            let mut patch = String::with_capacity(len + 32);
            let _ = write!(patch, "{{\"t\":\"patch\",\"seq\":{w},\"ops\":[");
            for (i, op) in taken.ops.iter().enumerate() {
                if i > 0 {
                    patch.push(',');
                }
                patch.push_str(op.json());
            }
            patch.push_str("]}");
            parts.push(patch);
        }
        if !parts.is_empty() {
            self.write(c, &parts, now, w);
        }
    }

    /// Past the high-water mark: drop each busy topic's queue and tell the client to resync it.
    fn shed(&mut self, c: &mut Conn<C>) {
        for topic in c.out.busy_topics() {
            let (oldest, any) = c.out.drop_topic(&topic, true);
            let Some(sub) = c.subs.get_mut(&topic) else {
                continue;
            };
            if !any {
                continue;
            }
            // the client holds the topic as of just before the oldest change it now won't get
            if let Some(o) = oldest {
                sub.since = Some(o.saturating_sub(1));
            }
            sub.state = SubState::Dropped;
            sub.buffer.clear();
            sub.buffer_bytes = 0;
            self.stats.resyncs += 1;
            c.control.push(json(&Resync { t: tag::Resync, topic }));
        }
    }

    pub(crate) fn write<S: AsRef<str>>(&mut self, c: &mut Conn<C>, messages: &[S], now: u64, id: u64) {
        let frame = encode_frame(Some(id), messages);
        c.buffered += frame.len(); // until the host reports the socket's real number
        c.last_write_at = now;
        self.send_raw(c.id, frame, Some(id));
    }

    pub(crate) fn send_raw(&mut self, conn: ConnId, frame: String, id: Option<u64>) {
        if id.is_some() {
            self.stats.frames += 1;
        }
        self.stats.bytes += frame.len() as u64;
        self.out.push(Output::Send { conn, frame, id });
    }

    pub(crate) fn heartbeat(&mut self, c: &mut Conn<C>, now: u64) {
        if now.saturating_sub(c.last_write_at) >= self.opts.heartbeat_ms {
            c.last_write_at = now;
            self.stats.heartbeats += 1;
            self.send_raw(c.id, HEARTBEAT.to_owned(), None);
        }
    }
}
