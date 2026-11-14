//! grid.json's checks: each setting refused at start with a sentence that says what it should be.
use std::path::Path;

use serde_json::Value;

use super::{Env, GridConfig, read_secret};
use crate::error::{GridError, Result};

// Each provider's secret, resolved now so a missing one fails at start, not at sign-in.
pub(super) fn resolve_providers(cfg: &mut GridConfig, dir: &Path, env: &Env) -> Result<()> {
    cfg.auth.providers.retain(|_, p| p.enabled != Some(false));
    for (id, p) in &mut cfg.auth.providers {
        if p.client_id.is_empty() {
            return Err(GridError::Config(format!("auth.providers.{id}: clientId is missing.")));
        }
        let file = p.client_secret_file.as_ref().map(|f| dir.join(f));
        let secret = read_secret(p.client_secret.as_deref(), file.as_deref(), p.client_secret_env.as_deref(), env)?;
        if secret.is_empty() {
            let var = p.client_secret_env.clone().unwrap_or_else(|| format!("GRID_{}_CLIENT_SECRET", id.to_uppercase()));
            return Err(GridError::Config(format!("auth.providers.{id}: no client secret (clientSecretFile, or {var}).")));
        }
        p.client_secret = Some(secret);
    }
    Ok(())
}

pub(super) fn validate_auth(cfg: &GridConfig) -> Result<()> {
    let e = |m: &str| Err(GridError::Config(m.to_owned()));
    if cfg.auth.signup != "open" && cfg.auth.signup != "closed" {
        return e("auth.signup: open or closed.");
    }
    let st = &cfg.auth.seats;
    if st.min < 1 {
        return e("auth.seats.min: a whole number above 0 (the seats \"auto\" starts with).");
    }
    if st.cap < st.min {
        return e("auth.seats.cap: a whole number, at least auth.seats.min (the most seats \"auto\" opens).");
    }
    if !(st.target > 0.0 && st.target <= 1.0) {
        return e("auth.seats.target: a share of the host above 0, up to 1 (0.7: open seats while under 70% busy).");
    }
    if st.every_hours <= 0.0 {
        return e("auth.seats.everyHours: hours between new seats, above 0.");
    }
    if st.hold_days < 0.0 {
        return e("auth.seats.holdDays: days a seat stays held for an invited person on the waitlist, 0 or more.");
    }
    Ok(())
}

pub(super) fn validate_hostd(cfg: &GridConfig) -> Result<()> {
    let h = &cfg.hostd;
    if h.driver != "process" && h.driver != "container" {
        return Err(GridError::Config(format!(
            "hostd driver \"{}\" isn’t built yet: use \"process\" or \"container\" (see apps/grid/README.md).",
            h.driver
        )));
    }
    if let Some(b) = h.container.as_ref().and_then(|c| c.boxd.as_ref())
        && !Path::new(b).is_absolute()
    {
        return Err(GridError::Config(
            "hostd.container.boxd: the path of boxd’s socket, e.g. /run/wisp-grid/box.sock (apps/grid/README.md → Isolation).".into(),
        ));
    }
    if let Some(ad) = &h.admit {
        let ok = match ad {
            Value::Bool(false) => true,
            Value::Object(o) => ["boxMb", "reserveMb"].iter().all(|k| o.get(*k).is_none_or(|v| v.is_null() || v.as_u64().is_some())),
            _ => false,
        };
        if !ok {
            return Err(GridError::Config(
                "hostd.admit: false, or { boxMb, reserveMb } in MiB (the memory one more box needs, and what the host keeps for itself)."
                    .into(),
            ));
        }
    }
    for (k, v) in [("evictAfterMs", h.evict_after_ms), ("queueMs", h.queue_ms)] {
        if v.is_some_and(|v| v < 0) {
            return Err(GridError::Config(format!("hostd.{k}: milliseconds, a whole number.")));
        }
    }
    Ok(())
}

pub(super) fn validate_channels(cfg: &mut GridConfig, dir: &Path, env: &Env) -> Result<()> {
    if let Some(ch) = &cfg.channels {
        for (k, v) in [("maxRows", ch.max_rows), ("maxBytes", ch.max_bytes)] {
            if v.is_some_and(|v| v < 1) {
                return Err(GridError::Config(format!("channels.{k}: a whole number above 0.")));
            }
        }
        if ch.route == Some(true) && ch.enabled != Some(true) {
            return Err(GridError::Config(
                "channels.route needs channels.enabled: what isn’t for a computer goes to the box through the inbox.".into(),
            ));
        }
    }
    if cfg.mail.is_some() {
        validate_mail(cfg, dir, env)?;
    }
    Ok(())
}

fn mail_domain_ok(d: &str) -> bool {
    let parts: Vec<&str> = d.split('.').collect();
    parts.len() >= 2 && parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
}

pub(super) fn topic_arn_ok(arn: &str) -> bool {
    // arn:aws[\w-]*:sns:[a-z0-9-]+:\d+:[\w-]+
    let p: Vec<&str> = arn.split(':').collect();
    let word = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    p.len() == 6
        && p[0] == "arn"
        && p[1].starts_with("aws")
        && p[1][3..].chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        && p[2] == "sns"
        && !p[3].is_empty()
        && p[3].chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !p[4].is_empty()
        && p[4].chars().all(|c| c.is_ascii_digit())
        && word(p[5])
}

fn validate_mail(cfg: &mut GridConfig, dir: &Path, env: &Env) -> Result<()> {
    let e = |m: &str| Err(GridError::Config(m.to_owned()));
    if !cfg.channels_on() {
        return e("mail needs channels: { enabled: true }: mail reaches a box through the same held inbox.");
    }
    let Some(mail) = cfg.file_cfg.mail.as_mut() else {
        return Ok(());
    };
    if !mail_domain_ok(&mail.domain) {
        return e("mail.domain: the domain the secret addresses are on, like mail.example.com.");
    }
    if mail.inbound.provider != "ses" || mail.outbound.provider != "ses" {
        return e("mail.inbound.provider and mail.outbound.provider: \"ses\" is the one there is.");
    }
    if !topic_arn_ok(&mail.inbound.topic_arn) {
        return e("mail.inbound.topicArn: the ARN of the SNS topic SES publishes to.");
    }
    let o = &mut mail.outbound;
    if o.region.is_empty() || o.access_key_id.is_empty() {
        return e("mail.outbound: region and accessKeyId are needed.");
    }
    let file = o.secret_access_key_file.as_ref().map(|f| dir.join(f));
    let env_name = o.secret_access_key_env.clone().unwrap_or_else(|| "GRID_MAIL_SECRET".into());
    let secret = read_secret(o.secret_access_key.as_deref(), file.as_deref(), Some(&env_name), env)?;
    if secret.is_empty() {
        return e("mail.outbound: no secret key (secretAccessKeyFile, or GRID_MAIL_SECRET).");
    }
    o.secret_access_key = Some(secret);
    for (k, v) in [("sendPerHour", mail.send_per_hour), ("threadDays", mail.thread_days)] {
        if v.is_some_and(|v| v < 1) {
            return Err(GridError::Config(format!("mail.{k}: a whole number above 0.")));
        }
    }
    Ok(())
}
