//! Mail on the edge (v1 grid/server.js `/_mail/<provider>`, `/api/channels/mail/reply`): the provider's webhook,
//! public and checked by its own signature; a box's reply, by its Box secret only; and a box's address through
//! `/api/channels/url?channel=email`.

use std::sync::Arc;

use serde_json::{Value, json};

use super::{Grid, Who, no};
use crate::error::{Result, bad};
use crate::http::{Resp, json as answer};
use crate::trust::{Credential, Reach, may};

impl Grid {
    /// `POST /_mail/ses`: the provider's webhook. What it holds is delivered behind the answer.
    pub(super) async fn mail_in(self: &Arc<Self>, provider: &str, bytes: &[u8]) -> Result<Resp> {
        let Some(mail) = self.mail.clone().filter(|_| provider == "ses") else { return Ok(answer(404, &json!({ "error": "not found" }))) };
        if bytes.len() > crate::mail::service::WEBHOOK_MAX {
            return Ok(answer(413, &json!({ "error": "Too big." })));
        }
        let ((status, body), held) = mail.webhook(&self.inbox, bytes).await?;
        for u in held {
            self.drain_later(u);
        }
        Ok(answer(status, &body))
    }

    /// `POST /api/channels/mail/reply {replyTo, subject, text}`: a box answering a message it accepted.
    pub(super) async fn mail_reply(&self, body: &Value, who: &Who) -> Result<Resp> {
        let Who::Box(user) = who else {
            return Err(bad("Only a box answers the mail it took.", if who.credential().is_some() { 403 } else { 401 }));
        };
        if let Some(r) = no(&may(Credential::Box, Reach::GridMailReply)) {
            return Ok(r);
        }
        let mail = self.mail.as_ref().ok_or_else(|| bad("This grid has no mail.", 404))?;
        Ok(answer(200, &mail.reply(&self.inbox, user, body).await?))
    }

    /// The box's address (`channels/url`) or a new one (`channels/rotate`), for `channel: email`.
    pub(super) fn mail_address(&self, user: &crate::rows::UserRow, rotate: bool) -> Result<Resp> {
        let mail = self.mail.as_ref().ok_or_else(|| bad("This grid has no mail.", 404))?;
        let address = if rotate { mail.rotate(&self.inbox, user)? } else { mail.address_of(&self.inbox, user)? };
        Ok(answer(200, &json!({ "address": address })))
    }
}
