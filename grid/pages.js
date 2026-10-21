// The grid's own pages. Signed out, it's the site (trywisp.dev's paper, ink and one blue): what a
// grid gives you, the real app, and the way in. Signed in, it's the app (wisp's own tokens and
// rows): your cloud computer, where to use it, your devices and sign-ins. Server-rendered, no
// build; every form posts with a CSRF token. Images come from grid/assets (/_grid/a/…).

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const A = '/_grid/a';
const I = {
  github: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.04-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.04 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.58.23 2.75.11 3.04.74.81 1.19 1.83 1.19 3.09 0 4.41-2.7 5.38-5.26 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z"/></svg>',
  google: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M23.5 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.45a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.57-5.17 3.57-8.81Z"/><path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.94-2.9l-3.88-3.01c-1.07.72-2.45 1.15-4.06 1.15-3.13 0-5.78-2.11-6.72-4.95H1.27v3.11A12 12 0 0 0 12 24Z"/><path fill="#FBBC05" d="M5.28 14.29a7.2 7.2 0 0 1 0-4.58V6.6H1.27a12 12 0 0 0 0 10.8l4.01-3.11Z"/><path fill="#EA4335" d="M12 4.77c1.76 0 3.34.61 4.59 1.8l3.44-3.44A11.97 11.97 0 0 0 12 0 12 12 0 0 0 1.27 6.6l4.01 3.11C6.22 6.88 8.87 4.77 12 4.77Z"/></svg>',
  key: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="15" r="4" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M11 12l8-8M16 7l2.5 2.5M14 9l2 2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  code: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 8l-4 4 4 4M16 8l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6.5l5.5 5.5-5.5 5.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  laptop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="11" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M2.5 19h19" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  phone: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="2.5" width="10" height="19" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M11 18.5h2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  globe: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M3 12h18M12 3c2.6 2.6 3.8 5.6 3.8 9s-1.2 6.4-3.8 9c-2.6-2.6-3.8-5.6-3.8-9S9.4 5.6 12 3z" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>',
  cloud: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 18.5h10a4 4 0 00.6-7.95A5.5 5.5 0 007.6 9.1 4.75 4.75 0 007.5 18.5z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>',
  shield: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.4-7.5 9.5-4.3-1.1-7.5-4.9-7.5-9.5V6L12 3z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
  moon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 019.5 4a8.5 8.5 0 1010.5 10.5z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
};
const logo = (id) => I[id] || I[id.split(':')[0]] || (id === 'dev' ? I.code : I.key);
const AGENTS = [
  ['claudecode-color.svg', 'Claude Code', ''],
  ['codex-color.svg', 'Codex', ''],
  ['opencode.svg', 'opencode', 'mono'],
  ['cursor.svg', 'Cursor', 'mono'],
];

// --- the site (signed out) ------------------------------------------------------------------

const SITE_CSS = `
:root{--bg:#f4f3ef;--bg-2:#ecebe6;--surface:#fff;--ink:#141414;--ink-2:#3a3a38;--muted:#6c6b66;--faint:#a6a49d;--line:#e1dfd8;--line-2:#d1cfc7;--accent:#2f5bea;--accent-soft:rgba(47,91,234,.1);--good:#18794e;--bad:#cd2b31;--band:#121212;--band-ink:#ededed;--band-muted:#8f8f8f;--band-line:#262626;--win-bar:#ebeae6;
--shadow:0 1px 1px rgba(0,0,0,.04),0 2px 6px rgba(0,0,0,.04),0 40px 80px -40px rgba(30,28,20,.35);
--sans:-apple-system,BlinkMacSystemFont,'SF Pro Text','Inter','Segoe UI',system-ui,sans-serif;--display:-apple-system,BlinkMacSystemFont,'SF Pro Display','Inter','Segoe UI',system-ui,sans-serif;--mono:ui-monospace,'SF Mono','JetBrains Mono',Menlo,Consolas,monospace;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0e0e0d;--bg-2:#151514;--surface:#171717;--ink:#ededeb;--ink-2:#c8c7c2;--muted:#8d8c86;--faint:#5c5b57;--line:#232322;--line-2:#31302e;--accent:#6d8dff;--accent-soft:rgba(109,141,255,.14);--good:#4cc38a;--bad:#ff6369;--band:#161615;--band-line:#2a2a28;--win-bar:#1d1d1c;--shadow:0 1px 1px rgba(0,0,0,.3),0 40px 80px -40px rgba(0,0,0,.9);color-scheme:dark}img.mono{filter:invert(1)}}
*,*::before,*::after{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:72px;-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 var(--sans);-webkit-font-smoothing:antialiased;overflow-x:hidden}
a{color:inherit}img{display:block;max-width:100%;height:auto}code{font-family:var(--mono);font-size:.86em;padding:.12em .38em;border-radius:5px;background:rgba(127,127,127,.12);white-space:nowrap}
h1,h2,h3{font-family:var(--display);margin:0;letter-spacing:-.03em;text-wrap:balance}p{margin:0}
.wrap{max-width:1120px;margin:0 auto;padding:0 28px}
.nav{position:sticky;top:0;z-index:20;background:color-mix(in srgb,var(--bg) 86%,transparent);backdrop-filter:saturate(1.4) blur(12px);border-bottom:1px solid transparent}
.nav.scrolled{border-bottom-color:var(--line)}
.nav .wrap{display:flex;align-items:center;gap:22px;height:60px}
.brand{display:flex;align-items:center;gap:9px;font-weight:650;font-size:17px;letter-spacing:-.02em;text-decoration:none}
.mark{position:relative;width:14px;height:14px;border-radius:50%;background:var(--ink);flex:none}.mark::after{content:'';position:absolute;right:-4px;bottom:-2px;width:7px;height:7px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 2px var(--bg)}
.tag{font:500 12px var(--sans);padding:2px 8px;border-radius:99px;color:var(--accent);background:var(--accent-soft);letter-spacing:0}
.links{display:flex;gap:22px}.links a{font-size:14px;color:var(--muted);text-decoration:none}.links a:hover{color:var(--ink)}
.nav .right{margin-left:auto;display:flex;gap:10px;align-items:center}
.pill{display:inline-flex;align-items:center;gap:8px;height:36px;padding:0 14px;border-radius:10px;font-size:14px;font-weight:550;text-decoration:none;border:1px solid var(--line-2);background:var(--surface);cursor:pointer}
.pill.dark{background:var(--ink);color:var(--bg);border-color:var(--ink)}.pill svg{width:16px;height:16px}
.hero{padding:72px 0 40px}.hero .wrap{display:grid;grid-template-columns:minmax(0,.92fr) minmax(0,1.08fr);gap:56px;align-items:center}
.kicker{font:13px var(--mono);color:var(--muted);display:flex;align-items:center;gap:8px;margin-bottom:18px}.kicker i{width:7px;height:7px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 4px var(--accent-soft)}
h1.big{font-size:clamp(40px,5.4vw,64px);line-height:1.02;font-weight:700}h1.big span{color:var(--faint)}
.lede{margin-top:20px;font-size:17.5px;color:var(--ink-2);max-width:500px}
.join{margin-top:28px;max-width:440px}
.join .btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;height:52px;border-radius:12px;border:1px solid var(--line-2);background:var(--surface);color:var(--ink);font:550 15.5px var(--sans);text-decoration:none;cursor:pointer;transition:border-color .15s,transform .15s}
.join .btn:hover{border-color:var(--faint);transform:translateY(-1px)}.join .btn svg,.join .btn img{width:19px;height:19px}
.join .btn.first{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.join .btn+.btn{margin-top:10px}
.join .fine{margin-top:12px;font-size:13px;color:var(--muted);display:flex;flex-wrap:wrap;gap:6px 14px}.join .fine span{display:inline-flex;align-items:center;gap:5px}.join .fine svg{width:14px;height:14px;color:var(--good)}
.err{margin:0 0 14px;padding:11px 14px;border-radius:10px;border:1px solid color-mix(in srgb,var(--bad) 35%,var(--line));color:var(--bad);font-size:14px;background:color-mix(in srgb,var(--bad) 6%,transparent)}
.stage{position:relative}
.win{border-radius:14px;overflow:hidden;background:var(--surface);border:1px solid var(--line);box-shadow:var(--shadow)}
.win .bar{display:flex;align-items:center;gap:7px;height:34px;padding:0 12px;background:var(--win-bar);border-bottom:1px solid var(--line)}
.win .bar i{width:10px;height:10px;border-radius:50%;background:var(--line-2)}.win .bar i:nth-child(1){background:#ff5f57}.win .bar i:nth-child(2){background:#febc2e}.win .bar i:nth-child(3){background:#28c840}
.win .url{margin:0 auto;font:12px var(--mono);color:var(--muted);padding:3px 12px;border-radius:7px;background:var(--surface);border:1px solid var(--line);display:flex;gap:6px;align-items:center}.win .url svg{width:12px;height:12px;color:var(--good)}
.win picture,.win img{width:100%}
.float{position:absolute;left:-36px;bottom:-30px;width:300px;padding:14px 16px;border-radius:14px;background:var(--surface);border:1px solid var(--line);box-shadow:var(--shadow);font-size:13.5px}
.float .row{display:flex;align-items:center;gap:10px}
.sw{position:relative;width:38px;height:22px;border-radius:99px;background:var(--line-2);border:0;cursor:pointer;flex:none;transition:background .2s}.sw::after{content:'';position:absolute;left:3px;top:3px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .2s}
.sw[aria-checked=true]{background:var(--ink)}.sw[aria-checked=true]::after{transform:translateX(16px)}
.float b{font-weight:600}.float .t{margin-left:auto;font:12px var(--mono);color:var(--muted)}
.jobs{margin-top:12px;display:flex;flex-direction:column;gap:8px}
.job{padding:8px 10px;border-radius:9px;border:1px solid var(--line);background:var(--bg)}
.job .n{display:flex;justify-content:space-between;gap:8px;font-size:12.5px}.job .n em{font-style:normal;font:11px var(--mono);color:var(--good)}
.job .p{margin-top:6px;height:3px;border-radius:2px;background:var(--line);overflow:hidden}.job .p span{display:block;height:100%;width:30%;background:var(--accent);border-radius:2px;transition:width 1.2s linear}
.where{margin-top:10px;font:12px var(--mono);color:var(--muted)}
.strip{border-top:1px solid var(--line);border-bottom:1px solid var(--line);margin-top:56px}
.strip .wrap{display:flex;align-items:center;gap:28px;height:64px;flex-wrap:wrap}.strip .l{font:12.5px var(--mono);color:var(--muted)}
.strip ul{display:flex;gap:24px;list-style:none;margin:0;padding:0;flex-wrap:wrap}.strip li{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:550}.strip li img,.strip li svg{width:18px;height:18px}
section.s{padding:96px 0 0}.num{font:13px var(--mono);color:var(--muted);letter-spacing:.06em;margin-bottom:14px}
h2.t{font-size:clamp(32px,4vw,46px);line-height:1.05;font-weight:700}h2.t span{color:var(--faint)}
.sub{margin-top:16px;font-size:17px;color:var(--ink-2);max-width:580px}
.steps{margin-top:40px;display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.step{padding:22px;border-radius:16px;background:var(--surface);border:1px solid var(--line)}
.step .k{width:34px;height:34px;border-radius:10px;display:grid;place-items:center;background:var(--bg);border:1px solid var(--line);font:600 14px var(--mono)}
.step h3{margin-top:16px;font-size:19px;letter-spacing:-.02em}.step p{margin-top:8px;color:var(--muted);font-size:15px}
.step .chips{margin-top:14px;display:flex;flex-wrap:wrap;gap:6px}.chip{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:8px;border:1px solid var(--line);font-size:12.5px;background:var(--bg)}.chip img,.chip svg{width:14px;height:14px}
.split{margin-top:40px;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:40px;align-items:start}
.split .win{max-height:560px}.split .win picture img{object-fit:cover;object-position:top}
.points{display:flex;flex-direction:column;gap:22px}.pt h3{font-size:18px;letter-spacing:-.02em}.pt p{margin-top:6px;color:var(--muted);font-size:15px}
.band{margin-top:96px;background:var(--band);color:var(--band-ink);padding:88px 0}
.band .num{color:var(--band-muted)}.band h2.t span{color:#6b6b68}.band .sub{color:#b9b9b5}
.grid4{margin-top:40px;display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--band-line);border:1px solid var(--band-line);border-radius:16px;overflow:hidden}
.grid4 div{background:var(--band);padding:22px}.grid4 svg{width:20px;height:20px;color:#9fb3ff}.grid4 h3{margin-top:14px;font-size:16px;letter-spacing:-.01em}.grid4 p{margin-top:6px;font-size:14px;color:var(--band-muted)}
.band .cmd{margin-top:28px;display:inline-flex;gap:10px;align-items:center;font:13px var(--mono);padding:10px 14px;border-radius:10px;border:1px solid var(--band-line);color:var(--band-ink)}
.final{padding:96px 0;text-align:center}.final h2{font-size:clamp(34px,4.4vw,52px);font-weight:700;line-height:1.04}.final .join{margin:28px auto 0}
.foot{border-top:1px solid var(--line);padding:26px 0 40px;font-size:13px;color:var(--muted)}.foot .wrap{display:flex;gap:18px;flex-wrap:wrap}.foot a{text-decoration:none}.foot a:hover{color:var(--ink)}
.dark-only{display:none}@media (prefers-color-scheme:dark){.dark-only{display:block}.light-only{display:none}}
.narrow{max-width:420px;margin:0 auto;padding:80px 24px}
.card{padding:24px;border-radius:16px;background:var(--surface);border:1px solid var(--line);box-shadow:var(--shadow)}
label.f{display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--muted);margin-top:14px}
.input{height:46px;border-radius:11px;border:1px solid var(--line-2);background:var(--bg);color:var(--ink);padding:0 14px;font:15px var(--sans)}
.input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
@media (max-width:920px){.hero .wrap,.split{grid-template-columns:1fr}.hero{padding-top:40px}.float{position:relative;left:auto;bottom:auto;width:auto;margin:-24px 16px 0}.steps,.grid4{grid-template-columns:1fr 1fr}.links{display:none}}
@media (max-width:600px){.steps,.grid4{grid-template-columns:1fr}.wrap{padding:0 20px}.nav .right .pill:not(.dark){display:none}}
`;

function siteHead(title, cfg) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="referrer" content="same-origin"><meta name="description" content="Your own wisp on a server: coding agents keep working when your laptop closes. Sign in with GitHub or Google.">
<link rel="icon" href="${A}/icon.svg"><style>${SITE_CSS}</style></head><body>
<header class="nav" id="nav"><div class="wrap"><a class="brand" href="/"><span class="mark"></span>wisp<span class="tag">Grid</span></a>
<nav class="links"><a href="#how">How it works</a><a href="#report">What you get back</a><a href="#private">Private by design</a></nav>
<div class="right"><a class="pill" href="https://trywisp.dev" target="_blank" rel="noopener">trywisp.dev</a><a class="pill dark" href="#join">Sign in</a></div></div></header>`;
}
const siteFoot = (cfg) => `<footer class="foot"><div class="wrap"><span>${esc(cfg.name)} · ${esc(cfg.domain)}</span><a href="https://trywisp.dev" target="_blank" rel="noopener">wisp</a><a href="https://github.com/M0xoo/wisp" target="_blank" rel="noopener">Open source (MIT)</a><a href="https://github.com/M0xoo/wisp/tree/main/grid" target="_blank" rel="noopener">Run your own grid</a></div></footer>
<script>addEventListener('scroll',()=>document.getElementById('nav').classList.toggle('scrolled',scrollY>8),{passive:true})</script></body></html>`;

const shot = (name, alt) => `<picture><source srcset="${A}/dark-${name}.webp" media="(prefers-color-scheme: dark)"><img src="${A}/light-${name}.webp" alt="${esc(alt)}" decoding="async"></picture>`;
const inviteOnly = (cfg) => cfg.auth.signup === 'closed' || Object.values(cfg.auth.allow || {}).some((v) => Array.isArray(v) && v.length);

function joinBox({ cfg, providers, ret = '', error = '', linking = false }) {
  const q = ret ? `?return=${encodeURIComponent(ret)}` : '';
  const list = [...providers.values()].sort((a, b) => (a.id === 'github' ? -1 : b.id === 'github' ? 1 : a.id === 'dev' ? 1 : 0));
  const buttons = list.map((p, i) => `<a class="btn${i === 0 ? ' first' : ''}" href="/auth/${encodeURIComponent(p.id)}/start${q}">${logo(p.id)}Continue with ${esc(p.label)}</a>`).join('');
  return `<div class="join" id="join">${error ? `<p class="err">${esc(error)}</p>` : ''}
    ${buttons || '<p class="err">No sign-in is set up on this grid yet. Its operator adds GitHub or Google in grid.json.</p>'}
    <div class="fine">${linking ? '<span>Sign in with it once; after that either one opens your account.</span>' : `<span>${I.check}Nothing to install</span><span>${I.check}Your own agent accounts</span><span>${I.check}${inviteOnly(cfg) ? 'Invite only' : 'Free while in preview'}</span>`}</div></div>`;
}

export function signInPage({ cfg, providers, ret = '', error = '', linking = false }) {
  const join = joinBox({ cfg, providers, ret, error, linking });
  return `${siteHead(`${cfg.name} · your agents keep working when your laptop closes`, cfg)}
<main>
<section class="hero"><div class="wrap">
  <div>
    <div class="kicker"><i></i>wisp Grid · ${esc(cfg.domain)}</div>
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
</div></section>

<div class="strip"><div class="wrap"><span class="l">Signs in with your own accounts</span><ul>
  ${AGENTS.map(([f, n, c]) => `<li><img src="${A}/${f}" alt="" class="${c}">${n}</li>`).join('')}<li>${I.github}GitHub</li></ul></div></div>

<section class="s" id="how"><div class="wrap">
  <p class="num">01 · HOW IT WORKS</p>
  <h2 class="t">Three minutes from here<br><span>to your first task.</span></h2>
  <div class="steps">
    <div class="step"><span class="k">1</span><h3>Sign in</h3><p>With GitHub or Google. You get your own wisp at <code>you.${esc(cfg.domain)}</code>, in a box nobody else can touch.</p><div class="chips"><span class="chip">${I.github}GitHub</span><span class="chip">${I.google}Google</span></div></div>
    <div class="step"><span class="k">2</span><h3>Connect your agents</h3><p>Sign in to Claude Code, Codex and GitHub from Settings → Agents: a link and a code, no terminal. Only what you sign in to shows up.</p><div class="chips">${AGENTS.slice(0, 2).map(([f, n]) => `<span class="chip"><img src="${A}/${f}" alt="">${n}</span>`).join('')}<span class="chip">${I.github}gh</span></div></div>
    <div class="step"><span class="k">3</span><h3>Send tasks from anywhere</h3><p>From the browser, from wisp on your computer (Settings → Cloud) or from the phone app. It sleeps when idle and wakes for you and your schedules.</p><div class="chips"><span class="chip">${I.globe}Browser</span><span class="chip">${I.laptop}Desktop</span><span class="chip">${I.phone}Phone</span></div></div>
  </div>
</div></section>

<section class="s" id="report"><div class="wrap">
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
</div></section>

<section class="band" id="private"><div class="wrap">
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
</div></section>

<section class="final"><div class="wrap">
  <h2>Leave the agents working.<br><span style="color:var(--faint)">Go have dinner.</span></h2>
  ${joinBox({ cfg, providers, ret })}
</div></section>
</main>
<script>
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
</script>
${siteFoot(cfg)}`;
}

export function devSignInPage({ cfg, ret = '', csrf }) {
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

// --- the app (signed in) ----------------------------------------------------------------------

const APP_CSS = `
:root{--bg:#fff;--bg-2:#f3f3f2;--surface:#fff;--surface-2:#f9f9f8;--ink:#171717;--ink-2:#3d3d3d;--muted:#6e6e6e;--faint:#a3a3a3;--line:#ebebea;--line-2:#dcdcda;--accent:#2f5bea;--accent-soft:rgba(47,91,234,.08);--good:#18794e;--warn:#a35c00;--bad:#cd2b31;
--shadow-2:0 1px 2px rgba(0,0,0,.04),0 10px 30px -12px rgba(0,0,0,.14);--sans:-apple-system,BlinkMacSystemFont,'SF Pro Text','Inter','Segoe UI',system-ui,sans-serif;--mono:ui-monospace,'SF Mono','JetBrains Mono',Menlo,Consolas,monospace;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#111;--bg-2:#1e1e1e;--surface:#171717;--surface-2:#1a1a1a;--ink:#ededed;--ink-2:#c7c7c7;--muted:#8f8f8f;--faint:#5e5e5e;--line:#262626;--line-2:#333;--accent:#6d8dff;--accent-soft:rgba(109,141,255,.12);--good:#4cc38a;--warn:#f0a33a;--bad:#ff6369;--shadow-2:0 1px 2px rgba(0,0,0,.3),0 10px 30px -12px rgba(0,0,0,.6);color-scheme:dark}img.mono{filter:invert(1)}}
*{box-sizing:border-box}html,body{margin:0}body{background:var(--bg);color:var(--ink);font:14px/1.5 var(--sans);-webkit-font-smoothing:antialiased}
a{color:inherit}p{margin:0}h1,h2,h3{margin:0;letter-spacing:-.01em}svg{flex:none}
.top{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:12px;height:56px;padding:0 24px;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:8px;font-weight:650;font-size:16px;text-decoration:none;letter-spacing:-.02em}
.mark{position:relative;width:13px;height:13px;border-radius:50%;background:var(--ink)}.mark::after{content:'';position:absolute;right:-4px;bottom:-2px;width:7px;height:7px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 2px var(--bg)}
.chipx{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:99px;border:1px solid var(--line-2);font-size:12.5px;color:var(--muted)}
.top .me{margin-left:auto;display:flex;align-items:center;gap:10px;font-size:13px;color:var(--muted)}
.av{width:26px;height:26px;border-radius:50%;background:var(--bg-2);display:grid;place-items:center;font-weight:600;font-size:12px;color:var(--ink);overflow:hidden}.av img{width:100%;height:100%}
.main{max-width:760px;margin:0 auto;padding:36px 24px 72px}
.h1{font-size:24px;font-weight:650;letter-spacing:-.02em}.sub{margin-top:4px;color:var(--muted)}
.primary{display:inline-flex;align-items:center;justify-content:center;gap:7px;height:36px;padding:0 15px;border-radius:10px;border:0;background:var(--ink);color:var(--bg);font:550 13.5px var(--sans);text-decoration:none;cursor:pointer}.primary:hover{opacity:.86}.primary svg{width:15px;height:15px}
.ghost{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 11px;border-radius:9px;border:1px solid transparent;background:transparent;color:var(--ink-2);font:500 13px var(--sans);text-decoration:none;cursor:pointer}.ghost:hover{background:var(--bg-2)}.ghost.danger{color:var(--bad)}.ghost.line{border-color:var(--line-2)}.ghost svg{width:14px;height:14px}
.hero{margin-top:22px;border:1px solid var(--line);border-radius:14px;overflow:hidden;background:var(--surface);box-shadow:var(--shadow-2)}
.hero .head{display:flex;align-items:center;gap:14px;padding:18px 20px}
.state{display:flex;align-items:center;gap:8px;font-weight:600}.state i{width:9px;height:9px;border-radius:50%;background:var(--faint)}
.state.running i{background:var(--good);box-shadow:0 0 0 4px color-mix(in srgb,var(--good) 18%,transparent)}.state.starting i,.state.stopping i{background:var(--warn);animation:blink 1.1s infinite}
@keyframes blink{50%{opacity:.35}}
.hero .detail{color:var(--muted);font-size:13px;margin-top:2px}.hero .acts{margin-left:auto;display:flex;gap:8px;align-items:center}
.peek{position:relative;display:block;height:220px;overflow:hidden;border-top:1px solid var(--line);background:var(--surface-2)}
.peek picture img{width:100%;display:block;transform-origin:top center;transform:scale(1);transition:transform .4s cubic-bezier(.25,.8,.25,1)}
.peek:hover picture img{transform:scale(1.02)}
.peek::after{content:'';position:absolute;inset:auto 0 0;height:90px;background:linear-gradient(transparent,var(--surface))}
.peek .go{position:absolute;z-index:2;left:50%;bottom:18px;transform:translateX(-50%)}
.url{display:inline-flex;align-items:center;gap:6px;font:12.5px var(--mono);color:var(--muted)}
h2.sec{margin:34px 0 10px;font-size:13px;font-weight:600;color:var(--muted)}
.group{border:1px solid var(--line);border-radius:12px;background:var(--surface-2)}
.r{display:flex;align-items:center;gap:12px;padding:12px 14px}.r+.r{border-top:1px solid var(--line)}
.r .ic{width:32px;height:32px;border-radius:9px;display:grid;place-items:center;background:var(--bg-2);color:var(--muted)}.r .ic svg,.r .ic img{width:17px;height:17px}
.r .tx{flex:1;min-width:0}.r .tx b{font-weight:600;font-size:13.5px}.r .tx small{display:block;color:var(--muted);font-size:12.5px;overflow:hidden;text-overflow:ellipsis}
.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.tile{padding:14px;border:1px solid var(--line);border-radius:12px;background:var(--surface-2)}.tile svg{width:18px;height:18px;color:var(--accent)}.tile b{display:block;margin-top:10px;font-size:13.5px}.tile p{margin-top:4px;color:var(--muted);font-size:12.5px}
.copy{margin-top:10px;display:flex;align-items:center;gap:6px;height:30px;padding:0 6px 0 10px;border-radius:8px;border:1px solid var(--line-2);background:var(--surface);font:12px var(--mono);cursor:pointer;width:100%}.copy span{flex:1;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.copy svg{width:13px;height:13px;color:var(--muted)}
.logos{display:flex;gap:6px;margin-top:10px}.logos img,.logos svg{width:16px;height:16px}
.flash{margin-top:18px;padding:10px 14px;border-radius:10px;border:1px solid var(--line-2);background:var(--surface-2);font-size:13.5px}.flash.bad{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 35%,var(--line))}
.foot{margin-top:40px;display:flex;gap:6px;flex-wrap:wrap}
.code{font:600 30px/1 var(--mono);letter-spacing:.14em;text-align:center;padding:22px;border:1px dashed var(--line-2);border-radius:12px;background:var(--surface-2);margin:18px 0}
.input{width:100%;height:40px;border-radius:10px;border:1px solid var(--line-2);background:var(--surface);color:var(--ink);padding:0 12px;font:15px var(--mono);letter-spacing:.08em;text-transform:uppercase}
.input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.narrow{max-width:440px}
.center{text-align:center}.orb{width:46px;height:46px;border-radius:50%;margin:10px auto 22px;background:radial-gradient(circle at 35% 35%,#c7d2fe,var(--accent) 60%,#1e3a8a);animation:pulse 1.6s ease-in-out infinite}
@keyframes pulse{0%,100%{transform:scale(.86);opacity:.75}50%{transform:scale(1);opacity:1}}
form.inline{display:inline}
@media (max-width:640px){.tiles{grid-template-columns:1fr}.hero .head{flex-wrap:wrap}.hero .acts{margin-left:0;width:100%}.top{padding:0 16px}.top .who{display:none}}
`;

function appPage({ cfg, title, user = null, csrf = '', body, head = '', narrow = false }) {
  const initial = esc((user?.name || user?.handle || '?').trim()[0]?.toUpperCase() || '?');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ${esc(cfg.name)}</title><meta name="referrer" content="same-origin"><link rel="icon" href="${A}/icon.svg"><style>${APP_CSS}</style>${head}</head><body>
<header class="top"><a class="brand" href="${esc(cfg.publicUrl)}/"><span class="mark"></span>wisp</a><span class="chipx">${I.cloud.replace('<svg', '<svg width="13" height="13"')}Grid</span>
${user ? `<div class="me"><span class="who">${esc(user.handle)}</span><span class="av">${user.avatar ? `<img src="${esc(user.avatar)}" alt="">` : initial}</span>${csrf ? `<form class="inline" method="post" action="/signout"><input type="hidden" name="csrf" value="${esc(csrf)}"><button class="ghost">Sign out</button></form>` : ''}</div>` : ''}</header>
<main class="main${narrow ? ' narrow' : ''}">${body}</main></body></html>`;
}

const STATE = { running: 'Running', starting: 'Waking up', stopping: 'Going to sleep', stopped: 'Asleep' };
const ago = (t) => {
  if (!t) return 'never';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toISOString().slice(0, 10);
};

export function accountPage({ cfg, user, instance, devices, identities, providers, csrf, flash: msg = '', tone = '' }) {
  const st = instance.state;
  const url = cfg.instanceUrl(user.handle);
  const linked = new Set(identities.map((i) => i.provider));
  const canLink = [...providers.values()].filter((p) => !linked.has(p.id) && p.id !== 'dev');
  const detail =
    st === 'running'
      ? `Up since ${ago(instance.started_at)} · sleeps when nothing’s going on`
      : instance.stopped_at
        ? `Since ${ago(instance.stopped_at)}${instance.stop_reason ? ` (${esc(instance.stop_reason)})` : ''} · wakes in seconds when you open it`
        : 'Starts the first time you open it, in a few seconds';
  const copyBtn = (v, label) => `<button class="copy" type="button" data-copy="${esc(v)}" title="Copy"><span>${esc(label || v)}</span>${I.copy}</button>`;
  return appPage({
    cfg,
    title: 'Your wisp',
    user,
    csrf,
    head: st === 'starting' || st === 'stopping' ? '<meta http-equiv="refresh" content="2">' : '',
    body: `${msg ? `<div class="flash ${tone}">${esc(msg)}</div>` : ''}
      <h1 class="h1">Hi ${esc((user.name || user.handle).split(' ')[0])}</h1>
      <p class="sub">Your wisp lives at <a class="url" href="/go">${esc(url.replace(/^https?:\/\//, ''))}</a></p>
      <div class="hero">
        <div class="head">
          <div><div class="state ${esc(st)}"><i></i>${STATE[st] || esc(st)}</div><div class="detail">${detail}${instance.next_wake_at ? ` · next schedule ${new Date(instance.next_wake_at).toLocaleString()}` : ''}</div></div>
          <div class="acts">
            ${st === 'running' ? `<form class="inline" method="post" action="/instance/stop"><input type="hidden" name="csrf" value="${esc(csrf)}"><button class="ghost line">${I.moon}Put to sleep</button></form>` : ''}
            <a class="primary" href="/go">Open wisp${I.arrow}</a>
          </div>
        </div>
        <a class="peek" href="/go" aria-label="Open wisp"><picture><source srcset="${A}/dark-app.webp" media="(prefers-color-scheme: dark)"><img src="${A}/light-app.webp" alt=""></picture></a>
      </div>

      <h2 class="sec">Use it everywhere</h2>
      <div class="tiles">
        <div class="tile">${I.globe}<b>Any browser</b><p>Open it from any computer. You sign in once per browser.</p>${copyBtn(url, url.replace(/^https?:\/\//, ''))}</div>
        <div class="tile">${I.laptop}<b>wisp on your computer</b><p>Settings → Cloud → Sign in with this address. It shows up under Machines.</p>${copyBtn(new URL(cfg.publicUrl).host)}</div>
        <div class="tile">${I.phone}<b>The phone app</b><p>Sign in to wisp Cloud, then this address. Answer your agents from anywhere.</p>${copyBtn(new URL(cfg.publicUrl).host)}</div>
      </div>

      <h2 class="sec">Connect your agents</h2>
      <div class="group"><div class="r"><span class="ic">${I.key}</span><div class="tx"><b>Sign in to Claude Code, Codex and GitHub</b><small>In your wisp: Settings → Agents → Sign in. A link and a code, no terminal; the logins stay in your box.</small><div class="logos">${AGENTS.slice(0, 2).map(([f]) => `<img src="${A}/${f}" alt="">`).join('')}${I.github}</div></div><a class="ghost line" href="/go">Open${I.arrow}</a></div></div>

      <h2 class="sec">Devices</h2>
      <div class="group">${
        devices.length
          ? devices
              .map(
                (d) => `<div class="r"><span class="ic">${/phone/i.test(d.name) ? I.phone : I.laptop}</span><div class="tx"><b>${esc(d.name)}</b><small>Added ${ago(d.created_at)} · last used ${ago(d.last_seen_at)}</small></div>
            <form class="inline" method="post" action="/devices/${esc(d.id)}/revoke"><input type="hidden" name="csrf" value="${esc(csrf)}"><button class="ghost danger">Remove</button></form></div>`,
              )
              .join('')
          : `<div class="r"><span class="ic">${I.laptop}</span><div class="tx"><b>No devices yet</b><small>wisp on your computer and the phone app sign in here once, with a code.</small></div></div>`
      }</div>

      <h2 class="sec">How you sign in</h2>
      <div class="group">${identities
        .map(
          (i) => `<div class="r"><span class="ic">${logo(i.provider)}</span><div class="tx"><b>${esc(providers.get(i.provider)?.label || i.provider)}</b><small>${esc(i.login || i.email || '')}</small></div>
          ${identities.length > 1 ? `<form class="inline" method="post" action="/identities/unlink"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="provider" value="${esc(i.provider)}"><button class="ghost">Disconnect</button></form>` : ''}</div>`,
        )
        .join('')}
        ${canLink.map((p) => `<div class="r"><span class="ic">${logo(p.id)}</span><div class="tx"><b>${esc(p.label)}</b><small>Connect it too, and either one signs you in</small></div><a class="ghost line" href="/auth/${encodeURIComponent(p.id)}/start?link=1">Connect</a></div>`).join('')}
      </div>
      <div class="foot"><form class="inline" method="post" action="/signout?all=1"><input type="hidden" name="csrf" value="${esc(csrf)}"><button class="ghost">Sign out everywhere</button></form></div>
      <script>document.addEventListener('click',async(e)=>{const b=e.target.closest('[data-copy]');if(!b)return;try{await navigator.clipboard.writeText(b.dataset.copy);const s=b.querySelector('span'),t=s.textContent;s.textContent='Copied';setTimeout(()=>s.textContent=t,1200)}catch{}})</script>`,
  });
}

// Opens the Android app (its intent filter in mobile/android/…/AndroidManifest.xml).
export const APP_URL = 'dev.trywisp.mobile://signed-in';

export function activatePage({ cfg, user, code = '', device = null, app = false, csrf, error = '' }) {
  if (!device)
    return appPage({
      cfg,
      title: 'Connect a device',
      user,
      csrf,
      narrow: true,
      body: `<h1 class="h1">Connect a device</h1><p class="sub">Type the code wisp shows on your computer or phone.</p>${error ? `<div class="flash bad">${esc(error)}</div>` : ''}
        <form method="get" action="/activate" style="margin-top:20px;display:flex;flex-direction:column;gap:10px"><input class="input" name="code" value="${esc(code)}" placeholder="ABCD-EFGH" autocomplete="off" autocapitalize="characters" autofocus required>${app ? '<input type="hidden" name="app" value="android">' : ''}
        <button class="primary" style="height:40px">Continue</button></form>`,
    });
  return appPage({
    cfg,
    title: 'Connect a device',
    user,
    csrf,
    narrow: true,
    body: `<h1 class="h1">Let this device in?</h1>
      <p class="sub"><b>${esc(device.name)}</b> asks to use your wisp as <b>${esc(user.handle)}</b>. Allow it only if you just started this on your own computer or phone, and the code matches.</p>
      <div class="code">${esc(device.user_code)}</div>
      <form method="post" action="/activate" style="display:flex;gap:10px">
        <input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="code" value="${esc(device.user_code)}">${app ? '<input type="hidden" name="app" value="android">' : ''}
        <button class="ghost line" style="flex:1;justify-content:center;height:40px" name="answer" value="deny">Don’t allow</button>
        <button class="primary" style="flex:1;height:40px" name="answer" value="allow">Allow</button>
      </form>`,
  });
}

export function messagePage({ cfg, title, text, link = null, tone = '' }) {
  return appPage({
    cfg,
    title,
    narrow: true,
    body: `<h1 class="h1">${esc(title)}</h1>${tone ? `<div class="flash ${tone}">${esc(text)}</div>` : `<p class="sub">${esc(text)}</p>`}${link ? `<p style="margin-top:20px"><a class="primary" href="${esc(link[0])}">${esc(link[1])}</a></p>` : ''}`,
  });
}

// Shown at <handle>.<domain> while its wisp starts; reloads itself once it answers.
export function wakingPage({ cfg, user }) {
  return appPage({
    cfg,
    title: 'Waking up',
    narrow: true,
    body: `<div class="center" style="padding-top:48px"><div class="orb"></div><h1 class="h1">Waking your wisp</h1><p class="sub" id="msg">${esc(user.handle)}’s computer was asleep. A few seconds.</p></div>
      <script>(async function poll(n){try{const r=await fetch('/_grid/state',{cache:'no-store'});const j=await r.json();if(j.state==='running')return location.reload();if(j.error)document.getElementById('msg').textContent=j.error;}catch{}setTimeout(()=>poll(n+1),n<20?700:2000)})(0)</script>`,
  });
}
