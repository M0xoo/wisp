//! Bench (plan §8, ADR-0011): status and Changes on a 1,000-file change, and how late a ticking task
//! runs while 8 Changes reads run at once on 2 runtime workers (nothing may block a worker).
//! Run: `cargo test -p wisp-git --release --test bench -- --ignored --nocapture`.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::assert_is_empty,
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::many_single_char_names,
    clippy::range_plus_one,
    clippy::format_push_string,
    clippy::needless_pass_by_value,
    clippy::needless_lifetimes,
    clippy::elidable_lifetime_names,
    clippy::option_option,
    clippy::doc_markdown,
    clippy::map_unwrap_or,
    clippy::format_collect,
    clippy::print_stdout,
    clippy::cast_precision_loss
)]

mod common;

use std::time::{Duration, Instant};

use common::*;
use wisp_git_api::GitService;
use wisp_git_api::commands::ChangesArgs;

fn pct(v: &mut [f64], p: f64) -> f64 {
    v.sort_by(f64::total_cmp);
    v[((v.len() as f64 - 1.0) * p).round() as usize]
}

fn thousand_file_change(t: &Tmp) -> std::path::PathBuf {
    let dir = repo(t);
    for i in 0..1000 {
        let body: String = (0..40).map(|l| format!("file {i} line {l}\n")).collect();
        write(&dir, &format!("src/m{}/f{i}.rs", i % 20), &body);
    }
    git(&dir, &["add", "-A"]);
    git(&dir, &["commit", "-q", "-m", "1000 files"]);
    git(&dir, &["push", "-q", "origin", "main"]);
    for i in 0..1000 {
        let body: String = (0..40)
            .map(|l| {
                if l % 10 == 3 {
                    format!("CHANGED {i} {l}\n")
                } else {
                    format!("file {i} line {l}\n")
                }
            })
            .collect();
        write(&dir, &format!("src/m{}/f{i}.rs", i % 20), &body);
    }
    for i in 0..50 {
        write(&dir, &format!("new/n{i}.txt"), "new\nfile\n");
    }
    dir
}

/// A 1 ms ticker's lateness (ms) until `stop` is set.
fn ticker(
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> tokio::task::JoinHandle<Vec<f64>> {
    tokio::spawn(async move {
        let mut late = Vec::new();
        while !stop.load(std::sync::atomic::Ordering::SeqCst) {
            let a = Instant::now();
            tokio::time::sleep(Duration::from_millis(1)).await;
            late.push((a.elapsed().as_secs_f64() * 1000.0 - 1.0).max(0.0));
        }
        late
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "bench: run with --ignored --nocapture"]
async fn bench_status_and_changes_on_1000_files() {
    let t = tmp("bench");
    let dir = thousand_file_change(&t);
    let (svc, s) = service();
    let o = owner();
    let r = s.repo(&user(), &o, dir.to_str().unwrap()).await.unwrap();
    let args = ChangesArgs {
        path: dir.display().to_string(),
        base: "origin/main".into(),
        reveal: vec![],
        mask: true,
        stage_state: true,
        inline: true,
    };
    let (mut st, mut ch) = (Vec::new(), Vec::new());
    for _ in 0..15 {
        let a = Instant::now();
        let status = r.status(&user()).await.unwrap();
        st.push(a.elapsed().as_secs_f64() * 1000.0);
        assert_eq!(status.dirty(), 1001);
        let a = Instant::now();
        let c = wisp_git::commands::changes(&svc, args.clone())
            .await
            .unwrap()
            .unwrap();
        ch.push(a.elapsed().as_secs_f64() * 1000.0);
        assert_eq!(c.stats.len(), 1050);
    }
    println!(
        "status 1,000 changed + 50 new: p50 {:.1} ms, p95 {:.1} ms",
        pct(&mut st, 0.5),
        pct(&mut st, 0.95)
    );
    println!(
        "changes (diff + untracked + stage state + mask): p50 {:.1} ms, p95 {:.1} ms",
        pct(&mut ch, 0.5),
        pct(&mut ch, 0.95)
    );

    // the same ticker idle first, so a busy machine (other builds) doesn't read as blocking
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let idle = ticker(stop.clone());
    tokio::time::sleep(Duration::from_millis(600)).await;
    stop.store(true, std::sync::atomic::Ordering::SeqCst);
    let mut base = idle.await.unwrap();
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let busy = ticker(stop.clone());
    let started = Instant::now();
    let loads: Vec<_> = (0..8)
        .map(|_| {
            let (svc, args) = (svc.clone(), args.clone());
            tokio::spawn(async move { wisp_git::commands::changes(&svc, args).await.unwrap() })
        })
        .collect();
    for l in loads {
        l.await.unwrap();
    }
    let load_ms = started.elapsed().as_secs_f64() * 1000.0;
    stop.store(true, std::sync::atomic::Ordering::SeqCst);
    let mut late = busy.await.unwrap();
    let (b99, l99) = (pct(&mut base, 0.99), pct(&mut late, 0.99));
    println!(
        "ticker idle: p50 {:.2} ms, p99 {b99:.2} ms over {} ticks",
        pct(&mut base, 0.5),
        base.len()
    );
    println!(
        "8 concurrent changes: {load_ms:.0} ms wall; ticker p50 {:.2} ms, p99 {l99:.2} ms, max {:.2} ms over {} ticks",
        pct(&mut late, 0.5),
        pct(&mut late, 1.0),
        late.len()
    );
    assert!(
        l99 - b99 < 10.0,
        "a runtime worker was blocked: p99 {l99:.1} ms against {b99:.1} ms idle"
    );
}
