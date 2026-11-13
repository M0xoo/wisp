//! The hub's WebSocket client (Slack's Socket Mode, Discord's gateway): reqwest's HTTP/1.1 upgrade for the
//! connection (TLS included), `wisp_channels_core::ws` for the handshake check and the frames. A ping is answered
//! here; the transport sees text, binary and one close.

use std::sync::Arc;

use async_trait::async_trait;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _, WriteHalf};
use tokio::sync::{Mutex, mpsc};
use wisp_channels_api::hub::{NetError, Ws, WsConn, WsFrame};
use wisp_channels_core::ws::{self, Decoder, Event, Op};

type Writer = Arc<Mutex<WriteHalf<reqwest::Upgraded>>>;

pub struct KWs;

async fn write(w: &Writer, op: Op, payload: &[u8]) -> std::result::Result<(), NetError> {
    let frame = ws::encode(op, payload, rand::random());
    w.lock().await.write_all(&frame).await.map_err(|e| NetError::Broken(e.to_string()))
}

#[async_trait]
impl Ws for KWs {
    async fn connect(&self, url: &str) -> std::result::Result<Box<dyn WsConn>, NetError> {
        let http = url.replacen("wss://", "https://", 1).replacen("ws://", "http://", 1);
        let key = ws::key(rand::random());
        let client = reqwest::Client::builder().http1_only().build().map_err(|e| NetError::Broken(e.to_string()))?;
        // the URL can hold a ticket (Slack's): errors never repeat it
        let r = client
            .get(&http)
            .header("connection", "Upgrade")
            .header("upgrade", "websocket")
            .header("sec-websocket-version", "13")
            .header("sec-websocket-key", &key)
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    NetError::Timeout
                } else {
                    NetError::Refused(format!(
                        "the WebSocket didn't connect ({})",
                        e.status().map_or_else(|| "no answer".to_owned(), |s| s.to_string())
                    ))
                }
            })?;
        if r.status() != reqwest::StatusCode::SWITCHING_PROTOCOLS {
            return Err(NetError::Refused(format!("the server answered {} instead of a WebSocket", r.status())));
        }
        let got = r.headers().get("sec-websocket-accept").and_then(|v| v.to_str().ok()).unwrap_or_default().to_owned();
        if got != ws::accept(&key) {
            return Err(NetError::Refused("the server's WebSocket handshake doesn't match".into()));
        }
        let up = r.upgrade().await.map_err(|e| NetError::Broken(e.to_string()))?;
        let (mut rd, wr) = tokio::io::split(up);
        let wr: Writer = Arc::new(Mutex::new(wr));
        let (tx, rx) = mpsc::channel(64);
        let w2 = wr.clone();
        let heard = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let seen = heard.clone();
        tokio::spawn(async move {
            let mut d = Decoder::default();
            let mut buf = vec![0u8; 16 * 1024];
            let close = loop {
                let n = match rd.read(&mut buf).await {
                    Ok(0) | Err(_) => break WsFrame::Close(1006, String::new()),
                    Ok(n) => n,
                };
                let mut end = None;
                heard.store(true, std::sync::atomic::Ordering::Relaxed);
                for ev in d.feed(&buf[..n]) {
                    match ev {
                        Event::Text(t) => {
                            let _ = tx.send(WsFrame::Text(t)).await;
                        }
                        Event::Binary(b) => {
                            let _ = tx.send(WsFrame::Binary(b)).await;
                        }
                        Event::Ping(p) => {
                            let _ = write(&w2, Op::Pong, &p).await;
                        }
                        Event::Pong => {}
                        Event::Close(code, why) => {
                            let _ = write(&w2, Op::Close, &ws::close_payload(code, "")).await;
                            end = Some(WsFrame::Close(code, why));
                        }
                        Event::Broken(code, why) => {
                            let _ = write(&w2, Op::Close, &ws::close_payload(code, &why)).await;
                            end = Some(WsFrame::Close(code, why));
                        }
                    }
                }
                if let Some(f) = end {
                    break f;
                }
            };
            let _ = tx.send(close).await;
        });
        Ok(Box::new(Conn { rx: Mutex::new(rx), wr, done: std::sync::atomic::AtomicBool::new(false), heard: seen }))
    }
}

struct Conn {
    rx: Mutex<mpsc::Receiver<WsFrame>>,
    wr: Writer,
    done: std::sync::atomic::AtomicBool,
    /// bytes came from the server since the last beat
    heard: Arc<std::sync::atomic::AtomicBool>,
}

#[async_trait]
impl WsConn for Conn {
    async fn recv(&self) -> Option<WsFrame> {
        if self.done.load(std::sync::atomic::Ordering::Relaxed) {
            return None;
        }
        let f = self.rx.lock().await.recv().await.unwrap_or(WsFrame::Close(1006, String::new()));
        if matches!(f, WsFrame::Close(..)) {
            self.done.store(true, std::sync::atomic::Ordering::Relaxed);
        }
        Some(f)
    }
    async fn send(&self, text: String) -> std::result::Result<(), NetError> {
        write(&self.wr, Op::Text, text.as_bytes()).await
    }
    async fn close(&self, code: u16) {
        let _ = write(&self.wr, Op::Close, &ws::close_payload(code, "")).await;
        let _ = self.wr.lock().await.shutdown().await;
    }
    async fn ping(&self) -> bool {
        let alive = self.heard.swap(false, std::sync::atomic::Ordering::Relaxed);
        alive && write(&self.wr, Op::Ping, b"wisp").await.is_ok()
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use tokio::io::{AsyncBufReadExt as _, BufReader};
    use tokio::net::TcpListener;

    use super::*;

    /// A server frame (unmasked).
    fn frame(op: u8, payload: &[u8]) -> Vec<u8> {
        let mut f = vec![0x80 | op, u8::try_from(payload.len()).unwrap()];
        f.extend_from_slice(payload);
        f
    }

    /// A client frame read off the wire, unmasked.
    async fn read_client(r: &mut BufReader<tokio::net::tcp::OwnedReadHalf>) -> (u8, Vec<u8>) {
        let mut h = [0u8; 2];
        r.read_exact(&mut h).await.unwrap();
        assert!(h[1] & 0x80 != 0, "a client frame is masked");
        let n = usize::from(h[1] & 0x7F);
        let mut mask = [0u8; 4];
        r.read_exact(&mut mask).await.unwrap();
        let mut p = vec![0u8; n];
        r.read_exact(&mut p).await.unwrap();
        (h[0] & 0x0F, p.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]).collect())
    }

    #[tokio::test]
    async fn the_websocket_client_talks_to_a_server() {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (s, _) = l.accept().await.unwrap();
            let (rd, mut wr) = s.into_split();
            let mut r = BufReader::new(rd);
            let mut key = String::new();
            loop {
                let mut line = String::new();
                r.read_line(&mut line).await.unwrap();
                if let Some(k) = line.to_ascii_lowercase().strip_prefix("sec-websocket-key:") {
                    key = line[line.len() - k.len()..].trim().to_owned();
                }
                if line == "\r\n" {
                    break;
                }
            }
            let accept = ws::accept(&key);
            wr.write_all(format!("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n").as_bytes()).await.unwrap();
            // a ping first, answered before anything else is sent (no race with the client's own frames)
            wr.write_all(&frame(9, b"are you there")).await.unwrap();
            let pong = read_client(&mut r).await;
            wr.write_all(&frame(1, b"hello")).await.unwrap();
            let said = read_client(&mut r).await;
            wr.write_all(&frame(8, &ws::close_payload(1000, "bye"))).await.unwrap();
            let closed = read_client(&mut r).await;
            (pong, said, closed)
        });
        let c = KWs.connect(&format!("ws://127.0.0.1:{port}/socket?ticket=x")).await.unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(c.recv().await, Some(WsFrame::Text("hello".into())));
        c.send("hi back".into()).await.unwrap();
        assert_eq!(c.recv().await, Some(WsFrame::Close(1000, "bye".into())));
        assert_eq!(c.recv().await, None, "one close, then nothing");
        let (pong, said, closed) = server.await.unwrap();
        assert_eq!(pong, (10, b"are you there".to_vec()), "a ping is answered with its bytes");
        assert_eq!(said, (1, b"hi back".to_vec()));
        assert_eq!(closed.0, 8, "the close is answered");
    }
}
