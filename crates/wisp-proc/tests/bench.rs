//! Throughput of a child's output through the proc service (ADR-0011: measure, don't guess).
//!
//!   cargo test -p wisp-proc --release --test bench -- --ignored --nocapture
#![cfg(unix)]
#![allow(clippy::unwrap_used, clippy::cast_precision_loss, reason = "a bench")]

use std::time::Instant;

use wisp_proc::{PtySize, SpawnOpts};

const MB: usize = 256;

async fn throughput(pty: bool) -> f64 {
    let proc = wisp_proc::local();
    // `yes` lines (a terminal adds a \r to each \n): tr would cap it at 16 MB/s on its own.
    let script = format!(
        "yes 'wisp proc throughput 0123456789 abcdefghijklmnopqrstuvwxyz' | head -c {}",
        MB * 1024 * 1024
    );
    let opts = SpawnOpts {
        pty: pty.then_some(PtySize {
            cols: 200,
            rows: 50,
        }),
        ..SpawnOpts::default()
    };
    let start = Instant::now();
    let (h, mut out) = proc
        .spawn("sh", &["-c".to_owned(), script], opts)
        .unwrap()
        .split();
    let mut bytes = 0usize;
    while let Some(o) = out.recv().await {
        bytes += o.data.len();
    }
    h.exited().await;
    let mbs = bytes as f64 / 1_048_576.0 / start.elapsed().as_secs_f64();
    assert!(bytes >= MB * 1024 * 1024 * 99 / 100, "{bytes}");
    mbs
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "bench"]
async fn output_throughput() {
    let pty = throughput(true).await;
    let pipes = throughput(false).await;
    eprintln!("proc throughput ({MB} MB): PTY {pty:.0} MB/s, pipes {pipes:.0} MB/s");
}
