//! Reading a point's contributions while plugins switch off and on never deadlocks (DESK2-05: a quit switches every
//! plugin off while ticks and commands read contributions; the registry read was held while waiting on the plugins'
//! lock, which `plan` holds while it waits on the registry's write).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::json;
use wisp_kernel::{Point, PluginGroup};

static WORDS: Point<str> = Point::new("lock.words", 1);

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn contributions_read_while_plugins_switch_off_and_on_never_deadlock() {
    let a = common::plugin("wisp.locka", json!({}), |s| s.contribute(&WORDS, Arc::from("a")));
    let b = common::plugin("wisp.lockb", json!({}), |s| s.contribute(&WORDS, Arc::from("b")));
    let k = Arc::new(common::start(PluginGroup::new().add(a).add(b)).await);
    let stop = Arc::new(AtomicBool::new(false));
    // a deadlock blocks the thread the timer runs on: a watchdog thread fails the run instead of hanging CI
    let finished = Arc::new(AtomicBool::new(false));
    let watch = finished.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(30));
        if !watch.load(Ordering::Relaxed) {
            eprintln!("deadlock: switching a plugin off and on hung while its point was read (lock order)");
            std::process::abort();
        }
    });
    let readers: Vec<_> = (0..3)
        .map(|_| {
            let (k, stop) = (k.clone(), stop.clone());
            std::thread::spawn(move || {
                let mut n = 0usize;
                while !stop.load(Ordering::Relaxed) {
                    n += k.contributions(&WORDS).len();
                }
                n
            })
        })
        .collect();
    let toggles = async {
        for _ in 0..200 {
            k.set_enabled("wisp.lockb", false).await.unwrap();
            k.set_enabled("wisp.lockb", true).await.unwrap();
        }
    };
    let done = tokio::time::timeout(Duration::from_secs(20), toggles).await;
    stop.store(true, Ordering::Relaxed);
    assert!(done.is_ok(), "switching a plugin off and on hung while its point was read (lock order)");
    for r in readers {
        assert!(r.join().unwrap() > 0);
    }
    assert_eq!(k.contributions(&WORDS).len(), 2);
    finished.store(true, Ordering::Relaxed);
}
