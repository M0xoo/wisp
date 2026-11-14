//! `channels.test` (F-chan-13, v1 `POST /api/remote/test`): a test message through a channel's transport, and what its
//! service answered, which is also its health (so the Phone row says Working or Not working).

use std::sync::Arc;

use wisp_channels_api::views::Msg;
use wisp_channels_api::{PHONE_ORDER, TestArgs, TestOutcome, Tested, TransportKind};
use wisp_kernel::{Ctx, Result};

use crate::setup::scrub;
use crate::{Live, lock};

/// A test message through each channel asked for (or every one that's on). Its outcome is also its health.
pub async fn test(ctx: &Ctx, live: &Arc<Live>, a: &TestArgs) -> Result<Vec<Tested>> {
    let out = test_now(live, a).await;
    crate::rows::poke(ctx, live);
    out
}

async fn test_now(live: &Live, a: &TestArgs) -> Result<Vec<Tested>> {
    let running = lock(&live.running).iter().map(|(n, (t, _))| (n.clone(), t.clone())).collect::<Vec<_>>();
    let pick: Vec<_> = match &a.channel {
        Some(c) => {
            let t = running.into_iter().find(|(n, _)| n == c);
            if t.is_none() {
                return Ok(vec![Tested {
                    channel: c.clone(),
                    outcome: TestOutcome::Failed,
                    error: Some(format!("{} is off: switch it on first.", title(c))),
                }]);
            }
            t.into_iter().collect()
        }
        None => running,
    };
    let msg = Msg {
        title: "✨ wisp".into(),
        text: "Test from wisp: questions and finished tasks will show up like this.".into(),
        actions: Vec::new(),
    };
    let mut out = Vec::new();
    for (name, t) in pick {
        if t.kind() == TransportKind::Thread {
            out.push(Tested { channel: name, outcome: TestOutcome::Unprompted, error: None });
            continue;
        }
        let r = t.publish(&msg, None).await;
        let error = r.err().map(|e| scrub(live, &name, e.message));
        let st = wisp_channels_api::Status { ok: Some(error.is_none()), error: error.clone(), ..wisp_channels_api::Status::default() };
        lock(&live.st.status).insert(name.clone(), st);
        out.push(Tested { channel: name, outcome: if error.is_none() { TestOutcome::Sent } else { TestOutcome::Failed }, error });
    }
    out.sort_by_key(|x| PHONE_ORDER.iter().position(|n| *n == x.channel).unwrap_or(PHONE_ORDER.len()));
    Ok(out)
}

fn title(t: &str) -> String {
    match t {
        "telegram" => "Telegram".into(),
        "slack" => "Slack".into(),
        "discord" => "Discord".into(),
        "github" => "GitHub".into(),
        "email" => "Email".into(),
        other => other.to_owned(),
    }
}
