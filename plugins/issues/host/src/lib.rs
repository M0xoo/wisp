//! wisp.issues: issues to start a task from (New task → Issue, ⌘K). `issues.list` and v1's
//! `GET /api/issues ?project=<id>&q=&source=github|linear|jira`, a thin adapter over it: a problem comes
//! back as `{error, fix}` beside an empty list, for the picker to show.

pub mod list;

use std::sync::Arc;

use tracing::Instrument;

use wisp_git_api::GitServiceV1;
use wisp_issues_api::{CONNECTORS, Connectors, Http, List, ListArgs, PROJECTS, Projects, Source};
use wisp_kernel::http::{Request, Response, Route};
use wisp_kernel::{BoxFuture, Call, Ctx, Manifest, Plugin, Result, Setup};

pub use list::{Deps, FixedConnectors, Lister, Origin, why_of};

#[derive(Debug, Default)]
pub struct IssuesPlugin;

impl Plugin for IssuesPlugin {
    fn manifest(&self) -> Manifest {
        Manifest::embedded(include_str!("../wisp-plugin.json"))
    }

    fn setup(&self, s: &mut Setup) -> Result<()> {
        let ctx = s.ctx();
        let lister = Arc::new(Lister::new(deps(&ctx)?));
        let l = lister.clone();
        s.command::<List, _, _>(move |_ctx, call, args| {
            let l = l.clone();
            let span = tracing::info_span!("issues.list", source = args.source.as_str());
            async move { l.list(&call, args).await }.instrument(span)
        });
        s.route(route(lister));
        Ok(())
    }
}

/// The origin through git.service: `repo(dir).remote_url("origin")`, owned by the plugin's scope.
struct GitOrigin(Ctx);

impl Origin for GitOrigin {
    fn origin(&self, call: &Call, dir: &str) -> BoxFuture<'static, Option<String>> {
        let (ctx, call, dir) = (self.0.clone(), call.clone(), dir.to_owned());
        Box::pin(async move {
            let git = ctx.use_service::<GitServiceV1>().ok()?;
            let repo = git.repo(&call, ctx.scope(), &dir).await.ok()?;
            repo.remote_url(&call, "origin").await.ok().flatten()
        })
    }
}

/// Points and services are read when a list is asked for, so a plugin switched on later counts.
struct FirstProjects(Ctx);
impl Projects for FirstProjects {
    fn project(
        &self,
        call: &Call,
        id: &str,
    ) -> BoxFuture<'static, Result<Option<wisp_issues_api::ProjectRef>>> {
        match self.0.contributions(&PROJECTS).first() {
            Some(p) => p.project(call, id),
            None => Box::pin(async { Ok(None) }),
        }
    }
}

struct AllConnectors(Ctx);
impl Connectors for AllConnectors {
    fn connectors(
        &self,
        call: &Call,
    ) -> BoxFuture<'static, Result<Vec<wisp_issues_api::Connector>>> {
        let all: Vec<_> = self
            .0
            .contributions(&CONNECTORS)
            .iter()
            .map(|c| c.connectors(call))
            .collect();
        Box::pin(async move {
            let mut out = Vec::new();
            for f in all {
                out.extend(f.await.unwrap_or_default());
            }
            Ok(out)
        })
    }
}

fn deps(ctx: &Ctx) -> Result<Deps> {
    let proc = ctx.service::<wisp_proc::Proc>()?;
    let clock = ctx.clock().ok();
    Ok(Deps {
        proc: (*proc).clone(),
        gh: std::env::var("WISP_GH_BIN").unwrap_or_else(|_| "gh".into()),
        origin: Arc::new(GitOrigin(ctx.clone())),
        http: ctx.service::<Arc<dyn Http>>().ok().map(|h| (*h).clone()),
        projects: Some(Arc::new(FirstProjects(ctx.clone()))),
        connectors: Some(Arc::new(AllConnectors(ctx.clone()))),
        linear_api: std::env::var("WISP_LINEAR_API")
            .unwrap_or_else(|_| wisp_issues_core::sources::LINEAR_API.into()),
        now: Arc::new(move || clock.as_ref().map_or(0, |c| c.now_ms())),
    })
}

fn error(status: u16, message: &str) -> Response {
    Response::Json {
        status,
        body: serde_json::json!({ "error": message }),
    }
}

/// `GET /issues`, answered as v1 did (400 for a source it doesn't know, 404 for a project that isn't one).
pub async fn get_issues(lister: &Lister, call: &Call, req: &Request) -> Result<Response> {
    let raw = req.query("source").unwrap_or("github");
    let Some(source) = Source::parse(raw) else {
        return Ok(error(400, "source is github, linear or jira"));
    };
    let args = ListArgs {
        source,
        project: req
            .query("project")
            .filter(|p| !p.is_empty())
            .map(str::to_owned),
        q: req.query("q").unwrap_or_default().to_owned(),
    };
    match lister.list(call, args).await {
        Ok(list) => Response::ok(list),
        Err(e) if e.status() == 404 => Ok(error(404, &e.message)),
        Err(e) => Err(e),
    }
}

pub fn route(lister: Arc<Lister>) -> Route {
    Route {
        method: "GET",
        pattern: "/issues",
        permission: "issues:list",
        doc: true,
        summary: "Open issues to start a task from: a project's on GitHub, yours on Linear or Jira",
        raw: false,
        max_body: None,
        handler: Arc::new(move |_ctx, call, req| {
            let l = lister.clone();
            Box::pin(async move { get_issues(&l, &call, &req).await })
        }),
    }
}
