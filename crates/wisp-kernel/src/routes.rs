//! HTTP routes (the `kernel.http` point) served by the kernel: whole-segment matching (`:name` binds a
//! segment, a trailing `*` binds the rest), lazy activation by `onRoute`, default deny on the route's
//! permission (`http::OPEN` routes check their own secret), and a new root call per request.
use std::collections::BTreeMap;

use crate::call::CallInner;
use crate::http::{Request, Response};
use crate::kernel_api::RouteEntry;
use crate::{BoxFuture, Caller, Code, Kernel, Result, WireError};

/// Binds `path` against `pattern`, or `None`.
pub fn bind(pattern: &str, path: &str) -> Option<BTreeMap<String, String>> {
    let mut params = BTreeMap::new();
    let (mut pp, mut vv) = (pattern.split('/').filter(|s| !s.is_empty()), path.split('/').filter(|s| !s.is_empty()));
    loop {
        match (pp.next(), vv.next()) {
            (None, None) => return Some(params),
            (Some("*"), Some(v)) => {
                let rest: Vec<&str> = std::iter::once(v).chain(vv).collect();
                params.insert("*".into(), rest.join("/"));
                return Some(params);
            }
            (Some("*"), None) => {
                params.insert("*".into(), String::new());
                return Some(params);
            }
            (Some(p), Some(v)) if p.starts_with(':') => {
                params.insert(p[1..].to_owned(), v.to_owned());
            }
            (Some(p), Some(v)) if p == v => {}
            _ => return None,
        }
    }
}

/// The full path a route answers on: under `/api` unless `raw`.
pub fn full_pattern(r: &crate::http::Route) -> String {
    if r.raw { r.pattern.to_owned() } else { format!("/api{}", r.pattern) }
}

fn find(k: &Kernel, method: &str, path: &str) -> Option<(RouteEntry, BTreeMap<String, String>)> {
    // a literal segment beats a parameter: try the routes with more literal segments first
    let mut all: Vec<(usize, RouteEntry)> = k.routes().into_iter().map(|e| (e.route.pattern.split('/').filter(|s| !s.is_empty() && !s.starts_with(':') && *s != "*").count(), e)).collect();
    all.sort_by(|a, b| b.0.cmp(&a.0));
    all.into_iter().filter(|(_, e)| e.route.method.eq_ignore_ascii_case(method)).find_map(|(_, e)| bind(&full_pattern(&e.route), path).map(|p| (e, p)))
}

pub(crate) fn serve(k: Kernel, caller: Caller, mut req: Request) -> BoxFuture<'static, Result<Response>> {
    Box::pin(async move {
        let found = match find(&k, &req.method, &req.path) {
            Some(f) => Some(f),
            None => {
                let name = format!("{} {}", req.method.to_ascii_uppercase(), req.path);
                crate::life::wake(&k.state, "onRoute", &name, None).await;
                find(&k, &req.method, &req.path)
            }
        };
        let Some((e, params)) = found else { return Err(WireError::not_found(format!("no route for {} {}", req.method, req.path))) };
        let open = e.route.permission == crate::http::OPEN || e.route.permission == crate::http::OPEN_QUIET;
        if !open && let Err(why) = crate::caps::explain_in(&k.state.caps, &caller, e.route.permission) {
            let m = format!("{} {} refused: {why}", req.method, req.path);
            return Err(crate::dispatch::refuse(&k.state, Code::Forbidden, m, "edge", vec![format!("{}:{} {}", e.plugin, e.route.method, e.route.pattern)]));
        }
        req.params = params;
        let call = CallInner::detached(&k.state, caller, Some(e.ctx.inner.id.clone()), k.state.root.child_token()).into_call();
        let r = (e.route.handler)(e.ctx.clone(), call, req).await;
        if let Err(err) = &r
            && err.status() >= 500
        {
            k.state.diag.record(k.state.now_ms(), &e.plugin, "route", "internal", format!("{} {}: {}", e.route.method, e.route.pattern, err.message), Vec::new());
        }
        r
    })
}

#[cfg(test)]
mod tests {
    use super::bind;

    #[test]
    fn segments() {
        assert_eq!(bind("/api/sessions/:id", "/api/sessions/abc").and_then(|p| p.get("id").cloned()).as_deref(), Some("abc"));
        assert!(bind("/api/sessions/:id", "/api/sessions").is_none());
        assert!(bind("/api/sessions/:id", "/api/sessions/a/b").is_none());
        assert!(bind("/api/sessions", "/api/sessionsx").is_none());
        assert_eq!(bind("/p/*", "/p/a/b/c").and_then(|p| p.get("*").cloned()).as_deref(), Some("a/b/c"));
        assert!(bind("/api/x", "/api/x/").is_some());
    }
}
