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
        return Err(WireError::invalid("wisp shares a crew as a link now (crew.share), not a gist: no GitHub token needed."));
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

/// The bundle an import reads: the pasted text or the bundle itself (a link was fetched into `bundle` by `shared::resolve`).
fn bundle_of(a: &c::ImportArgs) -> Result<(Value, &'static str), WireError> {
    if let Some(b) = &a.bundle {
        return Ok((b.clone(), "file"));
    }
    if a.url.as_deref().is_some_and(|u| !u.trim().is_empty()) {
        return Err(WireError::invalid("A link is read before the import: the host fetches it (crew.import { url })."));
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
        return Ok((c::Imported { members, spell: None, source: Some(src), room: Some(room), ..c::Imported::default() }, Vec::new()));
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
            ..c::Imported::default()
        },
        members,
    ))
}

/// A file's text, or empty when it can't be read; a skill's path may be its folder (its SKILL.md inside).
async fn read_kit_text(path: &str, skill: bool) -> String {
    if path.is_empty() {
        return String::new();
    }
    let file = match tokio::fs::metadata(path).await {
        Ok(m) if m.is_dir() && skill => format!("{}/SKILL.md", path.trim_end_matches('/')),
        Ok(m) if m.is_file() => path.to_owned(),
        _ => return String::new(),
    };
    tokio::fs::read_to_string(&file).await.map(|t| wisp_crew_core::kit::local_body(&t, skill)).unwrap_or_default()
}

/// What a kit can take here: wisp's skills, and the project's AGENTS.md, each with its text (v1 `/crew-kit`).
async fn kit(ctx: &Ctx, cwd: &str) -> Vec<LocalKitFile> {
    let call = ctx.root_call();
    let skills = calls::export(ctx, &call, &["skill"]).await.unwrap_or_default().into_iter().filter(|r| r.kind == "skill");
    let mut out = Vec::new();
    for r in skills {
        let s = |k: &str| r.spec.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
        let (path, text) = (s("path"), s("body"));
        let body = if text.trim().is_empty() { read_kit_text(&path, true).await } else { wisp_crew_core::kit::local_body(&text, true) };
        out.push(LocalKitFile { description: s("description"), path, name: r.name, from: "home".into(), body });
    }
    if !cwd.is_empty() {
        let p = format!("{}/AGENTS.md", cwd.trim_end_matches('/'));
        let body = read_kit_text(&p, false).await;
        if !body.is_empty() {
            out.push(LocalKitFile {
                name: "AGENTS.md".into(),
                description: "this project's instructions".into(),
                path: p,
                from: "project".into(),
                body,
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
        async move { take_in(&ctx, &call, &st, a, "user", None).await }
    });
    let sh = st.clone();
    s.command::<wisp_crew_api::share::Share, _, _>(move |ctx, call, a| {
        let st = sh.clone();
        async move {
            let crew = lock(&st.saved).crew.clone();
            let out = crate::shared::share(&ctx, &call, &crew, &a).await?;
            let shared = wisp_crew_api::events::Shared { members: out.members, gist: false, notebook: a.notebook.unwrap_or(false) };
            track(&ctx, "crew_shared", json!({ "members": shared.members, "gist": false, "notebook": shared.notebook })).await;
            ctx.emit(&call, &shared);
            Ok(out)
        }
    });
    s.command::<c::LocalKit, _, _>(move |ctx, _call, a| async move { Ok(kit(&ctx, &a.cwd).await) });
}

/// `crew.import`: a link (a share, v1's gist, an https file) is read first, then imported like a pasted file. `cwd`
/// (an agent's `wisp_crew_add { from }`: its project) puts every member there, unless `choices` already say.
pub(crate) async fn take_in(
    ctx: &Ctx,
    call: &wisp_kernel::Call,
    st: &State,
    mut a: c::ImportArgs,
    by: &str,
    cwd: Option<&str>,
) -> Result<c::Imported, WireError> {
    let asked = a.password.as_deref().is_some_and(|p| !p.trim().is_empty());
    let fetched = match crate::shared::resolve(ctx, call, &mut a).await {
        // a review asks for the password in the dialog's words; the import itself keeps the grid's refusal
        Err(e) if a.dry_run && crate::shared::locked(&e) == Some("password") => {
            return Ok(c::Imported { locked: Some("password".into()), wrong: asked, ..c::Imported::default() });
        }
        r => r?,
    };
    let source = fetched.as_ref().map_or("file", |f| f.kind);
    let now = ctx.clock().map_or(0, |c| c.now_ms());
    let crew = lock(&st.saved).crew.clone();
    if let (Some(cwd), None, false) = (cwd, &a.choices, a.dry_run) {
        let review = import(&crew, &c::ImportArgs { dry_run: true, ..a.clone() }, now)?.0;
        a.choices = Some(choices_in(&review.members, cwd));
    }
    let (mut out, joined) = import(&crew, &a, now)?;
    if let Some(f) = &fetched {
        out.source = Some(json!({ "kind": f.kind, "link": f.link }));
    }
    if !joined.is_empty() {
        for m in &joined {
            st.put(m.clone());
            ctx.emit(call, &wisp_crew_api::events::Joined { crew_id: m.id.clone(), name: m.name.clone(), how: "import".into() });
        }
        st.save().await;
        if let Some(f) = &fetched {
            crate::shared::counted(ctx, call, f).await;
        }
        let members = u32::try_from(joined.len()).unwrap_or(0);
        track(ctx, "crew_imported", json!({ "members": members, "source": source, "by": by })).await;
        ctx.emit(call, &wisp_crew_api::events::Imported { members, source: source.into() });
    }
    Ok(out)
}

/// What `wisp_crew_add { from }` asks `crew.import`: a crew file's JSON as pasted text, anything else as a link.
pub fn from_args(from: &str) -> c::ImportArgs {
    let f = from.trim().to_owned();
    if f.starts_with('{') {
        c::ImportArgs { text: Some(f), ..c::ImportArgs::default() }
    } else {
        c::ImportArgs { url: Some(f), ..c::ImportArgs::default() }
    }
}

/// What the agent reads after `wisp_crew_add { from }`: who joined, paused, and where.
pub fn joined_text(members: &[Value], cwd: &str) -> String {
    let names: Vec<&str> = members.iter().filter_map(|m| m.get("name").and_then(Value::as_str)).collect();
    let who = match names.as_slice() {
        [] => return "Nobody joined: the crew file had no one to add.".to_owned(),
        [one] => (*one).to_owned(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    };
    let place = if cwd.is_empty() { String::new() } else { format!(" in {cwd}") };
    format!("Added {who} to your crew{place}, paused: the user resumes each one when they're ready.")
}

/// Every member a review planned, kept, in `cwd` (a member's own folder can't come from the sharer's computer).
pub fn choices_in(plan: &[Value], cwd: &str) -> Value {
    let picks = plan
        .iter()
        .filter_map(|p| {
            let key = p.get("key").and_then(Value::as_str)?;
            let name = p.get("name").and_then(Value::as_str).unwrap_or_default();
            Some((key.to_owned(), json!({ "name": name, "cwd": cwd, "skip": false })))
        })
        .collect::<serde_json::Map<_, _>>();
    Value::Object(picks)
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

    /// A skill found on this computer comes with its text (no front matter), from its folder's SKILL.md; a file that
    /// can't be read gives no text (the UI leaves it out) rather than failing the list.
    #[tokio::test]
    async fn a_local_kit_file_comes_with_its_text_read_from_its_skill_md_or_file() {
        let dir = std::env::temp_dir().join(format!("wisp-crew-kit-{}", std::process::id()));
        let skill = dir.join("release-notes");
        tokio::fs::create_dir_all(&skill).await.unwrap();
        tokio::fs::write(skill.join("SKILL.md"), "---\nname: release-notes\ndescription: Notes\n---\n\n1. Read the log\n").await.unwrap();
        tokio::fs::write(dir.join("AGENTS.md"), "\r\n- Run the tests\r\n").await.unwrap();
        assert_eq!(read_kit_text(skill.to_str().unwrap(), true).await, "1. Read the log");
        assert_eq!(read_kit_text(skill.join("SKILL.md").to_str().unwrap(), true).await, "1. Read the log");
        assert_eq!(read_kit_text(dir.join("AGENTS.md").to_str().unwrap(), false).await, "- Run the tests");
        assert_eq!(read_kit_text(dir.join("gone.md").to_str().unwrap(), false).await, "");
        assert_eq!(read_kit_text("", true).await, "");
        let _ = tokio::fs::remove_dir_all(&dir).await;
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

    /// `wisp_crew_add { from }` (`crew.agent.add`, mcp's `CREW_ADD` owner) reaches `crew.import`: a link goes as `url`
    /// (read by `shared::resolve`), a crew file's JSON as `text`; every member joins paused in the caller's project, and the
    /// agent reads who joined and where.
    #[test]
    fn wisp_crew_add_from_reaches_crew_import() {
        use wisp_kernel::Command as _;
        assert_eq!(c::AgentAdd::ID, "crew.agent.add", "the id wisp.mcp's wisp_crew_add runs (owners::CREW_ADD)");
        let manifest = include_str!("../wisp-plugin.json");
        assert!(manifest.contains("\"crew.agent.add\""), "declared, so a capability set can reach it");
        let a: c::AgentAddArgs = serde_json::from_value(json!({ "session": "s1", "from": " gist:0a1b " })).unwrap();
        assert_eq!(a.from.as_deref(), Some(" gist:0a1b "));
        assert_eq!(from_args("https://grid.trywisp.dev/s/abc").url.as_deref(), Some("https://grid.trywisp.dev/s/abc"));
        assert_eq!(from_args(" gist:0a1b ").url.as_deref(), Some("gist:0a1b"));
        let crew = vec![member("Ada", "Reviews PRs")];
        let out = export(&crew, &c::ExportArgs { ids: vec!["Ada".into()], ..c::ExportArgs::default() }).unwrap();
        let text = serde_json::to_string(&out.bundle).unwrap();
        let mut args = from_args(&format!("  {text}"));
        assert!(args.url.is_none() && args.text.is_some(), "JSON is pasted text, not a link");
        let cwd = std::env::temp_dir();
        let cwd = cwd.to_str().unwrap();
        let review = import(&crew, &c::ImportArgs { dry_run: true, ..args.clone() }, 1).unwrap().0;
        args.choices = Some(choices_in(&review.members, cwd));
        let (done, joined) = import(&crew, &args, 1).unwrap();
        assert_eq!(joined.len(), 1);
        assert!(joined[0].paused, "they join paused");
        assert_eq!(joined[0].cwd, cwd, "in the caller's project");
        let said = joined_text(&done.members, cwd);
        assert!(said.starts_with(&format!("Added {} to your crew in {cwd}, paused", joined[0].name)), "{said}");
        assert_eq!(
            joined_text(&[json!({ "name": "A" }), json!({ "name": "B" }), json!({ "name": "C" })], ""),
            "Added A, B and C to your crew, paused: the user resumes each one when they're ready."
        );
    }
}
