//! The picker's list: decide (core), gather (gh through proc, origin through git.service, Linear and Jira
//! through the kernel's HTTP client), and keep it a minute.

use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use wisp_issues_api::{
    Connector, Connectors, Http, IssueList, ListArgs, Problem, ProjectRef, Projects, Source,
};
use wisp_issues_core as core;
use wisp_kernel::{BoxFuture, Call, Result, WireError};
use wisp_proc::{Env, ExecOpts, Proc, ProcError};

/// `owner/repo`'s origin URL of a folder (git.service `remote_url`), None when it has none.
pub trait Origin: Send + Sync + 'static {
    fn origin(&self, call: &Call, dir: &str) -> BoxFuture<'static, Option<String>>;
}

/// A connector's tool, called by wisp (`connectors.call`): the tool's result, or why not in words.
pub trait Tools: Send + Sync + 'static {
    fn call(&self, call: &Call, connector: &str, tool: &str, args: serde_json::Value) -> BoxFuture<'static, std::result::Result<serde_json::Value, String>>;
}

/// What the lister reads through. Each is a trait object so tests swap them.
pub struct Deps {
    /// a signed-in connector's tools (v1 #766); None: only API keys count
    pub tools: Option<Arc<dyn Tools>>,
    pub proc: Proc,
    pub gh: String,
    pub origin: Arc<dyn Origin>,
    pub http: Option<Arc<dyn Http>>,
    pub projects: Option<Arc<dyn Projects>>,
    pub connectors: Option<Arc<dyn Connectors>>,
    pub linear_api: String,
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
}

impl std::fmt::Debug for Deps {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Deps")
            .field("gh", &self.gh)
            .field("linear_api", &self.linear_api)
            .finish_non_exhaustive()
    }
}

#[derive(Debug)]
pub struct Lister {
    deps: Deps,
    cache: Mutex<core::IssueCache>,
}

/// gh and git print "fatal:" / "error:" first; otherwise the tail is the useful part.
pub fn why_of(stderr: &str) -> String {
    let lines: Vec<&str> = stderr
        .trim()
        .lines()
        .filter(|l| !l.trim().is_empty())
        .collect();
    let lead = |l: &&&str| {
        let l = l.to_ascii_lowercase();
        ["fatal", "error"].iter().any(|w| {
            l.strip_prefix(w)
                .is_some_and(|r| !r.starts_with(|c: char| c.is_alphanumeric()))
        })
    };
    lines.iter().find(lead).map_or_else(
        || lines[lines.len().saturating_sub(3)..].join(" "),
        |l| (*l).to_owned(),
    )
}

impl Lister {
    pub fn new(deps: Deps) -> Self {
        Self {
            deps,
            cache: Mutex::new(core::IssueCache::default()),
        }
    }

    pub fn clear(&self) {
        self.cache
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clear();
    }

    /// `not_found` for a project id that isn't one (the route's 404); everything else is a list.
    pub async fn list(&self, call: &Call, args: ListArgs) -> Result<IssueList> {
        let q = core::normalize_q(&args.q);
        let project = self.project(call, args.project.as_deref()).await?;
        let connectors = match &self.deps.connectors {
            Some(c) => c.connectors(call).await.unwrap_or_default(),
            None => Vec::new(),
        };
        let key = core::linear_key(&connectors);
        let jira = core::jira_creds(&connectors);
        // no key: a server signed in with the browser lists them through its own tools (v1 #766)
        let signed = |src| if self.deps.tools.is_some() { core::mcp::signed_in_connector(src, &connectors).map(|c| c.id.clone()) } else { None };
        let linear_mcp = key.is_none().then(|| signed(Source::Linear)).flatten();
        let jira_mcp = jira.is_none().then(|| signed(Source::Jira)).flatten();
        let (linear, has_jira) = (key.is_some() || linear_mcp.is_some(), jira.is_some() || jira_mcp.is_some());
        if let Some(refused) = core::precheck(args.source, project.is_some(), linear, has_jira) {
            return Ok(refused);
        }
        let id = core::cache_key(
            args.source,
            project.as_ref().map_or("", |p| p.id.as_str()),
            &q,
        );
        let now = (self.deps.now)();
        if let Some(hit) = self
            .cache
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&id, now, linear, has_jira)
        {
            return Ok(hit);
        }
        let value = match (args.source, project) {
            (Source::Linear, _) => match (&key, &linear_mcp) {
                (None, Some(c)) => self.linear_tools(call, c, &q, has_jira).await,
                _ => self.linear(key.as_deref().unwrap_or_default(), &q, linear, has_jira).await,
            },
            (Source::Jira, _) => match (&jira, &jira_mcp) {
                (None, Some(c)) => self.jira_tools(call, c, &q, linear).await,
                _ => self.jira(jira.as_ref(), &q, linear, has_jira).await,
            },
            (Source::Github, Some(p)) => self.github(call, &p, &q, linear, has_jira).await,
            (Source::Github, None) => {
                return Err(WireError::internal(
                    "precheck let GitHub through without a project",
                ));
            }
        };
        self.cache
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .put(id, now, value.clone());
        Ok(value)
    }

    async fn project(&self, call: &Call, id: Option<&str>) -> Result<Option<ProjectRef>> {
        let Some(id) = id.filter(|i| !i.is_empty()) else {
            return Ok(None);
        };
        let found = match &self.deps.projects {
            Some(p) => p.project(call, id).await?,
            None => None,
        };
        match found {
            Some(p) => Ok(Some(p)),
            None if id == "none" => Ok(None),
            // a folder (a trigger's `project`): its origin says the repo
            None if id.starts_with('/') => Ok(Some(ProjectRef { id: id.to_owned(), name: id.rsplit('/').next().unwrap_or(id).to_owned(), repo: String::new(), dir: Some(id.to_owned()) })),
            None => Err(WireError::not_found("No such project")),
        }
    }

    async fn github(
        &self,
        call: &Call,
        p: &ProjectRef,
        q: &str,
        linear: bool,
        jira: bool,
    ) -> IssueList {
        let origin = match (&p.dir, core::github_repo(&p.repo)) {
            (Some(dir), None) => self.deps.origin.origin(call, dir).await,
            _ => None,
        };
        let Some(repo) = core::repo_of_project(&p.repo, origin.as_deref()) else {
            return core::no_remote(&p.name, linear, jira);
        };
        let base = IssueList {
            source: Source::Github,
            linear,
            jira,
            repo: Some(repo.clone()),
            ..IssueList::default()
        };
        match self.gh(&repo, q, call).await {
            Ok(issues) => IssueList { issues, ..base },
            Err(problem) => IssueList {
                error: Some(problem.error),
                fix: problem.fix,
                ..base
            },
        }
    }

    async fn gh(
        &self,
        repo: &str,
        q: &str,
        call: &Call,
    ) -> std::result::Result<Vec<wisp_issues_api::Issue>, Problem> {
        let env = Env::default()
            .with("GH_PROMPT_DISABLED", "1")
            .with("GH_NO_UPDATE_NOTIFIER", "1")
            .with("GIT_TERMINAL_PROMPT", "0");
        let opts = ExecOpts {
            env,
            timeout: Some(Duration::from_secs(30)),
            scope: Some(call.cancelled().clone()),
            ..ExecOpts::default()
        };
        match self
            .deps
            .proc
            .exec(&self.deps.gh, &core::gh_args(repo, q), opts)
            .await
        {
            Err(ProcError::NotFound(_)) => Err(core::gh_problem(true, "", repo)),
            Err(e) => Err(core::gh_problem(false, &e.to_string(), repo)),
            Ok(r) if r.timed_out => Err(core::gh_problem(false, "timed out after 30 s", repo)),
            Ok(r) if !r.exit.success() => {
                Err(core::gh_problem(false, &why_of(&r.stderr_text()), repo))
            }
            Ok(r) => core::gh_list(&r.stdout_text()).map_err(|error| Problem { error, fix: None }),
        }
    }

    async fn send(
        &self,
        req: wisp_issues_api::HttpRequest,
        what: &str,
    ) -> std::result::Result<wisp_issues_api::HttpResponse, Problem> {
        let Some(http) = &self.deps.http else {
            return Err(Problem {
                error: format!("Couldn’t reach {what}: no network here"),
                fix: None,
            });
        };
        http.send(req).await.map_err(|e| Problem {
            error: format!("Couldn’t reach {what}: {e}"),
            fix: None,
        })
    }

    async fn linear(&self, key: &str, q: &str, linear: bool, jira: bool) -> IssueList {
        let base = IssueList {
            source: Source::Linear,
            linear,
            jira,
            ..IssueList::default()
        };
        let got = match self
            .send(
                core::linear_request(&self.deps.linear_api, key, q),
                "Linear",
            )
            .await
        {
            Ok(r) => core::linear_response(r.status, &r.status_text, &r.body),
            Err(p) => Err(p),
        };
        match got {
            Ok(issues) => IssueList { issues, ..base },
            Err(p) => core::refused(Source::Linear, linear, jira, p),
        }
    }

    async fn tool(&self, call: &Call, c: &str, tool: &str, args: serde_json::Value) -> std::result::Result<serde_json::Value, String> {
        match &self.deps.tools {
            Some(t) => t.call(call, c, tool, args).await,
            None => Err("no connectors here".into()),
        }
    }

    /// Linear through its server's `list_issues`: yours, else (a team that doesn't assign) the workspace's open ones.
    async fn linear_tools(&self, call: &Call, c: &str, q: &str, jira: bool) -> IssueList {
        let (mut got, mut scope) = (Vec::new(), "mine");
        for who in [Some("me"), None] {
            scope = if who.is_some() { "mine" } else { "all" };
            match self.tool(call, c, "list_issues", core::mcp::linear_args(who, q)).await {
                Ok(r) => got = core::mcp::linear_list(&r),
                Err(e) => return core::refused(Source::Linear, true, jira, core::mcp::mcp_problem(Source::Linear, &e)),
            }
            if !got.is_empty() {
                break;
            }
        }
        IssueList { source: Source::Linear, issues: got, linear: true, jira, scope: Some(scope.into()), ..IssueList::default() }
    }

    /// Jira through Atlassian's server: the first site with Jira, then a JQL search there.
    async fn jira_tools(&self, call: &Call, c: &str, q: &str, linear: bool) -> IssueList {
        let fail = |e: &str| core::refused(Source::Jira, linear, true, core::mcp::mcp_problem(Source::Jira, e));
        let sites = match self.tool(call, c, "getAccessibleAtlassianResources", serde_json::json!({})).await {
            Ok(r) => r,
            Err(e) => return fail(&e),
        };
        let Some((cloud, url)) = core::mcp::jira_site(&sites) else {
            return core::refused(Source::Jira, linear, true, Problem { error: core::mcp::NO_JIRA_SITE.into(), fix: None });
        };
        match self.tool(call, c, "searchJiraIssuesUsingJql", core::mcp::jira_args(&cloud, q)).await {
            Ok(r) => IssueList { source: Source::Jira, issues: core::mcp::jira_list(&url, &r), linear, jira: true, ..IssueList::default() },
            Err(e) => fail(&e),
        }
    }

    async fn jira(
        &self,
        creds: Option<&core::JiraCreds>,
        q: &str,
        linear: bool,
        jira: bool,
    ) -> IssueList {
        let Some(c) = creds else {
            return core::refused(Source::Jira, linear, jira, Problem::default());
        };
        let got = match self.send(core::jira_request(c, q), "Jira").await {
            Ok(r) => core::jira_response(&c.site, r.status, &r.status_text, &r.body),
            Err(p) => Err(p),
        };
        match got {
            Ok(issues) => IssueList {
                source: Source::Jira,
                issues,
                linear,
                jira,
                ..IssueList::default()
            },
            Err(p) => core::refused(Source::Jira, linear, jira, p),
        }
    }
}

/// Connectors given as a fixed list (tests, and installs without a connectors plugin).
#[derive(Debug, Clone, Default)]
pub struct FixedConnectors(pub Vec<Connector>);

impl Connectors for FixedConnectors {
    fn connectors(&self, _call: &Call) -> BoxFuture<'static, Result<Vec<Connector>>> {
        let v = self.0.clone();
        Box::pin(async move { Ok(v) })
    }
}
