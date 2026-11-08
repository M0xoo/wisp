//! The harnesses' I/O for wisp.accounts (`HarnessSys`): their live-limit reads and sign-outs, over the
//! proc service; files with tokio. Mirrors wisp.runtime's own (plugins/runtime/host/src/sys.rs).

use std::path::PathBuf;
use std::time::Duration;

use wisp_kernel::{BoxFuture, Result, WireError};
use wisp_proc::{Env, ExecOpts, Proc};
use wisp_runtime_api::harness::{ExecOut, ExecReq, HarnessSys};

pub struct Sys(pub Proc);

impl HarnessSys for Sys {
    fn exec(&self, req: ExecReq) -> BoxFuture<'_, Result<ExecOut>> {
        let opts = ExecOpts {
            cwd: req.cwd.map(PathBuf::from),
            env: Env { set: req.env.into_iter().collect(), ..Env::default() },
            input: req.stdin,
            timeout: Some(Duration::from_millis(if req.timeout_ms == 0 { 30_000 } else { req.timeout_ms })),
            ..ExecOpts::default()
        };
        let fut = self.0.exec(&req.program, &req.args, opts);
        Box::pin(async move {
            let r = fut.await.map_err(|e| WireError::invalid(e.to_string()))?;
            Ok(ExecOut { code: r.exit.code, stdout: r.stdout_text(), stderr: r.stderr_text(), timed_out: r.timed_out })
        })
    }
    fn which(&self, program: &str) -> BoxFuture<'_, Option<String>> {
        let f = self.0.which(program, None);
        Box::pin(async move { f.await.map(|p| p.to_string_lossy().into_owned()) })
    }
    fn read_file(&self, path: &str) -> BoxFuture<'_, Option<String>> {
        let p = path.to_owned();
        Box::pin(async move { tokio::fs::read_to_string(p).await.ok() })
    }
    fn write_file(&self, path: &str, contents: String) -> BoxFuture<'_, Result<()>> {
        let p = PathBuf::from(path);
        Box::pin(async move { write_atomic(&p, contents.as_bytes()).await.map_err(|e| WireError::invalid(e.to_string())) })
    }
    fn list_dir(&self, path: &str) -> BoxFuture<'_, Vec<String>> {
        let p = path.to_owned();
        Box::pin(async move {
            let mut out = Vec::new();
            if let Ok(mut rd) = tokio::fs::read_dir(p).await {
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
        std::env::var("HOME").unwrap_or_default()
    }
    fn platform(&self) -> String {
        match std::env::consts::OS {
            "macos" => "darwin".into(),
            "windows" => "win32".into(),
            o => o.into(),
        }
    }
}

/// temp + rename, 0600: a CLI's login file is never left half written or readable by others.
pub async fn write_atomic(p: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(d) = p.parent() {
        tokio::fs::create_dir_all(d).await?;
    }
    let tmp = p.with_extension(format!("{}.tmp", std::process::id()));
    tokio::fs::write(&tmp, bytes).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600)).await?;
    }
    tokio::fs::rename(&tmp, p).await
}
