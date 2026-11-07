//! The rows of grid.db (`migrations.rs`), one struct per table. Each has `COLS` (its columns, in
//! order, for `SELECT {COLS} FROM …`) and `from_row`, so a renamed column fails in one place.
//! `SELECT *` works too: `from_row` reads by name.
use serde::Serialize;

macro_rules! rows {
    ($( $(#[$m:meta])* $name:ident { $first:ident : $fty:ty $(, $field:ident : $ty:ty)* $(,)? } )*) => {$(
        $(#[$m])*
        #[derive(Debug, Clone, PartialEq, Serialize)]
        pub struct $name { pub $first: $fty, $(pub $field: $ty),* }
        impl $name {
            pub const COLS: &'static str = concat!(stringify!($first) $(, ", ", stringify!($field))*);
            /// Read a row by column name (`SELECT *` or `SELECT {COLS}`).
            pub fn from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
                Ok(Self { $first: r.get(stringify!($first))?, $($field: r.get(stringify!($field))?),* })
            }
        }
    )*};
}

rows! {
    UserRow { id: String, handle: String, email: Option<String>, name: Option<String>, avatar: Option<String>, created_at: i64, disabled: i64 }
    IdentityRow { provider: String, subject: String, user_id: String, email: Option<String>, login: Option<String>, created_at: i64 }
    SessionRow { id_hash: String, user_id: String, scope: String, created_at: i64, expires_at: i64, last_seen_at: i64, ua: Option<String> }
    DeviceRow { id: String, user_id: String, name: String, token_hash: String, created_at: i64, last_seen_at: Option<i64>, revoked_at: Option<i64> }
    DeviceCodeRow { code_hash: String, user_code: String, name: String, user_id: Option<String>, created_at: i64, expires_at: i64, approved_at: Option<i64>, denied_at: Option<i64>, consumed_at: Option<i64>, last_poll_at: Option<i64> }
    TicketRow { hash: String, user_id: String, expires_at: i64, used_at: Option<i64>, scope: Option<String> }
    InstanceRow { user_id: String, state: String, host: Option<String>, created_at: i64, started_at: Option<i64>, stopped_at: Option<i64>, last_active_at: Option<i64>, next_wake_at: Option<i64>, stop_reason: Option<String> }
    ComputerRow { id: String, user_id: String, device_id: String, name: String, label: String, created_at: i64, last_seen_at: Option<i64> }
    WaitlistRow { email: String, source: String, created_at: i64, invited_at: Option<i64>, joined_at: Option<i64>, user_id: Option<String> }
    SiteRow { id: String, user_id: String, key: String, label: String, title: String, entry: String, files: i64, size: i64, db: Option<String>, created_at: i64, updated_at: i64 }
    ShareRow { id: String, user_id: String, key: String, title: String, pass: Option<String>, size: i64, meta: String, created_at: i64, updated_at: i64 }
    SandboxRow { id: String, user_id: String, label: String, name: String, created_at: i64 }
    ApiKeyRow { id: String, user_id: String, name: String, token_hash: String, hint: String, created_at: i64, last_used_at: Option<i64>, revoked_at: Option<i64> }
    ChannelUrlRow { user_id: String, channel: String, token_hash: String, created_at: i64, dropped: i64 }
    ChannelInboxRow { id: i64, user_id: String, channel: String, event_key: String, headers: String, body: Vec<u8>, size: i64, at: i64, tries: i64, next_at: i64, done_at: Option<i64>, verified: i64 }
    MailThreadRow { user_id: String, message_id: String, to_addr: String, refs: String, at: i64 }
    ChannelRouteRow { user_id: String, channel: String, token_hash: String, created_at: i64 }
    ChannelThreadRow { id: String, user_id: String, computer_id: String, channel: String, chat: String, message: i64, created_at: i64 }
}

/// Who a box runs for: a user, or a sandbox (`sandbox` its id, `owner` the user it belongs to).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
pub struct BoxUser {
    pub id: String,
    pub handle: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
}

impl BoxUser {
    pub fn user(u: &UserRow) -> Self {
        Self {
            id: u.id.clone(),
            handle: u.handle.clone(),
            sandbox: None,
            owner: None,
        }
    }
}

/// The lookups every part needs, by key. One row or None.
pub mod find {
    use rusqlite::{Connection, OptionalExtension, Params};

    use super::{ComputerRow, SandboxRow, SiteRow, UserRow};

    fn one<T>(
        c: &Connection,
        sql: &str,
        p: impl Params,
        f: fn(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
    ) -> rusqlite::Result<Option<T>> {
        c.prepare_cached(sql)?.query_row(p, f).optional()
    }

    pub fn user_by_id(c: &Connection, id: &str) -> rusqlite::Result<Option<UserRow>> {
        one(
            c,
            "SELECT * FROM users WHERE id = ?1",
            [id],
            UserRow::from_row,
        )
    }
    pub fn user_by_handle(c: &Connection, handle: &str) -> rusqlite::Result<Option<UserRow>> {
        one(
            c,
            "SELECT * FROM users WHERE handle = ?1",
            [handle],
            UserRow::from_row,
        )
    }
    pub fn computer_by_id(c: &Connection, id: &str) -> rusqlite::Result<Option<ComputerRow>> {
        one(
            c,
            "SELECT * FROM computers WHERE id = ?1",
            [id],
            ComputerRow::from_row,
        )
    }
    pub fn computer_by_label(c: &Connection, label: &str) -> rusqlite::Result<Option<ComputerRow>> {
        one(
            c,
            "SELECT * FROM computers WHERE label = ?1",
            [label],
            ComputerRow::from_row,
        )
    }
    pub fn computers_of(c: &Connection, user_id: &str) -> rusqlite::Result<Vec<ComputerRow>> {
        c.prepare_cached("SELECT * FROM computers WHERE user_id = ?1 ORDER BY created_at, id")?
            .query_map([user_id], ComputerRow::from_row)?
            .collect()
    }
    pub fn sandbox_by_label(c: &Connection, label: &str) -> rusqlite::Result<Option<SandboxRow>> {
        one(
            c,
            "SELECT * FROM sandboxes WHERE label = ?1",
            [label],
            SandboxRow::from_row,
        )
    }
    pub fn site_by_label(c: &Connection, label: &str) -> rusqlite::Result<Option<SiteRow>> {
        one(
            c,
            "SELECT * FROM sites WHERE label = ?1",
            [label],
            SiteRow::from_row,
        )
    }
    /// v1's `accounts.audit`: one line of what happened, for `wisp grid audit`.
    pub fn audit(
        c: &Connection,
        user_id: Option<&str>,
        action: &str,
        meta: Option<&serde_json::Value>,
        at: i64,
    ) -> rusqlite::Result<()> {
        c.prepare_cached("INSERT INTO audit (user_id, action, meta, at) VALUES (?1, ?2, ?3, ?4)")?
            .execute(rusqlite::params![
                user_id,
                action,
                meta.map(ToString::to_string),
                at
            ])?;
        Ok(())
    }
}
