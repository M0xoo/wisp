//! The route table behind `kernel.http` (v1 http/router.js, wisp-kernel's routes.rs). Patterns match
//! whole path segments; `:name` captures one, percent-decoded (a malformed escape matches nothing); a
//! trailing `*` captures the rest. A route with more literal segments goes first (`/projects/discover`
//! before `/projects/:id`, whatever the order they came in), then the order they were added, as the
//! kernel's own matcher does. Bucketed by method and segment count, sorted once when built: a request
//! looks at a handful of patterns, not all 300. HEAD falls back to GET.
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use wisp_kernel::http::{Request, Response};
use wisp_kernel::{BoxFuture, Caller, Result};

/// The edge's own endpoints (not plugin routes).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Own {
    Health,
    Status,
    Events,
    EventsPost,
    Cmd,
    OpenApi,
}

/// A plugin route's handler with its owner's context bound; the backend makes the root call.
pub type Invoke =
    Arc<dyn Fn(Caller, Request) -> BoxFuture<'static, Result<Response>> + Send + Sync>;

#[derive(Clone)]
pub enum Target {
    Own(Own),
    Plugin(Invoke),
}

impl std::fmt::Debug for Target {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Own(o) => write!(f, "Own({o:?})"),
            Self::Plugin(_) => f.write_str("Plugin"),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Entry {
    pub method: String,
    /// the full path pattern: `/api/sessions/:id`, or `/hooks/:id` for a raw route
    pub path: String,
    segs: Vec<Seg>,
    pub permission: String,
    pub doc: bool,
    pub summary: String,
    pub max_body: Option<usize>,
    /// the plugin that added it (`wisp.edge` for the edge's own)
    pub owner: String,
    pub target: Target,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Seg {
    Lit(String),
    Cap(String),
    /// a trailing `*`: the rest of the path, one or more segments
    Rest,
}

impl Entry {
    fn literals(&self) -> usize {
        self.segs
            .iter()
            .filter(|s| matches!(s, Seg::Lit(_)))
            .count()
    }
    fn rest(&self) -> bool {
        matches!(self.segs.last(), Some(Seg::Rest))
    }
}

/// Everything a route needs said about it, owned (plugin routes carry `&'static str`s).
#[derive(Debug, Clone)]
pub struct Spec {
    pub method: String,
    pub pattern: String,
    pub raw: bool,
    pub permission: String,
    pub doc: bool,
    pub summary: String,
    pub max_body: Option<usize>,
    pub owner: String,
}

impl Spec {
    pub fn of(r: &wisp_kernel::http::Route, owner: &str) -> Self {
        Self {
            method: r.method.to_ascii_uppercase(),
            pattern: r.pattern.to_owned(),
            raw: r.raw,
            permission: r.permission.to_owned(),
            doc: r.doc,
            summary: r.summary.to_owned(),
            max_body: r.max_body,
            owner: owner.to_owned(),
        }
    }
}

pub type Params = BTreeMap<String, String>;

#[derive(Debug, Default)]
pub struct Table {
    buckets: HashMap<(String, usize), Vec<Arc<Entry>>>,
    /// routes ending in `*`, by method: they match any length from theirs up
    rests: HashMap<String, Vec<Arc<Entry>>>,
    order: Vec<Arc<Entry>>,
}

fn split(p: &str) -> impl Iterator<Item = &str> {
    p.split('/').filter(|s| !s.is_empty())
}

impl Table {
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds a route; refuses one that names no permission (default deny) or a malformed pattern.
    pub fn add(&mut self, spec: Spec, target: Target) -> std::result::Result<(), String> {
        if !spec.pattern.starts_with('/') {
            return Err(format!(
                "{}: route pattern \"{}\" must start with /",
                spec.owner, spec.pattern
            ));
        }
        if spec.permission.is_empty() {
            return Err(format!(
                "{}: {} {} names no permission (default deny)",
                spec.owner, spec.method, spec.pattern
            ));
        }
        let path = if spec.raw || spec.pattern.starts_with("/api/") {
            spec.pattern.clone()
        } else {
            format!(
                "/api{}",
                if spec.pattern == "/" {
                    ""
                } else {
                    &spec.pattern
                }
            )
        };
        let segs: Vec<Seg> = split(&path)
            .map(|s| match s.strip_prefix(':') {
                Some(c) => Seg::Cap(c.to_owned()),
                None if s == "*" => Seg::Rest,
                None => Seg::Lit(s.to_owned()),
            })
            .collect();
        if segs.iter().rev().skip(1).any(|s| *s == Seg::Rest) {
            return Err(format!(
                "{}: {} {}: `*` only goes last",
                spec.owner, spec.method, spec.pattern
            ));
        }
        let entry = Arc::new(Entry {
            method: spec.method,
            path,
            segs,
            permission: spec.permission,
            doc: spec.doc,
            summary: spec.summary,
            max_body: spec.max_body,
            owner: spec.owner,
            target,
        });
        let list = if entry.rest() {
            self.rests.entry(entry.method.clone()).or_default()
        } else {
            self.buckets
                .entry((entry.method.clone(), entry.segs.len()))
                .or_default()
        };
        list.push(entry.clone());
        // stable: equal literal counts keep the order they were added
        list.sort_by_key(|e| std::cmp::Reverse(e.literals()));
        self.order.push(entry);
        Ok(())
    }

    /// The first route that matches, its captures decoded; HEAD falls back to GET.
    pub fn find(&self, method: &str, path: &str) -> Option<(Arc<Entry>, Params)> {
        let parts: Vec<&str> = split(path).collect();
        self.find_in(method, &parts).or_else(|| {
            if method == "HEAD" {
                self.find_in("GET", &parts)
            } else {
                None
            }
        })
    }

    fn find_in(&self, method: &str, parts: &[&str]) -> Option<(Arc<Entry>, Params)> {
        let exact = self
            .buckets
            .get(&(method.to_owned(), parts.len()))
            .and_then(|list| {
                list.iter()
                    .find_map(|e| captures(&e.segs, parts).map(|p| (e.clone(), p)))
            });
        exact.or_else(|| {
            self.rests
                .get(method)?
                .iter()
                .find_map(|e| captures(&e.segs, parts).map(|p| (e.clone(), p)))
        })
    }

    /// Every route, in the order added (`OpenAPI` and its test read it).
    pub fn list(&self) -> &[Arc<Entry>] {
        &self.order
    }
}

fn captures(segs: &[Seg], parts: &[&str]) -> Option<Params> {
    let rest = matches!(segs.last(), Some(Seg::Rest));
    if (rest && parts.len() < segs.len()) || (!rest && parts.len() != segs.len()) {
        return None;
    }
    let mut out = Params::new();
    for (i, s) in segs.iter().enumerate() {
        match s {
            Seg::Lit(l) if l == parts[i] => {}
            Seg::Lit(_) => return None,
            Seg::Cap(name) => {
                out.insert(name.clone(), percent_decode(parts[i])?);
            }
            Seg::Rest => {
                let tail: Option<Vec<String>> =
                    parts[i..].iter().map(|p| percent_decode(p)).collect();
                out.insert("*".into(), tail?.join("/"));
            }
        }
    }
    Some(out)
}

/// `decodeURIComponent`: None on a malformed escape or bytes that aren't UTF-8.
pub fn percent_decode(s: &str) -> Option<String> {
    if !s.contains('%') {
        return Some(s.to_owned());
    }
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = b.get(i + 1..i + 3)?;
            let hex = std::str::from_utf8(hex).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
#[path = "router_tests.rs"]
mod tests;
