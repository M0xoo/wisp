//! "Type your password once" (`machines.letIn`): this computer's SSH key goes into
//! `~/.ssh/authorized_keys` over there, so ssh never asks again. The password reaches ssh only
//! through `SSH_ASKPASS` (an env var the helper prints): never stored, never logged, never in an
//! argv. A key is made (ed25519, no passphrase) when this computer has none.
use std::path::{Path, PathBuf};
use std::time::Duration;

use wisp_kernel::Ctx;
use wisp_kernel::services::Paths;
use wisp_machines_api::{Failing, LetInOut, PeerRow, PLUGIN, TransportFailure};
use wisp_machines_core::ssh::{self, LetInVerdict};
use wisp_proc::{Env, ExecOpts, Proc};

fn fail(status: u16, msg: impl Into<String>) -> TransportFailure {
    TransportFailure { status: Some(status), ..TransportFailure::new(msg) }
}

pub fn user_home() -> PathBuf {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map_or_else(std::env::temp_dir, PathBuf::from)
}

/// This computer's public key (made once if there is none), and whether it was made now.
async fn key(proc: &Proc, ssh_dir: &Path) -> Failing<(String, bool)> {
    for k in ssh::KEYS {
        if let Ok(text) = tokio::fs::read_to_string(ssh_dir.join(format!("{k}.pub"))).await {
            return Ok((text.trim().to_owned(), false));
        }
    }
    tokio::fs::create_dir_all(ssh_dir).await.map_err(|e| fail(500, e.to_string()))?;
    let file = ssh_dir.join(ssh::KEYS[0]);
    let host = std::env::var("HOSTNAME").unwrap_or_else(|_| "wisp".into());
    let r = proc.exec("ssh-keygen", &ssh::keygen_args(&file.display().to_string(), &host), ExecOpts::default()).await.map_err(|e| fail(500, e.to_string()))?;
    if !r.exit.success() {
        return Err(fail(500, format!("Couldn’t make an SSH key: {}", r.stderr_text().trim())));
    }
    let text = tokio::fs::read_to_string(file.with_extension("pub")).await.map_err(|e| fail(500, e.to_string()))?;
    Ok((text.trim().to_owned(), true))
}

/// The askpass helper, in the plugin's own folder (0700).
async fn askpass(ctx: &Ctx) -> Failing<PathBuf> {
    let dir = ctx.service::<Paths>().map(|p| p.plugin_dir(PLUGIN)).map_err(|e| fail(500, e.message))?;
    tokio::fs::create_dir_all(&dir).await.map_err(|e| fail(500, e.to_string()))?;
    let (name, text) = if cfg!(windows) { ("askpass.cmd", ssh::ASKPASS_CMD) } else { ("askpass.sh", ssh::ASKPASS_SH) };
    let file = dir.join(name);
    tokio::fs::write(&file, text).await.map_err(|e| fail(500, e.to_string()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o700)).await.map_err(|e| fail(500, e.to_string()))?;
    }
    Ok(file)
}

pub async fn let_in(ctx: Ctx, peer: PeerRow, password: String) -> Failing<LetInOut> {
    if password.is_empty() {
        return Err(fail(400, "Type the password you sign in to that computer with."));
    }
    let proc = ctx.service::<Proc>().map(|p| p.as_ref().clone()).map_err(|e| fail(500, e.message))?;
    let (pubkey, made_key) = key(&proc, &user_home().join(".ssh")).await?;
    let helper = askpass(&ctx).await?.display().to_string();
    let env = ssh::askpass_env(&helper, &password, std::env::var("DISPLAY").ok().as_deref());
    for (i, method) in ["password", "keyboard-interactive"].into_iter().enumerate() {
        let opts = ExecOpts { env: Env { set: env.clone(), ..Env::default() }, input: Some(format!("{pubkey}\n").into_bytes()), timeout: Some(Duration::from_secs(40)), scope: Some(ctx.scope().clone()), ..ExecOpts::default() };
        let r = proc.exec(crate::ssh::SSH_BIN, &ssh::let_in_args(&peer.address, method), opts).await.map_err(|e| fail(502, e.to_string()))?;
        let out = format!("{}{}", r.stdout_text(), r.stderr_text());
        match ssh::let_in_verdict((!r.timed_out).then_some(r.exit.code).flatten(), &out, i == 0) {
            LetInVerdict::Ok => return Ok(LetInOut { ok: true, made_key, machine: None }),
            LetInVerdict::TryKeyboard if i == 0 => {}
            LetInVerdict::TryKeyboard => return Err(fail(400, ssh::let_in_refusal(false))),
            LetInVerdict::TimedOut => return Err(fail(504, format!("{} didn’t answer in time.", peer.name))),
            LetInVerdict::Refused { passwords_off } => return Err(fail(400, ssh::let_in_refusal(passwords_off))),
            LetInVerdict::Other(line) => return Err(fail(502, line)),
        }
    }
    Err(fail(400, ssh::let_in_refusal(false)))
}
