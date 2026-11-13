//! Signing in from wisp (v1 agent-login.js): the CLI's own login (`Harness::login()`), run through the
//! proc service without a terminal, its output read for a link, a one-time code and whether it waits
//! for a code pasted back. One sign-in per harness and account at a time; it gives up after 15
//! minutes. Each change is an `accounts_login` row; a finished one tells the runtime, which runs the
//! turn a sign-in card was waiting on again.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use wisp_accounts_api::{LoginState, LoginStatus, LoginView};
use wisp_accounts_core::login::{MAX_OUT, TIMEOUT_MS, account_key, last_line, parse, tail};
use wisp_accounts_core::{accounts, login};
use wisp_kernel::{Ctx, WireError};
use wisp_proc::{Env, ExecOpts, SpawnOpts, Stream};
use wisp_runtime_api::Harness;
use wisp_runtime_api::harness::HarnessLogin;

use crate::{State, folders, lock, now, store};

#[derive(Debug, Clone)]
struct Flow {
    view: LoginView,
    out: String,
    /// what the CLI said since a code was pasted (None: nothing pasted)
    after: Option<String>,
    handle: Option<wisp_proc::ChildHandle>,
}

#[derive(Debug, Default)]
pub struct Flows(Mutex<HashMap<String, Flow>>);

/// The login row's id: the harness id for the CLI's own login, `agent@account` for another.
pub fn login_id(agent: &str, acc: &str) -> String {
    let acc = account_key(acc);
    if acc.is_empty() { agent.to_owned() } else { format!("{agent}@{acc}") }
}

fn spec(h: &dyn Harness) -> Result<&HarnessLogin, WireError> {
    h.login()
        .ok_or_else(|| WireError::invalid(format!("wisp can’t sign in to {} for you yet: run its login in a terminal.", h.info().name)))
}

fn bin(l: &HarnessLogin) -> String {
    std::env::var(&l.bin_env).ok().filter(|b| !b.is_empty()).unwrap_or_else(|| l.bin.clone())
}

/// The env a sign-in on that account needs ({} for the CLI's own).
async fn env_of(st: &State, h: &dyn Harness, acc: &str) -> Result<Vec<(String, String)>, WireError> {
    let acc = account_key(acc);
    let (Some(spec), false) = (h.accounts(), acc.is_empty()) else { return Ok(Vec::new()) };
    let agent = h.info().id.clone();
    if !lock(&st.accounts).get(&agent).is_some_and(|l| l.iter().any(|a| a.id == acc)) {
        return Err(WireError::not_found("No such account."));
    }
    let dir = folders::prepare(&st.home, &agent, spec, acc).await.map_err(|e| WireError::invalid(e.to_string()))?;
    Ok(vec![(spec.env.clone(), dir.to_string_lossy().into_owned())])
}

async fn put(st: &State, id: String, v: LoginView) {
    let _ = st.store.write(move |w| store::put_login(w, &id, &v)).await;
}

pub fn view(st: &State, agent: &str, acc: &str) -> LoginView {
    lock(&st.flows.0).get(&login_id(agent, acc)).map_or_else(|| LoginView::idle(agent, account_key(acc)), |f| f.view.clone())
}

/// Every sign-in wisp knows of, by its row id.
pub fn all(st: &State) -> Vec<(String, LoginView)> {
    lock(&st.flows.0).iter().map(|(k, f)| (k.clone(), f.view.clone())).collect()
}

/// Signed in or not, and as whom; kept on the account for the page.
pub async fn status(ctx: &Ctx, st: &State, h: &dyn Harness, acc: &str) -> Result<LoginStatus, WireError> {
    let l = spec(h)?;
    let agent = h.info().id.clone();
    let mut out = LoginStatus { agent: agent.clone(), account: account_key(acc).to_owned(), signed_in: None, email: None, plan: None };
    if l.status.is_empty() {
        return Ok(out);
    }
    let env = env_of(st, h, acc).await?;
    let r = st
        .proc
        .exec(
            &bin(l),
            &l.status,
            ExecOpts {
                env: Env { clear: false, set: env, remove: Vec::new() },
                timeout: Some(std::time::Duration::from_secs(8)),
                ..ExecOpts::default()
            },
        )
        .await;
    let (text, code) = match r {
        Ok(r) => (login::clean(&format!("{}{}", r.stdout_text(), String::from_utf8_lossy(&r.stderr))), r.exit.code),
        Err(e) => (e.to_string(), Some(-1)),
    };
    out.signed_in = h.signed_in(&text, code);
    if out.signed_in == Some(true)
        && let Some((email, plan)) = h.who_is(&text)
    {
        out.email = email;
        out.plan = plan;
    }
    if out.signed_in.is_some() {
        let list = {
            let mut map = lock(&st.accounts);
            map.get_mut(&agent).filter(|l| accounts::multi(l)).map(|list| {
                accounts::identify(list, account_key(acc), out.email.as_deref(), out.plan.as_deref(), out.signed_in);
                list.clone()
            })
        };
        if let Some(l2) = list {
            let a = agent.clone();
            let _ = st.store.write(move |w| store::put_accounts(w, &a, &l2)).await;
        }
    }
    let _ = ctx;
    Ok(out)
}

/// The login's command line on this OS (see [`argv_for`]).
fn argv_of(l: &HarnessLogin) -> (String, Vec<String>) {
    argv_for(l, std::env::consts::OS)
}

/// The login's command line on `os`: under util-linux script(1) on Linux when the CLI only asks on a
/// terminal (v1 `loginArgv`): `script -q -f -e -c '<bin> <args…>' /dev/null` (options and the one
/// quoted command first, the typescript file last; BSD script's `script -q file cmd…` order is not
/// used, macOS runs the CLI as it is, like v1). Elsewhere as it is.
fn argv_for(l: &HarnessLogin, os: &str) -> (String, Vec<String>) {
    if l.tty && os == "linux" {
        let q = |s: &str| format!("'{}'", s.replace('\'', "'\\''"));
        let line = std::iter::once(bin(l)).chain(l.args.iter().cloned()).map(|a| q(&a)).collect::<Vec<_>>().join(" ");
        return ("script".into(), ["-q", "-f", "-e", "-c"].iter().map(|s| (*s).to_owned()).chain([line, "/dev/null".into()]).collect());
    }
    (bin(l), l.args.clone())
}

/// Starts the CLI's own login (or answers the one already going).
#[allow(clippy::many_single_char_names, clippy::too_many_lines)] // v1 agent-login `start`, one flow
pub async fn start(ctx: &Ctx, st: &Arc<State>, h: Arc<dyn Harness>, acc: &str) -> Result<LoginView, WireError> {
    let l = spec(h.as_ref())?.clone();
    let agent = h.info().id.clone();
    let id = login_id(&agent, acc);
    if let Some(f) = lock(&st.flows.0).get(&id).filter(|f| f.view.state.live()) {
        return Ok(f.view.clone());
    }
    let mut env = env_of(st, h.as_ref(), acc).await?;
    env.extend(l.extra_env.iter().map(|(k, v)| (k.clone(), v.clone())));
    env.extend([("BROWSER", "false"), ("TERM", "dumb"), ("COLUMNS", "400")].map(|(k, v)| (k.to_owned(), v.to_owned())));
    let (program, argv) = argv_of(&l);
    let child = st
        .proc
        .spawn(&program, &argv, SpawnOpts { env: Env { clear: false, set: env, remove: Vec::new() }, ..SpawnOpts::default() })
        .map_err(|e| WireError::invalid(format!("Couldn’t run {}: {e}", l.bin)))?;
    let (handle, mut rx) = child.split();
    let mut v = LoginView::idle(&agent, account_key(acc));
    v.state = LoginState::Running;
    v.started_at = Some(now(ctx));
    lock(&st.flows.0).insert(id.clone(), Flow { view: v.clone(), out: String::new(), after: None, handle: Some(handle.clone()) });
    put(st, id.clone(), v.clone()).await;
    let (st2, ctx2, acc2) = (st.clone(), ctx.clone(), acc.to_owned());
    ctx.spawn(async move {
        let deadline = ctx2.clock().map(|c| c.sleep(u64::try_from(TIMEOUT_MS).unwrap_or(u64::MAX)));
        let Ok(deadline) = deadline else { return };
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                o = rx.recv() => match o {
                    Some(o) => {
                        let _ = o.stream == Stream::Stdout;
                        let text = String::from_utf8_lossy(&o.data).into_owned();
                        let changed = {
                            let mut map = lock(&st2.flows.0);
                            let Some(f) = map.get_mut(&id) else { return };
                            f.out.push_str(&text);
                            if f.out.len() > MAX_OUT { f.out = f.out[f.out.len() - MAX_OUT..].to_owned(); }
                            if let Some(a) = f.after.as_mut() { a.push_str(&text); }
                            let p = parse(&f.out);
                            let was = (f.view.url.clone(), f.view.code.clone(), f.view.needs_input);
                            if !p.url.is_empty() { f.view.url = Some(p.url); }
                            if !p.code.is_empty() { f.view.code = Some(p.code); }
                            f.view.needs_input = Some(f.after.as_deref().map_or(p.needs_input, |a| parse(a).needs_input));
                            if f.view.url.is_some() && f.view.state == LoginState::Running { f.view.state = LoginState::Waiting; }
                            f.view.output = Some(tail(&f.out, 6));
                            (was != (f.view.url.clone(), f.view.code.clone(), f.view.needs_input)).then(|| f.view.clone())
                        };
                        if let Some(v) = changed { put(&st2, id.clone(), v).await; }
                    }
                    None => break,
                },
                () = &mut deadline => {
                    finish(&ctx2, &st2, &id, &agent, &acc2, LoginState::Failed, Some("Sign-in timed out. Start again.".into())).await;
                    let _ = handle.kill().await;
                    return;
                }
            }
        }
        let exit = handle.exited().await;
        // trust the CLI's own status over its exit code when it has one
        let ok = if l.status.is_empty() {
            exit.code == Some(0)
        } else {
            status(&ctx2, &st2, h.as_ref(), &acc2).await.ok().and_then(|s| s.signed_in) == Some(true)
        };
        let why = (!ok).then(|| {
            let out = lock(&st2.flows.0).get(&id).map(|f| f.out.clone()).unwrap_or_default();
            last_line(&out)
                .unwrap_or_else(|| format!("{} exited ({}).", l.bin, exit.code.map_or_else(|| "signal".into(), |c| c.to_string())))
        });
        finish(&ctx2, &st2, &id, &agent, &acc2, if ok { LoginState::Done } else { LoginState::Failed }, why).await;
    });
    Ok(v)
}

async fn finish(ctx: &Ctx, st: &State, id: &str, agent: &str, acc: &str, state: LoginState, error: Option<String>) {
    let v = {
        let mut map = lock(&st.flows.0);
        let Some(f) = map.get_mut(id).filter(|f| f.view.state.live()) else { return };
        f.view.state = state;
        f.view.error = error;
        f.view.checking = None;
        f.handle = None;
        f.view.clone()
    };
    put(st, id.to_owned(), v).await;
    let step = match state {
        LoginState::Done => "done",
        LoginState::Cancelled => "cancelled",
        _ => "failed",
    };
    let _ = ctx
        .run_json(
            &ctx.root_call(),
            "telemetry.track",
            serde_json::json!({ "event": "agent_login", "props": { "agent": agent, "step": step } }),
        )
        .await;
    if state == LoginState::Done {
        // the turn a sign-in card waits on runs again
        let _ =
            ctx.run_json(&ctx.root_call(), "runtime.signInDone", serde_json::json!({ "agent": agent, "account": account_key(acc) })).await;
    }
}

/// The code the sign-in page showed, pasted back into the CLI.
pub async fn input(st: &State, agent: &str, acc: &str, code: &str) -> Result<LoginView, WireError> {
    let v = code.trim();
    if v.is_empty() || v.len() > 4000 || v.contains(['\r', '\n']) {
        return Err(WireError::invalid("Paste the code the sign-in page showed."));
    }
    let id = login_id(agent, acc);
    let view = {
        let mut map = lock(&st.flows.0);
        let f = map.get_mut(&id).filter(|f| f.view.state.live()).ok_or_else(|| WireError::conflict("No sign-in is waiting for a code."))?;
        if let Some(h) = &f.handle {
            h.write(format!("{v}\n").into_bytes()).map_err(|e| WireError::invalid(e.to_string()))?;
        }
        f.view.needs_input = Some(false);
        f.view.checking = Some(true);
        f.after = Some(String::new());
        f.view.clone()
    };
    put(st, id, view.clone()).await;
    Ok(view)
}

pub async fn cancel(ctx: &Ctx, st: &State, agent: &str, acc: &str) -> LoginView {
    let id = login_id(agent, acc);
    let handle = lock(&st.flows.0).get(&id).and_then(|f| f.handle.clone());
    finish(ctx, st, &id, agent, acc, LoginState::Cancelled, None).await;
    if let Some(h) = handle {
        let _ = h.kill().await;
    }
    view(st, agent, acc)
}

/// The CLI's own sign-out. Refused while a key in wisp's environment signs it in.
pub async fn logout(ctx: &Ctx, st: &State, h: &dyn Harness, acc: &str) -> Result<LoginStatus, WireError> {
    let l = spec(h)?;
    if let Some(k) = l.keys.iter().find(|k| std::env::var(k).is_ok_and(|v| !v.is_empty())) {
        return Err(WireError::invalid(format!("{} is signed in with {k}: remove it from wisp's environment to sign out.", l.bin)));
    }
    if l.logout.is_empty() {
        let sys = crate::sys::Sys(st.proc.clone());
        let Some(out) = h.sign_out(&sys) else {
            return Err(WireError::invalid(format!("{} has no sign-out command: run it in a terminal and sign out there.", l.bin)));
        };
        out.await?;
        // gone from where we know to look; if the CLI still says signed in, it kept it elsewhere
        if status(ctx, st, h, acc).await.ok().and_then(|s| s.signed_in) == Some(true) {
            return Err(WireError::invalid(format!("{} is still signed in: run {} in a terminal and type /logout.", l.bin, l.bin)));
        }
        return Ok(LoginStatus {
            agent: h.info().id.clone(),
            account: account_key(acc).to_owned(),
            signed_in: Some(false),
            email: None,
            plan: None,
        });
    }
    let env = env_of(st, h, acc).await?;
    let r = st
        .proc
        .exec(
            &bin(l),
            &l.logout,
            ExecOpts {
                env: Env { clear: false, set: env, remove: Vec::new() },
                timeout: Some(std::time::Duration::from_secs(15)),
                ..ExecOpts::default()
            },
        )
        .await
        .map_err(|e| WireError::invalid(e.to_string()))?;
    if r.exit.code != Some(0) {
        let out = format!("{}{}", r.stdout_text(), String::from_utf8_lossy(&r.stderr));
        return Err(WireError::invalid(last_line(&out).unwrap_or_else(|| format!("{} exited ({:?}).", l.bin, r.exit.code))));
    }
    let agent = h.info().id.clone();
    let id = login_id(&agent, acc);
    if lock(&st.flows.0).get(&id).is_some_and(|f| !f.view.state.live()) {
        lock(&st.flows.0).remove(&id);
        put(st, id, LoginView::idle(&agent, account_key(acc))).await;
    }
    let list = {
        let mut map = lock(&st.accounts);
        map.get_mut(&agent).filter(|l| accounts::multi(l)).map(|list| {
            accounts::identify(list, account_key(acc), None, None, Some(false));
            list.clone()
        })
    };
    if let Some(l2) = list {
        let a = agent.clone();
        let _ = st.store.write(move |w| store::put_accounts(w, &a, &l2)).await;
    }
    let _ = ctx;
    Ok(LoginStatus { agent, account: account_key(acc).to_owned(), signed_in: Some(false), email: None, plan: None })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| (*s).to_owned()).collect()
    }

    fn agy() -> HarnessLogin {
        HarnessLogin {
            bin: "agy".into(),
            bin_env: "WISP_TEST_NO_AGY_BIN".into(),
            args: v(&["-p", "Reply with OK."]),
            tty: true,
            ..HarnessLogin::default()
        }
    }

    #[test]
    fn a_login_that_asks_on_a_terminal_gets_one_on_linux() {
        let (p, a) = argv_of(&agy());
        assert_eq!((p, a), argv_for(&agy(), std::env::consts::OS));
        assert_eq!(login_id("codex", "default"), "codex");
        assert_eq!(login_id("codex", "w1"), "codex@w1");
    }

    #[test]
    fn signin_argv_on_linux_is_util_linux_script_with_the_quoted_command_before_the_file() {
        let (p, a) = argv_for(&agy(), "linux");
        assert_eq!(p, "script");
        assert_eq!(a, v(&["-q", "-f", "-e", "-c", "'agy' '-p' 'Reply with OK.'", "/dev/null"]));
        let mut l = agy();
        l.args = v(&["it's"]);
        assert_eq!(argv_for(&l, "linux").1[4], "'agy' 'it'\\''s'");
    }

    #[test]
    fn signin_argv_on_macos_or_without_tty_runs_the_cli_as_it_is() {
        assert_eq!(argv_for(&agy(), "macos"), ("agy".to_owned(), v(&["-p", "Reply with OK."])));
        let mut l = agy();
        l.tty = false;
        assert_eq!(argv_for(&l, "linux"), ("agy".to_owned(), v(&["-p", "Reply with OK."])));
    }
}
