//! wisp.resources host: one engine over every plugin's kinds (ADR-0026).
//!
//! - `resources.kinds`: what this wisp can declare (each kind's section, owner, scope and schema).
//! - `resources.plan`: the formula's resources against what is here: creates, updates (a desired spec
//!   patches the current one), and with `prune` deletes; each spec checked against its kind's schema;
//!   `${secret:NAME}` references that don't exist here; the sensitive ops in plain words.
//! - `resources.apply`: the same plan, then each op through its owner (`ResourceKind::apply`, which
//!   runs the owner's own commands). Refused while the plan has problems or missing secrets, and for a
//!   foreign formula's sensitive ops without `trust`.
//! - `resources.export`: every shared kind's resources (personal and device kinds when included).
//!
//! It never touches task history (ADR-0029): tasks aren't resources, so nothing here deletes one.

mod applied;

mod capability;

use std::collections::BTreeSet;
use std::sync::Arc;

use wisp_kernel::{Call, Ctx, Manifest, Plugin, Result, Setup, WireError};
use wisp_resources_api::{Applied, Apply, Export, ExportArgs, KindInfo, Kinds, Op, OpKind, Plan, PlanArgs, PlanCmd, RESOURCE_KIND, Refresh, RefreshArgs, Rename, RenameArgs, Resource, ResourceKind, Scope};
use wisp_resources_core::{formula, plan, schema};

pub use wisp_resources_api::PLUGIN_ID;

fn kinds(ctx: &Ctx) -> Vec<Arc<dyn ResourceKind>> {
    let mut ks = ctx.contributions(&RESOURCE_KIND);
    ks.sort_by_key(|k| {
        let i = k.info();
        (i.order, i.kind)
    });
    ks
}

/// The kind a resource names (by kind or by section).
fn find<'a>(ks: &'a [Arc<dyn ResourceKind>], name: &str) -> Option<&'a Arc<dyn ResourceKind>> {
    ks.iter().find(|k| k.info().named(name))
}

fn verb(op: OpKind) -> &'static str {
    match op {
        OpKind::Create => "adds",
        OpKind::Update => "changes",
        OpKind::Delete => "removes",
    }
}

async fn make_plan(ctx: &Ctx, call: &Call, a: &PlanArgs) -> Result<Plan> {
    let ks = kinds(ctx);
    let mut out = Plan::default();
    let mut infos: Vec<KindInfo> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for r in &a.resources {
        if find(&ks, &r.kind).is_none() && !seen.contains(&r.kind) {
            out.problems.push(format!("no plugin in this wisp owns the kind `{}`", r.kind));
            seen.push(r.kind.clone());
        }
    }
    for k in &ks {
        let info = k.info();
        let desired: Vec<Resource> = a
            .resources
            .iter()
            .filter(|r| info.named(&r.kind))
            .map(|r| {
                let mut spec = r.spec.clone();
                k.normalize(&mut spec);
                Resource { kind: info.kind.clone(), spec, ..r.clone() }
            })
            .collect();
        let gone: Vec<&str> = a.destroy.iter().filter_map(|d| d.split_once('.')).filter(|(kind, _)| info.named(kind)).map(|(_, n)| n).collect();
        if desired.is_empty() && gone.is_empty() {
            continue;
        }
        let current = k.read(call).await?;
        if !gone.is_empty() {
            let ops: Vec<Op> = current
                .iter()
                .filter(|c| gone.contains(&c.name.as_str()))
                .map(|c| Op { op: OpKind::Delete, kind: info.kind.clone(), name: c.name.clone(), spec: c.spec.clone(), id: c.id.clone(), changes: Vec::new(), before: None })
                .collect();
            if info.sensitive {
                for o in &ops {
                    out.sensitive.push(k.describe(o).unwrap_or_else(|| format!("{} the {} {}", verb(o.op), info.kind, o.name)));
                }
            }
            out.ops.extend(ops);
            infos.push(info);
            continue;
        }
        let ops = if let Some(ops) = k.plan(&current, &desired, a.prune) {
            out.unchanged += desired.len().saturating_sub(ops.iter().filter(|o| o.op != OpKind::Delete).count());
            ops
        } else {
            let (ops, same) = plan::plan(&current, &desired, a.prune);
            out.unchanged += same;
            ops
        };
        for o in ops.iter().filter(|o| o.op != OpKind::Delete) {
            let r = Resource::new(info.kind.clone(), o.name.clone(), o.spec.clone());
            // a map-form kind's schema is the whole map's: its own check validates each value
            if !info.map_form {
                out.problems.extend(schema::validate(&info.schema, &o.spec, &format!("{}.{}", info.section, o.name)));
            }
            out.problems.extend(k.check(&r).into_iter().map(|p| format!("{}.{}: {p}", info.section, o.name)));
        }
        if info.sensitive {
            for o in &ops {
                out.sensitive.push(k.describe(o).unwrap_or_else(|| format!("{} the {} {}", verb(o.op), info.kind, o.name)));
            }
        }
        // the kind's resources as the apply leaves them: what's kept, what's made or changed
        let mut after: Vec<Resource> = current.iter().filter(|c| !ops.iter().any(|o| o.name == c.name)).cloned().collect();
        after.extend(ops.iter().filter(|o| o.op != OpKind::Delete).map(|o| Resource::new(info.kind.clone(), o.name.clone(), o.spec.clone())));
        out.problems.extend(k.check_all(&after).into_iter().map(|p| format!("{}: {p}", info.section)));
        out.ops.extend(ops);
        infos.push(info);
    }
    plan::order(&mut out.ops, &infos);
    // drift: wisp's copy isn't what was last applied (the files' change is the rest of the diff)
    let base = applied::all(ctx).await.unwrap_or_default();
    for o in out.ops.iter().filter(|o| o.op == OpKind::Update) {
        if let (Some(was), Some(now)) = (base.get(&applied::key(&o.kind, &o.name)), o.before.as_ref())
            && was != now
        {
            out.drift.push(applied::key(&o.kind, &o.name));
        }
    }
    // a secret is referenced, never copied: it must already be here
    let mut names = BTreeSet::new();
    for o in out.ops.iter().filter(|o| o.op != OpKind::Delete) {
        formula::secrets_in(&o.spec, &mut names);
    }
    if !names.is_empty() {
        let secrets = wisp_kernel::services::secrets(ctx)?;
        for n in names {
            if secrets.get(&n).await?.is_none() {
                out.missing_secrets.push(n);
            }
        }
    }
    Ok(out)
}

async fn apply(ctx: &Ctx, call: &Call, a: &PlanArgs) -> Result<Applied> {
    let p = make_plan(ctx, call, a).await?;
    if !p.problems.is_empty() {
        return Err(WireError::invalid(format!("the formula has problems: {}", p.problems.join("; "))));
    }
    if !p.missing_secrets.is_empty() {
        return Err(WireError::invalid(format!("these secrets aren't set here: {} (wisp secret set NAME)", p.missing_secrets.join(", "))));
    }
    if a.foreign && !a.trust && !p.sensitive.is_empty() {
        return Err(WireError::forbidden(format!("this formula comes from elsewhere and changes who may act: {}. Apply it with --trust once you've read it", p.sensitive.join("; "))));
    }
    let ks = kinds(ctx);
    let mut done: Vec<&Op> = Vec::new();
    for op in &p.ops {
        let Some(k) = find(&ks, &op.kind) else { continue };
        if let Err(e) = apply_one(k.as_ref(), call, op).await {
            // all or nothing: what went before is undone, last first, through the same owners
            let left = rollback(&ks, call, &done).await;
            let tail = if left.is_empty() { format!("nothing was changed ({} undone)", done.len()) } else { format!("these couldn't be undone: {}", left.join("; ")) };
            return Err(WireError::new(e.code, format!("{} ({tail})", e.message)));
        }
        done.push(op);
    }
    let base: Vec<(String, Option<serde_json::Value>)> = done.iter().map(|o| (applied::key(&o.kind, &o.name), (o.op != OpKind::Delete).then(|| o.spec.clone()))).collect();
    if let Err(e) = applied::set(ctx, base).await {
        tracing::warn!("resources: the applied baseline wasn't kept: {}", e.message);
    }
    Ok(Applied { applied: done.len(), plan: p })
}

/// Undoes `done` (last first); what couldn't be undone, in words.
async fn rollback(ks: &[Arc<dyn ResourceKind>], call: &Call, done: &[&Op]) -> Vec<String> {
    let mut left = Vec::new();
    for op in done.iter().rev() {
        let Some(k) = find(ks, &op.kind) else { continue };
        let now = k.read(call).await.ok().and_then(|rs| rs.into_iter().find(|r| r.name == op.name));
        let Some(back) = plan::undo(op, now.as_ref()) else {
            if op.op == OpKind::Update {
                left.push(format!("{}/{}: no spec to put back", op.kind, op.name));
            }
            continue;
        };
        if let Err(e) = k.apply(call, &back).await {
            left.push(format!("{}/{}: {}", op.kind, op.name, e.message));
        }
    }
    left
}

async fn apply_one(k: &dyn ResourceKind, call: &Call, op: &Op) -> Result<()> {
    k.apply(call, op).await.map_err(|e| WireError::new(e.code, format!("{}/{}: {}", op.kind, op.name, e.message)))
}

/// `resources.rename`: in place through its kind; the baseline moves with it.
async fn rename(ctx: &Ctx, call: &Call, a: &RenameArgs) -> Result<serde_json::Value> {
    let ks = kinds(ctx);
    let k = find(&ks, &a.kind).ok_or_else(|| WireError::not_found(format!("no plugin owns the kind `{}`", a.kind)))?;
    let kind = k.info().kind;
    if a.from == a.to || a.to.trim().is_empty() {
        return Err(WireError::invalid("rename it to another name"));
    }
    let now = k.read(call).await?;
    if now.iter().any(|r| r.name == a.to) {
        return Err(WireError::conflict(format!("wisp has a {kind} named {} already", a.to)));
    }
    if !now.iter().any(|r| r.name == a.from) {
        return Err(WireError::not_found(format!("wisp has no {kind} named {}", a.from)));
    }
    k.rename(call, &a.from, &a.to).await?;
    let mut base = applied::all(ctx).await.unwrap_or_default();
    let was = base.remove(&applied::key(&kind, &a.from));
    applied::set(ctx, vec![(applied::key(&kind, &a.from), None), (applied::key(&kind, &a.to), was)]).await?;
    Ok(serde_json::json!({ "kind": kind, "from": a.from, "to": a.to }))
}

/// `resources.refresh`: what wisp has now is the baseline (drift accepted). → what was refreshed.
async fn refresh(ctx: &Ctx, call: &Call, a: &RefreshArgs) -> Result<Vec<String>> {
    let ks = kinds(ctx);
    let mut items = Vec::new();
    for r in &a.resources {
        let Some((kind, name)) = r.split_once('/') else { continue };
        let Some(k) = find(&ks, kind) else { continue };
        if let Some(now) = k.read(call).await?.into_iter().find(|x| x.name == name) {
            items.push((applied::key(&k.info().kind, name), Some(now.spec)));
        }
    }
    let done: Vec<String> = items.iter().map(|(k, _)| k.clone()).collect();
    applied::set(ctx, items).await?;
    Ok(done)
}

async fn export(ctx: &Ctx, call: &Call, a: &ExportArgs) -> Result<Vec<Resource>> {
    let mut out = Vec::new();
    for k in kinds(ctx) {
        let i = k.info();
        let named = a.kinds.is_empty() || a.kinds.iter().any(|x| i.named(x));
        let included = i.scope == Scope::Shared || a.include.iter().any(|x| i.named(x)) || (!a.kinds.is_empty() && named);
        if !(named && included) {
            continue;
        }
        out.extend(k.read(call).await?.into_iter().map(|r| Resource { id: None, ..r }));
    }
    Ok(out)
}

#[derive(Debug, Default)]
pub struct ResourcesPlugin;

impl Plugin for ResourcesPlugin {
    fn manifest(&self) -> Manifest {
        Manifest::embedded(include_str!("../wisp-plugin.json"))
    }

    fn setup(&self, s: &mut Setup) -> Result<()> {
        crate::capability::register(s);
        s.command::<Kinds, _, _>(|ctx, _, _| {
            let list: Vec<KindInfo> = kinds(&ctx).iter().map(|k| k.info()).collect();
            async move { Ok(list) }
        });
        s.command::<PlanCmd, _, _>(|ctx, call, a| async move { make_plan(&ctx, &call, &a).await });
        s.command::<Apply, _, _>(|ctx, call, a| async move { apply(&ctx, &call, &a).await });
        s.command::<Rename, _, _>(|ctx, call, a| async move { rename(&ctx, &call, &a).await });
        s.command::<Refresh, _, _>(|ctx, call, a| async move { refresh(&ctx, &call, &a).await });
        s.command::<Export, _, _>(|ctx, call, a| async move { export(&ctx, &call, &a).await });
        Ok(())
    }
}
