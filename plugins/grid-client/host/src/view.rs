//! Settings → Cloud reads one row, `grid-client.cloud` id `this` on `plugin:wisp.grid-client:cloud`: signed in
//! where and as whom, the cloud box's machine, this computer on the grid, and the newest sign-in (its code and
//! the page that takes it, while the browser approves). Rewritten after every change: a command, a sign-in's
//! step, the tunnel's state. The page never polls.

use serde_json::{Value, json};
use wisp_store::{Col, EntityDef, Migration, Row};

use crate::state::{St, lock};

pub const TOPIC: &str = "plugin:wisp.grid-client:cloud";

const MIGRATIONS: &[Migration] = &[Migration::sql(
    1,
    "CREATE TABLE grid_client_cloud (id TEXT PRIMARY KEY, signedIn INTEGER NOT NULL, grid TEXT NOT NULL, handle TEXT NOT NULL, machine TEXT NOT NULL,
       computer TEXT, signin TEXT) STRICT;",
)];

pub const CLOUD: EntityDef = EntityDef {
    kind: "grid-client.cloud",
    table: "grid_client_cloud",
    key: "id",
    columns: &[
        ("id", Col::Text),
        ("signedIn", Col::Bool),
        ("grid", Col::Text),
        ("handle", Col::Text),
        ("machine", Col::Text),
        ("computer", Col::Text),
        ("signin", Col::Text),
    ],
    json_columns: &["computer", "signin"],
    parent: None,
    seq: None,
    topics: |_| vec![TOPIC.to_owned()],
};

pub fn install(store: &wisp_store::Store) -> wisp_store::Result<()> {
    store.migrate("grid_client_view", MIGRATIONS)?;
    store.define_entity(CLOUD)
}

/// The row: the status, and the newest sign-in (the one started last).
pub fn row(status: &wisp_grid_client_api::Status, signin: Option<&wisp_grid_client_api::SignIn>) -> Row {
    let mut r = Row::new();
    r.insert("id".into(), json!("this"));
    r.insert("signedIn".into(), json!(status.signed_in));
    r.insert("grid".into(), json!(status.grid));
    r.insert("handle".into(), json!(status.handle));
    r.insert("machine".into(), json!(status.machine));
    r.insert("computer".into(), serde_json::to_value(&status.computer).unwrap_or(Value::Null));
    r.insert("signin".into(), signin.map_or(Value::Null, |s| serde_json::to_value(s).unwrap_or(Value::Null)));
    r
}

/// Writes the row now, off the caller's way.
pub fn publish(st: &std::sync::Arc<St>) {
    let st2 = st.clone();
    st.ctx.spawn(async move {
        let status = crate::status(&st2);
        let newest = lock(&st2.flows).values().max_by_key(|f| f.expires_at).cloned();
        let r = row(&status, newest.as_ref());
        if let Err(e) = st2.store.write(move |w| w.upsert(CLOUD.kind, r).map(|_| ())).await {
            tracing::warn!(error = %e, "grid-client: writing Settings → Cloud's row");
        }
    });
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use wisp_grid_client_api::{ComputerState, SignIn, Status};

    /// Signed out with a sign-in waiting: the row carries the code and the page; signed in, the handle.
    #[tokio::test]
    async fn the_cloud_row_carries_the_sign_in_under_way_and_who_is_signed_in() {
        let db = wisp_store::Store::open(wisp_store::Location::Memory, std::sync::Arc::new(wisp_store::SystemClock)).unwrap();
        install(&db).unwrap();
        let out = Status {
            signed_in: false,
            grid: String::new(),
            handle: String::new(),
            machine: String::new(),
            computer: ComputerState::default(),
        };
        let waiting = SignIn {
            id: "s1".into(),
            grid: "https://grid.trywisp.dev".into(),
            state: "waiting".into(),
            user_code: "ABCD-EFGH".into(),
            verify_url: "https://grid.trywisp.dev/device".into(),
            ..SignIn::default()
        };
        let r = row(&out, Some(&waiting));
        db.write(move |w| w.upsert(CLOUD.kind, r).map(|_| ())).await.unwrap();
        let got = db.read(|x| x.get("grid-client.cloud", "this")).unwrap().unwrap();
        assert_eq!(got["signedIn"], false);
        assert_eq!(got["signin"]["userCode"], "ABCD-EFGH");
        let signed = Status {
            signed_in: true,
            grid: "https://grid.trywisp.dev".into(),
            handle: "ada".into(),
            machine: "m1".into(),
            computer: ComputerState::default(),
        };
        let r = row(&signed, None);
        db.write(move |w| w.upsert(CLOUD.kind, r).map(|_| ())).await.unwrap();
        let got = db.read(|x| x.get("grid-client.cloud", "this")).unwrap().unwrap();
        assert_eq!((got["signedIn"].clone(), got["handle"].clone()), (json!(true), json!("ada")));
        assert!(got["signin"].is_null());
    }
}
