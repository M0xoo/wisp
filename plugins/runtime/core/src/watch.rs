//! Watch (v1 server/watch.js, F-page-32): the page an agent puts up beside its task while it works (`wisp_watch`),
//! kept current as it goes, so the user watches the work instead of waiting for the answer. Its own page (HTML that
//! draws the state it's sent) or a running app (a url it navigates and reloads). Sans-IO: the caller reads a `path`
//! page's file and passes it in; this decides what the watch becomes and what the agent reads back.
//!
//! `seq` moves on every change (the row carries it, so other clients hear of it); `rev` only when the page itself
//! changed: the frame reloads then, and otherwise only gets the new state.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const MAX_HTML: usize = 1_000_000;
pub const MAX_STATE: usize = 64_000;
const MAX_TITLE: usize = 80;
const MAX_CAPTION: usize = 200;

/// How the user runs or checks the thing themselves, shown under the page.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Run {
    pub command: String,
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// The watch on a task: everything but the page's HTML (kept apart: it changes only with `rev`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Watch {
    pub title: String,
    #[serde(default)]
    pub caption: String,
    #[serde(default)]
    pub state: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run: Option<Run>,
    pub seq: u64,
    pub rev: u64,
    pub at: i64,
    /// the `seq` of the last `open`: the pane beside the task opens by itself when it moves (v1 bus 'watch' opened)
    #[serde(default)]
    pub opened: u64,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub closed: bool,
    /// a running app it shows instead of a page
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// the .html file the page came from: read again on `reload`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

/// One call's outcome: the watch, the page's new HTML when it changed, what the agent reads, and the task's
/// activity line when a watch opened.
#[derive(Debug, Clone, PartialEq)]
pub struct Applied {
    pub watch: Watch,
    pub html: Option<String>,
    pub text: String,
    pub note: Option<String>,
}

fn text(v: Option<&Value>, max: usize) -> String {
    let s = v.and_then(Value::as_str).unwrap_or_default();
    s.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(max).collect()
}

fn str_of<'a>(a: &'a Map<String, Value>, k: &str) -> &'a str {
    a.get(k).and_then(Value::as_str).map(str::trim).unwrap_or_default()
}

/// `dir` joined with `p` unless `p` is absolute (no file system: plain path text).
#[must_use]
pub fn resolve(dir: &str, p: &str) -> String {
    if p.starts_with('/') || p.starts_with('~') || p.get(1..3) == Some(":\\") || dir.is_empty() {
        return p.to_owned();
    }
    let p = p.trim_start_matches("./");
    format!("{}/{p}", dir.trim_end_matches('/'))
}

fn run_of(v: Option<&Value>, dir: &str) -> Option<Run> {
    let r = v?.as_object()?;
    let command: String = str_of(r, "command").chars().take(2000).collect();
    if command.is_empty() {
        return None;
    }
    let cwd = match str_of(r, "cwd") {
        "" | "." => dir.to_owned(),
        c => resolve(dir, c),
    };
    let note = Some(text(r.get("note"), 300)).filter(|n| !n.is_empty());
    Some(Run { command, cwd, note })
}

fn state_of(v: Option<&Value>) -> Result<Value, String> {
    let v = v.cloned().unwrap_or(Value::Null);
    if serde_json::to_string(&v).map_or(0, |s| s.len()) > MAX_STATE {
        return Err(format!("state is larger than {} KB: send what the page draws now, not the whole history.", MAX_STATE / 1000));
    }
    Ok(v)
}

/// An http(s) page (v1 preview-spec previewUrl): anything else is refused.
fn page_url(s: &str) -> Option<String> {
    let s = s.trim();
    let rest = s.strip_prefix("http://").or_else(|| s.strip_prefix("https://"))?;
    (!rest.is_empty() && !rest.starts_with('/') && !s.contains(char::is_whitespace)).then(|| s.to_owned())
}

/// `url` read against `base` (v1 `new URL(to, w.url)`): a full url, or a path on `base`'s origin.
fn navigate_to(base: &str, to: &str) -> Option<String> {
    if let Some(u) = page_url(to) {
        return Some(u);
    }
    if !to.starts_with('/') {
        return None;
    }
    let scheme = if base.starts_with("https://") { "https://" } else { "http://" };
    let host = base.strip_prefix(scheme)?.split('/').next()?;
    page_url(&format!("{scheme}{host}{to}"))
}

/// An .html file, or a folder's index.html.
fn open_path(dir: &str, path: &str) -> String {
    let p = resolve(dir, path);
    let ext = std::path::Path::new(&p).extension().and_then(|e| e.to_str()).unwrap_or_default();
    if ext.eq_ignore_ascii_case("html") || ext.eq_ignore_ascii_case("htm") { p } else { format!("{}/index.html", p.trim_end_matches('/')) }
}

/// The file a call will read, for the caller to read first: an `open` with `path`, or a `reload` of a file's page.
#[must_use]
pub fn page_path(prev: Option<&Watch>, body: &Map<String, Value>, dir: &str) -> Option<String> {
    match str_of(body, "action") {
        "open" if str_of(body, "url").is_empty() && str_of(body, "html").is_empty() && !str_of(body, "path").is_empty() => {
            Some(open_path(dir, str_of(body, "path")))
        }
        "reload" => prev.and_then(|w| w.path.clone()),
        _ => None,
    }
}

/// What the task's row says of its watch: enough to offer Watch and to know when it moved.
#[must_use]
pub fn marker(w: &Watch) -> Value {
    let mut m = serde_json::json!({ "title": w.title, "caption": w.caption, "seq": w.seq, "rev": w.rev, "opened": w.opened });
    if w.closed {
        m["closed"] = Value::Bool(true);
    }
    m
}

/// One `wisp_watch` call. `dir`: the task's folder (relative paths); `page`: the HTML of a `path` page, read by the
/// caller (None: no such file); `now`: the clock.
///
/// # Errors
/// What the agent did wrong, in words it can act on.
pub fn apply(
    prev: Option<&Watch>,
    body: &Map<String, Value>,
    dir: &str,
    page: &dyn Fn(&str) -> Option<String>,
    now: i64,
) -> Result<Applied, String> {
    let action = str_of(body, "action");
    if action == "open" {
        return open(prev, body, dir, page, now);
    }
    let Some(w) = prev else { return Err("Nothing to watch yet: call it with action \"open\" first.".into()) };
    let mut w = w.clone();
    let bump = |w: &mut Watch, page: bool| {
        w.seq += 1;
        if page {
            w.rev += 1;
        }
        w.at = now;
    };
    let caption = |w: &mut Watch| {
        if body.contains_key("caption") {
            w.caption = text(body.get("caption"), MAX_CAPTION);
        }
    };
    let (html, said) = match action {
        "state" => {
            if w.url.is_some() {
                return Err("This watch shows a running app: it has no state. Use \"caption\" to say what you are doing, \"navigate\" and \"reload\" to show your change.".into());
            }
            let next = state_of(body.get("state"))?;
            w.state = match (body.get("merge").and_then(Value::as_bool), &w.state, &next) {
                (Some(true), Value::Object(was), Value::Object(add)) => {
                    let mut m = was.clone();
                    m.extend(add.clone());
                    state_of(Some(&Value::Object(m)))?
                }
                _ => next,
            };
            caption(&mut w);
            w.closed = false;
            bump(&mut w, false);
            (None, "Sent.".to_owned())
        }
        "caption" => {
            w.caption = text(body.get("caption").or_else(|| body.get("text")), MAX_CAPTION);
            bump(&mut w, false);
            (None, "Caption set.".to_owned())
        }
        "navigate" => {
            let Some(base) = w.url.clone() else {
                return Err(
                    "navigate is for a watch that shows a url (open it with url); your own page draws what it gets in \"state\".".into()
                );
            };
            let to = Some(str_of(body, "path")).filter(|s| !s.is_empty()).unwrap_or_else(|| str_of(body, "url"));
            let url = navigate_to(&base, to).ok_or("navigate needs path (e.g. \"/settings\") or an http(s) url.")?;
            w.url = Some(url.clone());
            caption(&mut w);
            w.closed = false;
            bump(&mut w, true);
            (None, format!("Showing {url}."))
        }
        "reload" => {
            if body.contains_key("run") {
                w.run = run_of(body.get("run"), dir);
            }
            // a page from a file is read again: the agent edited it
            let html = match &w.path {
                Some(p) => Some(page(p).ok_or_else(|| format!("No such file: {p}"))?),
                None => None,
            };
            if html.as_ref().is_some_and(|h| h.len() > MAX_HTML) {
                return Err(format!("The page is larger than {} MB.", MAX_HTML / 1_000_000));
            }
            w.closed = false;
            bump(&mut w, true);
            let said =
                w.url.as_ref().map_or_else(|| "Reloaded the page; it gets the last state again.".to_owned(), |u| format!("Reloaded {u}."));
            (html, said)
        }
        "close" => {
            w.closed = true;
            w.caption = text(body.get("caption"), MAX_CAPTION);
            bump(&mut w, false);
            (None, "Closed. The page stays on the task, with its last state, for the user to look back at.".to_owned())
        }
        _ => return Err("action must be open, state, caption, navigate, reload or close.".into()),
    };
    Ok(Applied { watch: w, html, text: said, note: None })
}

fn open(
    prev: Option<&Watch>,
    body: &Map<String, Value>,
    dir: &str,
    page: &dyn Fn(&str) -> Option<String>,
    now: i64,
) -> Result<Applied, String> {
    let title = Some(text(body.get("title"), MAX_TITLE))
        .filter(|t| !t.is_empty())
        .or_else(|| prev.map(|w| w.title.clone()))
        .unwrap_or_else(|| "Progress".into());
    let (url, path, html) = if !str_of(body, "url").is_empty() {
        let u = page_url(str_of(body, "url")).ok_or("url must be an http:// or https:// page, e.g. http://localhost:5173.")?;
        (Some(u), None, String::new())
    } else if !str_of(body, "html").is_empty() {
        (None, None, str_of(body, "html").to_owned())
    } else if !str_of(body, "path").is_empty() {
        let p = open_path(dir, str_of(body, "path"));
        let html = page(&p).ok_or_else(|| format!("No such file: {p}. path must be an .html file (or a folder with index.html)."))?;
        (None, Some(p), html)
    } else {
        return Err("open needs html (the page), path (an .html file you wrote) or url (a running app, e.g. your dev server).".into());
    };
    if html.len() > MAX_HTML {
        return Err(format!("html is larger than {} MB.", MAX_HTML / 1_000_000));
    }
    let reopened = prev.is_some_and(|w| !w.closed);
    let state = if url.is_none() && body.contains_key("state") { state_of(body.get("state"))? } else { Value::Null };
    let next = if url.is_some() {
        format!(
            "It shows {} live. Say what you're doing with \"caption\", \"navigate\" to the page you changed (path or url), and \"reload\" when hot reload doesn't pick a change up.",
            url.as_deref().unwrap_or_default()
        )
    } else {
        "Send progress with action \"state\" (the page gets it in wisp.on('state', fn)), say what you're doing with \"caption\", and \"reload\" after you edit the page's file.".to_owned()
    };
    let watch = Watch {
        title: title.clone(),
        caption: text(body.get("caption"), MAX_CAPTION),
        state,
        run: run_of(body.get("run"), dir),
        seq: prev.map_or(0, |w| w.seq) + 1,
        rev: prev.map_or(0, |w| w.rev) + 1,
        at: now,
        opened: prev.map_or(0, |w| w.seq) + 1,
        closed: false,
        url: url.clone(),
        path,
    };
    Ok(Applied {
        watch,
        html: Some(html),
        text: format!(
            "{} “{title}” beside the task: the user can watch it now. {next}",
            if reopened { "Replaced the page" } else { "Opened" }
        ),
        note: (!reopened).then(|| format!("Opened Watch: {title}")),
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use serde_json::json;

    fn args(v: Value) -> Map<String, Value> {
        let Value::Object(m) = v else { unreachable!("a call is an object") };
        m
    }
    const NONE: &dyn Fn(&str) -> Option<String> = &|_| None;

    #[test]
    fn open_then_state_moves_seq_not_rev_and_merge_keeps_the_rest_v1_watch_apply() {
        let a = apply(
            None,
            &args(json!({ "action": "open", "title": "  TS   migration ", "html": "<p>hi</p>", "state": { "done": 1 } })),
            "/w",
            NONE,
            10,
        )
        .unwrap();
        assert_eq!((a.watch.title.as_str(), a.watch.seq, a.watch.rev, a.html.as_deref()), ("TS migration", 1, 1, Some("<p>hi</p>")));
        assert_eq!(a.note.as_deref(), Some("Opened Watch: TS migration"));
        let s = apply(
            Some(&a.watch),
            &args(json!({ "action": "state", "state": { "total": 9 }, "merge": true, "caption": "Files" })),
            "/w",
            NONE,
            11,
        )
        .unwrap();
        assert_eq!((s.watch.seq, s.watch.rev, s.html), (2, 1, None));
        assert_eq!(s.watch.opened, 1, "a state is not an open");
        assert_eq!(s.watch.state, json!({ "done": 1, "total": 9 }));
        assert_eq!(s.watch.caption, "Files");
        // opened again while open: replaced, no second activity line
        let again = apply(Some(&s.watch), &args(json!({ "action": "open", "html": "<p>2</p>" })), "/w", NONE, 12).unwrap();
        assert!(again.text.starts_with("Replaced the page “TS migration”"));
        assert_eq!((again.note, again.watch.rev), (None, 2));
        assert_eq!(again.watch.opened, 3, "a new open moves it: the pane opens again");
    }

    #[test]
    fn refusals_say_what_to_do_v1_watch_refusals() {
        assert!(apply(None, &args(json!({ "action": "state", "state": 1 })), "/w", NONE, 1).unwrap_err().contains("open\" first"));
        assert!(apply(None, &args(json!({ "action": "open" })), "/w", NONE, 1).unwrap_err().starts_with("open needs html"));
        assert!(
            apply(None, &args(json!({ "action": "open", "url": "file:///etc" })), "/w", NONE, 1).unwrap_err().starts_with("url must be")
        );
        let big = "x".repeat(MAX_STATE + 1);
        assert!(
            apply(None, &args(json!({ "action": "open", "html": "<p/>", "state": big })), "/w", NONE, 1).unwrap_err().contains("64 KB")
        );
        let app = apply(None, &args(json!({ "action": "open", "url": "http://localhost:5173" })), "/w", NONE, 1).unwrap().watch;
        assert!(apply(Some(&app), &args(json!({ "action": "state", "state": 1 })), "/w", NONE, 2).unwrap_err().contains("running app"));
        assert!(apply(Some(&app), &args(json!({ "action": "dance" })), "/w", NONE, 2).unwrap_err().starts_with("action must be"));
    }

    #[test]
    fn a_url_watch_navigates_on_its_origin_and_a_file_page_is_read_again_on_reload_v1_watch_url_path() {
        let app = apply(None, &args(json!({ "action": "open", "url": "http://localhost:5173/x" })), "/w", NONE, 1).unwrap().watch;
        let n = apply(Some(&app), &args(json!({ "action": "navigate", "path": "/settings" })), "/w", NONE, 2).unwrap();
        assert_eq!((n.watch.url.as_deref(), n.watch.rev), (Some("http://localhost:5173/settings"), 2));
        let file = |p: &str| (p == "/w/out/watch.html").then(|| "<h1>v1</h1>".to_owned());
        let o = apply(
            None,
            &args(json!({ "action": "open", "path": "out/watch.html", "run": { "command": "npm test", "cwd": "web" } })),
            "/w",
            &file,
            1,
        )
        .unwrap();
        assert_eq!((o.watch.path.as_deref(), o.html.as_deref()), (Some("/w/out/watch.html"), Some("<h1>v1</h1>")));
        assert_eq!(o.watch.run.as_ref().map(|r| r.cwd.as_str()), Some("/w/web"));
        let r = apply(Some(&o.watch), &args(json!({ "action": "reload" })), "/w", &file, 2).unwrap();
        assert_eq!((r.html.as_deref(), r.watch.rev), (Some("<h1>v1</h1>"), 2));
        let c = apply(Some(&r.watch), &args(json!({ "action": "close", "caption": "Done" })), "/w", &file, 3).unwrap();
        assert!(c.watch.closed && c.watch.rev == 2 && c.watch.caption == "Done");
    }
}
