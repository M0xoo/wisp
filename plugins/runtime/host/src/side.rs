//! A run that is not a turn (v1 quick.js, btw.js): the harness's launch spawned through the proc
//! service, its output fed to the harness's driver, and the answer collected. Nothing is written to
//! the task's turns or activity; a timeout kills the process tree.

use std::time::Duration;

use wisp_proc::{Env, SpawnOpts, Stream};
use wisp_runtime_api::harness::{Exit, HarnessRun, ParserInput, ParserOutput, Stdin};
use wisp_runtime_api::{Harness, HarnessEvent};

use crate::error::{Result, RuntimeError};
use crate::runtime::Runtime;
use crate::sys::ProcSys;

/// What a side run answered.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SideOut {
    pub text: String,
    pub is_error: bool,
    pub cost_usd: Option<f64>,
    pub timed_out: bool,
}

fn take(out: ParserOutput, side: &mut SideOut, done: &mut bool) {
    for e in out.events {
        match e {
            HarnessEvent::Result { text, is_error, stats, .. } => {
                side.text = text;
                side.is_error = is_error;
                side.cost_usd = stats.and_then(|s| s.cost_usd);
                *done = true;
            }
            HarnessEvent::Text { text } if !*done => {
                side.text.push_str(&text);
            }
            _ => {}
        }
    }
}

impl Runtime {
    /// Runs `run` on `h` to its result, at most `timeout`.
    pub(crate) async fn side_run(&self, h: &dyn Harness, run: &HarnessRun, timeout: Duration) -> Result<SideOut> {
        let launch = h.launch(run)?;
        let opts = SpawnOpts {
            // a /btw runs where its task does; a quick answer with no folder in one empty folder of its own
            cwd: Some(
                crate::run::run_folder(&launch.cwd, &run.cwd, if run.session_id.is_empty() { "quick" } else { &run.session_id }).await?,
            ),
            env: Env {
                clear: false,
                set: run.env.iter().chain(&run.account_env).chain(&launch.env).map(|(k, v)| (k.clone(), v.clone())).collect(),
                remove: launch.env_remove.clone(),
            },
            no_stdin: launch.stdin == Stdin::Null,
            ..SpawnOpts::default()
        };
        let child = self.proc.spawn(&launch.program, &launch.args, opts)?;
        let (handle, mut rx) = child.split();
        if let Stdin::Bytes(b) = &launch.stdin {
            handle.write(b.clone())?;
            handle.close_stdin();
        }
        let sys = ProcSys { proc: self.proc.clone() };
        let mut driver = h.driver(run);
        let (mut side, mut done) = (SideOut::default(), false);
        let (mut buf, mut stderr) = (Vec::<u8>::new(), String::new());
        // the deadline on the kernel's clock (a test's FakeClock drives it)
        let deadline = self.clock.sleep(u64::try_from(timeout.as_millis()).unwrap_or(u64::MAX));
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                o = rx.recv() => match o {
                    Some(o) if o.stream == Stream::Stderr => stderr.push_str(&String::from_utf8_lossy(&o.data)),
                    Some(o) => {
                        buf.extend_from_slice(&o.data);
                        while let Some(i) = buf.iter().position(|&b| b == b'\n') {
                            let line: Vec<u8> = buf.drain(..=i).collect();
                            let line = String::from_utf8_lossy(&line[..line.len() - 1]).trim_end_matches('\r').to_owned();
                            let mut out = ParserOutput::default();
                            driver.on(ParserInput::Stdout(&line), self.now(), &sys, &mut out).await;
                            for w in std::mem::take(&mut out.writes) {
                                let _ = handle.write(w);
                            }
                            take(out, &mut side, &mut done);
                        }
                        if done {
                            break;
                        }
                    }
                    None => break,
                },
                () = &mut deadline => {
                    side.timed_out = true;
                    break;
                }
            }
        }
        if handle.running() {
            let _ = handle.kill().await;
        }
        let exit = handle.exited().await;
        if !done && !side.timed_out {
            let x = Exit { code: exit.code, signal: exit.signal, stderr: stderr.trim().to_owned(), stopped: false, stop_requested: false };
            let mut out = ParserOutput::default();
            driver.on(ParserInput::Exit(&x), self.now(), &sys, &mut out).await;
            take(out, &mut side, &mut done);
        }
        if side.timed_out {
            return Err(RuntimeError::Conflict(format!("It took over {} s and was stopped.", timeout.as_secs())));
        }
        Ok(side)
    }
}
