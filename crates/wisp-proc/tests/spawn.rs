//! The real proc service on this computer: pipes, PTYs, exec, scopes and tree kills.
#![cfg(unix)]
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "a test: failing loudly is the point"
)]

mod common;

use std::path::PathBuf;
use std::time::Duration;

use common::{args, read_until, sh, tree_of};
use tokio_util::sync::CancellationToken;
use wisp_proc::{Env, ExecOpts, ProcError, PtySize, Signal, SpawnOpts, Stream};

#[tokio::test]
async fn pipes_carry_input_output_and_the_exit_code() {
    let proc = wisp_proc::local();
    let child = proc
        .spawn(
            "sh",
            &args(&["-c", "read l; echo \"got $l\"; echo oops >&2; exit 3"]),
            SpawnOpts::default(),
        )
        .unwrap();
    let (h, mut out) = child.split();
    h.write(b"hello\n".to_vec()).unwrap();
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    while let Some(o) = out.recv().await {
        if o.stream == Stream::Stdout {
            stdout.extend(o.data);
        } else {
            stderr.extend(o.data);
        }
    }
    let exit = h.exited().await;
    assert_eq!(String::from_utf8(stdout).unwrap(), "got hello\n");
    assert_eq!(String::from_utf8(stderr).unwrap(), "oops\n");
    assert_eq!(exit.code, Some(3));
    assert_eq!(proc.live(), 0);
}

#[tokio::test]
async fn a_missing_cli_is_an_error_not_a_panic() {
    // v1 proc.test.js: "spawn() reports a missing CLI as an error event, not a throw"
    let proc = wisp_proc::local();
    let err = proc
        .spawn(
            "definitely-not-a-real-cli-wisp",
            &args(&["--version"]),
            SpawnOpts::default(),
        )
        .unwrap_err();
    assert!(matches!(err, ProcError::NotFound(_)), "{err:?}");
    let pty = SpawnOpts {
        pty: Some(PtySize { cols: 80, rows: 24 }),
        ..SpawnOpts::default()
    };
    assert!(matches!(
        proc.spawn("definitely-not-a-real-cli-wisp", &[], pty)
            .unwrap_err(),
        ProcError::NotFound(_)
    ));
    let gone = SpawnOpts {
        cwd: Some(PathBuf::from("/no/such/folder/wisp")),
        ..SpawnOpts::default()
    };
    assert!(
        matches!(
            proc.spawn("sh", &[], gone).unwrap_err(),
            ProcError::NoFolder(_)
        ),
        "a wrong folder fails, never falls back to $HOME"
    );
}

#[tokio::test]
async fn which_finds_programs_on_path() {
    let proc = wisp_proc::local();
    assert!(proc.which("sh", None).await.unwrap().is_absolute());
    assert_eq!(
        proc.which("definitely-not-a-real-cli-wisp", None).await,
        None
    );
    let only = vec![("PATH".to_owned(), "/nowhere".to_owned())];
    assert_eq!(
        proc.which("sh", Some(only)).await,
        None,
        "the PATH given, not wisp's"
    );
}

#[tokio::test]
async fn env_is_patched_cwd_is_honoured() {
    let proc = wisp_proc::local();
    let dir = std::env::temp_dir().canonicalize().unwrap();
    let env = Env::default().with("WISP_T", "yes").without("HOME");
    let r = proc
        .exec(
            "sh",
            &args(&["-c", "echo \"$WISP_T|${HOME-unset}|$(pwd -P)\""]),
            ExecOpts {
                env,
                cwd: Some(dir.clone()),
                ..ExecOpts::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(
        r.stdout_text().trim(),
        format!("yes|unset|{}", dir.display())
    );
}

#[tokio::test]
async fn exec_keeps_output_to_its_cap_and_kills_on_timeout() {
    let proc = wisp_proc::local();
    let r = proc
        .exec(
            "sh",
            &args(&["-c", "head -c 100000 /dev/zero"]),
            ExecOpts {
                max_output: 1000,
                ..ExecOpts::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(
        (r.stdout.len(), r.truncated, r.exit.code),
        (1000, true, Some(0))
    );
    let r = proc
        .exec(
            "sh",
            &args(&["-c", "echo started; sleep 30"]),
            ExecOpts {
                timeout: Some(Duration::from_millis(300)),
                ..ExecOpts::default()
            },
        )
        .await
        .unwrap();
    assert!(r.timed_out);
    assert_eq!(r.exit.signal.as_deref(), Some("SIGKILL"));
    assert_eq!(r.stdout_text(), "started\n");
    let r = proc
        .exec(
            "cat",
            &[],
            ExecOpts {
                input: Some(b"piped in".to_vec()),
                ..ExecOpts::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(r.stdout_text(), "piped in");
}

#[tokio::test]
async fn a_background_grandchild_holding_the_pipe_does_not_hold_the_exit() {
    let proc = wisp_proc::local();
    let start = std::time::Instant::now();
    let r = proc
        .exec(
            "sh",
            &args(&["-c", "sleep 5 & echo done"]),
            ExecOpts::default(),
        )
        .await
        .unwrap();
    assert_eq!(r.stdout_text(), "done\n");
    assert!(
        start.elapsed() < Duration::from_secs(3),
        "{:?}",
        start.elapsed()
    );
    proc.kill_all(Duration::from_millis(100)).await;
}

#[tokio::test]
async fn a_pty_has_its_size_from_the_first_line_and_takes_a_resize() {
    // v1 pty.test.js: "the program sees its size from its first line, however late the helper sets it"
    let proc = wisp_proc::local();
    let opts = SpawnOpts {
        pty: Some(PtySize { cols: 91, rows: 27 }),
        ..SpawnOpts::default()
    };
    let child = proc
        .spawn(
            "sh",
            &args(&["-c", "stty size; read l; stty size; echo \"in:$l\""]),
            opts,
        )
        .unwrap();
    let (h, mut out) = child.split();
    let mut seen = read_until(&mut out, "27 91").await;
    h.resize(PtySize {
        cols: 120,
        rows: 40,
    })
    .unwrap();
    h.write(b"typed\r".to_vec()).unwrap();
    seen.push_str(&read_until(&mut out, "in:typed").await);
    assert!(seen.contains("40 120"), "{seen:?}");
    assert_eq!(h.exited().await.code, Some(0));
    assert!(
        h.resize(PtySize { cols: 1, rows: 1 }).is_err(),
        "no resize after the exit"
    );
}

#[tokio::test]
async fn a_big_paste_goes_in_whole_while_the_program_prints() {
    // v1 pty.test.js: "a big paste goes in whole while the program prints (no hang)": cat echoes
    // every line back while 200 KB are still going in, so input and output must not wait on each other.
    let proc = wisp_proc::local();
    let opts = SpawnOpts {
        pty: Some(PtySize { cols: 80, rows: 24 }),
        ..SpawnOpts::default()
    };
    let (h, mut out) = proc.spawn("cat", &[], opts).unwrap().split();
    let text: String = (0..4000)
        .map(|i| format!("pasted line {i} {}\r", "x".repeat(40)))
        .collect();
    h.write(text.into_bytes()).unwrap();
    read_until(&mut out, "pasted line 3999").await;
    assert_eq!(h.kill().await.survivors, 0);
}

#[tokio::test]
async fn cancelling_the_scope_kills_the_tree() {
    let proc = wisp_proc::local();
    let scope = CancellationToken::new();
    let child = proc
        .spawn(
            "sh",
            &args(&["-c", &sh::tree()]),
            SpawnOpts {
                scope: Some(scope.clone()),
                grace: Some(Duration::from_millis(200)),
                ..SpawnOpts::default()
            },
        )
        .unwrap();
    let (h, mut out) = child.split();
    read_until(&mut out, "ready").await;
    let members = tree_of(h.pid());
    assert!(members.len() >= 4, "{members:?}");
    scope.cancel();
    let exit = tokio::time::timeout(Duration::from_secs(5), h.exited())
        .await
        .unwrap();
    assert!(exit.signal.is_some(), "{exit:?}");
    common::assert_all_gone(&members).await;
}

#[tokio::test]
async fn signal_int_reaches_the_tree_and_kill_reports_zero_survivors() {
    let proc = wisp_proc::local();
    let opts = SpawnOpts {
        pty: Some(PtySize { cols: 80, rows: 24 }),
        grace: Some(Duration::from_millis(200)),
        ..SpawnOpts::default()
    };
    let child = proc.spawn("sh", &args(&["-c", &sh::tree()]), opts).unwrap();
    let (h, mut out) = child.split();
    read_until(&mut out, "ready").await;
    let members = tree_of(h.pid());
    h.signal(Signal::Int, true).unwrap();
    let report = h.kill().await;
    assert_eq!(report.survivors, 0, "{report:?}");
    common::assert_all_gone(&members).await;
    assert!(
        h.signal(Signal::Term, false).is_err(),
        "a reaped root is never signalled by pid"
    );
}
