//! Sign in to Claude once for every sandbox (ADR-0047, v1 Settings → Cloud → Sandboxes): `claude setup-token` runs on
//! a pty here, its link shows, the code from that page goes back in, and the long-lived token it prints goes to the
//! grid, sealed per user. Nothing is kept on this computer: the token passes through memory only.

use std::sync::{Arc, Mutex, PoisonError};

use wisp_kernel::{Call, Ctx, Result, WireError};
use wisp_proc::{ChildHandle, Proc, PtySize, SpawnOpts};
use wisp_sandbox_api::ClaudeSignIn;
use wisp_sandbox_core::{setup_link, setup_token};

#[derive(Default)]
pub struct Flow {
    child: Option<ChildHandle>,
    out: String,
    state: ClaudeSignIn,
}

pub type Shared = Arc<Mutex<Flow>>;

fn lock(f: &Shared) -> std::sync::MutexGuard<'_, Flow> {
    f.lock().unwrap_or_else(PoisonError::into_inner)
}

fn state(f: &Shared) -> ClaudeSignIn {
    lock(f).state.clone()
}

pub fn current(f: &Shared) -> ClaudeSignIn {
    let s = state(f);
    if s.state.is_empty() { ClaudeSignIn { state: "idle".into(), ..ClaudeSignIn::default() } } else { s }
}

async fn wait_for(ctx: &Ctx, f: &Shared, secs: u64, done: impl Fn(&Flow) -> bool) -> bool {
    let Ok(clock) = ctx.clock() else { return false };
    let until = clock.now_ms() + i64::try_from(secs * 1000).unwrap_or(i64::MAX);
    loop {
        if done(&lock(f)) {
            return true;
        }
        if clock.now_ms() > until {
            return false;
        }
        clock.sleep(200).await;
    }
}

/// Starts `claude setup-token` and waits for its link.
pub async fn begin(ctx: &Ctx, f: &Shared) -> Result<ClaudeSignIn> {
    let old = lock(f).child.take();
    if let Some(c) = old {
        let _ = c.kill().await;
    }
    *lock(f) = Flow { state: ClaudeSignIn { state: "waiting".into(), ..ClaudeSignIn::default() }, ..Flow::default() };
    let proc = ctx.service::<Proc>()?;
    let bin = std::env::var("WISP_CLAUDE_BIN").unwrap_or_else(|_| "claude".into());
    // wide, so the link isn't broken over lines
    let opts = SpawnOpts { pty: Some(PtySize { cols: 400, rows: 40 }), scope: Some(ctx.scope().clone()), ..SpawnOpts::default() };
    let child = proc.spawn(&bin, &["setup-token".to_owned()], opts).map_err(|e| WireError::unavailable(format!("Claude Code didn't start ({e}): install it first (Settings → Agents)")))?;
    let (handle, mut output) = child.split();
    lock(f).child = Some(handle);
    let reader = f.clone();
    ctx.spawn(async move {
        while let Some(o) = output.recv().await {
            let mut g = lock(&reader);
            g.out.push_str(&String::from_utf8_lossy(&o.data));
            if g.state.link.is_none()
                && let Some(link) = setup_link(&g.out)
            {
                g.state = ClaudeSignIn { state: "link".into(), link: Some(link), error: None };
            }
        }
        let mut g = lock(&reader);
        if g.state.state == "waiting" || g.state.state == "link" {
            g.state = ClaudeSignIn { state: "failed".into(), link: None, error: Some("Claude's sign-in ended before it gave a token.".into()) };
        }
    });
    if !wait_for(ctx, f, 30, |g| g.state.link.is_some() || g.state.state == "failed").await {
        return Err(WireError::unavailable("Claude's sign-in didn't show its link in 30 s."));
    }
    Ok(state(f))
}

/// The code from the sign-in page: the token Claude prints goes to the grid for every sandbox.
pub async fn code(ctx: &Ctx, call: &Call, f: &Shared, code: &str) -> Result<ClaudeSignIn> {
    let handle = lock(f).child.clone().ok_or_else(|| WireError::conflict("Start the sign-in first."))?;
    handle.write(format!("{}\r", code.trim())).map_err(|e| WireError::unavailable(format!("Claude's sign-in: {e}")))?;
    let got = wait_for(ctx, f, 60, |g| setup_token(&g.out).is_some() || g.state.state == "failed").await;
    let token = setup_token(&lock(f).out);
    let _ = handle.kill().await;
    lock(f).child = None;
    let Some(token) = token.filter(|_| got) else {
        lock(f).state = ClaudeSignIn { state: "failed".into(), link: None, error: Some("That code didn't sign in. Start again.".into()) };
        return Ok(state(f));
    };
    lock(f).out.clear();
    crate::calls::grid_login(ctx, call, "claude", &token).await?;
    lock(f).state = ClaudeSignIn { state: "done".into(), link: None, error: None };
    Ok(state(f))
}
