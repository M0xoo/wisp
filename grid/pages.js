// The grid's own pages: sign in, your account (your cloud computer, devices, linked accounts),
// approve a device, the "waking up" page, errors. Server-rendered, no build, no scripts beyond a
// few lines; every form posts with a CSRF token.

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const LOGOS = {
  github: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.04-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.04 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.58.23 2.75.11 3.04.74.81 1.19 1.83 1.19 3.09 0 4.41-2.7 5.38-5.26 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z"/></svg>',
  google: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M23.5 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.45a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.57-5.17 3.57-8.81Z"/><path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.94-2.9l-3.88-3.01c-1.07.72-2.45 1.15-4.06 1.15-3.13 0-5.78-2.11-6.72-4.95H1.27v3.11A12 12 0 0 0 12 24Z"/><path fill="#FBBC05" d="M5.28 14.29a7.2 7.2 0 0 1 0-4.58V6.6H1.27a12 12 0 0 0 0 10.8l4.01-3.11Z"/><path fill="#EA4335" d="M12 4.77c1.76 0 3.34.61 4.59 1.8l3.44-3.44A11.97 11.97 0 0 0 12 0 12 12 0 0 0 1.27 6.6l4.01 3.11C6.22 6.88 8.87 4.77 12 4.77Z"/></svg>',
  oidc: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 12h8M12 8v8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  dev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 8l-4 4 4 4M16 8l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
const logo = (id) => LOGOS[id] || LOGOS[id.split(':')[0]] || LOGOS.oidc;

const CSS = `
:root{--bg:#fafaf9;--card:#fff;--ink:#1c1917;--muted:#78716c;--line:#e7e5e4;--line-2:#d6d3d1;--accent:#4f46e5;--accent-ink:#fff;--good:#15803d;--bad:#b91c1c;--warn:#b45309;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#111110;--card:#1a1918;--ink:#f5f5f4;--muted:#a8a29e;--line:#292524;--line-2:#3a3633;--accent:#818cf8;--accent-ink:#0b0b12;--good:#4ade80;--bad:#f87171;--warn:#fbbf24}}
*{box-sizing:border-box}html,body{margin:0}body{background:var(--bg);color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:56px 18px}
a{color:var(--accent)}.wrap{width:100%;max-width:560px}.narrow{max-width:400px}
.brand{display:flex;align-items:center;gap:10px;font-weight:650;font-size:15px;margin-bottom:28px;color:var(--ink);text-decoration:none}.brand i{width:22px;height:22px;border-radius:50%;background:radial-gradient(circle at 35% 35%,#c7d2fe,var(--accent) 60%,#312e81);box-shadow:0 0 18px color-mix(in srgb,var(--accent) 40%,transparent)}
h1{font-size:26px;line-height:1.2;margin:0 0 8px;letter-spacing:-.01em}h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:30px 0 10px;font-weight:600}
p{margin:0 0 14px}.muted{color:var(--muted)}.small{font-size:13px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px}
.stack{display:flex;flex-direction:column;gap:10px}.row{display:flex;align-items:center;gap:10px}.grow{flex:1;min-width:0}
.btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:9px;height:40px;padding:0 16px;border-radius:10px;border:1px solid var(--line-2);background:var(--card);color:var(--ink);font:inherit;font-weight:550;text-decoration:none;cursor:pointer;white-space:nowrap}
.btn:hover{border-color:var(--muted)}.btn svg{width:18px;height:18px}.btn.wide{width:100%;height:46px}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}.btn.primary:hover{filter:brightness(1.08)}
.btn.danger{color:var(--bad)}.btn.sm{height:32px;padding:0 12px;font-size:13px;border-radius:8px}
.input{width:100%;height:42px;border-radius:10px;border:1px solid var(--line-2);background:var(--bg);color:var(--ink);padding:0 12px;font:inherit}
label.f{display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--muted)}
.pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;padding:3px 9px;border-radius:99px;border:1px solid var(--line-2)}
.pill i{width:7px;height:7px;border-radius:50%;background:var(--muted)}.pill.running i{background:var(--good);box-shadow:0 0 0 3px color-mix(in srgb,var(--good) 25%,transparent)}.pill.starting i,.pill.stopping i{background:var(--warn)}
.list{border:1px solid var(--line);border-radius:14px;background:var(--card)}.list>div{display:flex;align-items:center;gap:12px;padding:12px 16px;border-top:1px solid var(--line)}.list>div:first-child{border-top:0}
.ico{width:34px;height:34px;border-radius:9px;border:1px solid var(--line);display:grid;place-items:center;flex:none}.ico svg{width:18px;height:18px}
.code{font:600 30px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em;text-align:center;padding:18px;border:1px dashed var(--line-2);border-radius:12px;background:var(--bg);margin:6px 0 16px}
.flash{padding:10px 14px;border-radius:10px;border:1px solid var(--line-2);margin-bottom:18px;font-size:14px}.flash.bad{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 35%,var(--line))}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}.url{word-break:break-all}
.foot{margin-top:36px;font-size:12px;color:var(--muted);text-align:center}
.spin{width:44px;height:44px;border-radius:50%;margin:8px auto 22px;background:radial-gradient(circle at 35% 35%,#c7d2fe,var(--accent) 60%,#312e81);animation:pulse 1.6s ease-in-out infinite}
@keyframes pulse{0%,100%{transform:scale(.86);opacity:.75}50%{transform:scale(1);opacity:1}}
form.inline{display:inline}
`;

export function layout({ title, body, narrow = false, name = 'wisp Grid', home = '/', head = '' }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ${esc(name)}</title><meta name="referrer" content="same-origin"><style>${CSS}</style>${head}</head>
<body><main class="wrap${narrow ? ' narrow' : ''}"><a class="brand" href="${esc(home)}"><i></i>${esc(name)}</a>${body}</main>
<p class="foot">Runs <a href="https://trywisp.dev" target="_blank" rel="noopener">wisp</a>, open source (MIT).</p></body></html>`;
}

const flash = (msg, tone = '') => (msg ? `<div class="flash ${tone}">${esc(msg)}</div>` : '');

export function signInPage({ cfg, providers, ret = '', error = '', linking = false }) {
  const q = ret ? `?return=${encodeURIComponent(ret)}` : '';
  const buttons = [...providers.values()]
    .map((p) => `<a class="btn wide${p.id === 'dev' ? '' : ''}" href="/auth/${encodeURIComponent(p.id)}/start${q}">${logo(p.id)}Continue with ${esc(p.label)}</a>`)
    .join('');
  return layout({
    title: 'Sign in',
    name: cfg.name,
    narrow: true,
    body: `<h1>${linking ? 'Connect another account' : 'Sign in'}</h1>
      <p class="muted">${linking ? 'Sign in with it once; after that either one opens your account.' : 'Your own wisp, running here: start tasks from any device and they keep going when you close the lid.'}</p>
      ${flash(error, 'bad')}
      <div class="stack" style="margin-top:22px">${buttons || '<p class="flash bad">No sign-in is set up on this grid yet. Its operator adds Google or GitHub in grid.json.</p>'}</div>`,
  });
}

export function devSignInPage({ cfg, ret = '', csrf }) {
  return layout({
    title: 'Dev sign-in',
    name: cfg.name,
    narrow: true,
    body: `<h1>Dev sign-in</h1><p class="muted">Only on a development grid (<span class="mono">wisp grid dev</span>): any email, no password.</p>
      <form method="post" action="/auth/dev/callback" class="stack" style="margin-top:18px">
        <input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="return" value="${esc(ret)}">
        <label class="f">Email<input class="input" name="email" type="email" required autofocus placeholder="ada@example.com"></label>
        <label class="f">Name <input class="input" name="name" placeholder="Ada"></label>
        <button class="btn primary wide" type="submit">Sign in</button>
      </form>`,
  });
}

const STATE = { running: 'Running', starting: 'Starting', stopping: 'Stopping', stopped: 'Asleep' };
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
  const linked = new Set(identities.map((i) => i.provider));
  const canLink = [...providers.values()].filter((p) => !linked.has(p.id) && p.id !== 'dev');
  return layout({
    title: 'Your wisp',
    name: cfg.name,
    head: st === 'starting' || st === 'stopping' ? '<meta http-equiv="refresh" content="2">' : '',
    body: `${flash(msg, tone)}
      <h1>Hi ${esc(user.name || user.handle)}</h1>
      <p class="muted">Your wisp lives at <a class="mono url" href="/go">${esc(cfg.instanceUrl(user.handle))}</a>. It sleeps when nothing's going on and wakes when you open it, or when a scheduled task is due.</p>
      <div class="card" style="margin-top:20px">
        <div class="row"><div class="grow"><b>Your cloud computer</b><div class="small muted">${st === 'running' ? `Up since ${ago(instance.started_at)}` : instance.stopped_at ? `Asleep since ${ago(instance.stopped_at)}${instance.stop_reason ? ` (${esc(instance.stop_reason)})` : ''}` : 'Starts the first time you open it'}${instance.next_wake_at ? ` · next scheduled task ${new Date(instance.next_wake_at).toLocaleString()}` : ''}</div></div>
          <span class="pill ${esc(st)}"><i></i>${STATE[st] || esc(st)}</span></div>
        <div class="row" style="margin-top:16px">
          <a class="btn primary" href="/go">Open wisp</a>
          ${st === 'running' ? `<form class="inline" method="post" action="/instance/stop"><input type="hidden" name="csrf" value="${esc(csrf)}"><button class="btn">Put to sleep</button></form>` : ''}
        </div>
      </div>
      <h2>Devices</h2>
      <p class="small muted">wisp on your computers and phone signs in here once. Remove one you don’t use any more.</p>
      <div class="list">${
        devices.length
          ? devices
              .map(
                (d) => `<div><span class="ico">${LOGOS.dev}</span><div class="grow"><b>${esc(d.name)}</b><div class="small muted">Added ${ago(d.created_at)} · last used ${ago(d.last_seen_at)}</div></div>
            <form class="inline" method="post" action="/devices/${esc(d.id)}/revoke"><input type="hidden" name="csrf" value="${esc(csrf)}"><button class="btn sm danger">Remove</button></form></div>`,
              )
              .join('')
          : '<div class="muted small">None yet. In wisp on your computer: Settings → Cloud → Sign in. In the phone app: Add a computer → wisp Cloud.</div>'
      }</div>
      <h2>Sign-in</h2>
      <div class="list">${identities
        .map(
          (i) => `<div><span class="ico">${logo(i.provider)}</span><div class="grow"><b>${esc(providers.get(i.provider)?.label || i.provider)}</b><div class="small muted">${esc(i.login || i.email || '')}</div></div>
          ${identities.length > 1 ? `<form class="inline" method="post" action="/identities/unlink"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="provider" value="${esc(i.provider)}"><button class="btn sm">Disconnect</button></form>` : ''}</div>`,
        )
        .join('')}
        ${canLink.map((p) => `<div><span class="ico">${logo(p.id)}</span><div class="grow muted">${esc(p.label)}</div><a class="btn sm" href="/auth/${encodeURIComponent(p.id)}/start?link=1">Connect</a></div>`).join('')}
      </div>
      <div class="row" style="margin-top:28px">
        <form class="inline" method="post" action="/signout"><input type="hidden" name="csrf" value="${esc(csrf)}"><button class="btn">Sign out</button></form>
        <form class="inline" method="post" action="/signout?all=1"><input type="hidden" name="csrf" value="${esc(csrf)}"><button class="btn">Sign out everywhere</button></form>
      </div>`,
  });
}

export function activatePage({ cfg, user, code = '', device = null, csrf, error = '' }) {
  if (!device)
    return layout({
      title: 'Connect a device',
      name: cfg.name,
      narrow: true,
      body: `<h1>Connect a device</h1><p class="muted">Type the code wisp shows on your computer or phone.</p>${flash(error, 'bad')}
        <form method="get" action="/activate" class="stack"><input class="input mono" name="code" value="${esc(code)}" placeholder="ABCD-EFGH" autocomplete="off" autocapitalize="characters" autofocus required>
        <button class="btn primary wide">Continue</button></form>`,
    });
  return layout({
    title: 'Connect a device',
    name: cfg.name,
    narrow: true,
    body: `<h1>Let this device in?</h1>
      <p class="muted"><b>${esc(device.name)}</b> asks to use your wisp as <b>${esc(user.handle)}</b>. Only allow it if you just started this from your own computer or phone, and the code matches.</p>
      <div class="code">${esc(device.user_code)}</div>
      <form method="post" action="/activate" class="row">
        <input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="code" value="${esc(device.user_code)}">
        <button class="btn grow" name="answer" value="deny">Don’t allow</button>
        <button class="btn primary grow" name="answer" value="allow">Allow</button>
      </form>`,
  });
}

export function messagePage({ cfg, title, text, link = null, tone = '' }) {
  return layout({ title, name: cfg.name, narrow: true, body: `<h1>${esc(title)}</h1>${tone ? flash(text, tone) : `<p class="muted">${esc(text)}</p>`}${link ? `<a class="btn primary" href="${esc(link[0])}">${esc(link[1])}</a>` : ''}` });
}

// Shown at <handle>.<domain> while its wisp starts; reloads itself once it answers.
export function wakingPage({ cfg, user }) {
  return layout({
    title: 'Waking up',
    name: cfg.name,
    home: cfg.publicUrl,
    narrow: true,
    body: `<div style="text-align:center"><div class="spin"></div><h1>Waking your wisp</h1><p class="muted" id="msg">${esc(user.handle)}’s computer was asleep. This takes a few seconds.</p></div>
      <script>(async function poll(n){try{const r=await fetch('/_grid/state',{cache:'no-store'});const j=await r.json();if(j.state==='running')return location.reload();if(j.error)document.getElementById('msg').textContent=j.error;}catch{}setTimeout(()=>poll(n+1),n<20?700:2000)})(0)</script>`,
  });
}
