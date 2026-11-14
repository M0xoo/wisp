//! Home (`/`), signed in: the cloud wisp with a picture of it, your own computers and published
//! apps as cards, then what to try next, each tile saying so when the grid knows it's already done.

use super::account::DeviceView;
use super::icons::{ARROW, CHECK, CODE, COPY, GLOBE, KEY, LAPTOP, MOON, PHONE, PLUS, SHARE, STACK};
use super::layout::{AppPage, Tab, app_page, state_label};
use super::machines::{MachineView, add_machine_row, machines_dialog, machines_js, spec};
use super::scripts::{COPY_JS, HOME_JS, LIVE};
use super::site::{shot, tag};
use super::time::{ago, locale_string};
use super::{PageCfg, PageUser, Tone, esc};

/// The account's cloud wisp, as its instance row has it.
#[derive(Debug, Clone, Default)]
pub struct InstanceView {
    /// `running`, `queued`, `starting`, `stopping`, `stopped`
    pub state: String,
    pub started_at: Option<i64>,
    pub stopped_at: Option<i64>,
    pub next_wake_at: Option<i64>,
}

/// One of your own computers on the grid.
#[derive(Debug, Clone, Default)]
pub struct ComputerView {
    pub id: String,
    pub device_id: String,
    pub name: String,
    pub url: String,
    pub online: bool,
    pub last_seen_at: Option<i64>,
}

/// One published app.
#[derive(Debug, Clone, Default)]
pub struct SiteView {
    pub key: String,
    pub title: String,
    pub url: String,
    pub files: u32,
    pub updated_at: Option<i64>,
}

/// What this grid offers (a tile goes when it's off).
#[derive(Debug, Clone, Copy)]
pub struct Offers {
    pub sites: bool,
    pub sandboxes: bool,
}

impl Default for Offers {
    fn default() -> Self {
        Self { sites: true, sandboxes: true }
    }
}

#[derive(Debug, Clone, Default)]
pub struct HomePage {
    pub user: PageUser,
    /// `cfg.instance_url(handle)`
    pub url: String,
    pub instance: InstanceView,
    pub machine: MachineView,
    pub devices: Vec<DeviceView>,
    pub computers: Vec<ComputerView>,
    pub sites: Vec<SiteView>,
    pub offers: Offers,
    pub csrf: String,
    pub flash: String,
    pub tone: Tone,
    pub now_ms: i64,
}

pub(super) fn hidden(csrf: &str) -> String {
    format!(r#"<input type="hidden" name="csrf" value="{}">"#, esc(csrf))
}

pub(super) fn flash(msg: &str, tone: Tone) -> String {
    if msg.is_empty() { String::new() } else { format!(r#"<div class="flash {}">{}</div>"#, tone.class(), esc(msg)) }
}

fn bare(u: &str) -> &str {
    u.strip_prefix("https://").or_else(|| u.strip_prefix("http://")).unwrap_or(u)
}

fn host_of(url: &str) -> &str {
    let b = bare(url);
    b.split('/').next().unwrap_or(b)
}

fn copy_btn(v: &str, label: Option<&str>) -> String {
    let v = esc(v);
    format!(
        r#"<button class="copy" type="button" data-copy="{v}" title="Copy {v}" aria-label="Copy {v}"><span>{}</span>{COPY}</button>"#,
        label.map_or_else(|| v.clone(), esc)
    )
}

/// What the state means now: every state has its own line.
fn cloud_line(i: &InstanceView, now: i64) -> String {
    match i.state.as_str() {
        "running" => format!("Started {}. Sleeps by itself when nothing’s going on.", ago(i.started_at, now)),
        "starting" => "A few seconds. It opens as soon as it’s up.".into(),
        "queued" => "The grid is busy. It starts as soon as there’s room.".into(),
        "stopping" => "Your tasks and files stay where they are.".into(),
        _ if i.stopped_at.is_some_and(|t| t != 0) => {
            format!("Went to sleep {}. Opening it wakes it in a few seconds.", ago(i.stopped_at, now))
        }
        _ => "Starts the first time you open it, in a few seconds.".into(),
    }
}

fn cloud_block(p: &HomePage, hidden: &str) -> String {
    let st = p.instance.state.as_str();
    let label = state_label(st).map_or_else(|| esc(st), str::to_owned);
    let off = if st == "running" { "" } else { " off" };
    let next = p.instance.next_wake_at.map_or_else(|| "Nothing scheduled".to_owned(), |t| esc(&locale_string(t)));
    format!(
        r#"<div class="h-state"><div class="state {cls}"><i></i>{label}</div><p class="h-line">{line}</p></div><div class="h-acts"><a class="primary" href="/go">Open{ARROW}</a><form class="inline{off}" method="post" action="/instance/stop">{hidden}<button class="ghost line">{MOON}Sleep</button></form></div><dl class="h-facts"><dt>Address</dt><dd>{addr}</dd><dt>Machine</dt><dd>{spec}</dd><dt>Next schedule</dt><dd>{next}</dd></dl>"#,
        cls = esc(st),
        line = cloud_line(&p.instance, p.now_ms),
        addr = copy_btn(&p.url, Some(bare(&p.url))),
        spec = esc(&spec(&p.machine, false)),
    )
}

fn computer_card(c: &ComputerView, hidden: &str, now: i64) -> String {
    let state = if c.online {
        r#"<div class="state running"><i></i>Online</div>"#.to_owned()
    } else {
        let seen = c.last_seen_at.filter(|t| *t != 0).map_or_else(String::new, |_| format!(" · last seen {}", ago(c.last_seen_at, now)));
        format!(r#"<div class="state stopped"><i></i>Offline{seen}</div>"#)
    };
    let open = if c.online {
        format!(r#"<a class="primary" href="/go?computer={}">Open{ARROW}</a>"#, esc(&c.id))
    } else {
        format!(
            r#"<span class="primary off" aria-disabled="true" title="Back when it’s switched on and wisp runs there.">Open{ARROW}</span>"#
        )
    };
    format!(
        r#"<div class="c">
      <div class="c-head"><span class="w-ic">{LAPTOP}</span><div class="c-name"><b title="{name}">{name}</b>{state}</div></div>
      {copy}
      <div class="c-acts">{open}<form class="inline" method="post" action="/computers/{id}/remove">{hidden}<button class="ghost quiet" title="Take it off the grid. wisp on it keeps running.">Remove</button></form></div>
    </div>"#,
        name = esc(&c.name),
        copy = copy_btn(&c.url, Some(bare(&c.url))),
        id = esc(&c.id),
    )
}

fn site_card(x: &SiteView, hidden: &str, now: i64) -> String {
    format!(
        r#"<div class="c">
      <div class="c-head"><span class="w-ic">{GLOBE}</span><div class="c-name"><b title="{title}">{title}</b><small>Updated {ago} · {n} file{s}</small></div></div>
      {copy}
      <div class="c-acts"><a class="ghost line" href="{url}" target="_blank" rel="noopener">Open{ARROW}</a><form class="inline" method="post" action="/sites/{key}/remove">{hidden}<button class="ghost quiet" title="Take it offline: the link stops working. It stays in My Stuff.">Unpublish</button></form></div>
    </div>"#,
        title = esc(&x.title),
        ago = ago(x.updated_at, now),
        n = x.files,
        s = if x.files == 1 { "" } else { "s" },
        copy = copy_btn(&x.url, Some(bare(&x.url).trim_end_matches('/'))),
        url = esc(&x.url),
        key = esc(&x.key),
    )
}

const FIRST_STEPS: &str = r#"<ol class="path">
      <li><span class="n">1</span><div><b>Open your cloud wisp</b><p>It starts in a few seconds.</p></div></li>
      <li><span class="n">2</span><div><b>Sign in to an agent</b><p>Settings → Agents: a link and a code, no terminal.</p></div></li>
      <li><span class="n">3</span><div><b>Send a task, close the laptop</b><p>The report waits for you here and on your phone.</p></div></li>
    </ol>"#;

struct Tile<'a> {
    icon: &'a str,
    title: &'a str,
    text: String,
    on: String,
    go: &'a str,
    href: &'a str,
    add: bool,
}

fn tile(t: &Tile<'_>) -> String {
    let step = if t.add {
        format!(r#"<button class="t-go" type="button" data-add>{}{ARROW}</button>"#, t.go)
    } else {
        let ext = if t.href.starts_with("http:") || t.href.starts_with("https:") { r#" target="_blank" rel="noopener""# } else { "" };
        format!(r#"<a class="t-go" href="{}"{ext}>{}{ARROW}</a>"#, esc(t.href), t.go)
    };
    let on = if t.on.is_empty() { String::new() } else { format!(r#"<span class="t-on">{CHECK}{}</span>"#, esc(&t.on)) };
    format!(
        r#"<div class="t"><span class="w-ic">{}</span><b>{}</b><p>{}</p><div class="t-foot">{step}{on}</div></div>"#,
        t.icon, t.title, t.text
    )
}

fn tiles(p: &HomePage, host: &str) -> String {
    let phone = p.devices.iter().any(|d| d.name.to_lowercase().contains("phone"));
    let n = p.computers.len();
    let scheduled = if p.instance.next_wake_at.is_some_and(|t| t != 0) {
        format!(r#"<span class="t-on">{CHECK}Scheduled</span>"#)
    } else {
        String::new()
    };
    let big = format!(
        r#"<div class="t big"><div class="t-tx"><span class="w-ic cloud">{MOON}</span><b>Keeps working with your laptop closed</b><p>Leave a task running or schedule one. Your cloud wisp wakes for it, does the work and goes back to sleep. The report waits for you.</p><div class="t-foot"><a class="t-go" href="/go">Schedule a task{ARROW}</a>{scheduled}</div></div><div class="t-shot" aria-hidden="true">{}</div></div>"#,
        shot("report", "")
    );
    let s = p.sites.len();
    let mut list = vec![tile(&Tile {
        icon: KEY,
        title: "Bring your own agents",
        text: "Sign in to Claude Code, Codex and GitHub in Settings → Agents. A link and a code, no terminal.".into(),
        on: String::new(),
        go: "Sign in to an agent",
        href: "/go",
        add: false,
    })];
    if p.offers.sites {
        list.push(tile(&Tile {
            icon: GLOBE,
            title: "Publish an app",
            text: "From My Stuff, an app an agent built goes up at a public link, and stays up while your wisp sleeps.".into(),
            on: if s > 0 { format!("{s} published") } else { String::new() },
            go: if s > 0 { "See your apps" } else { "Publish from My Stuff" },
            href: if s > 0 { "#apps" } else { "/go" },
            add: false,
        }));
    }
    if p.offers.sandboxes {
        list.push(tile(&Tile {
            icon: STACK,
            title: "A fresh box for one task",
            text: "Start a task with /sandbox and it gets a box of its own, deleted with the task.".into(),
            on: String::new(),
            go: "Try /sandbox",
            href: "/go",
            add: false,
        }));
    }
    list.push(tile(&Tile {
        icon: PHONE,
        title: "On your phone",
        text: format!("Sign in with {} in the wisp app, or add your cloud wisp to an iPhone’s Home Screen.", esc(host)),
        on: if phone { "Phone connected".into() } else { String::new() },
        go: "How to set it up",
        href: "https://trywisp.dev/guides/use-wisp-cloud",
        add: false,
    }));
    list.push(tile(&Tile {
        icon: SHARE,
        title: "Share a task",
        text: "Share… on a task makes a link to what it did, with a passkey if you want one.".into(),
        on: String::new(),
        go: "Pick a task",
        href: "/go",
        add: false,
    }));
    list.push(tile(&Tile {
        icon: LAPTOP,
        title: "Reach your own computers",
        text: "Your phone and other computers open them through the grid. No SSH, no open ports.".into(),
        on: if n > 0 { format!("{n} added") } else { String::new() },
        go: "Add a computer",
        href: "",
        add: true,
    }));
    list.push(tile(&Tile {
        icon: CODE,
        title: "API keys for scripts",
        text: "Settings → Connect makes a key, so a script can start tasks in your cloud wisp.".into(),
        on: String::new(),
        go: "Make a key",
        href: "/go",
        add: false,
    }));
    format!("{big}{}", list.join(""))
}

fn add_how(cli: &str, host: &str) -> String {
    format!(
        r#"<details class="add" id="add"><summary aria-controls="addHow"><span class="add-plus">{PLUS}</span><b>Add a computer</b><small>One command in a terminal, or a few clicks in the app. No SSH, no open ports.</small></summary></details>
        <div class="how" id="addHow">
          <input type="radio" name="addHow" id="addCli" checked><input type="radio" name="addHow" id="addApp">
          <div class="seg" role="presentation"><label for="addCli">{CODE}In a terminal</label><label for="addApp">{LAPTOP}With the app</label></div>
          <ol class="steps p-cli">
            <li><span class="n">1</span><div><b>Run this on that computer</b><p>Node 20 or later. It starts wisp in the background if it isn’t running. Have wisp already? <code>wisp computer on</code> does the same.</p>{cli}</div></li>
            <li><span class="n">2</span><div><b>Allow it here</b><p>It prints a code and opens a page from this grid; on a server, open the link it prints in any browser, even your phone’s. Check the code matches and press <i>Allow</i>. The computer then shows up in this list, and in the phone app.</p></div></li>
          </ol>
          <ol class="steps p-app">
            <li><span class="n">1</span><div><b>Run wisp on that computer</b><p>The desktop app from <a href="https://trywisp.dev" target="_blank" rel="noopener">trywisp.dev</a>, or <code>npx wisp-agents</code> in a terminal.</p></div></li>
            <li><span class="n">2</span><div><b>Open Machines → Reach this computer from anywhere</b><p>Type this grid’s address and press <i>Sign in and add it</i>:</p>{host}</div></li>
            <li><span class="n">3</span><div><b>Allow it here</b><p>A page from this grid opens with a code. Check it matches and press <i>Allow</i>. The computer then shows up in this list, and in the phone app.</p></div></li>
          </ol>
        </div>"#,
        cli = copy_btn(cli, None),
        host = copy_btn(host, None),
    )
}

pub fn home_page(cfg: &PageCfg, p: &HomePage) -> String {
    let hidden = hidden(&p.csrf);
    let host = host_of(&cfg.public_url);
    let online = p.computers.iter().filter(|c| c.online).count();
    // `wisp computer on` signs in to grid.trywisp.dev unless told another grid
    let cli = if host == "grid.trywisp.dev" {
        "npx wisp-agents computer on".to_owned()
    } else {
        format!("npx wisp-agents computer on --grid {host}")
    };
    let fresh = p.instance.started_at.is_none_or(|t| t == 0)
        && p.instance.stopped_at.is_none_or(|t| t == 0)
        && p.computers.is_empty()
        && p.sites.is_empty()
        && p.devices.is_empty();
    let apps = if p.sites.is_empty() {
        String::new()
    } else {
        let cards: String = p.sites.iter().map(|x| site_card(x, &hidden, p.now_ms)).collect();
        format!(
            r#"<h2 class="sec" id="apps">Published apps <span class="n">{}</span></h2><p class="hint">Anyone with the link can open them, while your wisp sleeps too; search engines don’t list them.</p><div class="cards">{cards}</div>"#,
            p.sites.len()
        )
    };
    let first = p.user.name.as_deref().filter(|n| !n.is_empty()).unwrap_or(&p.user.handle);
    let first = first.split(' ').next().unwrap_or(first);
    let count = if p.computers.is_empty() { String::new() } else { format!("{online} of {} online", p.computers.len()) };
    let computers: String = p.computers.iter().map(|c| computer_card(c, &hidden, p.now_ms)).collect();
    let what = if tag(cfg).eq_ignore_ascii_case("cloud") { "cloud" } else { "grid" };
    let body = format!(
        r#"{flash}
      <section class="hero" aria-labelledby="hi">
        <div class="h-main">
          <h1 class="h1" id="hi">Hi {first}</h1>
          <p class="sub">Your cloud wisp runs here on {host}, so it keeps working while your computers are off.</p>
          <div data-live="cloud">{cloud}</div>
        </div>
        <div class="h-shot"><a href="/go" tabindex="-1" aria-hidden="true">{shot}</a></div>
        <div class="h-more" data-live="wish">{wish}</div>
      </section>
      <div data-live="start">{start}</div>

      <h2 class="sec">Your computers <span class="n" data-live="online">{count}</span></h2>
      <p class="hint">wisp on your own desktop or laptop, reached through the grid. Your files and agents stay on it.</p>
      <div class="cards">
        <div class="cards-live" data-live="computers">{computers}</div>
        {add}
      </div>

      <div data-live="sites">{apps}</div>

      <h2 class="sec">What your {what} can do</h2>
      <div class="can" data-live="can">{tiles}</div>
      {dialog}
      {COPY_JS}{machines_js}{HOME_JS}{LIVE}"#,
        flash = flash(&p.flash, p.tone),
        first = esc(first),
        host = esc(host),
        cloud = cloud_block(p, &hidden),
        shot = shot("app", ""),
        wish = add_machine_row(p.machine.wish.as_ref()),
        start = if fresh { FIRST_STEPS } else { "" },
        add = add_how(&cli, host),
        tiles = tiles(p, host),
        dialog = machines_dialog(&p.machine, &p.user, &hidden),
        machines_js = machines_js(),
    );
    app_page(&AppPage { user: Some(&p.user), csrf: &p.csrf, tab: Tab::Home, ..AppPage::new(cfg, "Home", &body) })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> PageCfg {
        PageCfg { name: "wisp Cloud".into(), domain: "grid.trywisp.dev".into(), public_url: "https://grid.trywisp.dev".into() }
    }

    fn page() -> HomePage {
        HomePage {
            user: PageUser { handle: "ada".into(), name: Some("Ada Lovelace".into()), ..PageUser::default() },
            url: "https://ada.grid.trywisp.dev".into(),
            instance: InstanceView { state: "stopped".into(), ..InstanceView::default() },
            now_ms: 1_793_000_000_000,
            ..HomePage::default()
        }
    }

    #[test]
    fn a_fresh_account_gets_the_first_steps() {
        let h = home_page(&cfg(), &page());
        assert!(h.contains("Hi Ada</h1>"));
        assert!(h.contains("Open your cloud wisp"));
        assert!(h.contains("Starts the first time you open it"));
        assert!(h.contains("What your cloud can do"));
        assert!(h.contains(r#"data-copy="npx wisp-agents computer on""#));
        assert!(h.contains(r#"<form class="inline off" method="post" action="/instance/stop">"#));
    }

    #[test]
    fn computers_and_apps_show_as_cards() {
        let mut p = page();
        p.instance = InstanceView { state: "running".into(), started_at: Some(p.now_ms - 120_000), ..InstanceView::default() };
        p.computers = vec![
            ComputerView {
                id: "c1".into(),
                name: "mac".into(),
                url: "https://mac--ada.grid".into(),
                online: true,
                ..ComputerView::default()
            },
            ComputerView { id: "c2".into(), name: "<pc>".into(), last_seen_at: Some(p.now_ms - 3_600_000), ..ComputerView::default() },
        ];
        p.sites = vec![SiteView {
            key: "k".into(),
            title: "Demo".into(),
            url: "https://demo.grid/".into(),
            files: 1,
            updated_at: Some(p.now_ms),
        }];
        let h = home_page(&cfg(), &p);
        assert!(!h.contains("Open your cloud wisp</b>"));
        assert!(h.contains("Started 2 min ago."));
        assert!(h.contains("1 of 2 online"));
        assert!(h.contains("Offline · last seen 1 h ago"));
        assert!(h.contains("&#60;pc&#62;"));
        assert!(h.contains("Updated just now · 1 file</small>"));
        assert!(h.contains("1 published"));
        assert!(h.contains("2 added"));
    }
}
