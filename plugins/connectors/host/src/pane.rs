//! Settings → Connectors (v1 server/connectors.js routes, as commands): the connector resources with what
//! the page shows of them, published as rows on `plugin:wisp.connectors:list` (`connectors.connector`,
//! `connectors.found`, `connectors.reach`, flat, snake-case columns where two words). Secret values go to
//! the secrets file (`connector:<id>:env:<KEY>`, `…:headers:<KEY>`); the spec keeps `${secret:…}`.
//!
//! - add / update / remove: one resource op each (the resource kind's own apply), then a test in the background;
//! - test: a local server is started and asked for its tools (`initialize`, `tools/list`, the probe's
//!   state machine), a remote one is asked over HTTP (the kernel's one client);
//! - import: servers in the harnesses' own configs (`connectors.found`) become connectors, values and all;
//! - signin / oauthFinish / signout: OAuth with discovery, dynamic registration and PKCE; the tokens live in
//!   secrets and runs get `Authorization: Bearer` from them.
//!
//! size-ok: one pane's commands and their rows

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use serde_json::{Value, json};
use wisp_connectors_api::{
    self as api, Connector, ConnectorBody, ConnectorView, ConnectorsView, FoundServer, HarnessMcp, ImportView, KeyState, OAuthMeta,
    ProbeResult, SecretInput, SignedIn, SignedInName, SigninUrl, Skipped, Transport, Where, secrets_ns,
};
use wisp_connectors_core::harness::{Found, Source, builtins, found, own_names};
use wisp_connectors_core::oauth::{self, PendingSignins};
use wisp_connectors_core::probe::{Outcome, PROBE_MS, Probe, TIMEOUT_REASON, exited_reason};
use wisp_connectors_core::rpc::{Lines, Sse, http_failure, initialize};
use wisp_connectors_core::text::{host_of, split_command, valid_key, valid_name};
use wisp_kernel::services::{NetRequest, net, secrets};
use wisp_kernel::{Ctx, Result, Setup, WireError};
use wisp_resources_api::{Op, OpKind, ResourceKind, StoredKind};
use wisp_store::{Col, EntityDef, Migration, Row, Store};

use crate::kinds::ConnectorSpec;

pub const OWNER: &str = "connectors";

const MIGRATIONS: &[Migration] = &[Migration::sql(
    1,
    "CREATE TABLE connectors_connector (id TEXT PRIMARY KEY, name TEXT NOT NULL, transport TEXT NOT NULL, command TEXT NOT NULL, args TEXT, url TEXT NOT NULL,
       env TEXT, headers TEXT, enabled INTEGER NOT NULL, test TEXT, signed_in TEXT, added_at INTEGER NOT NULL, own TEXT, testing INTEGER NOT NULL) STRICT;
     CREATE TABLE connectors_found (id TEXT PRIMARY KEY, name TEXT NOT NULL, \"from\" TEXT, transport TEXT NOT NULL, command TEXT, args TEXT, url TEXT, env TEXT, headers TEXT) STRICT;
     CREATE TABLE connectors_reach (id TEXT PRIMARY KEY, harnesses TEXT) STRICT;",
)];

fn topics(_: &Row) -> Vec<String> {
    vec![api::TOPIC.into()]
}

pub const CONNECTOR: EntityDef = EntityDef {
    kind: "connectors.connector",
    table: "connectors_connector",
    key: "id",
    columns: &[
        ("id", Col::Text),
        ("name", Col::Text),
        ("transport", Col::Text),
        ("command", Col::Text),
        ("args", Col::Text),
        ("url", Col::Text),
        ("env", Col::Text),
        ("headers", Col::Text),
        ("enabled", Col::Bool),
        ("test", Col::Text),
        ("signed_in", Col::Text),
        ("added_at", Col::Int),
        ("own", Col::Text),
        ("testing", Col::Bool),
    ],
    json_columns: &["args", "env", "headers", "test", "signed_in", "own"],
    parent: None,
    seq: None,
    topics,
};
pub const FOUND: EntityDef = EntityDef {
    kind: "connectors.found",
    table: "connectors_found",
    key: "id",
    columns: &[
        ("id", Col::Text),
        ("name", Col::Text),
        ("from", Col::Text),
        ("transport", Col::Text),
        ("command", Col::Text),
        ("args", Col::Text),
        ("url", Col::Text),
        ("env", Col::Text),
        ("headers", Col::Text),
    ],
    json_columns: &["from", "args", "env", "headers"],
    parent: None,
    seq: None,
    topics,
};
pub const REACH: EntityDef = EntityDef {
    kind: "connectors.reach",
    table: "connectors_reach",
    key: "id",
    columns: &[("id", Col::Text), ("harnesses", Col::Text)],
    json_columns: &["harnesses"],
    parent: None,
    seq: None,
    topics,
};

pub fn install(store: &Store) -> wisp_store::Result<()> {
    store.migrate(OWNER, MIGRATIONS)?;
    for d in [CONNECTOR, FOUND, REACH] {
        store.define_entity(d)?;
    }
    Ok(())
}

/// The secret a spec value names: `connector:<id>:<field>:<KEY>`.
pub fn secret_key(id: &str, field: &str, key: &str) -> String {
    format!("{}:{field}:{key}", secrets_ns(id))
}

fn reference(key: &str) -> String {
    format!("${{secret:{key}}}")
}

/// What a saved form makes of a connector: its spec, and the secrets to write (key, value). A field the
/// form doesn't carry keeps what `prev` had; an empty secret value keeps the saved one; a key left out
/// goes (its secret is in `drop`).
#[derive(Debug, Default, PartialEq)]
pub struct Plan {
    pub spec: ConnectorSpec,
    pub set: Vec<(String, String)>,
    pub drop: Vec<String>,
}

fn pairs(input: &SecretInput) -> Vec<(String, String)> {
    let text = |v: &Value| match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    };
    match input {
        SecretInput::List(l) => l.iter().map(|f| (f.key.trim().to_owned(), text(&f.value))).collect(),
        SecretInput::Map(m) => m.iter().map(|(k, v)| (k.trim().to_owned(), text(v))).collect(),
    }
}

fn secrets_of(
    id: &str,
    field: &str,
    input: Option<&SecretInput>,
    prev: &BTreeMap<String, String>,
    plan: &mut Plan,
) -> std::result::Result<BTreeMap<String, String>, WireError> {
    let Some(input) = input else { return Ok(prev.clone()) };
    let mut out = BTreeMap::new();
    for (k, v) in pairs(input) {
        if k.is_empty() {
            continue;
        }
        if !valid_key(&k) {
            return Err(WireError::invalid(format!("{k} can't be a name for a {}", if field == "env" { "variable" } else { "header" })));
        }
        let key = secret_key(id, field, &k);
        if !v.is_empty() {
            plan.set.push((key.clone(), v));
        } else if !prev.contains_key(&k) {
            continue;
        }
        out.insert(k, reference(&key));
    }
    plan.drop.extend(prev.keys().filter(|k| !out.contains_key(*k)).map(|k| secret_key(id, field, k)));
    Ok(out)
}

/// A form (add: no `prev`; update: the saved spec) → the plan. Local needs a command, remote an http(s) URL.
pub fn plan_of(id: &str, b: &ConnectorBody, prev: Option<&ConnectorSpec>) -> std::result::Result<Plan, WireError> {
    let was = prev.cloned().unwrap_or_default();
    let mut plan = Plan::default();
    let remote = match b.transport.as_deref() {
        Some("remote") => true,
        Some("local") => false,
        Some(t) => return Err(WireError::invalid(format!("transport: local or remote, not {t}"))),
        // v1 connectors.js: an edit keeps its kind; a new one is remote when it has a URL
        None if prev.is_some() => !was.url.is_empty(),
        None => b.url.as_deref().is_some_and(|u| !u.trim().is_empty()),
    };
    let mut spec = ConnectorSpec {
        enabled: b.enabled.or(was.enabled),
        oauth: was.oauth,
        agents: was.agents.clone(),
        modes: was.modes.clone(),
        ..ConnectorSpec::default()
    };
    if remote {
        let url = b.url.clone().unwrap_or(was.url.clone()).trim().to_owned();
        if !(url.starts_with("https://") || url.starts_with("http://")) {
            return Err(WireError::invalid("A remote connector needs its server's address (https://…)"));
        }
        spec.url = url;
        spec.headers = secrets_of(id, "headers", b.headers.as_ref(), &was.headers, &mut plan)?;
        plan.drop.extend(was.env.keys().map(|k| secret_key(id, "env", k)));
    } else {
        let (command, args) = match (&b.command, &b.args) {
            (Some(line), None) => {
                let mut parts = split_command(line);
                if parts.is_empty() {
                    (String::new(), Vec::new())
                } else {
                    let c = parts.remove(0);
                    (c, parts)
                }
            }
            (Some(c), Some(a)) => (c.trim().to_owned(), a.clone()),
            (None, Some(a)) => (was.command.clone(), a.clone()),
            (None, None) => (was.command.clone(), was.args.clone()),
        };
        if command.is_empty() {
            return Err(WireError::invalid("A local connector needs the command that starts it"));
        }
        spec.command = command;
        spec.args = args;
        spec.env = secrets_of(id, "env", b.env.as_ref(), &was.env, &mut plan)?;
        plan.drop.extend(was.headers.keys().map(|k| secret_key(id, "headers", k)));
    }
    plan.spec = spec;
    Ok(plan)
}

/// What the page shows of a connector.
pub fn view_of(
    name: &str,
    c: &ConnectorSpec,
    test: Option<ProbeResult>,
    testing: bool,
    signed_in: Option<SignedIn>,
    own: Vec<String>,
) -> ConnectorView {
    let keys = |m: &BTreeMap<String, String>| m.iter().map(|(k, v)| KeyState { key: k.clone(), set: !v.is_empty() }).collect();
    ConnectorView {
        id: name.to_owned(),
        name: name.to_owned(),
        transport: if c.url.is_empty() { Transport::Local } else { Transport::Remote },
        command: c.command.clone(),
        args: c.args.clone(),
        url: c.url.clone(),
        env: keys(&c.env),
        headers: keys(&c.headers),
        enabled: c.enabled != Some(false),
        test,
        signed_in,
        added_at: 0,
        own,
        testing,
    }
}

/// `usedAt` → `used_at`.
fn snake(k: &str) -> String {
    let mut out = String::new();
    for ch in k.chars() {
        if ch.is_ascii_uppercase() {
            out.push('_');
            out.push(ch.to_ascii_lowercase());
        } else {
            out.push(ch);
        }
    }
    out
}

fn row_of(id: &str, v: &impl serde::Serialize, def: &EntityDef) -> Row {
    let mut r = Row::new();
    r.insert("id".into(), json!(id));
    if let Ok(Value::Object(m)) = serde_json::to_value(v) {
        for (k, v) in m {
            let col = snake(&k);
            if def.columns.iter().any(|(c, _)| *c == col) && col != "id" {
                r.insert(col, v);
            }
        }
    }
    for (c, _) in def.columns {
        r.entry((*c).to_owned()).or_insert(Value::Null);
    }
    r
}

/// The rows for a view: connectors, found servers, the reach row (`this`).
pub fn rows(v: &ConnectorsView) -> Vec<(&'static EntityDef, Vec<Row>)> {
    vec![
        (&CONNECTOR, v.connectors.iter().map(|c| row_of(&c.id, c, &CONNECTOR)).collect()),
        (&FOUND, v.found.iter().map(|f| row_of(&f.name, f, &FOUND)).collect()),
        (&REACH, vec![row_of("this", &json!({ "harnesses": v.reach }), &REACH)]),
    ]
}

pub struct Pane {
    kind: Arc<StoredKind>,
    connectors: Arc<dyn ResourceKind>,
    pub(crate) tests: Mutex<HashMap<String, ProbeResult>>,
    testing: Mutex<HashSet<String>>,
    dismissed: Mutex<BTreeSet<String>>,
    pending: Mutex<PendingSignins>,
}

pub(crate) fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

fn where_() -> Where {
    // the variables a harness's config lookup sees, with the PATH wisp finds programs on (ADR-0057)
    Where { home: std::env::var("HOME").map(Into::into).unwrap_or_default(), env: wisp_proc::vars().into_iter().collect() }
}

/// Each harness's own servers, read from its config files.
async fn sources() -> Vec<Source> {
    let w = where_();
    let mut out = Vec::new();
    for b in builtins() {
        let mut texts = Vec::new();
        for f in b.files(&w, None) {
            texts.push(tokio::fs::read_to_string(&f).await.ok());
        }
        out.push(Source { agent: b.agent().to_owned(), label: b.label().to_owned(), servers: b.servers(&texts, None) });
    }
    out
}

impl Pane {
    pub(crate) async fn specs(&self) -> Vec<(String, ConnectorSpec)> {
        self.kind.specs().await.unwrap_or_default().into_iter().filter_map(|(n, v)| Some((n, serde_json::from_value(v).ok()?))).collect()
    }

    async fn spec(&self, id: &str) -> Result<ConnectorSpec> {
        self.specs()
            .await
            .into_iter()
            .find(|(n, _)| n == id)
            .map(|(_, s)| s)
            .ok_or_else(|| WireError::not_found(format!("No connector called {id}")))
    }

    pub(crate) async fn oauth_of(ctx: &Ctx, id: &str) -> Option<OAuthMeta> {
        let s = secrets(ctx).ok()?;
        serde_json::from_str(&s.get(&format!("{}:oauth", secrets_ns(id))).await.ok()??).ok()
    }

    pub async fn view(&self, ctx: &Ctx) -> ConnectorsView {
        let srcs = sources().await;
        let own = own_names(&srcs);
        let specs = self.specs().await;
        let list: Vec<Connector> =
            specs.iter().map(|(n, _)| Connector { id: n.clone(), name: n.clone(), ..Connector::default() }).collect();
        let tests = lock(&self.tests).clone();
        let testing = lock(&self.testing).clone();
        let mut connectors = Vec::new();
        for (n, c) in &specs {
            let signed = match Self::oauth_of(ctx, n).await {
                Some(o) if o.signed_in_at.is_some() => Some(SignedIn { host: host_of(&o.issuer), at: o.signed_in_at }),
                _ => None,
            };
            let mine: Vec<String> = own.iter().filter(|(_, names)| names.contains(n)).map(|(a, _)| a.clone()).collect();
            connectors.push(view_of(n, c, tests.get(n).cloned(), testing.contains(n), signed, mine));
        }
        let hidden = lock(&self.dismissed).clone();
        let found = found(&srcs, &list).into_iter().filter(|f| !hidden.contains(&f.name)).map(|f| f.public()).collect::<Vec<FoundServer>>();
        let reach = builtins().into_iter().filter(HarnessMcp::per_turn).map(|b| b.agent().to_owned()).collect();
        ConnectorsView { connectors, found, reach }
    }

    /// The view, also written as the pane's rows (a gone connector's row goes).
    pub async fn publish(&self, ctx: &Ctx) -> ConnectorsView {
        let v = self.view(ctx).await;
        if let Ok(store) = ctx.service::<Store>() {
            let all = rows(&v);
            let r = store
                .write(move |w| {
                    for (def, want) in all {
                        let keep: HashSet<String> =
                            want.iter().filter_map(|r| r.get("id").and_then(Value::as_str).map(str::to_owned)).collect();
                        for old in w.query(def.kind, &wisp_store::Query::default())? {
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
                tracing::warn!(error = %e, "connectors: writing the pane's rows");
            }
        }
        v
    }

    async fn write_plan(ctx: &Ctx, plan: &Plan) -> Result<()> {
        let s = secrets(ctx)?;
        for (k, v) in &plan.set {
            s.set(k, v).await?;
        }
        for k in &plan.drop {
            let _ = s.delete(k).await;
        }
        Ok(())
    }

    async fn apply(&self, ctx: &Ctx, op: OpKind, name: &str, spec: &ConnectorSpec, before: Option<&ConnectorSpec>) -> Result<()> {
        let spec = serde_json::to_value(spec).map_err(|e| WireError::internal(e.to_string()))?;
        let before = before.map(|b| serde_json::to_value(b).unwrap_or(Value::Null));
        self.connectors
            .apply(
                &ctx.root_call(),
                &Op { op, kind: "connector".into(), name: name.to_owned(), spec, id: None, changes: Vec::new(), before },
            )
            .await
    }

    pub async fn add(self: &Arc<Self>, ctx: &Ctx, b: &ConnectorBody) -> Result<ConnectorsView> {
        let name = self.create(ctx, b, |_| {}).await?;
        self.test_later(ctx, &name);
        Ok(self.publish(ctx).await)
    }

    /// The new connector stored (no test, no rows yet): its name. `edit` sees the spec before it's applied.
    pub(crate) async fn create(&self, ctx: &Ctx, b: &ConnectorBody, edit: impl FnOnce(&mut ConnectorSpec)) -> Result<String> {
        let name = b.name.clone().unwrap_or_default().trim().to_owned();
        if !valid_name(&name) {
            return Err(WireError::invalid("A name: 1 to 40 of a–z, 0–9 and _"));
        }
        if self.specs().await.iter().any(|(n, _)| *n == name) {
            return Err(WireError::conflict(format!("There's a connector called {name} already")));
        }
        let mut plan = plan_of(&name, b, None)?;
        edit(&mut plan.spec);
        Self::write_plan(ctx, &plan).await?;
        self.apply(ctx, OpKind::Create, &name, &plan.spec, None).await?;
        Ok(name)
    }

    pub async fn update(self: &Arc<Self>, ctx: &Ctx, id: &str, b: &ConnectorBody) -> Result<ConnectorsView> {
        let prev = self.spec(id).await?;
        let plan = if b.edits() {
            plan_of(id, b, Some(&prev))?
        } else {
            Plan { spec: ConnectorSpec { enabled: b.enabled.or(prev.enabled), ..prev.clone() }, ..Plan::default() }
        };
        Self::write_plan(ctx, &plan).await?;
        self.apply(ctx, OpKind::Update, id, &plan.spec, Some(&prev)).await?;
        if b.edits() {
            lock(&self.tests).remove(id);
            self.test_later(ctx, id);
        }
        Ok(self.publish(ctx).await)
    }

    pub async fn remove(&self, ctx: &Ctx, id: &str) -> Result<ConnectorsView> {
        let prev = self.spec(id).await?;
        self.apply(ctx, OpKind::Delete, id, &prev, None).await?;
        if let Ok(s) = secrets(ctx) {
            for k in s.keys(&format!("{}:", secrets_ns(id))).await.unwrap_or_default() {
                let _ = s.delete(&k).await;
            }
        }
        lock(&self.tests).remove(id);
        Ok(self.publish(ctx).await)
    }

    fn test_later(self: &Arc<Self>, ctx: &Ctx, id: &str) {
        let (me, cx, id) = (self.clone(), ctx.clone(), id.to_owned());
        ctx.spawn(async move {
            let _ = me.test(&cx, &id).await;
        });
    }

    /// Starts it (or asks it over HTTP) and keeps the outcome on the row.
    pub async fn test(&self, ctx: &Ctx, id: &str) -> Result<ConnectorsView> {
        let spec = self.spec(id).await?;
        lock(&self.testing).insert(id.to_owned());
        self.publish(ctx).await;
        let mut c = spec.clone();
        for v in c.env.values_mut().chain(c.headers.values_mut()) {
            *v = crate::kinds::reveal(ctx, v).await;
        }
        if c.oauth == Some(true)
            && let Ok(s) = secrets(ctx)
            && let Ok(Some(t)) = s.get(&format!("{}:token", secrets_ns(id))).await
        {
            c.headers.insert("Authorization".into(), format!("Bearer {t}"));
        }
        let at = ctx.clock().map_or(0, |k| k.now_ms());
        let r = if c.url.is_empty() { probe_local(ctx, id, &c, at).await } else { probe_remote(ctx, id, &c, at).await };
        lock(&self.testing).remove(id);
        lock(&self.tests).insert(id.to_owned(), r);
        Ok(self.publish(ctx).await)
    }

    pub async fn import(self: &Arc<Self>, ctx: &Ctx, names: &[String], dismiss: &[String]) -> Result<ImportView> {
        lock(&self.dismissed).extend(dismiss.iter().cloned());
        let list: Vec<Connector> =
            self.specs().await.into_iter().map(|(n, _)| Connector { id: n.clone(), name: n, ..Connector::default() }).collect();
        let all: Vec<Found> = found(&sources().await, &list);
        let mut skipped = Vec::new();
        for n in names {
            let Some(f) = all.iter().find(|f| f.name == *n) else {
                skipped.push(Skipped { name: n.clone(), error: "It isn't in a harness's config any more".into() });
                continue;
            };
            if let Err(e) = self.add(ctx, &f.body()).await {
                skipped.push(Skipped { name: n.clone(), error: e.message });
            }
        }
        Ok(ImportView { view: self.publish(ctx).await, skipped })
    }

    /// The sign-in page's URL: discovery from the server's 401, the issuer's metadata, a registration
    /// (reused while it fits), PKCE.
    pub async fn signin(&self, ctx: &Ctx, id: &str, origin: &str) -> Result<SigninUrl> {
        let spec = self.spec(id).await?;
        if spec.url.is_empty() {
            return Err(WireError::invalid("Only a remote connector signs in"));
        }
        let n = net(ctx)?;
        let get = |url: String| {
            let n = n.clone();
            async move {
                n.fetch(NetRequest {
                    method: "GET".into(),
                    url,
                    headers: vec![("accept".into(), "application/json".into())],
                    ..NetRequest::default()
                })
                .await
                .ok()
                .filter(|r| r.status < 300)
                .and_then(|r| r.json::<serde_json::Map<String, Value>>().ok())
            }
        };
        let hello = n
            .fetch(NetRequest {
                method: "POST".into(),
                url: spec.url.clone(),
                headers: vec![
                    ("content-type".into(), "application/json".into()),
                    ("accept".into(), "application/json, text/event-stream".into()),
                ],
                body: initialize(env!("CARGO_PKG_VERSION")).into_bytes(),
                timeout_ms: 15_000,
            })
            .await?;
        let prm_url = hello.header("www-authenticate").and_then(|w| oauth::resource_metadata(w, &spec.url));
        let prm = match prm_url {
            Some(u) => get(u).await,
            None => None,
        };
        let issuer = oauth::issuer(prm.as_ref(), &spec.url);
        let mut meta = None;
        for u in oauth::meta_urls(&issuer) {
            if let Some(m) = get(u).await {
                meta = Some(m);
                break;
            }
        }
        let found = oauth::meta_from(prm.as_ref(), meta.as_ref(), &issuer, &spec.url);
        let redirect = oauth::redirect_for(origin)?;
        let had = Self::oauth_of(ctx, id).await;
        let o = if let Some(o) = oauth::reuse_client(had.as_ref(), &found, &redirect) {
            o
        } else {
            {
                let reg = found.register.clone().ok_or_else(|| WireError::from(oauth::no_registration(&issuer)))?;
                let r = n
                    .fetch(NetRequest {
                        method: "POST".into(),
                        url: reg,
                        headers: vec![("content-type".into(), "application/json".into())],
                        body: oauth::registration_body(&redirect).to_string().into_bytes(),
                        timeout_ms: 15_000,
                    })
                    .await
                    .ok();
                let body = r.as_ref().and_then(|r| r.json::<Value>().ok());
                let (client_id, secret) = oauth::registered(&issuer, r.as_ref().map(|r| r.status), body.as_ref())?;
                if let Some(sc) = secret {
                    secrets(ctx)?.set(&format!("{}:client_secret", secrets_ns(id)), &sc).await?;
                }
                OAuthMeta { client_id: Some(client_id), redirect: Some(redirect.clone()), ..found }
            }
        };
        let verifier = format!("{}{}", wisp_kernel::ids::uuid7().replace('-', ""), wisp_kernel::ids::uuid7().replace('-', ""));
        let state = wisp_kernel::ids::uuid7().replace('-', "");
        let url = oauth::authorize_url(&o, &redirect, &oauth::challenge(&verifier), &state)?;
        secrets(ctx)?.set(&format!("{}:oauth", secrets_ns(id)), &serde_json::to_string(&o).unwrap_or_default()).await?;
        let at = ctx.clock().map_or(0, |k| k.now_ms());
        lock(&self.pending).begin(state, oauth::Pending { id: id.to_owned(), verifier, redirect, at });
        Ok(SigninUrl { url })
    }

    /// The browser came back: the code for tokens, kept in secrets; runs get them from then on.
    #[allow(clippy::many_single_char_names)] // q, p, s, o, t, r: the steps of one exchange
    pub async fn finish(&self, ctx: &Ctx, q: &BTreeMap<String, String>) -> Result<SignedInName> {
        let at = ctx.clock().map_or(0, |k| k.now_ms());
        let p = lock(&self.pending).take(q.get("state").map_or("", String::as_str), at)?;
        oauth::callback_refusal(q)?;
        let code = q.get("code").filter(|c| !c.is_empty()).ok_or_else(|| WireError::invalid("The sign-in sent no code back"))?;
        let s = secrets(ctx)?;
        let o = Self::oauth_of(ctx, &p.id).await.ok_or_else(|| WireError::invalid("Start the sign-in again from Settings → Connectors"))?;
        let secret = s.get(&format!("{}:client_secret", secrets_ns(&p.id))).await.ok().flatten();
        let form = oauth::form_encode(&oauth::code_form(&o, code, &p, secret.as_deref()));
        let r = net(ctx)?
            .fetch(NetRequest {
                method: "POST".into(),
                url: o.token.clone(),
                headers: vec![
                    ("content-type".into(), "application/x-www-form-urlencoded".into()),
                    ("accept".into(), "application/json".into()),
                ],
                body: form.into_bytes(),
                timeout_ms: 15_000,
            })
            .await?;
        let t = oauth::token_reply(r.status, &String::from_utf8_lossy(&r.body))?;
        s.set(&format!("{}:token", secrets_ns(&p.id)), &t.access).await?;
        if let Some(rf) = &t.refresh {
            s.set(&format!("{}:refresh", secrets_ns(&p.id)), rf).await?;
        }
        s.set(&format!("{}:oauth", secrets_ns(&p.id)), &serde_json::to_string(&oauth::after_tokens(&o, &t, at)).unwrap_or_default())
            .await?;
        let prev = self.spec(&p.id).await?;
        self.apply(ctx, OpKind::Update, &p.id, &ConnectorSpec { oauth: Some(true), ..prev.clone() }, Some(&prev)).await?;
        let _ = self.test(ctx, &p.id).await;
        Ok(SignedInName { name: p.id })
    }

    pub async fn signout(&self, ctx: &Ctx, id: &str) -> Result<ConnectorsView> {
        let prev = self.spec(id).await?;
        let s = secrets(ctx)?;
        for k in ["token", "refresh", "oauth", "client_secret"] {
            let _ = s.delete(&format!("{}:{k}", secrets_ns(id))).await;
        }
        self.apply(ctx, OpKind::Update, id, &ConnectorSpec { oauth: None, ..prev.clone() }, Some(&prev)).await?;
        lock(&self.tests).remove(id);
        Ok(self.publish(ctx).await)
    }
}

/// A local server, started as a run would start it, asked for its tools.
async fn probe_local(ctx: &Ctx, id: &str, c: &ConnectorSpec, at: i64) -> ProbeResult {
    let mut probe = Probe::new(id);
    let Ok(proc) = ctx.service::<wisp_proc::Proc>() else {
        return probe.result(Outcome::Failed("wisp can't start programs here".into()), at);
    };
    let mut env = wisp_proc::Env::default();
    for (k, v) in &c.env {
        env = env.with(k.clone(), v.clone());
    }
    let opts = wisp_proc::SpawnOpts { env, scope: Some(ctx.scope().clone()), ..wisp_proc::SpawnOpts::default() };
    let child = match proc.spawn(&c.command, &c.args, opts) {
        Ok(ch) => ch,
        Err(e) => return probe.result(Outcome::Failed(format!("It wouldn't start: {e}")), at),
    };
    let (handle, mut out) = child.split();
    let _ = handle.write(format!("{}\n", initialize(env!("CARGO_PKG_VERSION"))));
    let mut lines = Lines::default();
    let talk = async {
        while let Some(o) = out.recv().await {
            if o.stream == wisp_proc::Stream::Stderr {
                probe.stderr(&String::from_utf8_lossy(&o.data));
                continue;
            }
            for l in lines.push(&o.data) {
                let step = probe.on_line(&l);
                for s in step.send {
                    let _ = handle.write(format!("{s}\n"));
                }
                if let Some(done) = step.done {
                    return done;
                }
            }
        }
        Outcome::Failed(exited_reason(handle.exited().await.code.unwrap_or(-1)))
    };
    let outcome =
        tokio::time::timeout(Duration::from_millis(PROBE_MS), talk).await.unwrap_or_else(|_| Outcome::Failed(TIMEOUT_REASON.into()));
    let _ = handle.kill().await;
    probe.result(outcome, at)
}

/// One JSON-RPC answer from an HTTP reply: plain JSON, or the first `message` of an event stream.
fn answer_of(r: &wisp_kernel::services::NetResponse) -> Option<String> {
    if r.header("content-type").is_some_and(|t| t.contains("text/event-stream")) {
        let mut sse = Sse::default();
        return sse.push(&r.body).into_iter().map(|e| e.data).find(|d| d.contains("\"id\""));
    }
    Some(String::from_utf8_lossy(&r.body).into_owned())
}

/// A remote server, asked over HTTP (streamable HTTP: `initialize`, then `tools/list` with its session).
async fn probe_remote(ctx: &Ctx, id: &str, c: &ConnectorSpec, at: i64) -> ProbeResult {
    let mut probe = Probe::new(id);
    let Ok(n) = net(ctx) else { return probe.result(Outcome::Failed("wisp can't reach the network here".into()), at) };
    let mut headers: Vec<(String, String)> = c.headers.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    headers.push(("content-type".into(), "application/json".into()));
    headers.push(("accept".into(), "application/json, text/event-stream".into()));
    let mut send = vec![initialize(env!("CARGO_PKG_VERSION"))];
    let mut session: Option<String> = None;
    for _ in 0..6 {
        let Some(body) = send.pop() else { break };
        let mut h = headers.clone();
        if let Some(s) = &session {
            h.push(("mcp-session-id".into(), s.clone()));
        }
        let r = match n
            .fetch(NetRequest { method: "POST".into(), url: c.url.clone(), headers: h, body: body.into_bytes(), timeout_ms: 30_000 })
            .await
        {
            Ok(r) => r,
            Err(e) => return probe.result(Outcome::Failed(e.message), at),
        };
        if r.status >= 400 {
            let reason = if r.status == 401 { "needs sign-in (HTTP 401)" } else { "" };
            return probe.result(Outcome::Failed(if reason.is_empty() { http_failure(r.status, "") } else { reason.into() }), at);
        }
        if let Some(s) = r.header("mcp-session-id") {
            session = Some(s.to_owned());
        }
        let Some(line) = answer_of(&r) else { continue };
        let step = probe.on_line(&line);
        if let Some(done) = step.done {
            return probe.result(done, at);
        }
        // the notification needs no answer: it goes, then what asks the next question
        for s in step.send.into_iter().rev() {
            if s.contains("notifications/initialized") {
                let mut h = headers.clone();
                if let Some(sid) = &session {
                    h.push(("mcp-session-id".into(), sid.clone()));
                }
                let _ = n
                    .fetch(NetRequest { method: "POST".into(), url: c.url.clone(), headers: h, body: s.into_bytes(), timeout_ms: 10_000 })
                    .await;
            } else {
                send.push(s);
            }
        }
    }
    probe.result(Outcome::Failed("It didn't list its tools".into()), at)
}

pub(crate) fn register(s: &mut Setup, kind: Arc<StoredKind>, connectors: Arc<dyn ResourceKind>) {
    let pane = Arc::new(Pane {
        kind,
        connectors,
        tests: Mutex::default(),
        testing: Mutex::default(),
        dismissed: Mutex::default(),
        pending: Mutex::default(),
    });
    macro_rules! on {
        ($C:ty, |$p:ident, $ctx:ident, $a:ident| $body:expr) => {{
            let pane = pane.clone();
            s.command::<$C, _, _>(move |$ctx, _call, $a| {
                let $p = pane.clone();
                async move { $body }
            });
        }};
    }
    on!(api::List, |p, ctx, _a| Ok(p.publish(&ctx).await));
    on!(api::Add, |p, ctx, a| p.add(&ctx, &a).await);
    on!(api::Update, |p, ctx, a| p.update(&ctx, &a.id, &a.body).await);
    on!(api::Remove, |p, ctx, a| p.remove(&ctx, &a.id).await);
    on!(api::Test, |p, ctx, a| p.test(&ctx, &a.id).await);
    on!(api::Import, |p, ctx, a| p.import(&ctx, &a.names, &a.dismiss).await);
    on!(api::Signin, |p, ctx, a| p.signin(&ctx, &a.id, &a.origin).await);
    on!(api::OauthFinish, |p, ctx, a| p.finish(&ctx, &a.query).await);
    on!(api::Signout, |p, ctx, a| p.signout(&ctx, &a.id).await);
    crate::agent::register(s, &pane);
    let cb = pane.clone();
    s.route(wisp_kernel::http::Route {
        method: "GET",
        pattern: "/connectors/oauth/callback",
        permission: "connectors:oauthFinish",
        doc: false,
        summary: "Where a connector's sign-in comes back to",
        raw: false,
        max_body: None,
        handler: Arc::new(move |ctx, _call, req| {
            let p = cb.clone();
            Box::pin(async move {
                let q: BTreeMap<String, String> = req.query.iter().cloned().collect();
                let (title, text) = match p.finish(&ctx, &q).await {
                    Ok(n) => wisp_connectors_core::page::signed_in(&n.name),
                    Err(e) => wisp_connectors_core::page::failed(&e.message),
                };
                Ok(wisp_kernel::http::Response::Text {
                    status: 200,
                    content_type: "text/html; charset=utf-8".into(),
                    body: wisp_connectors_core::page::callback_page(&title, &text),
                })
            })
        }),
    });
    s.on_start(move |ctx| async move {
        if let Ok(store) = ctx.service::<Store>() {
            install(&store).map_err(|e| WireError::internal(e.to_string()))?;
        }
        let (p, c) = (pane.clone(), ctx.clone());
        ctx.spawn(async move {
            p.publish(&c).await;
        });
        Ok(())
    });
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;
    use wisp_connectors_api::SecretField;

    fn field(k: &str, v: &str) -> SecretField {
        SecretField { key: k.into(), value: json!(v) }
    }

    /// A form becomes a spec whose secrets are references: a typed value is written, an empty one keeps the
    /// saved one, a key left out goes; the command line splits; remote needs a URL, local a command.
    /// v1 connectors.js `c.transport ||= b.url ? 'remote' : 'local'`: a new connector with a URL and no
    /// transport is remote; an edit that names neither keeps what it was.
    #[test]
    fn a_new_connector_with_a_url_is_remote_without_saying_so() {
        let b = ConnectorBody { url: Some("https://mcp.linear.app/mcp".into()), ..ConnectorBody::default() };
        assert_eq!(plan_of("linear", &b, None).unwrap().spec.url, "https://mcp.linear.app/mcp");
        let local = ConnectorSpec { command: "docs-mcp".into(), ..ConnectorSpec::default() };
        let rename = ConnectorBody { enabled: Some(false), ..ConnectorBody::default() };
        assert_eq!(plan_of("docs", &rename, Some(&local)).unwrap().spec.command, "docs-mcp", "an edit keeps its kind");
        assert!(plan_of("x", &ConnectorBody::default(), None).is_err(), "neither: a local one without its command");
    }

    #[test]
    fn a_connector_form_keeps_secrets_out_of_its_spec() {
        let b = ConnectorBody {
            name: Some("gh".into()),
            command: Some("npx -y @mcp/github".into()),
            env: Some(SecretInput::List(vec![field("TOKEN", "ghp_x"), field("EMPTY", "")])),
            ..ConnectorBody::default()
        };
        let p = plan_of("gh", &b, None).unwrap();
        assert_eq!(p.spec.command, "npx");
        assert_eq!(p.spec.args, ["-y", "@mcp/github"]);
        assert_eq!(p.spec.env["TOKEN"], "${secret:connector:gh:env:TOKEN}");
        assert!(!p.spec.env.contains_key("EMPTY"), "nothing saved, nothing typed: no key");
        assert_eq!(p.set, vec![("connector:gh:env:TOKEN".to_owned(), "ghp_x".to_owned())]);
        // the edit: the token kept (empty value), a new key typed
        let edit =
            ConnectorBody { env: Some(SecretInput::List(vec![field("TOKEN", ""), field("ORG", "acme")])), ..ConnectorBody::default() };
        let q = plan_of("gh", &edit, Some(&p.spec)).unwrap();
        assert_eq!(q.spec.env["TOKEN"], "${secret:connector:gh:env:TOKEN}");
        assert_eq!(q.set, vec![("connector:gh:env:ORG".to_owned(), "acme".to_owned())]);
        assert_eq!(q.drop, Vec::<String>::new());
        let gone =
            plan_of("gh", &ConnectorBody { env: Some(SecretInput::List(vec![])), ..ConnectorBody::default() }, Some(&q.spec)).unwrap();
        assert_eq!(gone.drop.len(), 2, "both keys and their secrets go");
        assert!(
            plan_of(
                "x",
                &ConnectorBody { transport: Some("remote".into()), url: Some("ftp://x".into()), ..ConnectorBody::default() },
                None
            )
            .is_err()
        );
        assert!(plan_of("x", &ConnectorBody { command: Some("  ".into()), ..ConnectorBody::default() }, None).is_err());
        assert!(
            plan_of(
                "x",
                &ConnectorBody {
                    command: Some("x".into()),
                    env: Some(SecretInput::List(vec![field("bad key", "v")])),
                    ..ConnectorBody::default()
                },
                None
            )
            .is_err()
        );
    }

    /// The pane reads flat rows: key names with whether they're set (never a value), snake-case columns for
    /// two-word fields, the reach row `this`.
    #[tokio::test]
    async fn the_connectors_pane_rows_carry_key_names_never_values() {
        let db = Store::open(wisp_store::Location::Memory, Arc::new(wisp_store::SystemClock)).unwrap();
        install(&db).unwrap();
        let spec = ConnectorSpec {
            url: "https://mcp.linear.app/mcp".into(),
            headers: [("Authorization".to_owned(), "${secret:connector:linear:headers:Authorization}".to_owned())].into(),
            ..ConnectorSpec::default()
        };
        let v = ConnectorsView {
            connectors: vec![view_of(
                "linear",
                &spec,
                None,
                true,
                Some(SignedIn { host: "linear.app".into(), at: Some(4) }),
                vec!["claude".into()],
            )],
            found: Vec::new(),
            reach: vec!["claude".into()],
        };
        let all = rows(&v);
        db.write(move |w| {
            for (def, rs) in all {
                for r in rs {
                    w.upsert(def.kind, r)?;
                }
            }
            Ok(())
        })
        .await
        .unwrap();
        let r = db.read(|x| x.get("connectors.connector", "linear")).unwrap().unwrap();
        assert_eq!(r["transport"], "remote");
        assert_eq!(r["headers"][0], json!({ "key": "Authorization", "set": true }));
        assert!(!Value::Object(r.clone()).to_string().contains("secret:"), "no reference, no value: {r:?}");
        assert_eq!(r["signed_in"]["host"], "linear.app");
        assert_eq!(r["testing"], true);
        assert_eq!(db.read(|x| x.get("connectors.reach", "this")).unwrap().unwrap()["harnesses"][0], "claude");
    }

    /// ADR-0057: the variables the config discovery reads carry the PATH the desktop app handed over, not the
    /// inherited one.
    #[cfg(unix)]
    #[test]
    fn config_discovery_sees_the_handed_over_path() {
        let handed = format!("/wisp-handed-connectors/bin:{}", std::env::var("PATH").unwrap_or_default());
        wisp_proc::set_path(&handed);
        assert_eq!(where_().var("PATH"), Some(handed.as_str()));
    }
}
