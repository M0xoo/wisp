//! What Settings → Agents reads, as flat rows on `plugin:wisp.accounts:harnesses` (the UI's types.ts, field
//! for field): `accounts.harness` per harness (`runtime.agents` and each harness's sign-in kind),
//! `accounts.account` per extra account, `accounts.login` per sign-in under way, `accounts.key` per
//! provider key (never the key), `accounts.tool` for git and gh, `accounts.place` (`this`). Written whole
//! after every change (`publish`); a row that's gone is deleted.

use std::collections::HashSet;

use serde_json::{Value, json};
use wisp_accounts_api::TOPIC;
use wisp_kernel::Ctx;
use wisp_store::{Col, EntityDef, Migration, Query, Row, Store};

use crate::{State, lock, now};

const MIGRATIONS: &[Migration] = &[Migration::sql(
    1,
    "CREATE TABLE accounts_v_harness (id TEXT PRIMARY KEY, name TEXT NOT NULL, ord INTEGER NOT NULL, available INTEGER NOT NULL, version TEXT, models TEXT,
       signedIn INTEGER, error TEXT, hasKey INTEGER, setup TEXT, signIn TEXT NOT NULL, installable INTEGER, installing INTEGER, brand TEXT, provider TEXT,
       changed TEXT, pinnedAt INTEGER) STRICT;
     CREATE TABLE accounts_v_account (id TEXT PRIMARY KEY, agent TEXT NOT NULL, ord INTEGER NOT NULL, label TEXT NOT NULL, email TEXT NOT NULL, plan TEXT NOT NULL,
       \"default\" INTEGER NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, until INTEGER, why TEXT NOT NULL) STRICT;
     CREATE TABLE accounts_v_login (id TEXT PRIMARY KEY, agent TEXT NOT NULL, account TEXT NOT NULL, state TEXT NOT NULL, url TEXT, code TEXT, needsInput INTEGER,
       checking INTEGER, error TEXT, signedIn INTEGER) STRICT;
     CREATE TABLE accounts_v_key (id TEXT PRIMARY KEY, agent TEXT NOT NULL, agentName TEXT NOT NULL, provider TEXT NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL,
       env TEXT NOT NULL, \"set\" INTEGER NOT NULL, hint TEXT NOT NULL, savedAt INTEGER, test TEXT) STRICT;
     CREATE TABLE accounts_v_tool (id TEXT PRIMARY KEY, name TEXT NOT NULL, installed INTEGER NOT NULL, setup TEXT) STRICT;
     CREATE TABLE accounts_v_place (id TEXT PRIMARY KEY, grid INTEGER NOT NULL, ask INTEGER NOT NULL) STRICT;",
)];

fn topics(_: &Row) -> Vec<String> {
    vec![TOPIC.into()]
}

pub const HARNESS: EntityDef = EntityDef {
    kind: "accounts.harness",
    table: "accounts_v_harness",
    key: "id",
    columns: &[
        ("id", Col::Text),
        ("name", Col::Text),
        ("ord", Col::Int),
        ("available", Col::Bool),
        ("version", Col::Text),
        ("models", Col::Text),
        ("signedIn", Col::Bool),
        ("error", Col::Text),
        ("hasKey", Col::Bool),
        ("setup", Col::Text),
        ("signIn", Col::Text),
        ("installable", Col::Bool),
        ("installing", Col::Bool),
        ("brand", Col::Text),
        ("provider", Col::Text),
        ("changed", Col::Text),
        ("pinnedAt", Col::Int),
    ],
    json_columns: &["models", "setup", "changed"],
    parent: None,
    seq: None,
    topics,
};
pub const ACCOUNT: EntityDef = EntityDef {
    kind: "accounts.account",
    table: "accounts_v_account",
    key: "id",
    columns: &[("id", Col::Text), ("agent", Col::Text), ("ord", Col::Int), ("label", Col::Text), ("email", Col::Text), ("plan", Col::Text), ("default", Col::Bool), ("kind", Col::Text), ("state", Col::Text), ("until", Col::Int), ("why", Col::Text)],
    json_columns: &[],
    parent: None,
    seq: None,
    topics,
};
pub const LOGIN: EntityDef = EntityDef {
    kind: "accounts.login",
    table: "accounts_v_login",
    key: "id",
    columns: &[("id", Col::Text), ("agent", Col::Text), ("account", Col::Text), ("state", Col::Text), ("url", Col::Text), ("code", Col::Text), ("needsInput", Col::Bool), ("checking", Col::Bool), ("error", Col::Text), ("signedIn", Col::Bool)],
    json_columns: &[],
    parent: None,
    seq: None,
    topics,
};
pub const KEY: EntityDef = EntityDef {
    kind: "accounts.key",
    table: "accounts_v_key",
    key: "id",
    columns: &[("id", Col::Text), ("agent", Col::Text), ("agentName", Col::Text), ("provider", Col::Text), ("name", Col::Text), ("url", Col::Text), ("env", Col::Text), ("set", Col::Bool), ("hint", Col::Text), ("savedAt", Col::Int), ("test", Col::Text)],
    json_columns: &["test"],
    parent: None,
    seq: None,
    topics,
};
pub const TOOL: EntityDef = EntityDef { kind: "accounts.tool", table: "accounts_v_tool", key: "id", columns: &[("id", Col::Text), ("name", Col::Text), ("installed", Col::Bool), ("setup", Col::Text)], json_columns: &["setup"], parent: None, seq: None, topics };
pub const PLACE: EntityDef = EntityDef { kind: "accounts.place", table: "accounts_v_place", key: "id", columns: &[("id", Col::Text), ("grid", Col::Bool), ("ask", Col::Bool)], json_columns: &[], parent: None, seq: None, topics };

pub const ALL: [EntityDef; 6] = [HARNESS, ACCOUNT, LOGIN, KEY, TOOL, PLACE];

pub fn install(store: &Store) -> wisp_store::Result<()> {
    store.migrate("accounts_view", MIGRATIONS)?;
    for d in ALL {
        store.define_entity(d)?;
    }
    Ok(())
}

/// A JSON object as a row of `def`: its own columns only, the rest null.
pub fn row_of(def: &EntityDef, v: &Value) -> Row {
    let mut r = Row::new();
    for (c, _) in def.columns {
        r.insert((*c).to_owned(), v.get(*c).cloned().unwrap_or(Value::Null));
    }
    r
}

/// How a harness signs in: a key pasted into wisp, its CLI's own login, or neither here.
pub fn sign_in_kind(has_keys: bool, has_login: bool) -> &'static str {
    if has_keys {
        "key"
    } else if has_login {
        "cli"
    } else {
        "none"
    }
}

/// Every row, by kind, as they stand now.
pub async fn rows(ctx: &Ctx, st: &State) -> Vec<(&'static EntityDef, Vec<Row>)> {
    let call = ctx.root_call();
    let agents = ctx.run_json(&call, "runtime.agents", json!({})).await.unwrap_or(Value::Null);
    let mut harnesses = Vec::new();
    let mut keys = Vec::new();
    let mut accounts = Vec::new();
    let installing = lock(&st.installing).clone();
    for (ord, a) in agents.as_array().into_iter().flatten().enumerate() {
        let id = a.get("id").and_then(Value::as_str).unwrap_or_default().to_owned();
        let h = crate::harness(ctx, &id);
        let has_keys = h.as_ref().is_some_and(|h| h.keys().is_some());
        let has_login = h.as_ref().is_some_and(|h| h.login().is_some());
        let multi = h.as_ref().and_then(|h| h.accounts().map(|s| s.label.clone()));
        let w = lock(&st.watch).get(&id).cloned().unwrap_or_default();
        let wv = wisp_accounts_core::watch::view(&w);
        let mut has_key = Value::Null;
        if let Some(k) = h.as_ref().and_then(|h| h.keys().cloned())
            && let Ok(kv) = crate::keys::view(&id, &k).await
        {
            has_key = json!(kv.providers.iter().any(|p| p.set) || !kv.env.is_empty());
            for p in kv.providers {
                keys.push(row_of(&KEY, &json!({ "id": format!("{id}/{}", p.id), "agent": id, "agentName": a.get("name"), "provider": p.id, "name": p.name, "url": kv.url, "env": kv.env, "set": p.set, "hint": "", "savedAt": null })));
            }
        }
        let models: Vec<Value> = a.get("models").and_then(Value::as_array).into_iter().flatten().map(|m| json!({ "id": m.get("id"), "label": m.get("label").cloned().unwrap_or_else(|| m.get("id").cloned().unwrap_or(Value::Null)) })).collect();
        harnesses.push(row_of(
            &HARNESS,
            &json!({
                "id": id, "name": a.get("name"), "ord": ord, "available": a.get("available").cloned().unwrap_or(json!(false)),
                "version": a.get("version"), "models": models,
                "signedIn": if a.get("signedIn") == Some(&json!(false)) { json!(false) } else { Value::Null },
                "error": a.get("error"), "hasKey": has_key, "setup": a.get("setup"), "signIn": sign_in_kind(has_keys, has_login),
                "installable": h.as_ref().is_some_and(|h| h.npm_package().is_some()), "installing": installing.contains(&id),
                "brand": multi, "provider": null,
                "changed": serde_json::to_value(&wv.changed).unwrap_or(Value::Null), "pinnedAt": wv.pinned_at,
            }),
        ));
        let list = lock(&st.accounts).get(&id).cloned().unwrap_or_default();
        for (i, v) in wisp_accounts_core::accounts::view(&list, now(ctx)).into_iter().enumerate() {
            let mut x = serde_json::to_value(&v).unwrap_or(Value::Null);
            x["id"] = json!(format!("{id}/{}", v.id));
            x["agent"] = json!(id);
            x["ord"] = json!(i);
            accounts.push(row_of(&ACCOUNT, &x));
        }
    }
    let flows = crate::signin::all(st);
    let mut logins: Vec<Row> = flows
        .iter()
        .map(|(lid, v)| {
            let mut x = serde_json::to_value(v).unwrap_or(Value::Null);
            x["id"] = json!(lid);
            row_of(&LOGIN, &x)
        })
        .collect();
    // the CLIs' own logins as last asked: Signed in / Sign out on their rows
    for (lid, on) in lock(&st.statuses).iter() {
        if on.is_some() && !flows.iter().any(|(f, _)| f == lid) {
            let (agent, account) = lid.split_once('@').unwrap_or((lid.as_str(), ""));
            logins.push(row_of(&LOGIN, &json!({ "id": lid, "agent": agent, "account": account, "state": "idle", "signedIn": on })));
        }
    }
    let tools = ctx.run_json(&call, "git.tools", json!(null)).await.unwrap_or(Value::Null);
    let tool_rows: Vec<Row> = [("git", "git"), ("gh", "GitHub CLI")]
        .iter()
        .filter_map(|(id, name)| {
            let t = tools.get(*id)?;
            Some(row_of(&TOOL, &json!({ "id": id, "name": name, "installed": t.get("installed").cloned().unwrap_or(json!(false)), "setup": t.get("setup") })))
        })
        .collect();
    let grid = std::env::var("WISP_GRID").is_ok_and(|v| !v.is_empty());
    vec![(&HARNESS, harnesses), (&ACCOUNT, accounts), (&LOGIN, logins), (&KEY, keys), (&TOOL, tool_rows), (&PLACE, vec![row_of(&PLACE, &json!({ "id": "this", "grid": grid, "ask": st.ask() }))])]
}

/// Writes every row; a row no longer there is deleted.
pub async fn publish(ctx: &Ctx, st: &State) {
    let all = rows(ctx, st).await;
    let r = st
        .store
        .write(move |w| {
            for (def, want) in all {
                let keep: HashSet<String> = want.iter().filter_map(|r| r.get("id").and_then(Value::as_str).map(str::to_owned)).collect();
                for old in w.query(def.kind, &Query::default())? {
                    if let Some(id) = old.get("id").and_then(Value::as_str).filter(|id| !keep.contains(*id)) {
                        w.del(def.kind, id.to_owned())?;
                    }
                }
                for r in want {
                    w.upsert(def.kind, r)?;
                }
            }
            Ok(())
        })
        .await;
    if let Err(e) = r {
        tracing::warn!(error = %e, "accounts: writing Settings → Agents' rows");
    }
}

/// Asks each CLI that signs in by itself whether it's signed in (its status command), for the rows.
pub async fn probe(ctx: &Ctx, st: &State) {
    for h in ctx.contributions(&wisp_runtime_api::HARNESS) {
        if h.login().is_none() || h.keys().is_some() {
            continue;
        }
        let agent = h.info().id.clone();
        if let Ok(s) = crate::signin::status(ctx, st, h.as_ref(), "").await {
            lock(&st.statuses).insert(agent, s.signed_in);
        }
    }
}

/// The CLIs asked again, then `publish`, off the caller's way (at start, after a command).
pub fn soon(ctx: &Ctx, st: &std::sync::Arc<State>) {
    let (c, s) = (ctx.clone(), st.clone());
    ctx.spawn(async move {
        publish(&c, &s).await;
        probe(&c, &s).await;
        publish(&c, &s).await;
    });
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    /// A harness row is the UI's fields only, named as the UI names them; the sign-in kind follows what
    /// the harness has: keys win, then its CLI's login.
    #[tokio::test]
    async fn the_agents_pane_rows_are_flat_and_named_as_the_ui_reads_them() {
        let db = Store::open(wisp_store::Location::Memory, std::sync::Arc::new(wisp_store::SystemClock)).unwrap();
        install(&db).unwrap();
        let r = row_of(&HARNESS, &json!({ "id": "opencode", "name": "opencode", "ord": 2, "available": true, "models": [{ "id": "a", "label": "A" }], "signIn": sign_in_kind(true, true), "hasKey": false, "pinnedAt": 9, "extra": "dropped" }));
        let a = row_of(&ACCOUNT, &json!({ "id": "claude/work", "agent": "claude", "ord": 0, "label": "Work", "email": "", "plan": "", "default": false, "kind": "work", "state": "ready", "until": null, "why": "" }));
        db.write(move |w| w.upsert(HARNESS.kind, r).and_then(|_| w.upsert(ACCOUNT.kind, a)).map(|_| ())).await.unwrap();
        let h = db.read(|x| x.get("accounts.harness", "opencode")).unwrap().unwrap();
        assert_eq!(h["signIn"], "key");
        assert_eq!(h["hasKey"], false);
        assert_eq!(h["pinnedAt"], 9);
        assert_eq!(h["models"][0]["label"], "A");
        assert!(h.get("extra").is_none());
        assert_eq!(db.read(|x| x.get("accounts.account", "claude/work")).unwrap().unwrap()["default"], false);
        assert_eq!(sign_in_kind(false, true), "cli");
        assert_eq!(sign_in_kind(false, false), "none");
        assert_eq!((HARNESS.topics)(&h), vec![TOPIC.to_owned()]);
    }
}
