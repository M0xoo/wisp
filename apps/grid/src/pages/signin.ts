// Signed out: the sign-in page (what a grid gives you, the real app, and the way in), its in-app
// browser box, and the dev grid's sign-in.

import { browserName, inAppBrowser, openOutside, type InApp } from '../in-app.ts';
import type { SeatsView } from '../seats.ts';
import { A, AGENTS, I, esc, logo, shot, type PageCfg, type PageProvider } from './common.ts';
import { siteFoot, siteHead } from './site.ts';

type Providers = ReadonlyMap<string, PageProvider>;

interface JoinArgs {
  cfg: PageCfg;
  providers: Providers;
  seats?: Partial<SeatsView>;
  ret?: string;
  error?: string;
  linking?: boolean;
  waitlisted?: boolean;
  inApp?: InApp | null;
}

export interface SignInArgs {
  cfg: PageCfg;
  providers: Providers;
  seats?: Partial<SeatsView>;
  ret?: string;
  error?: string;
  linking?: boolean;
  waitlisted?: boolean;
  /** load the hosted grid's PostHog script (telemetry.pages) */
  analytics?: boolean;
  ua?: string | undefined;
}

const waitlist = (cfg: Pick<PageCfg, 'domain'>): string => (cfg.domain === 'grid.trywisp.dev' ? 'https://trywisp.dev/cloud.html#join' : '');
const signInWith = (providers: Providers): PageProvider[] => [...providers.values()].filter((p) => p.id !== 'dev');

// No seat count: with seats that open as the grid grows, "3 left" says little and reads as a
// countdown. Just whether there's room, and the waitlist when there isn't.
function joinBox({ cfg, providers, seats = {}, ret = '', error = '', linking = false, waitlisted = false, inApp = null }: JoinArgs): string {
  const q = ret ? `?return=${encodeURIComponent(ret)}` : '';
  const full = !linking && seats.left === 0;
  const wl = full && !waitlisted && waitlist(cfg);
  // In an app's own browser Google sign-in can only fail (it refuses web views): leave it out there.
  const list = [...providers.values()].filter((p) => !(inApp && p.id === 'google')).sort((a, b) => (a.id === 'github' ? -1 : b.id === 'github' ? 1 : a.id === 'dev' ? 1 : 0));
  // Full: new people get the waitlist first; the few with an account still sign in below it.
  // Two ways in share one row, so adding Google doesn't push the page down; "Continue with" drops on phones.
  const pair = list.length === 2;
  let buttons = list.map((p, i) => `<a class="btn${i === 0 && !wl && !inApp ? ' first' : ''}" href="/auth/${encodeURIComponent(p.id)}/start${q}">${logo(p.id)}${pair ? `<span><span class="cw">Continue with </span>${esc(p.label)}</span>` : `Continue with ${esc(p.label)}`}</a>`).join('');
  if (pair) buttons = `<div class="ways">${buttons}</div>`;
  const invite = seats.invite || seats.open === false;
  const fullNote = waitlisted
    ? `<b>All seats are taken, so you’re on the waitlist.</b> Seats open as the grid grows, oldest on the list first; yours is held for you then. Sign in again to check.`
    : wl
      ? `<b>All preview seats are taken.</b> Leave your email and you get the next one. Already have a seat? Sign in below.`
      : `<b>This grid is full:</b> it has all the accounts it takes. Already have one? Sign in below.`;
  return `<div class="join" id="join">${error ? `<p class="err">${esc(error)}</p>` : ''}
    ${full ? `<p class="full">${fullNote}</p>` : ''}
    ${wl ? `<a class="btn first" href="${wl}">${I.arrow}Get the next free seat</a>` : ''}
    ${buttons || '<p class="err">No sign-in is set up on this grid yet. Its operator adds GitHub or Google in grid.json.</p>'}
    <div class="fine">${linking ? '<span>Sign in with it once; after that either one opens your account.</span>' : `<span>${I.check}Nothing to install</span><span>${I.check}Your own agent accounts</span><span>${I.check}${invite ? 'Invite only' : 'Free during the preview'}</span>`}</div></div>`;
}

// In X's (or another app's) own browser: the way out to Safari or Chrome, the link to copy, and
// "email me the link" for finishing on a computer (it joins the waitlist as source in-app).
function inAppBox(inApp: InApp, url: string): string {
  const where = browserName(inApp.os);
  return `<div class="inapp" id="inapp" data-app="${esc(inApp.app)}" data-url="${esc(url)}">
    <p><b>You’re in ${esc(inApp.app === 'this app' ? 'this app’s' : `${inApp.app}’s`)} browser.</b> Signing in doesn’t work here: Google blocks it and GitHub would ask for your password.</p>
    <div class="ways"><a class="btn first" href="${esc(openOutside(url, inApp.os))}" data-inapp="open">${I.arrow}Open in ${where}</a><button class="btn" type="button" data-inapp="copy">${I.copy}<span>Copy link</span></button></div>
    <input class="link" readonly value="${esc(url)}" aria-label="Link to this page" hidden>
    <p class="tip">Nothing happens? Tap <b>⋯</b> at the top right, then <b>Open in browser</b>.</p>
    <form class="mail" id="inappMail" novalidate><label for="inappEmail">Or get the link by email for your computer:</label>
      <div><input id="inappEmail" type="email" name="email" placeholder="you@example.com" autocomplete="email" autocapitalize="off" enterkeyhint="send" required><button class="btn" type="submit">Email me</button></div>
      <p class="sent" role="status" hidden>${I.check}<span></span></p><p class="err" role="alert" hidden></p></form>
  </div>`;
}
// Copy falls back to execCommand (older web views refuse the clipboard API), then to the link
// shown selected. Email: says saved at once, and takes it back if the grid refuses.
const INAPP_JS = `<script>(()=>{const box=document.getElementById('inapp');if(!box)return;const app=box.dataset.app,url=box.dataset.url,ph=(e,p)=>window.posthog&&posthog.capture(e,Object.assign({app,page:'grid'},p||{}),{transport:'sendBeacon'});ph('inapp_seen');
const copy=async()=>{try{await navigator.clipboard.writeText(url);return true}catch{const t=document.createElement('textarea');t.value=url;t.setAttribute('readonly','');t.style.cssText='position:fixed;opacity:0';document.body.append(t);t.select();let ok=false;try{ok=document.execCommand('copy')}catch{}t.remove();return ok}};
box.addEventListener('click',async(e)=>{const a=e.target.closest('[data-inapp]');if(!a)return;if(a.dataset.inapp==='open')return ph('inapp_open_clicked');ph('inapp_copy_clicked');const s=a.querySelector('span');if(await copy()){s.textContent='Copied';setTimeout(()=>{s.textContent='Copy link'},1500)}else{const l=box.querySelector('.link');l.hidden=false;l.focus();l.select()}});
const f=document.getElementById('inappMail');f.addEventListener('submit',async(e)=>{e.preventDefault();const row=f.querySelector('div'),label=f.querySelector('label'),err=f.querySelector('.err'),ok=f.querySelector('.sent'),email=f.email.value.trim();err.hidden=true;if(!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(email)){err.textContent='An email address, please.';err.hidden=false;f.email.focus();return}
ok.querySelector('span').textContent='Saved. We’ll send the link to '+email+'.';row.hidden=true;label.hidden=true;ok.hidden=false;
try{const r=await fetch('/api/waitlist',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,source:'in-app'})});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||'That didn’t go through. Try again.');ph('inapp_email_sent')}catch(x){ok.hidden=true;row.hidden=false;label.hidden=false;err.textContent=x instanceof TypeError?'No connection. Try again.':x.message;err.hidden=false}})})()</script>`;


// The landing page's sections, in order. Each is what v1 had inline in signInPage.
const hero = (cfg: PageCfg, join: string): string => `<section class="hero"><div class="wrap">
  <div>
    <div class="kicker"><i></i>${esc(cfg.name)} · ${esc(cfg.domain)}</div>
    <h1 class="big">Close the laptop.<br><span>Your agents keep going.</span></h1>
    <p class="lede">Your own wisp, running on a server. Start Claude Code, Codex or opencode on a task, shut the lid, and read the report from your phone. Same app, same reports, nothing to keep awake.</p>
    ${join}
  </div>
  <div class="stage">
    <div class="win"><div class="bar"><i></i><i></i><i></i><span class="url">${I.shield}you.${esc(cfg.domain)}</span></div>${shot('app', 'wisp: tasks running and waiting for you')}</div>
    <div class="float" aria-live="polite">
      <div class="row"><button class="sw" id="lid" role="switch" aria-checked="false" aria-label="Close the laptop"></button><b id="lidText">Laptop open</b><span class="t" id="clock">18:40</span></div>
      <div class="jobs">
        <div class="job"><div class="n"><span>Migrate billing to the new API</span><em>running</em></div><div class="p"><span></span></div></div>
        <div class="job"><div class="n"><span>Add e2e tests for checkout</span><em>running</em></div><div class="p"><span></span></div></div>
      </div>
      <p class="where" id="where">Flip the switch: the laptop sleeps, your grid doesn’t.</p>
    </div>
  </div>
</div></section>`;

const STRIP = `<div class="strip"><div class="wrap"><span class="l">Signs in with your own accounts</span><ul>
  ${AGENTS.map(([f, n, c]) => `<li><img src="${A}/${f}" alt="" class="${c}">${n}</li>`).join('')}<li>${I.github}GitHub</li></ul></div></div>`;

const how = (cfg: PageCfg, ways: PageProvider[]): string => `<section class="s" id="how"><div class="wrap">
  <p class="num">01 · HOW IT WORKS</p>
  <h2 class="t">Three minutes from here<br><span>to your first task.</span></h2>
  <div class="steps">
    <div class="step"><span class="k">1</span><h3>Sign in</h3><p>${ways.length ? `With ${esc(ways.map((p) => p.label).join(' or '))}. ` : ''}You get your own wisp at <code>you.${esc(cfg.domain)}</code>, in a box nobody else can touch.</p><div class="chips">${ways.map((p) => `<span class="chip">${logo(p.id)}${esc(p.label)}</span>`).join('')}</div></div>
    <div class="step"><span class="k">2</span><h3>Connect your agents</h3><p>Sign in to Claude Code, Codex and GitHub from Settings → Agents: a link and a code, no terminal. Only what you sign in to shows up.</p><div class="chips">${AGENTS.slice(0, 2).map(([f, n]) => `<span class="chip"><img src="${A}/${f}" alt="">${n}</span>`).join('')}<span class="chip">${I.github}gh</span></div></div>
    <div class="step"><span class="k">3</span><h3>Send tasks from anywhere</h3><p>From the browser, from wisp on your computer (Settings → Cloud) or from the phone app. It sleeps when idle and wakes for you and your schedules.</p><div class="chips"><span class="chip">${I.globe}Browser</span><span class="chip">${I.laptop}Desktop</span><span class="chip">${I.phone}Phone</span></div></div>
  </div>
</div></section>`;

const report = (cfg: PageCfg): string => `<section class="s" id="report"><div class="wrap">
  <p class="num">02 · WHAT YOU GET BACK</p>
  <h2 class="t">The report,<br><span>not the transcript.</span></h2>
  <div class="split">
    <div class="win"><div class="bar"><i></i><i></i><i></i><span class="url">${I.shield}you.${esc(cfg.domain)}</span></div>${shot('report', 'A wisp report: what changed, the diff, the tests')}</div>
    <div class="points">
      <div class="pt"><h3>What changed and why</h3><p>Each task ends with a short brief: the diff that matters, the tests it ran, the numbers that moved, and what it couldn’t do.</p></div>
      <div class="pt"><h3>It asks when it must</h3><p>A question or an approval waits on the card, and on your phone, until you answer. Everything else just runs.</p></div>
      <div class="pt"><h3>Ship it from the card</h3><p>Every task works in its own branch. One click commits, pushes and opens the pull request with your GitHub.</p></div>
      <div class="pt"><h3>Follow up in one line</h3><p>“Now add the same to RefreshQueue.” It picks up where it left off, with its context.</p></div>
    </div>
  </div>
</div></section>`;

const PRIVATE = `<section class="band" id="private"><div class="wrap">
  <p class="num">03 · PRIVATE BY DESIGN</p>
  <h2 class="t">Your box, your keys.<br><span>Nobody else’s agents next door.</span></h2>
  <p class="sub">wisp runs your agents with real permissions, so every person gets a sandbox of their own on this grid, and nothing of yours leaves it.</p>
  <div class="grid4">
    <div>${I.shield}<h3>Its own sandbox</h3><p>Your wisp runs in its own gVisor container: its own kernel boundary, filesystem and network. Other users can’t reach it.</p></div>
    <div>${I.key}<h3>Logins stay yours</h3><p>Claude, ChatGPT and GitHub sign in inside your box and stay in your folder. The grid never sees a password.</p></div>
    <div>${I.moon}<h3>Sleeps when idle</h3><p>Nothing running, nobody looking: it stops, and wakes in seconds when you open it or a schedule is due.</p></div>
    <div>${I.code}<h3>Open source</h3><p>The whole grid is in the wisp repo (MIT). Rather host it yourself? One command on any Linux box.</p></div>
  </div>
  <span class="cmd">$ npx wisp-agents grid init --domain wisp.example.com</span>
</div></section>`;

// The laptop-lid toy in the hero: flip it and the jobs keep going on the grid.
const lid = (cfg: PageCfg): string => `<script>
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
    where.textContent = closed ? 'Still running on ${esc(cfg.domain)}. The report waits on your phone.' : 'Flip the switch: the laptop sleeps, your grid doesn’t.';
  };
})();
</script>`;

export function signInPage({ cfg, providers, seats = {}, ret = '', error = '', linking = false, waitlisted = false, analytics = false, ua = '' }: SignInArgs): string {
  const inApp = inAppBrowser(ua);
  const here = `${cfg.publicUrl}/${ret ? `signin?return=${encodeURIComponent(ret)}` : ''}`;
  const join = (inApp ? inAppBox(inApp, here) : '') + joinBox({ cfg, providers, seats, ret, error, linking, waitlisted, inApp });
  const ways = signInWith(providers);
  return `${siteHead(`${cfg.name} · your agents keep working when your laptop closes`, cfg, analytics)}
<main>
${hero(cfg, join)}

${STRIP}

${how(cfg, ways)}

${report(cfg)}

${PRIVATE}

<section class="final"><div class="wrap">
  <h2>Leave the agents working.<br><span style="color:var(--faint)">Go have dinner.</span></h2>
  ${joinBox({ cfg, providers, seats, ret, waitlisted, inApp })}
</div></section>
</main>
${lid(cfg)}
${inApp ? INAPP_JS : ''}${siteFoot(cfg)}`;
}

export function devSignInPage({ cfg, ret = '', csrf }: { cfg: PageCfg; ret?: string; csrf: string }): string {
  return `${siteHead(`Dev sign-in · ${cfg.name}`, cfg)}<main class="narrow"><div class="card">
    <div class="kicker"><i></i>development grid</div><h1 style="font-size:30px">Dev sign-in</h1>
    <p style="color:var(--muted);margin-top:8px">Only on a grid started with <code>wisp grid dev</code>: any email, no password.</p>
    <form method="post" action="/auth/dev/callback" class="join" style="margin-top:8px">
      <input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="return" value="${esc(ret)}">
      <label class="f">Email<input class="input" name="email" type="email" required autofocus placeholder="ada@example.com"></label>
      <label class="f">Name<input class="input" name="name" placeholder="Ada"></label>
      <button class="btn first" type="submit" style="margin-top:18px">Sign in</button>
    </form></div></main>${siteFoot(cfg)}`;
}
