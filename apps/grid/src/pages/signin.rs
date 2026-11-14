//! The signed-out site: what a grid gives you, the real app, and the way in (`/`, `/signin`), and
//! the dev grid's any-email sign-in.

use super::icons::{CODE, GITHUB, GLOBE, KEY, LAPTOP, MOON, PHONE, SHIELD};
use super::in_app::in_app_browser;
use super::join::{Join, in_app_box, join_box, logo};
use super::scripts::INAPP_JS;
use super::site::{shot, site_foot, site_head};
use super::{ASSETS, PageCfg, Provider, esc};
use crate::http::encode_component;

/// The agents the strip shows: file under assets, name, and `mono` for a logo that turns white in
/// the dark.
const AGENTS: [(&str, &str, &str); 4] = [
    ("claudecode-color.svg", "Claude Code", ""),
    ("codex-color.svg", "Codex", ""),
    ("opencode.svg", "opencode", "mono"),
    ("cursor.svg", "Cursor", "mono"),
];

/// Whether the grid has room (no counts: see `join_box`).
#[derive(Debug, Clone, Default)]
pub struct Seats {
    /// Seats left, when the grid has a cap; `Some(0)` is full.
    pub left: Option<i64>,
    /// An allow list decides who gets in.
    pub invite: bool,
    /// Sign-ups are closed.
    pub closed: bool,
}

/// The sign-in page (`/` signed out, `/signin`).
#[derive(Debug, Clone, Default)]
pub struct SignInPage {
    /// The grid's ways to sign in, in its order.
    pub providers: Vec<Provider>,
    pub seats: Seats,
    /// Where to go once signed in (a safe path), or empty.
    pub ret: String,
    pub error: String,
    /// Signing in to link a second way to an account.
    pub linking: bool,
    /// Turned away at sign-in with a verified email that's on the waitlist.
    pub waitlisted: bool,
    /// The `PostHog` project key, on the hosted grid only.
    pub analytics: Option<String>,
    /// The caller's user agent (an app's own browser gets the way out).
    pub ua: String,
}

pub fn sign_in_page(cfg: &PageCfg, p: &SignInPage) -> String {
    let in_app = in_app_browser(&p.ua);
    let here = if p.ret.is_empty() {
        format!("{}/", cfg.public_url)
    } else {
        format!("{}/signin?return={}", cfg.public_url, encode_component(&p.ret))
    };
    let join = |error: &str, linking: bool| {
        join_box(&Join {
            cfg,
            providers: &p.providers,
            seats: &p.seats,
            ret: &p.ret,
            error,
            linking,
            waitlisted: p.waitlisted,
            in_app: in_app.as_ref(),
        })
    };
    let top = in_app.as_ref().map(|a| in_app_box(a, &here)).unwrap_or_default() + &join(&p.error, p.linking);
    let title = format!("{} · your agents keep working when your laptop closes", cfg.name);
    let mut out = site_head(&title, cfg, p.analytics.as_deref());
    out += "\n<main>\n";
    out += &hero(cfg, &top);
    out += &strip();
    out += &how(cfg, &p.providers);
    out += &report(cfg);
    out += &private();
    out += &format!(
        "<section class=\"final\"><div class=\"wrap\">\n  <h2>Leave the agents working.<br><span style=\"color:var(--faint)\">Go have dinner.</span></h2>\n  {}\n</div></section>\n</main>\n",
        join("", false)
    );
    out += LID_JS_HEAD;
    out += &esc(&cfg.domain);
    out += LID_JS_TAIL;
    out += "\n";
    if in_app.is_some() {
        out += INAPP_JS;
    }
    out + &site_foot(cfg)
}

fn hero(cfg: &PageCfg, join: &str) -> String {
    let (name, domain) = (esc(&cfg.name), esc(&cfg.domain));
    format!(
        r#"<section class="hero"><div class="wrap">
  <div>
    <div class="kicker"><i></i>{name} · {domain}</div>
    <h1 class="big">Close the laptop.<br><span>Your agents keep going.</span></h1>
    <p class="lede">Your own wisp, running on a server. Start Claude Code, Codex or opencode on a task, shut the lid, and read the report from your phone. Same app, same reports, nothing to keep awake.</p>
    {join}
  </div>
  <div class="stage">
    <div class="win"><div class="bar"><i></i><i></i><i></i><span class="url">{SHIELD}you.{domain}</span></div>{shot}</div>
    <div class="float" aria-live="polite">
      <div class="row"><button class="sw" id="lid" role="switch" aria-checked="false" aria-label="Close the laptop"></button><b id="lidText">Laptop open</b><span class="t" id="clock">18:40</span></div>
      <div class="jobs">
        <div class="job"><div class="n"><span>Migrate billing to the new API</span><em>running</em></div><div class="p"><span></span></div></div>
        <div class="job"><div class="n"><span>Add e2e tests for checkout</span><em>running</em></div><div class="p"><span></span></div></div>
      </div>
      <p class="where" id="where">Flip the switch: the laptop sleeps, your grid doesn’t.</p>
    </div>
  </div>
</div></section>

"#,
        shot = shot("app", "wisp: tasks running and waiting for you")
    )
}

fn strip() -> String {
    let agents: String = AGENTS.iter().map(|(f, n, c)| format!(r#"<li><img src="{ASSETS}/{f}" alt="" class="{c}">{n}</li>"#)).collect();
    format!(
        "<div class=\"strip\"><div class=\"wrap\"><span class=\"l\">Signs in with your own accounts</span><ul>\n  {agents}<li>{GITHUB}GitHub</li></ul></div></div>\n\n"
    )
}

fn how(cfg: &PageCfg, providers: &[Provider]) -> String {
    let ways: Vec<&Provider> = providers.iter().filter(|p| p.id != "dev").collect();
    let with = if ways.is_empty() {
        String::new()
    } else {
        format!("With {}. ", esc(&ways.iter().map(|p| p.label.as_str()).collect::<Vec<_>>().join(" or ")))
    };
    let chips: String = ways.iter().map(|p| format!(r#"<span class="chip">{}{}</span>"#, logo(&p.id), esc(&p.label))).collect();
    let agents: String =
        AGENTS[..2].iter().map(|(f, n, _)| format!(r#"<span class="chip"><img src="{ASSETS}/{f}" alt="">{n}</span>"#)).collect();
    let domain = esc(&cfg.domain);
    format!(
        r#"<section class="s" id="how"><div class="wrap">
  <p class="num">01 · HOW IT WORKS</p>
  <h2 class="t">Three minutes from here<br><span>to your first task.</span></h2>
  <div class="steps">
    <div class="step"><span class="k">1</span><h3>Sign in</h3><p>{with}You get your own wisp at <code>you.{domain}</code>, in a box nobody else can touch.</p><div class="chips">{chips}</div></div>
    <div class="step"><span class="k">2</span><h3>Connect your agents</h3><p>Sign in to Claude Code, Codex and GitHub from Settings → Agents: a link and a code, no terminal. Only what you sign in to shows up.</p><div class="chips">{agents}<span class="chip">{GITHUB}gh</span></div></div>
    <div class="step"><span class="k">3</span><h3>Send tasks from anywhere</h3><p>From the browser, from wisp on your computer (Settings → Cloud) or from the phone app. It sleeps when idle and wakes for you and your schedules.</p><div class="chips"><span class="chip">{GLOBE}Browser</span><span class="chip">{LAPTOP}Desktop</span><span class="chip">{PHONE}Phone</span></div></div>
  </div>
</div></section>

"#
    )
}

fn report(cfg: &PageCfg) -> String {
    format!(
        r#"<section class="s" id="report"><div class="wrap">
  <p class="num">02 · WHAT YOU GET BACK</p>
  <h2 class="t">The report,<br><span>not the transcript.</span></h2>
  <div class="split">
    <div class="win"><div class="bar"><i></i><i></i><i></i><span class="url">{SHIELD}you.{}</span></div>{}</div>
    <div class="points">
      <div class="pt"><h3>What changed and why</h3><p>Each task ends with a short brief: the diff that matters, the tests it ran, the numbers that moved, and what it couldn’t do.</p></div>
      <div class="pt"><h3>It asks when it must</h3><p>A question or an approval waits on the card, and on your phone, until you answer. Everything else just runs.</p></div>
      <div class="pt"><h3>Ship it from the card</h3><p>Every task works in its own branch. One click commits, pushes and opens the pull request with your GitHub.</p></div>
      <div class="pt"><h3>Follow up in one line</h3><p>“Now add the same to RefreshQueue.” It picks up where it left off, with its context.</p></div>
    </div>
  </div>
</div></section>

"#,
        esc(&cfg.domain),
        shot("report", "A wisp report: what changed, the diff, the tests")
    )
}

fn private() -> String {
    format!(
        r#"<section class="band" id="private"><div class="wrap">
  <p class="num">03 · PRIVATE BY DESIGN</p>
  <h2 class="t">Your box, your keys.<br><span>Nobody else’s agents next door.</span></h2>
  <p class="sub">wisp runs your agents with real permissions, so every person gets a sandbox of their own on this grid, and nothing of yours leaves it.</p>
  <div class="grid4">
    <div>{SHIELD}<h3>Its own sandbox</h3><p>Your wisp runs in its own gVisor container: its own kernel boundary, filesystem and network. Other users can’t reach it.</p></div>
    <div>{KEY}<h3>Logins stay yours</h3><p>Claude, ChatGPT and GitHub sign in inside your box and stay in your folder. The grid never sees a password.</p></div>
    <div>{MOON}<h3>Sleeps when idle</h3><p>Nothing running, nobody looking: it stops, and wakes in seconds when you open it or a schedule is due.</p></div>
    <div>{CODE}<h3>Open source</h3><p>The whole grid is in the wisp repo (MIT). Rather host it yourself? One command on any Linux box.</p></div>
  </div>
  <span class="cmd">$ npx wisp-agents grid init --domain wisp.example.com</span>
</div></section>

"#
    )
}

/// The hero's toy: flip the lid and the jobs keep going. The grid's domain goes between the halves.
const LID_JS_HEAD: &str = r"<script>
(() => {
  const lid = document.getElementById('lid'), text = document.getElementById('lidText'), where = document.getElementById('where'), clock = document.getElementById('clock');
  const bars = [...document.querySelectorAll('.job .p span')];
  let m = 18 * 60 + 40, closed = false, w = [30, 52];
  const tick = () => {
    m = (m + (closed ? 17 : 1)) % 1440;
    clock.textContent = String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
    w = w.map((x, i) => Math.min(100, x + (closed ? 6 + i * 3 : 0.6)));
    bars.forEach((b, i) => (b.style.width = w[i] + '%'));
    document.querySelectorAll('.job em').forEach((e, i) => (e.textContent = w[i] >= 100 ? 'done' : 'running'));
    if (w.every((x) => x >= 100)) { w = [6, 18]; }
  };
  setInterval(tick, 900); tick();
  lid.onclick = () => {
    closed = !closed;
    lid.setAttribute('aria-checked', closed);
    text.textContent = closed ? 'Laptop closed' : 'Laptop open';
    where.textContent = closed ? 'Still running on ";
const LID_JS_TAIL: &str = r". The report waits on your phone.' : 'Flip the switch: the laptop sleeps, your grid doesn’t.';
  };
})();
</script>";

/// Only on a grid started with `wisp grid dev`: any email, no password.
pub fn dev_sign_in_page(cfg: &PageCfg, ret: &str, csrf: &str) -> String {
    let head = site_head(&format!("Dev sign-in · {}", cfg.name), cfg, None);
    format!(
        r#"{head}<main class="narrow"><div class="card">
    <div class="kicker"><i></i>development grid</div><h1 style="font-size:30px">Dev sign-in</h1>
    <p style="color:var(--muted);margin-top:8px">Only on a grid started with <code>wisp grid dev</code>: any email, no password.</p>
    <form method="post" action="/auth/dev/callback" class="join" style="margin-top:8px">
      <input type="hidden" name="csrf" value="{}"><input type="hidden" name="return" value="{}">
      <label class="f">Email<input class="input" name="email" type="email" required autofocus placeholder="ada@example.com"></label>
      <label class="f">Name<input class="input" name="name" placeholder="Ada"></label>
      <button class="btn first" type="submit" style="margin-top:18px">Sign in</button>
    </form></div></main>{}"#,
        esc(csrf),
        esc(ret),
        site_foot(cfg)
    )
}
