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

mod capability;

use std::collections::BTreeSet;
use std::sync::Arc;

use wisp_kernel::{Call, Ctx, Manifest, Plugin, Result, Setup, WireError};
use wisp_resources_api::{Applied, Apply, Export, ExportArgs, KindInfo, Kinds, Op, OpKind, Plan, PlanArgs, PlanCmd, RESOURCE_KIND, Resource, ResourceKind, Scope};
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
        out.ops.extend(ops);
        infos.push(info);
    }
    plan::order(&mut out.ops, &infos);
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
        s.command::<Export, _, _>(|ctx, call, a| async move { export(&ctx, &call, &a).await });
        Ok(())
    }
}
