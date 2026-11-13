//! Sharing the crew as a link, and taking one in (ADR-0052). `crew.share` makes `crew.export`'s bundle (refused
//! while the secret scan finds anything; notebooks only when ticked) and sends it through `share.send` as a `crew`
//! share to the first ready destination (wisp Cloud): a grid link with access, expiry and revoke, no GitHub token.
//! `crew.import { url }` reads a share link through `grid-client.fetch`, and still reads v1's gists (`gist:<id>`, a
//! gist page) and any https `.crew.json`; what it finds is imported like a pasted file.

use std::sync::OnceLock;
use std::time::Duration;

use serde_json::{Value, json};
use wisp_crew_api::Member;
use wisp_crew_api::commands::{ExportArgs, ImportArgs};
use wisp_crew_api::share::{SHARE_KIND, ShareArgs, SharedLink};
use wisp_crew_core::source::{MAX_FETCHED, Source, gist_api, gist_text, parse_fetched, share_crew, share_key, source_of};
use wisp_kernel::{Call, Ctx, WireError};
use wisp_share_api::{Destinations, NoArgs, SendArgs, SendCmd};

use crate::{transfer, wire};

type R<T> = Result<T, WireError>;

/// What `share.send` is asked, for `a` over `crew`: the export's bundle (no secrets, no project, computer, log or
/// jobs), keyed so sharing the same members again updates the same link. The notes and how many go come back too.
pub fn send_args(crew: &[Member], a: &ShareArgs, to: &str) -> R<(SendArgs, Vec<String>, u32)> {
    let whole = a.ids.is_empty();
    let ids: Vec<String> = if whole { crew.iter().map(|m| m.id.clone()).collect() } else { a.ids.clone() };
    let e = transfer::export(crew, &ExportArgs { ids: ids.clone(), kit: a.kit, notebook: a.notebook, team: a.team, gist: None })?;
    let members: Vec<&Value> = e.bundle.get("members").and_then(Value::as_array).into_iter().flatten().collect();
    let n = u32::try_from(members.len()).unwrap_or(0);
    let name = |m: &Value| m.get("name").and_then(Value::as_str).unwrap_or_default().to_owned();
    let title = match members.as_slice() {
        [one] => name(one),
        _ if whole => "A crew".to_owned(),
        list => list.iter().map(|m| name(m)).collect::<Vec<_>>().join(", "),
    };
    let summary = members
        .iter()
        .map(|m| format!("{} · {}", name(m), m.get("role").and_then(Value::as_str).unwrap_or_default()))
        .collect::<Vec<_>>()
        .join("\n");
    let access = match a.password.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => json!({ "kind": "password", "password": p }),
        None => json!({ "kind": "anyone" }),
    };
    let args = SendArgs {
        to: to.to_owned(),
        kind: Some(SHARE_KIND.into()),
        content: Some(e.bundle),
        key: Some(share_key(&ids, whole)),
        title: Some(title),
        summary: Some(summary),
        tags: vec![SHARE_KIND.into()],
        access: Some(access),
        expires_at: a.expires_at,
        ..SendArgs::default()
    };
    Ok((args, e.notes, n))
}

/// The first destination ready to take a share, or why none is (sign in to wisp Cloud).
async fn destination(ctx: &Ctx, call: &Call) -> R<String> {
    let dests = ctx.run::<Destinations>(call, NoArgs {}).await?;
    let list = dests.as_array().cloned().unwrap_or_default();
    if let Some(id) = list.iter().find(|d| d.get("ready") == Some(&json!(true))).and_then(|d| d.get("id")).and_then(Value::as_str) {
        return Ok(id.to_owned());
    }
    let why = list.first().and_then(|d| d.get("why")).and_then(Value::as_str).unwrap_or("Sign in to wisp Cloud to share a link.");
    Err(WireError::invalid(why))
}

/// `crew.share`: the link made.
pub(crate) async fn share(ctx: &Ctx, call: &Call, crew: &[Member], a: &ShareArgs) -> R<SharedLink> {
    // what goes is checked before a destination is asked: a secret refuses it even signed out
    send_args(crew, a, "")?;
    let to = destination(ctx, call).await?;
    let (args, notes, members) = send_args(crew, a, &to)?;
    let link = ctx.run::<SendCmd>(call, args).await?;
    let url = link.get("url").and_then(Value::as_str).unwrap_or_default().to_owned();
    Ok(SharedLink { url, members, notes, link })
}

/// Where an import's bundle came from: how (link | gist | url), the link, and the share's version (to count it).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fetched {
    pub kind: &'static str,
    pub link: String,
    pub version: Option<i64>,
}

fn http() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    // no redirects: a public link can't bounce the read to this computer or its network
    C.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("wisp")
            .build()
            .unwrap_or_default()
    })
}

async fn get(url: &str) -> R<Vec<u8>> {
    let mut r = http()
        .get(url)
        .header("accept", "application/vnd.github+json, application/json")
        .send()
        .await
        .map_err(|e| WireError::unavailable(format!("Couldn't read {url}: {e}")))?;
    let status = r.status();
    if status.as_u16() == 404 {
        return Err(WireError::not_found(format!("Nothing at {url}: the link may be wrong, or it was deleted.")));
    }
    if !status.is_success() {
        return Err(WireError::unavailable(format!("{url} answered {status}.")));
    }
    let too_big = || WireError::invalid("That file is too big to be a crew file.");
    if r.content_length().is_some_and(|n| n > MAX_FETCHED as u64) {
        return Err(too_big());
    }
    // read up to the cap, never the whole of an endless answer
    let mut out = Vec::new();
    while let Some(chunk) = r.chunk().await.map_err(|e| WireError::unavailable(format!("Couldn't read {url}: {e}")))? {
        if out.len() + chunk.len() > MAX_FETCHED {
            return Err(too_big());
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

/// The bundle a pasted link holds, read from where it is.
async fn fetch(ctx: &Ctx, call: &Call, src: &Source, password: Option<String>) -> R<(Value, Option<i64>)> {
    match src {
        Source::Share(link) => {
            let f = ctx.run::<wisp_grid_client_api::Fetch>(call, wisp_grid_client_api::FetchArgs { link: link.clone(), password }).await?;
            if !f.verified {
                return Err(WireError::invalid("This share's signature doesn't match its contents: not imported."));
            }
            let kind = f.card.get("kind").and_then(Value::as_str).unwrap_or_default();
            Ok((share_crew(&f.content, kind).map_err(wire)?, Some(f.version)))
        }
        Source::Gist(id) => {
            let api = parse_fetched(&get(&gist_api(id)).await?).map_err(wire)?;
            let text = gist_text(&api).map_err(wire)?;
            Ok((parse_fetched(text.as_bytes()).map_err(wire)?, None))
        }
        Source::Url(url) => Ok((parse_fetched(&get(url).await?).map_err(wire)?, None)),
    }
}

/// An import with a `url`: the bundle it names, fetched, in its place (`None` when there's no link to read).
pub(crate) async fn resolve(ctx: &Ctx, call: &Call, a: &mut ImportArgs) -> R<Option<Fetched>> {
    let Some(url) = a.url.take().filter(|u| !u.trim().is_empty()) else { return Ok(None) };
    let src = source_of(&url).map_err(wire)?;
    // a password-locked link answers that it is (grid-client's words); the dialog has no password box yet
    let (bundle, version) = fetch(ctx, call, &src, None).await?;
    a.bundle = Some(bundle);
    Ok(Some(Fetched { kind: src.kind(), link: url.trim().to_owned(), version }))
}

/// Counted on the grid as taken in, and remembered there for "update available"; the import stands without it.
pub(crate) async fn counted(ctx: &Ctx, call: &Call, f: &Fetched) {
    if f.kind != "link" {
        return;
    }
    let args = wisp_grid_client_api::ImportedArgs { link: f.link.clone(), version: f.version.unwrap_or(0) };
    crate::calls::warn("the share's import count", ctx.run::<wisp_grid_client_api::Imported>(call, args).await);
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;
    use wisp_crew_api::commands as c;

    fn member(name: &str) -> Member {
        Member {
            id: format!("id-{name}"),
            name: name.into(),
            role: "Reviewer".into(),
            brief: "Reviews PRs".into(),
            agent: "claude".into(),
            parallel: 1,
            cwd: "/Users/ada/secret-project".into(),
            machine: "devbox-7".into(),
            notebook: "the staging db is at 10.0.0.4".into(),
            ..Member::default()
        }
    }

    /// What a crew share sends is the export's bundle: who they are and their kit, never their project, computer,
    /// log or jobs, their notebook only when ticked, and nothing the secret scan finds (a key refuses the share).
    #[test]
    fn a_crew_share_bundle_has_no_secrets() {
        let crew = vec![member("Ada"), member("Bob")];
        let (args, _notes, n) = send_args(&crew, &ShareArgs::default(), "wisp-cloud").unwrap();
        assert_eq!(n, 2, "no ids: the whole crew");
        assert_eq!(args.kind.as_deref(), Some("crew"));
        assert_eq!(args.key.as_deref(), Some("crew"));
        assert_eq!(args.access, Some(json!({ "kind": "anyone" })));
        let text = serde_json::to_string(&args.content).unwrap();
        for leak in ["/Users/ada", "devbox-7", "10.0.0.4", "\"log\"", "\"queue\""] {
            assert!(!text.contains(leak), "{leak} went in the share: {text}");
        }
        assert_eq!(wisp_crew_core::scan::scan_all(&[("share".to_owned(), text)]).len(), 0, "the scan finds nothing in what goes");
        let with = ShareArgs { ids: vec!["Ada".into()], notebook: Some(true), password: Some("pw".into()), ..ShareArgs::default() };
        let (args, _, n) = send_args(&crew, &with, "wisp-cloud").unwrap();
        assert_eq!(n, 1);
        assert_eq!(args.title.as_deref(), Some("Ada"));
        assert_eq!(args.key.as_deref(), Some("crew:Ada"));
        assert!(serde_json::to_string(&args.content).unwrap().contains("10.0.0.4"), "the notebook goes when ticked");
        assert_eq!(args.access.unwrap()["kind"], "password");
        let mut leaky = member("Eve");
        leaky.kit.push(wisp_crew_api::KitFile {
            id: "k1".into(),
            kind: "skill".into(),
            name: "deploy".into(),
            description: Some("Deploys".into()),
            body: "export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789".into(),
            path: None,
            on: true,
        });
        assert!(send_args(&[leaky], &ShareArgs::default(), "wisp-cloud").is_err(), "a key in a kit refuses the share");
    }

    /// A share link's content is the crew file; imported, its members join paused.
    #[test]
    fn a_share_link_imports_the_members() {
        let crew = vec![member("Ada")];
        let (args, _, _) = send_args(&crew, &ShareArgs::default(), "wisp-cloud").unwrap();
        assert_eq!(source_of("https://grid.trywisp.dev/s/abc").unwrap().kind(), "link");
        let bundle = share_crew(&args.content.unwrap(), "crew").unwrap();
        let a = c::ImportArgs { bundle: Some(bundle), ..c::ImportArgs::default() };
        let (_, joined) = transfer::import(&[], &a, 1).unwrap();
        assert_eq!(joined.len(), 1);
        assert_eq!(joined[0].name, "Ada");
        assert!(joined[0].paused);
        assert!(joined[0].cwd.is_empty() || joined[0].cwd != "/Users/ada/secret-project", "the sharer's project stays there");
    }

    /// v1 shared a member as a secret gist: `gist:<id>` or its page still names it, and the gist's crew file imports.
    #[test]
    fn a_gist_link_still_imports() {
        let crew = vec![member("Ada")];
        let out = transfer::export(&crew, &c::ExportArgs { ids: vec!["Ada".into()], ..c::ExportArgs::default() }).unwrap();
        let text = serde_json::to_string(&out.bundle).unwrap();
        assert_eq!(source_of("gist:0a1b2c").unwrap(), Source::Gist("0a1b2c".into()));
        assert_eq!(source_of("https://gist.github.com/ada/0a1b2c").unwrap(), Source::Gist("0a1b2c".into()));
        assert_eq!(gist_api("0a1b2c"), "https://api.github.com/gists/0a1b2c");
        let api = json!({ "files": { "ada.crew.json": { "filename": "ada.crew.json", "content": text } } });
        let bundle = parse_fetched(gist_text(&api).unwrap().as_bytes()).unwrap();
        let (_, joined) = transfer::import(&[], &c::ImportArgs { bundle: Some(bundle), ..c::ImportArgs::default() }, 1).unwrap();
        assert_eq!(joined.len(), 1);
        assert_eq!(joined[0].role, "Reviewer");
    }
}
