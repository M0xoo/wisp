//! wisp-discord-core: what Discord says and what wisp says back, with no IO (v1 `server/channels/discord.js`): the
//! gateway's frames and the connection's rules (hello, identify or resume, the heartbeat and its ack, what a close
//! code means), a message read down to what a person sent, and the invite link. The host (`wisp-discord`) owns the
//! wire; everything it decides is decided here.

pub mod gateway;
pub mod message;
pub mod rest;

/// Guilds, guild messages, direct messages: no privileged intent (`MESSAGE_CONTENT`), so only a mention, a DM or a
/// slash command carries its text.
pub const INTENTS: u64 = 1 | (1 << 9) | (1 << 12);
/// View, send, history, create threads, send in threads.
pub const PERMISSIONS: u64 = (1 << 10) + (1 << 11) + (1 << 16) + (1 << 35) + (1 << 38);
/// An embed fetches a URL an agent wrote.
pub const SUPPRESS_EMBEDS: u64 = 1 << 2;
pub const MAX_TEXT: usize = 2000;
pub const BACKOFF_MAX_MS: u64 = 5 * 60_000;
/// Connections in a row that got nowhere before a resume URL is given up on.
pub const RESUME_TRIES: u32 = 3;

/// The link that adds the bot to a server, with the permissions it needs.
pub fn invite_url(app_id: &str) -> String {
    let id: String = app_id.chars().filter(char::is_ascii_digit).collect();
    format!("https://discord.com/oauth2/authorize?client_id={id}&scope=bot+applications.commands&permissions={PERMISSIONS}")
}

/// The wait before dialling again after `fails` in a row.
pub fn backoff_ms(base_ms: u64, fails: u32) -> u64 {
    base_ms.saturating_mul(1u64 << fails.saturating_sub(1).min(20)).min(BACKOFF_MAX_MS)
}

/// A link shows what it says: `[text](url)` would show only the text, so no agent can dress one up.
pub fn unmask(text: &str) -> String {
    text.replace("](", "]\\(")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_invite_asks_for_what_the_bot_needs_and_no_more() {
        assert_eq!(invite_url("123&x=1"), "https://discord.com/oauth2/authorize?client_id=1231&scope=bot+applications.commands&permissions=309237713920", "v1 PERMISSIONS: view, send, history, threads, in threads");
        assert_eq!(INTENTS, 4609, "no MESSAGE_CONTENT");
        assert_eq!(unmask("[docs](https://evil)"), "[docs]\\(https://evil)");
        assert_eq!((backoff_ms(1000, 1), backoff_ms(1000, 3), backoff_ms(1000, 30)), (1000, 4000, BACKOFF_MAX_MS));
    }
}
