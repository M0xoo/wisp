//! wisp.sandbox's rules, sans-IO (ADR-0047, v1 `design/sandboxes.md`): who owns a sandbox and when it goes, what the
//! sweep drops, how a project travels in (a git bundle and its uncommitted changes) and where it lands, which
//! harnesses may start in one, and reading `claude setup-token`'s output. Time comes in as `now` (ms).

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A launch that never got its task goes after this long (v1).
pub const PENDING_MS: i64 = 30 * 60_000;
/// How often the sweep runs.
pub const SWEEP_MS: u64 = 10 * 60_000;
/// A crew job waiting on a full grid tries again after this, doubling to `RETRY_MAX_MS`.
pub const RETRY_MS: i64 = 60_000;
pub const RETRY_MAX_MS: i64 = 30 * 60_000;

/// Who a sandbox belongs to (its machine's `data.owner`). One owner each; it goes with it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Owner {
    /// a task's (`/sandbox`): `<peer>:<id>` of the task, as the app keys it
    Task { task: String },
    /// a launch still making its task
    Pending { pending: i64 },
    /// a delegate's: the lead task and the member's name
    Delegate { lead: String, member: String },
    /// one crew job's: the member and the job's task
    Job { crew: String, job: String },
    /// a crew member's own, kept across their jobs
    Member { crew: String },
    /// a goal's judges, for that task
    Judges { judges: String },
}

impl Owner {
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

/// A sandbox machine as the plugin reads it from `machines.list`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Held {
    /// the machine's local id
    pub machine: String,
    /// the grid's sandbox id
    pub sandbox: String,
    pub owner: Option<Owner>,
    /// its drop failed once: the sweep tries again
    pub dropping: bool,
}

/// The sandboxes among `machines.list`'s rows (the ones with `data.sandbox`).
pub fn held(machines: &[Value]) -> Vec<Held> {
    machines
        .iter()
        .filter_map(|m| {
            // `machines.list` flattens a machine's data into it; a stored row keeps it under `data`
            let data = if m.get("sandbox").is_some() { m } else { m.get("data")? };
            let sandbox = data.get("sandbox")?.as_str()?.to_owned();
            Some(Held {
                machine: m.get("id").and_then(Value::as_str).unwrap_or_default().to_owned(),
                sandbox,
                owner: data.get("owner").and_then(|o| serde_json::from_value(o.clone()).ok()),
                dropping: data.get("dropping").and_then(Value::as_bool).unwrap_or(false),
            })
        })
        .collect()
}

/// Whether a machine may be offered as a place (Run on, a delegate's place, *Their jobs run on*, Machines): never a
/// sandbox, which belongs to its owner.
pub fn placeable(machine: &Value) -> bool {
    machine.get("sandbox").is_none_or(Value::is_null) && machine.pointer("/data/sandbox").is_none_or(Value::is_null)
}

/// A task's own id, from how its owner names it: `<peer>:<id>`, `<machine>|<id>` (a crew job there), or the id.
pub fn bare(task: &str) -> &str {
    task.rsplit([':', '|']).next().unwrap_or(task)
}

/// The sandboxes that go when task `task` (`<peer>:<id>` or a bare id) is deleted: its own, its judges', its
/// delegates', and a crew job's when the job is that task.
pub fn gone_with_task<'a>(all: &'a [Held], task: &str) -> Vec<&'a Held> {
    let me = bare(task);
    all.iter()
        .filter(|h| match &h.owner {
            Some(Owner::Task { task: t } | Owner::Judges { judges: t } | Owner::Delegate { lead: t, .. } | Owner::Job { job: t, .. }) => bare(t) == me,
            _ => false,
        })
        .collect()
}

/// The sandboxes that go when crew member `crew` leaves: their own, and any job's still here.
pub fn gone_with_member<'a>(all: &'a [Held], crew: &str) -> Vec<&'a Held> {
    all.iter().filter(|h| matches!(&h.owner, Some(Owner::Member { crew: c } | Owner::Job { crew: c, .. }) if c == crew)).collect()
}

/// What the sweep drops: a drop that failed, and a launch that never got its task.
pub fn sweep(all: &[Held], now: i64) -> Vec<&Held> {
    all.iter().filter(|h| h.dropping || matches!(h.owner, Some(Owner::Pending { pending }) if now - pending > PENDING_MS)).collect()
}

/// The sandbox a reusable owner already has (a member's own, a delegate's, a task's judges').
pub fn reusable<'a>(all: &'a [Held], owner: &Owner) -> Option<&'a Held> {
    match owner {
        Owner::Member { .. } | Owner::Delegate { .. } | Owner::Judges { .. } => all.iter().find(|h| !h.dropping && h.owner.as_ref() == Some(owner)),
        _ => None,
    }
}

/// A project's folder name in a sandbox (`~/code/<name>`): the folder's last part, letters, digits, `.`, `_`, `-`.
pub fn name_of(cwd: &str) -> String {
    let last = cwd.trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next().unwrap_or_default();
    let n: String = last.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '-' }).collect();
    let n = n.trim_matches(['-', '.']).chars().take(60).collect::<String>();
    if n.is_empty() { "project".to_owned() } else { n }
}

/// The git commands that pack a project: every ref as one bundle (written to `bundle`), and what isn't committed.
pub fn pack_commands(bundle: &str) -> [Vec<String>; 2] {
    [
        ["bundle", "create", bundle, "--all"].map(str::to_owned).to_vec(),
        ["diff", "HEAD", "--binary"].map(str::to_owned).to_vec(),
    ]
}

/// The git commands that unpack it in the sandbox, in `home/code`: clone the bundle, check out the branch it was on,
/// keep its origin and author. The uncommitted patch is applied after (`git apply`), when there is one.
pub fn seed_commands(bundle: &str, dir: &str, branch: &str, origin: &str) -> Vec<Vec<String>> {
    let mut out = vec![["clone", "--quiet", bundle, dir].map(str::to_owned).to_vec()];
    if !branch.is_empty() {
        out.push(["-C", dir, "checkout", "--quiet", branch].map(str::to_owned).to_vec());
    }
    out.push(["-C", dir, "remote", "remove", "origin"].map(str::to_owned).to_vec());
    if !origin.is_empty() {
        out.push(["-C", dir, "remote", "add", "origin", origin].map(str::to_owned).to_vec());
    }
    out
}

/// The sign-ins every sandbox starts with, as the grid says them: `{"claude": true}` (or a list of names).
pub fn logins_of(v: Option<&Value>) -> Vec<String> {
    match v {
        Some(Value::Object(m)) => m.iter().filter(|(_, on)| on.as_bool() == Some(true)).map(|(k, _)| k.clone()).collect(),
        Some(Value::Array(a)) => a.iter().filter_map(|x| x.as_str().map(str::to_owned).or_else(|| x.get("agent").and_then(Value::as_str).map(str::to_owned))).collect(),
        _ => Vec::new(),
    }
}

/// Whether a harness may start in a sandbox, or why not. Claude (and Auto, which picks Claude there) runs on the
/// user's subscription once they signed in for sandboxes; the others sign in inside the sandbox (their device login,
/// asked on the task's first turn), so they may start.
pub fn may_start(agent: &str, logins: &[String]) -> Result<(), String> {
    let claude = matches!(agent, "" | "auto" | "claude");
    if claude && !logins.iter().any(|l| l == "claude") {
        return Err("Sign in to Claude for sandboxes first: Settings → Cloud → Sandboxes → Sign in (once for all of them).".into());
    }
    Ok(())
}

/// A full grid: a launch or a delegation fails at once; a crew job waits and tries again, doubling to 30 minutes.
pub fn full(message: &str) -> bool {
    let m = message.to_lowercase();
    m.contains("is full") || m.contains("sandboxes of yours") || m.contains("at most")
}

/// When a crew job that met a full grid tries again: after `RETRY_MS`, doubling per try, at most `RETRY_MAX_MS`.
pub fn retry_in(tries: u32) -> i64 {
    RETRY_MS.saturating_mul(1_i64 << tries.min(10)).min(RETRY_MAX_MS)
}

fn plain(out: &str) -> String {
    // the terminal's colours and cursor moves out
    let mut s = String::with_capacity(out.len());
    let mut esc = false;
    for c in out.chars() {
        if esc {
            if c.is_ascii_alphabetic() || c == '~' {
                esc = false;
            }
            continue;
        }
        if c == '\u{1b}' {
            esc = true;
            continue;
        }
        s.push(c);
    }
    s
}

/// The sign-in link `claude setup-token` printed, once it has.
pub fn setup_link(out: &str) -> Option<String> {
    let p = plain(out);
    let at = p.find("https://")?;
    let link: String = p[at..].chars().take_while(|c| !c.is_whitespace()).collect();
    (link.contains("oauth") || link.contains("claude")).then_some(link)
}

/// The token `claude setup-token` printed at the end (`sk-ant-oat01-…`), once it has, the line breaks the
/// terminal put in it taken out.
pub fn setup_token(out: &str) -> Option<String> {
    let p = plain(out);
    let at = p.find("sk-ant-oat01-")?;
    // a wrapped token goes on after a single line break; a blank line (or anything else) ends it
    let text: String = p[at..].chars().filter(|c| *c != '\r').collect();
    let mut tok = String::new();
    let mut breaks = 0;
    for c in text.chars() {
        if c == '\n' {
            breaks += 1;
            if breaks > 1 {
                break;
            }
            continue;
        }
        if !(c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            break;
        }
        breaks = 0;
        tok.push(c);
    }
    (tok.len() > 30).then_some(tok)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::needless_pass_by_value)]
mod tests {
    use super::*;
    use serde_json::json;

    fn m(id: &str, data: Value) -> Value {
        json!({ "id": id, "data": data })
    }

    #[test]
    fn a_sandbox_has_one_owner_and_is_never_a_place_you_pick() {
        let list = vec![
            m("mac", json!({ "computer": "c1" })),
            m("s1", json!({ "sandbox": "a1", "owner": { "task": "h:t1" } })),
            m("s2", json!({ "sandbox": "a2", "owner": { "crew": "ada" } })),
            m("s3", json!({ "sandbox": "a3", "owner": { "crew": "ada", "job": "t9" } })),
            m("s4", json!({ "sandbox": "a4", "owner": { "lead": "t1", "member": "codex" } })),
            m("s5", json!({ "sandbox": "a5", "owner": { "judges": "t1" } })),
            m("s6", json!({ "sandbox": "a6", "owner": { "pending": 5 } })),
        ];
        assert_eq!(list.iter().filter(|x| placeable(x)).count(), 1, "only the computer is a place");
        // as `machines.list` gives it: the data flattened into the machine
        let flat = json!({ "id": "s9", "sandbox": "a9", "owner": { "task": "s9:t" }, "url": "http://sb" });
        assert!(!placeable(&flat));
        assert_eq!(held(&[flat])[0].owner, Some(Owner::Task { task: "s9:t".into() }));
        let h = held(&list);
        assert_eq!(h.len(), 6);
        assert_eq!(h[0].owner, Some(Owner::Task { task: "h:t1".into() }));
        assert_eq!(h[1].owner, Some(Owner::Member { crew: "ada".into() }));
        assert_eq!(h[2].owner, Some(Owner::Job { crew: "ada".into(), job: "t9".into() }));
        assert_eq!(h[3].owner, Some(Owner::Delegate { lead: "t1".into(), member: "codex".into() }));
        assert_eq!(h[4].owner, Some(Owner::Judges { judges: "t1".into() }));
        assert_eq!(h[5].owner, Some(Owner::Pending { pending: 5 }));
        assert_eq!(Owner::Job { crew: "ada".into(), job: "t9".into() }.to_value(), json!({ "crew": "ada", "job": "t9" }));
        // the reusable ones come back for the same owner; a task's never does
        assert_eq!(reusable(&h, &Owner::Member { crew: "ada".into() }).map(|x| x.machine.as_str()), Some("s2"));
        assert_eq!(reusable(&h, &Owner::Task { task: "h:t1".into() }), None);
    }

    #[test]
    fn deleting_the_owner_drops_its_sandboxes_whatever_the_sandbox_answers() {
        let list = vec![
            m("s1", json!({ "sandbox": "a1", "owner": { "task": "h:t1" } })),
            m("s3", json!({ "sandbox": "a3", "owner": { "crew": "ada", "job": "m3|t9" } })),
            m("s4", json!({ "sandbox": "a4", "owner": { "lead": "h:t1", "member": "codex" } })),
            m("s5", json!({ "sandbox": "a5", "owner": { "judges": "t1" } })),
            m("s7", json!({ "sandbox": "a7", "owner": { "task": "h:t2" } })),
            m("s2", json!({ "sandbox": "a2", "owner": { "crew": "ada" } })),
        ];
        let h = held(&list);
        let ids = |v: Vec<&Held>| v.iter().map(|x| x.machine.clone()).collect::<Vec<_>>();
        assert_eq!(ids(gone_with_task(&h, "t1")), ["s1", "s4", "s5"], "its own, its delegates', its judges'");
        assert_eq!(ids(gone_with_task(&h, "h:t9")), ["s3"], "a job's goes with the job");
        assert_eq!(ids(gone_with_member(&h, "ada")), ["s3", "s2"]);
    }

    #[test]
    fn the_sweep_drops_failed_drops_and_launches_that_never_finished() {
        let list = vec![
            m("s1", json!({ "sandbox": "a1", "owner": { "pending": 0 } })),
            m("s2", json!({ "sandbox": "a2", "owner": { "pending": PENDING_MS } })),
            m("s3", json!({ "sandbox": "a3", "owner": { "task": "t" }, "dropping": true })),
            m("s4", json!({ "sandbox": "a4", "owner": { "task": "t" } })),
        ];
        let h = held(&list);
        assert_eq!(sweep(&h, PENDING_MS + 1).iter().map(|x| x.machine.as_str()).collect::<Vec<_>>(), ["s1", "s3"]);
    }

    #[test]
    fn a_projects_work_goes_in_as_a_bundle_and_its_uncommitted_changes() {
        assert_eq!(name_of("/Users/me/code/web app/"), "web-app");
        assert_eq!(name_of("/"), "project");
        let [bundle, diff] = pack_commands("/tmp/b.bundle");
        assert_eq!(bundle, ["bundle", "create", "/tmp/b.bundle", "--all"]);
        assert_eq!(diff, ["diff", "HEAD", "--binary"]);
        let seed = seed_commands("/h/in.bundle", "/h/code/web", "fix-login", "git@github.com:me/web.git");
        assert_eq!(seed[0], ["clone", "--quiet", "/h/in.bundle", "/h/code/web"]);
        assert_eq!(seed[1], ["-C", "/h/code/web", "checkout", "--quiet", "fix-login"]);
        assert_eq!(seed.last().unwrap(), &["-C", "/h/code/web", "remote", "add", "origin", "git@github.com:me/web.git"]);
        assert_eq!(seed_commands("b", "d", "", "").len(), 2, "no branch, no origin: clone, and the bundle's origin goes");
    }

    #[test]
    fn a_launch_on_a_harness_not_signed_in_for_sandboxes_is_refused_up_front() {
        assert!(may_start("claude", &[]).unwrap_err().contains("Settings → Cloud → Sandboxes"));
        assert!(may_start("auto", &[]).is_err());
        assert_eq!(may_start("claude", &["claude".into()]), Ok(()));
        assert_eq!(may_start("codex", &[]), Ok(()), "codex signs in inside, with its device login");
        // the grid says them as a map
        assert_eq!(logins_of(Some(&json!({ "claude": true }))), ["claude"]);
        assert_eq!(logins_of(Some(&json!({ "claude": false }))), Vec::<String>::new());
        assert_eq!(logins_of(Some(&json!(["claude"]))), ["claude"]);
    }

    #[test]
    fn a_full_grid_fails_a_launch_at_once_and_a_crew_job_waits() {
        assert!(full("This grid is full right now. Try again in a few minutes."));
        assert!(full("You have 5 sandboxes of yours already: at most 5."));
        assert!(!full("Sign in first."));
        assert_eq!((retry_in(0), retry_in(1), retry_in(9)), (60_000, 120_000, RETRY_MAX_MS));
    }

    #[test]
    fn claude_setup_token_shows_its_link_and_takes_the_code_and_the_token_goes_to_the_grid() {
        let first = "\u{1b}[2J\u{1b}[1mBrowser didn't open? Use the url below to sign in:\u{1b}[0m\r\n\r\nhttps://claude.ai/oauth/authorize?code=true&client_id=x&state=y\r\n\r\nPaste code here if prompted > ";
        assert_eq!(setup_link(first).as_deref(), Some("https://claude.ai/oauth/authorize?code=true&client_id=x&state=y"));
        assert_eq!(setup_token(first), None);
        let done = "✓ Long-lived authentication token created successfully!\r\n\r\nYour OAuth token (valid for 1 year):\r\n\r\nsk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWx\r\nYz0123456789_-tail\r\n\r\nStore this token securely.";
        assert_eq!(setup_token(done).as_deref(), Some("sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-tail"));
        assert_eq!(setup_link("no link yet"), None);
    }
}
