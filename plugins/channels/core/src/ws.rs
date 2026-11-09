//! A WebSocket client's wire (RFC 6455), sans-IO: the handshake's key and the `Sec-WebSocket-Accept` the server must
//! answer, client frames (always masked; the mask comes from the host), and a decoder for server frames (never
//! masked) that joins fragments and hands control frames back to answer (a ping's pong, a close). The host does
//! the upgrade (reqwest) and the reads and writes; Slack's Socket Mode and Discord's gateway run on it.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;

const GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/// The most a message may hold (Discord's are small; Slack's a few KB): past it, the connection closes 1009.
pub const MAX_MESSAGE: usize = 16 << 20;

/// SHA-1, for the handshake's accept value only (it proves the server read the key; it isn't a secret).
#[allow(clippy::many_single_char_names)] // a..e, h, w, f, k: FIPS 180-4's names
fn sha1(data: &[u8]) -> [u8; 20] {
    let mut h: [u32; 5] = [0x6745_2301, 0xEFCD_AB89, 0x98BA_DCFE, 0x1032_5476, 0xC3D2_E1F0];
    let mut msg = data.to_vec();
    let bits = (data.len() as u64).wrapping_mul(8);
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bits.to_be_bytes());
    for chunk in msg.chunks(64) {
        let mut w = [0u32; 80];
        for (i, word) in chunk.chunks(4).enumerate().take(16) {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let [mut a, mut b, mut c, mut d, mut e] = h;
        for (i, wi) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | (!b & d), 0x5A82_7999),
                20..=39 => (b ^ c ^ d, 0x6ED9_EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1B_BCDC),
                _ => (b ^ c ^ d, 0xCA62_C1D6),
            };
            let t = a.rotate_left(5).wrapping_add(f).wrapping_add(e).wrapping_add(k).wrapping_add(*wi);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = t;
        }
        for (x, y) in h.iter_mut().zip([a, b, c, d, e]) {
            *x = x.wrapping_add(y);
        }
    }
    let mut out = [0u8; 20];
    for (i, x) in h.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&x.to_be_bytes());
    }
    out
}

/// The `Sec-WebSocket-Key` for 16 random bytes.
pub fn key(random: [u8; 16]) -> String {
    B64.encode(random)
}

/// What the server must answer as `Sec-WebSocket-Accept` for `key`.
pub fn accept(key: &str) -> String {
    B64.encode(sha1(format!("{key}{GUID}").as_bytes()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    Text = 1,
    Binary = 2,
    Close = 8,
    Ping = 9,
    Pong = 10,
}

/// A client frame: FIN set, masked with `mask`.
pub fn encode(op: Op, payload: &[u8], mask: [u8; 4]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 14);
    out.push(0x80 | op as u8);
    let n = payload.len();
    if n < 126 {
        out.push(0x80 | u8::try_from(n).unwrap_or(0));
    } else if n <= 0xFFFF {
        out.push(0x80 | 0x7E);
        out.extend_from_slice(&u16::try_from(n).unwrap_or(u16::MAX).to_be_bytes());
    } else {
        out.push(0x80 | 0x7F);
        out.extend_from_slice(&(n as u64).to_be_bytes());
    }
    out.extend_from_slice(&mask);
    out.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]));
    out
}

/// A close frame's payload: the code, then the reason.
pub fn close_payload(code: u16, reason: &str) -> Vec<u8> {
    let mut p = code.to_be_bytes().to_vec();
    p.extend_from_slice(reason.as_bytes());
    p
}

/// What a server's bytes said.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    Text(String),
    Binary(Vec<u8>),
    /// answer it with a pong carrying the same bytes
    Ping(Vec<u8>),
    /// the server closes (code, reason): answer with a close, then the connection ends
    Close(u16, String),
    /// the server broke the protocol (a masked frame, a bad length, bad UTF-8): close with this code
    Broken(u16, String),
}

/// Server frames in, events out; partial frames wait for more bytes.
#[derive(Debug, Default)]
pub struct Decoder {
    buf: Vec<u8>,
    /// a fragmented message so far: its opcode and bytes
    partial: Option<(u8, Vec<u8>)>,
}

impl Decoder {
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<Event> {
        self.buf.extend_from_slice(bytes);
        let mut out = Vec::new();
        while let Some(ev) = self.next() {
            let stop = matches!(ev, Event::Broken(..) | Event::Close(..));
            out.push(ev);
            if stop {
                break;
            }
        }
        out
    }

    fn next(&mut self) -> Option<Event> {
        let b = &self.buf;
        if b.len() < 2 {
            return None;
        }
        let (fin, op, masked, len7) = (b[0] & 0x80 != 0, b[0] & 0x0F, b[1] & 0x80 != 0, usize::from(b[1] & 0x7F));
        if b[0] & 0x70 != 0 {
            return Some(Event::Broken(1002, "reserved bits set".into()));
        }
        if masked {
            return Some(Event::Broken(1002, "a server's frame is never masked".into()));
        }
        let (len, head) = match len7 {
            126 => {
                if b.len() < 4 {
                    return None;
                }
                (usize::from(u16::from_be_bytes([b[2], b[3]])), 4)
            }
            127 => {
                if b.len() < 10 {
                    return None;
                }
                let mut a = [0u8; 8];
                a.copy_from_slice(&b[2..10]);
                (usize::try_from(u64::from_be_bytes(a)).unwrap_or(usize::MAX), 10)
            }
            n => (n, 2),
        };
        if len > MAX_MESSAGE {
            return Some(Event::Broken(1009, "a message too big".into()));
        }
        if b.len() < head + len {
            return None;
        }
        let payload: Vec<u8> = b[head..head + len].to_vec();
        self.buf.drain(..head + len);
        match op {
            // control frames: never fragmented, at most 125 bytes
            8..=10 if !fin || len > 125 => Some(Event::Broken(1002, "a bad control frame".into())),
            8 => {
                let code = if payload.len() >= 2 { u16::from_be_bytes([payload[0], payload[1]]) } else { 1005 };
                Some(Event::Close(code, String::from_utf8_lossy(payload.get(2..).unwrap_or_default()).into_owned()))
            }
            9 => Some(Event::Ping(payload)),
            10 => self.next(),
            0 => {
                let Some((first, mut so_far)) = self.partial.take() else { return Some(Event::Broken(1002, "a continuation with nothing to continue".into())) };
                so_far.extend_from_slice(&payload);
                if so_far.len() > MAX_MESSAGE {
                    return Some(Event::Broken(1009, "a message too big".into()));
                }
                if fin { Some(Self::message(first, so_far)) } else {
                    self.partial = Some((first, so_far));
                    self.next()
                }
            }
            1 | 2 if self.partial.is_some() => Some(Event::Broken(1002, "a new message inside a fragmented one".into())),
            1 | 2 if !fin => {
                self.partial = Some((op, payload));
                self.next()
            }
            1 | 2 => Some(Self::message(op, payload)),
            _ => Some(Event::Broken(1002, format!("opcode {op}"))),
        }
    }

    fn message(op: u8, bytes: Vec<u8>) -> Event {
        if op == 2 {
            return Event::Binary(bytes);
        }
        match String::from_utf8(bytes) {
            Ok(t) => Event::Text(t),
            Err(_) => Event::Broken(1007, "text that isn't UTF-8".into()),
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    /// A server frame (unmasked).
    fn server(fin: bool, op: u8, payload: &[u8]) -> Vec<u8> {
        let mut f = vec![if fin { 0x80 } else { 0 } | op];
        if payload.len() < 126 {
            f.push(u8::try_from(payload.len()).unwrap());
        } else {
            f.push(126);
            f.extend_from_slice(&u16::try_from(payload.len()).unwrap().to_be_bytes());
        }
        f.extend_from_slice(payload);
        f
    }

    #[test]
    fn the_handshake_accept_is_rfc_6455s() {
        // RFC 6455 §1.3
        assert_eq!(accept("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
        assert_eq!(key([0; 16]).len(), 24);
    }

    #[test]
    fn client_frames_are_masked_and_server_frames_decode_across_reads() {
        let f = encode(Op::Text, b"Hello", [0x37, 0xfa, 0x21, 0x3d]);
        // RFC 6455 §5.7: a masked "Hello"
        assert_eq!(f, [0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58]);
        assert_eq!(encode(Op::Binary, &[0; 300], [1; 4])[1], 0x80 | 0x7E, "a 16-bit length");
        let mut d = Decoder::default();
        let big = "x".repeat(300);
        let mut bytes = server(true, 1, b"hi");
        bytes.extend(server(true, 1, big.as_bytes()));
        let (a, b) = bytes.split_at(5);
        assert_eq!(d.feed(a), vec![Event::Text("hi".into())]);
        assert_eq!(d.feed(b), vec![Event::Text(big)], "a frame split across reads");
    }

    #[test]
    fn fragments_join_and_control_frames_come_through() {
        let mut d = Decoder::default();
        let mut bytes = server(false, 1, b"hel");
        bytes.extend(server(true, 9, b"p"));
        bytes.extend(server(true, 0, b"lo"));
        bytes.extend(server(true, 10, b""));
        bytes.extend(server(true, 8, &close_payload(1000, "bye")));
        assert_eq!(d.feed(&bytes), vec![Event::Ping(b"p".to_vec()), Event::Text("hello".into()), Event::Close(1000, "bye".into())]);
    }

    #[test]
    fn a_broken_server_is_closed_with_why() {
        let mut masked = server(true, 1, b"x");
        masked[1] |= 0x80;
        assert!(matches!(Decoder::default().feed(&masked).as_slice(), [Event::Broken(1002, _)]));
        assert!(matches!(Decoder::default().feed(&server(true, 1, &[0xff, 0xfe])).as_slice(), [Event::Broken(1007, _)]));
        assert!(matches!(Decoder::default().feed(&server(true, 0, b"x")).as_slice(), [Event::Broken(1002, _)]));
    }
}
