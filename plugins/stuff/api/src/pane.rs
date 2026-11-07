//! Panes (v1 web/js/pane-bridge.js): a My Stuff app pinned beside a task or on home. The app runs on
//! its own origin in a sandboxed frame and never gets wisp's API: each call it makes is checked against
//! what you allowed (`allowed`, a subset of what its wisp-app.json `uses`). These rules are data and pure
//! functions so the server, the page and the *Make a plugin* guide read the same ones.

/// What an app may ask for, with the words the Allow card shows.
pub const PANE_USES: &[(&str, &str)] = &[
    (
        "tasks:read",
        "See your tasks: title, state, project, branch, PR and the one-line summary of the last answer (not the conversation)",
    ),
    (
        "tasks:write",
        "Ask to start tasks and send follow-ups (you confirm each one), and mark tasks done",
    ),
    ("prs:read", "See your tasks’ pull requests"),
    (
        "crew:read",
        "See your crew: names, roles and what they’re doing",
    ),
    (
        "usage:read",
        "See your usage windows: how much of each is gone, when it resets, and what each period cost",
    ),
];

/// Each call the frame can make, and the scope it needs.
pub const PANE_CALLS: &[(&str, &str)] = &[
    ("tasks.list", "tasks:read"),
    ("tasks.get", "tasks:read"),
    ("tasks.watch", "tasks:read"),
    ("tasks.launch", "tasks:write"),
    ("tasks.followUp", "tasks:write"),
    ("tasks.done", "tasks:write"),
    ("prs.list", "prs:read"),
    ("crew.list", "crew:read"),
    ("usage.accounts", "usage:read"),
];

/// How to call each of them and what comes back: the agent's reference (the *Make a plugin* guide).
/// A new call needs an entry here (a test checks).
pub const CALL_DOCS: &[(&str, &str, &str)] = &[
    (
        "tasks.list",
        "wisp.tasks.list()",
        "[Task], every task that isn't archived. Task: { id, title, state: \"running\"|\"waiting\"|\"review\"|\"done\", status, project, agent, harness (its name), account, machine, model, mode, branch, summary, live, unread, archived, asks, crew: { id, name } | absent, pr: { number, url, state, draft, checks, review, conflict } | null, createdAt, updatedAt }",
    ),
    (
        "tasks.get",
        "wisp.tasks.get(id)",
        "Task; rejects if there is no such task",
    ),
    (
        "tasks.watch",
        "wisp.on('tasks', fn)",
        "fn([Task]) now, then each time tasks change, at most every 300 ms. Returns a function that stops it",
    ),
    (
        "tasks.launch",
        "wisp.tasks.launch({ prompt, project })",
        "Task, or { queued: true }. project: a project's name, or leave it out for no project. Harness and mode are the user's defaults. Opens wisp's card; rejects if they cancel",
    ),
    (
        "tasks.followUp",
        "wisp.tasks.followUp(id, text)",
        "true. Opens wisp's card; rejects if they cancel",
    ),
    ("tasks.done", "wisp.tasks.done(id)", "true. No card"),
    (
        "prs.list",
        "wisp.prs.list()",
        "[{ number, url, state, draft, checks, review, conflict, repo, task (id), title }], each task's pull requests",
    ),
    (
        "crew.list",
        "wisp.crew.list()",
        "[{ id, name, role, busy, nextAt }]",
    ),
    (
        "usage.accounts",
        "wisp.usage.accounts()",
        "[{ agent, agentName, account, windows: [{ id, label, used (0 to 1), resetsAt (ms) | null, periods, shrink }], burnPerHour | null, burnWindow }], one per account. burnPerHour is null when it is too early to tell; never make one up",
    ),
];

/// The scopes that change something. A grant of one is tied to the app's code (`effective_grant`).
pub const WRITE_USES: &[&str] = &["tasks:write"];
pub const PANE_WHERE: &[&str] = &["task", "home"];
pub const MAX_PANES: usize = 8;
/// Writes a minute from one pane, whatever became of them: a loop can't bury you in cards.
pub const PANE_WRITES_PER_MIN: u32 = 6;

pub fn is_scope(s: &str) -> bool {
    PANE_USES.iter().any(|(k, _)| *k == s)
}

pub fn is_write(s: &str) -> bool {
    WRITE_USES.contains(&s)
}

/// The scope a call needs, or None when wisp has no such call.
pub fn call_scope(method: &str) -> Option<&'static str> {
    PANE_CALLS
        .iter()
        .find(|(m, _)| *m == method)
        .map(|(_, s)| *s)
}

/// What a grant may hold: only what the app asks for, each once, in the order asked.
pub fn grant_of(uses: &[String], want: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for w in want {
        if uses.contains(w) && !out.contains(w) {
            out.push(w.clone());
        }
    }
    out
}

/// What the app asks for that you haven't allowed yet.
pub fn missing_of(uses: &[String], allowed: &[String]) -> Vec<String> {
    uses.iter()
        .filter(|u| !allowed.contains(u))
        .cloned()
        .collect()
}

/// What a grant holds now: `{ allowed, changed }`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
pub struct Grant {
    pub allowed: Vec<String>,
    pub changed: bool,
}

/// What a stored grant is worth now. A write scope holds only for the code you allowed: while the
/// app's hash differs (or there is none) the write scopes are off and `changed` says so. Nothing is
/// deleted: going back to that code brings them back. Read scopes aren't tied to the hash.
pub fn effective_grant(allowed: &[String], grant_hash: &str, hash_now: &str) -> Grant {
    let tied = allowed.iter().any(|x| is_write(x));
    if !tied || (!grant_hash.is_empty() && grant_hash == hash_now) {
        return Grant {
            allowed: allowed.to_vec(),
            changed: false,
        };
    }
    Grant {
        allowed: allowed.iter().filter(|x| !is_write(x)).cloned().collect(),
        changed: true,
    }
}

/// Why a call is refused, or None when it may go.
pub fn refusal(method: &str, allowed: &[String]) -> Option<String> {
    let Some(need) = call_scope(method) else {
        let name: String = method.chars().take(60).collect();
        let calls: Vec<&str> = PANE_CALLS.iter().map(|(m, _)| *m).collect();
        return Some(format!(
            "wisp has no {name}(). Panes can call: {}.",
            calls.join(", ")
        ));
    };
    if allowed.iter().any(|a| a == need) {
        return None;
    }
    Some(format!(
        "Not allowed: {method}() needs \"{need}\". Add it to \"uses\" in wisp-app.json, then allow it when you pin the app."
    ))
}

/// A task the app may not gain a scope under: it runs in Full auto, nobody is reading cards.
pub fn runs_full_auto(mode: &str, running: bool) -> bool {
    mode == "auto" && running
}

pub fn not_while(title: &str) -> String {
    let t = if title.is_empty() { "a task" } else { title };
    format!("Not while {t} runs in Full auto.")
}

/// Has the app moved on from what its pane loaded? `rev` goes up on every update and restore.
pub fn pane_stale(seen: Option<u32>, rev: Option<u32>) -> bool {
    match (seen, rev) {
        (Some(s), Some(r)) => s != r,
        _ => false,
    }
}

/// One pin of the `panes` setting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pin {
    pub app: String,
    pub r#where: String,
}

/// The `panes` setting: `"<app>@task,<app>@home"`, where `<app>` is an app's id or its name.
pub fn parse_panes(v: &str) -> Vec<Pin> {
    v.split(',')
        .map(str::trim)
        .filter(|x| !x.is_empty())
        .map(|x| match x.rfind('@') {
            Some(i) if i > 0 => Pin {
                app: x[..i].trim().to_owned(),
                r#where: x[i + 1..].trim().to_owned(),
            },
            _ => Pin {
                app: x.to_owned(),
                r#where: "task".to_owned(),
            },
        })
        .collect()
}

pub fn panes_string(pins: &[Pin]) -> String {
    pins.iter()
        .map(|p| format!("{}@{}", p.app, p.r#where))
        .collect::<Vec<_>>()
        .join(",")
}

/// Why a `panes` value can't be kept, or None.
pub fn panes_problem(v: &serde_json::Value) -> Option<String> {
    let Some(s) = v.as_str() else {
        return Some("panes is a string like \"kanban@home,pr-notes@task\".".into());
    };
    if s.chars().count() > 1000 {
        return Some("panes is too long.".into());
    }
    let pins = parse_panes(s);
    if pins.len() > MAX_PANES {
        return Some(format!("At most {MAX_PANES} panes."));
    }
    let bad = pins.iter().find(|p| {
        !PANE_WHERE.contains(&p.r#where.as_str())
            || p.app.is_empty()
            || p.app.contains([',', '@', '<', '>', '"'])
    });
    bad.map(|p| {
        format!(
            "panes: \"{}@{}\" should be <app id or name>@task or @home.",
            p.app, p.r#where
        )
    })
}
