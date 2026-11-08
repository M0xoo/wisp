//! `HarnessSys` over the proc service and tokio's fs: the I/O harness plugins ask for outside a run
//! (detect, trust, has-session). Every call is async; nothing blocks a worker.

use std::path::PathBuf;
use std::time::Duration;

use wisp_kernel::{BoxFuture, Result, WireError};
use wisp_proc::{Env, ExecOpts, Proc};
use wisp_runtime_api::harness::{ExecOut, ExecReq, HarnessSys};

pub struct ProcSys {
    pub proc: Proc,
}

impl std::fmt::Debug for ProcSys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProcSys").finish_non_exhaustive()
    }
}

impl HarnessSys for ProcSys {
    fn exec(&self, req: ExecReq) -> BoxFuture<'_, Result<ExecOut>> {
        let opts = ExecOpts {
            cwd: req.cwd.map(PathBuf::from),
            env: Env {
                set: req.env.into_iter().collect(),
                ..Env::default()
            },
            input: req.stdin,
            timeout: Some(Duration::from_millis(if req.timeout_ms == 0 {
                30_000
            } else {
                req.timeout_ms
            })),
            ..ExecOpts::default()
        };
        let fut = self.proc.exec(&req.program, &req.args, opts);
        Box::pin(async move {
            let r = fut.await.map_err(WireError::from)?;
            Ok(ExecOut {
                code: r.exit.code,
                stdout: r.stdout_text(),
                stderr: r.stderr_text(),
                timed_out: r.timed_out,
            })
        })
    }
    fn which(&self, program: &str) -> BoxFuture<'_, Option<String>> {
        let fut = self.proc.which(program, None);
        Box::pin(async move { fut.await.map(|p| p.to_string_lossy().into_owned()) })
    }
    fn read_file(&self, path: &str) -> BoxFuture<'_, Option<String>> {
        let path = path.to_owned();
        Box::pin(async move { tokio::fs::read_to_string(path).await.ok() })
    }
    fn write_file(&self, path: &str, contents: String) -> BoxFuture<'_, Result<()>> {
        let path = PathBuf::from(path);
        Box::pin(async move {
            // temp + rename, so a crash never leaves the CLI's config half written
            let tmp = path.with_extension("wisp-tmp");
            tokio::fs::write(&tmp, contents)
                .await
                .map_err(|e| WireError::internal(e.to_string()))?;
            tokio::fs::rename(&tmp, &path)
                .await
                .map_err(|e| WireError::internal(e.to_string()))
        })
    }
    fn list_dir(&self, path: &str) -> BoxFuture<'_, Vec<String>> {
        let path = path.to_owned();
        Box::pin(async move {
            let mut out = Vec::new();
            if let Ok(mut rd) = tokio::fs::read_dir(path).await {
                while let Ok(Some(e)) = rd.next_entry().await {
                    out.push(e.file_name().to_string_lossy().into_owned());
                }
            }
            out
        })
    }
    fn env(&self, name: &str) -> Option<String> {
        std::env::var(name).ok()
    }
    fn home(&self) -> String {
        std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_default()
    }
    fn platform(&self) -> String {
        match std::env::consts::OS {
            "macos" => "darwin".into(),
            "windows" => "win32".into(),
            other => other.into(),
        }
    }
}
