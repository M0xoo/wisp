//! Sharing members (v1 crew-share.js): `crew.export` builds the bundle and refuses it while the secret scan
//! finds anything; `crew.import` reviews a bundle (`dryRun`) and then adds its members, all or none, paused;
//! `crew.kit` lists the skills (wisp's `skill` resources) and the project's AGENTS.md a member's kit can
//! take. The decisions are wisp-crew-core's (`transfer`, `share`, `scan`); this reads and writes the crew.

use std::sync::Arc;

use serde_json::{Value, json};
use wisp_crew_api::commands::{self as c, LocalKitFile};
use wisp_crew_api::{HARNESSES, MAX_CREW, Member};
use wisp_crew_core::cron::CronOnly;
use wisp_crew_core::member::Checks;
use wisp_crew_core::mentions::handle_of;
use wisp_crew_core::scan::scan_all;
use wisp_crew_core::share::{CrewFile, parse_crew_file};
use wisp_crew_core::transfer::{export_crew, import_members, plan_import};
use wisp_kernel::{Ctx, Setup, WireError};

use crate::{NewIds, State, calls, lock, wire};

/// The bundle for `a` from `crew`, or why it can't go (a secret in it, nobody picked).
pub fn export(crew: &[Member], a: &c::ExportArgs) -> Result<c::Exported, WireError> {
    if a.gist == Some(true) {
        return Err(WireError::invalid("A gist isn't made from here yet: save the file and share it."));
    }
    let e = export_crew(crew, &a.ids, &|_| Vec::new(), a.kit.unwrap_or(true), a.notebook.unwrap_or(false), a.team.unwrap_or(false))
        .map_err(wire)?;
    let hits = scan_all(&e.texts);
    if let Some(h) = hits.first() {
        let more = if hits.len() > 1 { format!(" (and {} more)", hits.len() - 1) } else { String::new() };
        return Err(WireError::invalid(format!(
            "{} looks like it holds {} (line {}){more}: take it out before sharing.",
            h.place, h.what, h.line
        )));
    }
    Ok(c::Exported { bundle: e.bundle, notes: e.notes, file: e.file, gist: None })
}

/// The bundle an import reads: the pasted text or the bundle itself (a link is fetched by the caller).
fn bundle_of(a: &c::ImportArgs) -> Result<(Value, &'static str), WireError> {
    if let Some(b) = &a.bundle {
        return Ok((b.clone(), "file"));
    }
    if a.url.as_deref().is_some_and(|u| !u.trim().is_empty()) {
        return Err(WireError::invalid("Paste the file's text: links and gists aren't read from here yet."));
    }
    let text = a.text.as_deref().unwrap_or_default().trim();
    if text.is_empty() {
        return Err(WireError::invalid("Paste a crew file, or pick one."));
    }
    serde_json::from_str(text).map(|v| (v, "file")).map_err(|_| WireError::invalid("That isn't a crew file: it isn't JSON."))
}

/// The review (`dryRun`), or the members it adds to `crew` (all or none, paused).
pub fn import(crew: &[Member], a: &c::ImportArgs, now: i64) -> Result<(c::Imported, Vec<Member>), WireError> {
    let (j, source) = bundle_of(a)?;
    let CrewFile::Members(list) = parse_crew_file(&j, &CronOnly).map_err(wire)?;
    let taken: Vec<String> = crew.iter().map(|m| handle_of(&m.name)).collect();
    let agents: Vec<String> = HARNESSES.iter().map(|h| (*h).to_owned()).collect();
    let choices = a.choices.clone().unwrap_or(Value::Null);
    let plan = plan_import(&list, &taken, &agents, &choices).map_err(wire)?;
    let room = u32::try_from(MAX_CREW.saturating_sub(crew.len())).unwrap_or(0);
    let src = json!({ "kind": source });
    if a.dry_run {
        let members = plan.iter().map(|p| serde_json::to_value(p).unwrap_or(Value::Null)).collect();
        return Ok((c::Imported { members, spell: None, source: Some(src), room: Some(room) }, Vec::new()));
    }
    let exists = |p: &str| std::path::Path::new(p).is_dir();
    let machine_ok = |_: &str| false;
    let agent_ok = |x: &str| HARNESSES.contains(&x);
    let checks = Checks { taken: crew, exists: &exists, machine_ok: &machine_ok, words: &CronOnly, agent_ok: &agent_ok };
    let made = import_members(&plan, &checks, &mut NewIds, now).map_err(wire)?;
    let members: Vec<Member> = made.into_iter().map(|(m, _on)| m).collect();
    let rows = members.iter().map(|m| json!({ "id": m.id, "name": m.name })).collect();
    Ok((
        c::Imported {
            members: rows,
            spell: None,
            source: Some(src),
            room: Some(room.saturating_sub(u32::try_from(members.len()).unwrap_or(0))),
        },
        members,
    ))
}

/// What a kit can take here: wisp's skills, and the project's AGENTS.md.
async fn kit(ctx: &Ctx, cwd: &str) -> Vec<LocalKitFile> {
    let call = ctx.root_call();
    let mut out: Vec<LocalKitFile> = calls::export(ctx, &call, &["skill"])
        .await
        .unwrap_or_default()
        .into_iter()
        .filter(|r| r.kind == "skill")
        .map(|r| {
            let s = |k: &str| r.spec.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
            LocalKitFile { description: s("description"), path: s("path"), name: r.name, from: "home".into() }
        })
        .collect();
    if !cwd.is_empty() {
        let p = format!("{}/AGENTS.md", cwd.trim_end_matches('/'));
        if tokio::fs::metadata(&p).await.is_ok_and(|m| m.is_file()) {
            out.push(LocalKitFile {
                name: "AGENTS.md".into(),
                description: "this project's instructions".into(),
                path: p,
                from: "project".into(),
            });
        }
    }
    out
}

pub(crate) fn register(s: &mut Setup, st: &Arc<State>) {
    let e = st.clone();
    s.command::<c::Export, _, _>(move |ctx, call, a| {
        let st = e.clone();
        async move {
            let crew = lock(&st.saved).crew.clone();
            let out = export(&crew, &a)?;
            let shared = wisp_crew_api::events::Shared {
                members: u32::try_from(a.ids.len()).unwrap_or(0),
                gist: false,
                notebook: a.notebook.unwrap_or(false),
            };
            track(&ctx, "crew_shared", serde_json::json!({ "members": shared.members, "gist": shared.gist, "notebook": shared.notebook }))
                .await;
            ctx.emit(&call, &shared);
            Ok(out)
        }
    });
    let i = st.clone();
    s.command::<c::Import, _, _>(move |ctx, call, a| {
        let st = i.clone();
        async move {
            let now = ctx.clock().map_or(0, |c| c.now_ms());
            let crew = lock(&st.saved).crew.clone();
            let (out, joined) = import(&crew, &a, now)?;
            if !joined.is_empty() {
                for m in &joined {
                    st.put(m.clone());
                    ctx.emit(&call, &wisp_crew_api::events::Joined { crew_id: m.id.clone(), name: m.name.clone(), how: "import".into() });
                }
                st.save().await;
                let members = u32::try_from(joined.len()).unwrap_or(0);
                track(&ctx, "crew_imported", serde_json::json!({ "members": members, "source": "file", "by": "user" })).await;
                ctx.emit(&call, &wisp_crew_api::events::Imported { members, source: "file".into() });
            }
            Ok(out)
        }
    });
    s.command::<c::LocalKit, _, _>(move |ctx, _call, a| async move { Ok(kit(&ctx, &a.cwd).await) });
}

/// A catalogue event for a fact the crew owns (ADR-0021); never fails the command.
pub(crate) async fn track(ctx: &wisp_kernel::Ctx, event: &str, props: serde_json::Value) {
    calls::warn(&format!("the {event} event isn't tracked"), calls::track(ctx, event, props).await);
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    fn member(name: &str, brief: &str) -> Member {
        Member {
            id: format!("id-{name}"),
            name: name.into(),
            role: "Reviewer".into(),
            brief: brief.into(),
            agent: "claude".into(),
            parallel: 1,
            ..Member::default()
        }
    }

    /// A shared member's bundle comes back in as the same member, paused, under a free name; the review
    /// adds nothing; a secret in what would go refuses the export.
    #[test]
    fn a_crew_bundle_exports_reviews_and_imports_paused_and_a_secret_refuses_it() {
        let crew = vec![member("Ada", "Reviews PRs")];
        let out = export(&crew, &c::ExportArgs { ids: vec!["Ada".into()], ..c::ExportArgs::default() }).unwrap();
        assert_eq!(out.file, "ada.crew.json");
        let text = serde_json::to_string(&out.bundle).unwrap();
        let review = import(&crew, &c::ImportArgs { text: Some(text.clone()), dry_run: true, ..c::ImportArgs::default() }, 1).unwrap();
        assert_eq!(review.0.members.len(), 1);
        assert!(review.1.is_empty(), "a review adds no one");
        let (done, joined) = import(&crew, &c::ImportArgs { text: Some(text), ..c::ImportArgs::default() }, 1).unwrap();
        assert_eq!(joined.len(), 1);
        assert_ne!(joined[0].name, "Ada", "Ada is taken: the newcomer gets another name");
        assert!(joined[0].paused, "they join paused");
        assert_eq!(done.members.len(), 1);
        let leaky = vec![member("Bob", "call the API with sk-ant-api03-abcdefghijklmnopqrstuvwx")];
        assert!(export(&leaky, &c::ExportArgs { ids: vec!["Bob".into()], ..c::ExportArgs::default() }).is_err());
        assert!(import(&crew, &c::ImportArgs { text: Some("nope".into()), ..c::ImportArgs::default() }, 1).is_err(), "not JSON");
        assert!(
            import(&crew, &c::ImportArgs { url: Some("https://x".into()), ..c::ImportArgs::default() }, 1).is_err(),
            "a link isn't fetched here"
        );
    }
}
