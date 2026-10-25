// wisp site: the hero's night shift, the transcript/report switch, the terminal, and small things.

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
const small = () => matchMedia('(max-width: 960px)').matches;

// ---------- copy buttons ----------
// Delegated: the nav's Get wisp menu adds its copy rows later.
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  {
    const label = $('.copy', btn);
    try {
      await navigator.clipboard.writeText(btn.dataset.copy);
      btn.classList.add('copied');
      if (label) label.textContent = 'Copied';
      window.posthog?.capture?.('install_copied', { method: btn.dataset.copy.split(' ')[0] });
    } catch {
      if (label) label.textContent = 'Select';
    }
    setTimeout(() => {
      btn.classList.remove('copied');
      if (label) label.textContent = 'Copy';
    }, 1600);
  }
});

// ---------- wisp Cloud seats ----------
// The preview opens seats as its server shows room for them. No count: just, once they're all
// taken, say so and send people to the waitlist instead of a sign-in that turns them away.
const cloudLinks = $$('[data-cloud-cta]');
for (const a of cloudLinks) {
  a.addEventListener('click', () => {
    window.posthog?.capture?.('cloud_cta_clicked', { where: a.dataset.cloudCta, full: a.dataset.full === '1' }, { transport: 'sendBeacon' });
  });
}
if (cloudLinks.length) {
  fetch('https://grid.trywisp.dev/api/seats', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((s) => {
      if (!s?.max || s.invite || !s.open) return;
      if (s.left !== 0) return;
      for (const n of $$('[data-seats-full]')) n.textContent = n.dataset.seatsFull;
      for (const a of cloudLinks) {
        a.href = 'cloud.html#join';
        a.dataset.full = '1';
        a.setAttribute('aria-label', 'Join the wisp Cloud waitlist');
      }
      for (const n of $$('[data-seats-cta]')) n.textContent = n.dataset.seatsCta;
    })
    .catch(() => {});
}

// ---------- downloads ----------
// The desktop app from the latest GitHub release (the file names carry no version). The Download
// tab offers the build for this visitor's OS with what to expect on first open, since the builds
// aren't signed yet. On a Mac it's the curl install: curl doesn't quarantine what it downloads, so
// macOS opens it without the "can't verify" warning a browser download of the .dmg gets.
const DL = 'https://github.com/M0xoo/wisp/releases/latest/download/';
const MAC_APP = 'curl -fsSL https://trywisp.dev/install.sh | bash -s -- --app';
const BUILDS = {
  mac: ['macOS', 'wisp-mac-arm64.dmg'],
  'mac-x64': ['macOS', 'wisp-mac-x64.dmg'],
  win: ['Windows', 'wisp-windows-x64-setup.exe'],
  'win-arm64': ['Windows', 'wisp-windows-arm64-setup.exe'],
  linux: ['Linux', 'wisp-linux-x64.deb'],
  'linux-arm64': ['Linux', 'wisp-linux-arm64.deb'],
};
const osKey = () => {
  const p = `${navigator.userAgentData?.platform || ''} ${navigator.platform || ''} ${navigator.userAgent}`;
  return /Win/i.test(p) ? 'win' : /Linux|X11|CrOS/i.test(p) && !/Android/i.test(p) ? 'linux' : 'mac';
};
// Most Macs are Apple silicon and Safari can't tell (the curl install picks for itself); Chromium says.
const os = osKey();
let build = os;
const file = (k = build) => DL + BUILDS[k][1];
const link = (href, text) => `<a href="${href}">${text}</a>`;
const others = () => ['mac', 'win', 'linux'].filter((k) => k !== os).map((k) => link(file(k), BUILDS[k][0])).join(', ');
const appNote = () =>
  ({
    mac: `No Node needed · or the ${link(file(), '.dmg')}: allow it in Privacy &amp; Security → Open Anyway · Also for ${others()}`,
    win: `No Node needed · if Windows says it protected your PC: More info → Run anyway · Also for ${others()}`,
    linux: `No Node needed · Debian and Ubuntu, or the ${link(file().replace('.deb', '.AppImage'), 'AppImage')} · Also for ${others()}`,
  })[os];
const paintDownloads = () => {
  for (const a of $$('[data-tab-dl]')) {
    a.href = file();
    $('[data-dl-label]', a).textContent = `Download for ${BUILDS[build][0]}`;
    $('[data-dl-kind]', a).textContent = file().slice(file().lastIndexOf('.'));
  }
};
navigator.userAgentData
  ?.getHighEntropyValues?.(['architecture'])
  .then(({ architecture }) => {
    if (architecture === 'arm' && os !== 'mac') build = `${os}-arm64`;
    if (architecture === 'x86' && os === 'mac') build = 'mac-x64';
    paintDownloads();
    if (getMenu) paintGetMenu();
    for (const t of tabBoxes) t.refresh();
  })
  .catch(() => {});
paintDownloads();
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="' + DL + '"]');
  if (a) window.posthog?.capture?.('download_clicked', { file: a.href.slice(DL.length) }, { transport: 'sendBeacon' });
});

// ---------- install tabs ----------
// The hero and the install section each have npx / npm / curl / brew / Download tabs. Picking one
// updates the command, its copy button and the note (Download shows the app's link instead, or
// on a Mac the curl install), and the other box follows. A box with data-task set (the hero, once the visitor typed a task) shows
// the command that installs wisp and starts that task, so it leaves Download for npx.
const tabBoxes = $$('[data-tabs]').map((box) => {
  const tabs = $$('[role="tab"]', box);
  const code = $('[data-tab-code]', box);
  const copy = $('[data-tab-copy]', box);
  const dl = $('[data-tab-dl]', box);
  const note = $('[data-tab-note]', box) || $('[data-tab-note]', box.parentElement);
  const panel = $('[role="tabpanel"]', box);
  let current = tabs.find((t) => t.getAttribute('aria-selected') === 'true') || tabs[0];
  const commandFor = (tab) => {
    const task = box.dataset.task;
    if (!task) return tab.dataset.cmd;
    return tab.dataset.tab === 'npx' ? `npx wisp-agents "${task}"` : `${tab.dataset.cmd} && wisp "${task}"`;
  };
  const pick = (tab, focus) => {
    if (tab.dataset.tab === 'app' && box.dataset.task) tab = tabs.find((t) => t.dataset.tab === 'npx');
    current = tab;
    const app = tab.dataset.tab === 'app' && os !== 'mac'; // a link; the Mac's is a command
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', on);
      t.tabIndex = on ? 0 : -1;
    }
    dl.hidden = !app;
    copy.hidden = app;
    code.hidden = app && !copy.contains(code);
    if (!app) code.textContent = copy.dataset.copy = tab.dataset.tab === 'app' ? MAC_APP : commandFor(tab);
    if (note && !box.dataset.task) {
      if (tab.dataset.tab === 'app') note.innerHTML = appNote();
      else note.textContent = tab.dataset.note;
    }
    panel.setAttribute('aria-labelledby', tab.id);
    if (focus) tab.focus();
  };
  const choose = (tab, focus) => {
    pick(tab, focus);
    for (const other of tabBoxes) if (other.box !== box) other.show(tab.dataset.tab);
  };
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => {
      choose(tab);
    });
    tab.addEventListener('keydown', (e) => {
      const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
      if (!step && e.key !== 'Home' && e.key !== 'End') return;
      e.preventDefault();
      const n = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + step + tabs.length) % tabs.length;
      choose(tabs[n], true);
    });
  });
  return {
    box,
    show: (name) => {
      const tab = tabs.find((t) => t.dataset.tab === name);
      if (tab) pick(tab);
    },
    refresh: () => {
      pick(current);
    },
  };
});

// ---------- Get wisp (nav) ----------
// Once the hero's install box scrolls away, the nav offers every way in: a menu with each
// command to copy and this OS's download (on a Mac, the curl install), like the hero's tabs.
const getBtn = $('#getBtn');
const getMenu = $('#getMenu');
const attr = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const paintGetMenu = () => {
  const rows = $$('#deskCta [role="tab"]').map((t) => {
    const name = t.textContent.trim();
    if (t.dataset.tab !== 'app') return { name, cmd: t.dataset.cmd };
    if (os === 'mac') return { name: 'Mac app', cmd: MAC_APP };
    return { name: BUILDS[build][0], href: file(), label: file().slice(file().lastIndexOf('/') + 1) };
  });
  getMenu.innerHTML =
    rows
      .map((r) =>
        r.href
          ? `<a class="gm-row" role="menuitem" href="${r.href}"><b>${r.name}</b><code>${attr(r.label)}</code><span class="copy">Download</span></a>`
          : `<button class="gm-row" role="menuitem" data-copy="${attr(r.cmd)}"><b>${r.name}</b><code>${attr(r.cmd)}</code><span class="copy">Copy</span></button>`,
      )
      .join('') + '<a class="gm-foot" role="menuitem" href="#install">Every option, and what to expect on first open</a>';
};
const openGet = (open) => {
  getMenu.hidden = !open;
  getBtn.setAttribute('aria-expanded', open);
  if (open) $('.gm-row', getMenu)?.focus();
};
if (getBtn) {
  paintGetMenu();
  getBtn.addEventListener('click', () => {
    openGet(getMenu.hidden);
  });
  getMenu.addEventListener('click', (e) => {
    if (e.target.closest('a')) openGet(false); // a download or #install; copy rows stay open to show Copied
  });
  document.addEventListener('click', (e) => {
    if (!getMenu.hidden && !e.target.closest('#navGet')) openGet(false);
  });
  getMenu.addEventListener('keydown', (e) => {
    const items = $$('[role="menuitem"]', getMenu);
    const i = items.indexOf(document.activeElement);
    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (step) {
      e.preventDefault();
      items[(i + step + items.length) % items.length].focus();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !getMenu.hidden) {
      openGet(false);
      getBtn.focus();
    }
  });
}

// ---------- reveal once ----------
const io = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add('in');
      io.unobserve(e.target);
    }
  },
  { rootMargin: '0px 0px -10% 0px' },
);
$$('.h-head > *, .h-stage, .strip, .r-head, .c-head, .cmp-shot, .cli-text, .term-win, .more, .install h2, .install .sub, .steps li, .faq, .final h2, .final .cta').forEach((el, i) => {
  el.classList.add('rise');
  if (el.closest('.hero')) el.style.transitionDelay = `${i * 80}ms`;
  if (el.matches('.steps li')) el.style.transitionDelay = `${[...el.parentElement.children].indexOf(el) * 90}ms`;
  io.observe(el);
});

// ---------- hero: the second line, and the night shift ----------
// The headline's second line cycles through what the agents get up to. Under it, one night with
// wisp plays back once it's on screen: the clock runs from midnight to 07:30, the six tasks finish
// at their times (one stops to ask), the flaky-test report fills in, and morning says hello. The
// markup is the morning, so without JS (or with reduced motion) that's what shows.
const rot = $('.h-rot');
if (rot && !calm) {
  const lines = rot.dataset.rot.split('|');
  let i = 0;
  setInterval(() => {
    if (document.hidden) return;
    rot.classList.remove('in');
    rot.classList.add('out');
    setTimeout(() => {
      i = (i + 1) % lines.length;
      rot.textContent = lines[i];
      rot.classList.remove('out');
      void rot.offsetWidth;
      rot.classList.add('in');
    }, 340);
  }, 3000);
}

const night = $('#night');
if (night) {
  const rows = $$('.h-row', night);
  const clock = $('[data-hclock]', night);
  const count = $('[data-count]', night);
  const report = $('.h-report', night);
  const replay = $('[data-replay]', night);
  const MOOD = { live: 'live', asks: 'asks', done: 'idle' };
  // The faces are the app's spirits (spirit.js, copied in by scripts/site.mjs); until it loads a
  // face is its tinted circle, the same size, so the row doesn't change shape when it arrives.
  let spirits = null;
  const face = (row) => {
    const f = $('[data-face]', row);
    if (f && spirits) f.innerHTML = spirits.spiritSvg(f.dataset.face, { state: MOOD[row.dataset.s], small: true });
  };
  import('./spirit.js')
    .then((m) => {
      spirits = m;
      rows.forEach(face);
    })
    .catch(() => {});

  const mins = (t) => t.split(':').reduce((h, m) => h * 60 + Number(m));
  const fmt = (m) => {
    m = Math.floor((m + 1440) % 1440);
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  };
  const START = -12;
  const END = mins('07:30');
  const RUN = 9000;
  for (const r of rows) r.dataset.final = r.dataset.s;

  const tally = () => {
    const n = (s) => rows.filter((r) => r.dataset.s === s).length;
    count.textContent = [[n('live'), 'working'], [n('done'), 'done'], [n('asks'), 'needs you']]
      .filter(([k]) => k)
      .map(([k, w]) => `${k} ${w}`)
      .join(' · ');
  };
  const set = (row, s, swap) => {
    row.dataset.s = s;
    const sub = $('small', row);
    sub.textContent = s === 'live' ? sub.dataset.live : sub.dataset.done;
    if (swap) {
      for (const el of [sub, row]) el.classList.remove(el === sub ? 'swap' : 'pop');
      void row.offsetWidth;
      sub.classList.add('swap');
      row.classList.add('pop');
    }
    face(row);
  };
  const reset = () => {
    for (const r of rows) set(r, 'live');
    report.dataset.show = '0';
    night.classList.remove('morning');
    clock.textContent = fmt(START);
    replay.hidden = true;
    tally();
  };
  let raf = 0;
  const play = () => {
    cancelAnimationFrame(raf);
    reset();
    const t0 = performance.now();
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / RUN);
      const m = START + (END - START) * p;
      clock.textContent = fmt(m);
      for (const r of rows) {
        if (r.dataset.s !== 'live' || mins(r.dataset.at) > m) continue;
        set(r, r.dataset.final, true);
        if (r.hasAttribute('data-report')) report.dataset.show = '1';
        tally();
      }
      if (p < 1) raf = requestAnimationFrame(tick);
      else {
        night.classList.add('morning');
        replay.hidden = false;
      }
    };
    raf = requestAnimationFrame(tick);
  };
  replay.addEventListener('click', () => {
    play();
  });
  if (!calm) {
    reset();
    const seen = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      seen.disconnect();
      setTimeout(play, 500);
    }, { threshold: 0.35 });
    seen.observe(night);
  }
}

// ---------- scroll-driven bits ----------
const nav = $('.nav');
const heroBox = $('#deskCta [role="tabpanel"]'); // the command or the download, whichever tab shows
function onScroll() {
  nav.classList.toggle('scrolled', scrollY > 8);
  if (heroBox) nav.classList.toggle('cmd-away', heroBox.getBoundingClientRect().bottom < 64);
  if (getMenu && !nav.classList.contains('cmd-away')) openGet(false);
}
addEventListener('scroll', onScroll, { passive: true });
addEventListener('resize', onScroll);
onScroll();

// ---------- transcript vs report ----------
// A stand-in for what the same run streams: the tool calls and output you'd scroll past.
function transcript() {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const files = ['src/auth/session.ts', 'src/auth/token.ts', 'test/auth.test.ts', 'src/auth/refresh-queue.ts', 'src/lib/time.ts', 'test/helpers/clock.ts', 'src/middleware/auth.ts', 'jest.config.ts', 'package.json', 'src/auth/index.ts', '.github/workflows/ci.yml', 'src/lib/rate-limit.ts'];
  const thoughts = [
    'The failure is intermittent, so this is probably timing rather than logic.',
    'Let me look at how SessionStore decides a token is expired.',
    'isExpired compares Date.now() with exp using >, so a token is still valid at exactly exp.',
    'The test sleeps 50 ms and the TTL is 50 ms. On a loaded CI box that race goes either way.',
    'I could raise the sleep, but that only hides it. Injecting a clock makes it deterministic.',
    'RefreshQueue also calls Date.now() directly. Out of scope; I will mention it.',
    'Running the auth suite 200 times to make sure the flake is actually gone.',
    'Checking whether anything else constructs SessionStore with positional arguments.',
  ];
  const out = [];
  const push = (s, c = '') => out.push(c ? `<span class="${c}">${s}</span>` : s);
  for (let i = 0; out.length < 640; i++) {
    const r = rnd();
    if (r < 0.18) {
      push(`⏺ ${pick(thoughts)}`, 't');
    } else if (r < 0.42) {
      const f = pick(files);
      push(`⏺ Read(${f})`, 't');
      push(`  ⎿  Read ${20 + Math.floor(rnd() * 180)} lines`, 'dim');
      const n = 2 + Math.floor(rnd() * 6);
      for (let k = 0; k < n; k++) push(`     ${String(10 + k).padStart(3)}  ${pick(['export class SessionStore {', '  constructor(private ttl: number) {}', '  isExpired(t: Token) {', '    return Date.now() > t.exp;', '  }', "import { Token } from './token';", '  refresh(t: Token) {', "describe('SessionStore', () => {", '  await sleep(50);', '  expect(store.isExpired(t)).toBe(true);'])}`, 'dim');
    } else if (r < 0.55) {
      push(`⏺ Search(pattern: "${pick(['Date.now', 'isExpired', 'new SessionStore', 'sleep(', 'ttl'])}", path: "src")`, 't');
      push(`  ⎿  Found ${1 + Math.floor(rnd() * 30)} files`, 'dim');
      for (let k = 0; k < 3; k++) push(`     ${pick(files)}:${1 + Math.floor(rnd() * 120)}`, 'dim');
    } else if (r < 0.78) {
      push(`⏺ Bash(npm test -- auth${rnd() < 0.5 ? ' --repeat 20' : ''})`, 't');
      const fail = rnd() < 0.4;
      push(`  ⎿  > api-server@3.4.1 test`, 'dim');
      push(`     ${fail ? 'FAIL' : 'PASS'} test/auth.test.ts (${(1 + rnd() * 3).toFixed(2)} s)`, fail ? 'bad' : 'ok');
      if (fail) {
        push('       ● SessionStore › expires tokens after ttl', 'bad');
        push('         expect(received).toBe(expected) // Object.is equality');
        push('         Expected: true');
        push('         Received: false');
        push(`           at Object.<anonymous> (test/auth.test.ts:${40 + Math.floor(rnd() * 20)}:31)`, 'dim');
      }
      push(`     Tests: ${fail ? '1 failed, ' : ''}${200 + Math.floor(rnd() * 12)} passed`, fail ? '' : 'ok');
    } else {
      const f = pick(files);
      push(`⏺ Update(${f})`, 't');
      push(`  ⎿  Updated ${f} with ${1 + Math.floor(rnd() * 6)} additions and ${Math.floor(rnd() * 4)} removals`, 'dim');
      push(`     - ${pick(['    return Date.now() > t.exp;', '  await sleep(50);', '  constructor(private ttl: number) {}'])}`, 'bad');
      push(`     + ${pick(['    return this.clock.now() >= t.exp;', '  clock.tick(50);', '  constructor(private ttl: number, private clock = systemClock) {}'])}`, 'ok');
    }
    if (rnd() < 0.3) push('');
  }
  return out;
}
const log = $('#log');
const rBody = $('#rBody');
const seg = $('.seg');
if (log && rBody && seg) {
  const lines = transcript();
  log.innerHTML = lines.join('\n');
  $('#logCount').textContent = `${lines.length} lines`;
  let y = 0;
  let raf = 0;
  const scroll = () => {
    y += 0.9;
    if (y > log.scrollHeight - 600) y = 0;
    log.style.transform = `translateY(${-y}px)`;
    raf = requestAnimationFrame(scroll);
  };
  const ind = $('.seg-ind', seg);
  let touched = false;
  const show = (v) => {
    rBody.dataset.view = v;
    $$('button', seg).forEach((b) => {
      const on = b.dataset.v === v;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on);
      if (on) Object.assign(ind.style, { left: `${b.offsetLeft}px`, width: `${b.offsetWidth}px` });
    });
    cancelAnimationFrame(raf);
    if (v === 'log' && !calm) raf = requestAnimationFrame(scroll);
  };
  $$('button', seg).forEach((b) => b.addEventListener('click', () => ((touched = true), show(b.dataset.v))));
  // Arrive on the wall of text, then let the report take over.
  if (small()) show('report');
  else {
    show('log');
    new IntersectionObserver(
      ([e], obs) => {
        if (!e.isIntersecting) return;
        obs.disconnect();
        setTimeout(() => touched || show('report'), 2600);
      },
      { threshold: 0.5 },
    ).observe(rBody);
  }
}

// ---------- terminal ----------
// A wisp CLI you can type into. Commands and output follow the real CLI's formats (bin/wisp.js),
// against the demo projects. It types the first command itself, then it's yours: type, or click a
// suggestion. Lines are only ever appended, so the scrollback never re-renders.
const TERM_SESSIONS = () => [
  { id: '9c21e07d4a18', state: 'waiting', agent: 'claude', project: 'api-server', title: 'Migrate billing webhooks to the new Stripe API', question: 'Keep a v1 handler alongside v2?' },
  { id: 'b4e9120c77d1', state: 'running', agent: 'codex', project: 'web-app', title: 'Upgrade to Node 22' },
];
const FLAKY = { id: '7f3ac21b9e04', agent: 'claude', project: 'api-server', title: 'Fix the flaky session-expiry test' };
const FLAKY_REPORT = [
  '<span class="h">## Session-expiry test no longer flakes</span>\n',
  '<span class="ok">**✅ Done**</span> — The test slept 50 ms and raced the token TTL. SessionStore now takes an injectable clock; the test ticks it instead of sleeping.\n',
  '- **flaky runs / 200:** 0 <span class="ok">(−34)</span>\n- **tests passing:** 212 <span class="ok">(+2)</span>\n',
  '```diff\n<span class="del">-    return Date.now() > t.exp;</span>\n<span class="add">+    return this.clock.now() >= t.exp;</span>\n```\n',
];
const TERM_HELP = `usage:
  wisp "task"                   launch a task in this folder
  wisp ls                       list sessions        (--state running,waiting)
  wisp show &lt;id&gt;                state + latest report as markdown
  wisp reply &lt;id&gt; "text"        follow up (answers a pending question)
  wisp ship &lt;id&gt;                commit, push and open a PR
  wisp usage                    spend and outcomes
  wisp computer on              reach this computer from your phone, via wisp Cloud
  wisp spell cast "&lt;change&gt;"    an agent writes a spell for it
  wisp mcp                      run the MCP server for other agents

launch options: --mode plan|edits|auto  --agent claude|codex|opencode|…  --wait  --json`;
const termWin = $('.term-win');
const termOut = $('#termOut');
const termForm = $('#termForm');
const termIn = $('#termIn');
const termChips = $('#termChips');
const termBox = $('#term');
let termGen = 0; // bumps on restart, so a command still printing stops
let termBusy = false;
let sessions = [];
let shipped = new Set();
let nextPr = 186;

function termPrint(html) {
  termOut.insertAdjacentHTML('beforeend', html);
  termBox.scrollTop = termBox.scrollHeight;
}
const sleepT = (ms) => new Promise((r) => setTimeout(r, calm ? 0 : ms));
const escT = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// The CLI takes ids as typed; here a unique prefix is enough, so suggestions stay short.
const findSession = (id) => (id && id.length >= 4 ? sessions.filter((s) => s.id.startsWith(id)) : []).length === 1 ? sessions.find((s) => s.id.startsWith(id)) : null;
const lsLine = (s) => `${s.id}  ${s.state.padEnd(7)}  ${s.agent.padEnd(8)}  ${s.project.padEnd(16).slice(0, 16)}  ${escT(s.title)}${s.question ? `  <span class="warn">— asks: ${escT(s.question)}</span>` : ''}`;

// Splits a command line the way a shell would, enough for quoted task text.
function words(line) {
  const out = [];
  line.replace(/"([^"]*)"|'([^']*)'|(\S+)/g, (m, a, b, c) => out.push(a ?? b ?? c));
  return out;
}

function chips() {
  const waiting = sessions.find((s) => s.state === 'waiting');
  const review = sessions.find((s) => s.state === 'review' && !shipped.has(s.id));
  const list = [
    waiting ? 'wisp ls --state waiting' : 'wisp ls',
    waiting && `wisp reply ${waiting.id.slice(0, 4)} "keep both until the cutover"`,
    review && `wisp ship ${review.id.slice(0, 4)}`,
    !sessions.some((s) => s.title.startsWith('Add a /health')) && 'wisp "add a /health endpoint" --agent codex',
    'wisp usage',
    'wisp --help',
  ].filter(Boolean);
  // Same suggestions as before: leave the buttons alone.
  if (termChips.dataset.list === list.join('\n')) return;
  termChips.dataset.list = list.join('\n');
  termChips.innerHTML = list.map((c) => `<button type="button" data-cmd="${escT(c).replace(/"/g, '&quot;')}">${escT(c)}</button>`).join('');
}

async function launch(title, agent, wait, gen) {
  const s = sessions.find((x) => x.title === title) || (title === FLAKY.title ? { ...FLAKY } : { id: Math.random().toString(16).slice(2, 14).padEnd(12, '0'), agent, project: 'api-server', title });
  s.state = 'running';
  if (!sessions.includes(s)) sessions.unshift(s);
  if (!wait) {
    termPrint(`<span class="c">  ◌ launched: ${escT(title)}  (${s.id})</span>\n`);
    // It finishes a little later, the way a short task would.
    setTimeout(() => { if (gen === termGen && s.state === 'running') { s.state = 'review'; chips(); } }, calm ? 0 : 7000);
    return;
  }
  termPrint(`<span class="c">  ◌ launched: ${escT(title)}  (${s.id}) — waiting…</span>\n`);
  await sleepT(1400);
  if (gen !== termGen) return;
  s.state = 'review';
  await show(s, gen);
}

async function show(s, gen) {
  termPrint(`◌ ${escT(s.title)}  [${s.state}]  ${s.id}\n\n`);
  const lines = s.id === FLAKY.id
    ? FLAKY_REPORT
    : s.state === 'review' || s.state === 'done'
      ? [`<span class="h">## ${escT(s.title)}</span>\n`, '<span class="ok">**✅ Done**</span> — Made the change on its own branch and ran the tests.\n', '- **tests passing:** 214 <span class="ok">(+3)</span>\n']
      : s.question
        ? [`<span class="warn">**❓ Asks** — ${escT(s.question)}</span>\n`]
        : ['<span class="c">Still running. wisp wait ' + s.id + ' blocks until it is done.</span>\n'];
  for (const l of lines) {
    await sleepT(160);
    if (gen !== termGen) return;
    termPrint(l + '\n');
  }
}

async function exec(line, gen) {
  const w = words(line);
  if (!w.length) return;
  if (w[0] === 'clear') { termOut.innerHTML = ''; return; }
  if (w[0] !== 'wisp') { termPrint(`<span class="c">This terminal only runs wisp. Try </span>wisp --help\n`); return; }
  const flags = {};
  const args = [];
  for (let i = 1; i < w.length; i++) {
    if (w[i].startsWith('--')) flags[w[i].slice(2)] = w[i + 1] && !w[i + 1].startsWith('--') && w[i] !== '--wait' ? w[++i] : true;
    else args.push(w[i]);
  }
  const [cmd, ...rest] = args;
  const need = (s) => { if (!s) termPrint(`<span class="del">wisp: session id required — see wisp --help</span>\n`); return s; };
  await sleepT(220);
  if (gen !== termGen) return;
  if (flags.help || cmd === 'help') return termPrint(TERM_HELP + '\n');
  if (flags.version) return termPrint('0.36.0\n');
  if (!cmd) return termPrint('\n  ◌ wisp is open\n\n');
  switch (cmd) {
    case 'ls':
    case 'list': {
      const want = typeof flags.state === 'string' ? flags.state.split(',') : null;
      const list = sessions.filter((s) => !want || want.includes(s.state));
      return termPrint((list.map(lsLine).join('\n') || 'No sessions.') + '\n');
    }
    case 'show': {
      const s = need(rest[0]) && findSession(rest[0]);
      if (rest[0] && !s) return termPrint(`<span class="del">wisp: no session ${escT(rest[0])}</span>\n`);
      return s && show(s, gen);
    }
    case 'reply': {
      const s = need(rest[0]) && findSession(rest[0]);
      if (rest[0] && !s) return termPrint(`<span class="del">wisp: no session ${escT(rest[0])}</span>\n`);
      if (!s) return;
      const answered = s.state === 'waiting';
      s.state = 'running';
      delete s.question;
      setTimeout(() => { if (gen === termGen && s.state === 'running') { s.state = 'review'; chips(); } }, calm ? 0 : 6000);
      return termPrint(`<span class="ok">  ✓ ${answered ? 'answered' : 'sent'}</span>\n`);
    }
    case 'ship': {
      const s = need(rest[0]) && findSession(rest[0]);
      if (rest[0] && !s) return termPrint(`<span class="del">wisp: no session ${escT(rest[0])}</span>\n`);
      if (!s) return;
      if (s.state === 'running' || s.state === 'waiting') return termPrint(`<span class="del">wisp: ${s.id} is still ${s.state}; ship it once it's done</span>\n`);
      if (!shipped.has(s.id)) { shipped.add(s.id); s.pr = nextPr++; }
      await sleepT(900);
      if (gen !== termGen) return;
      return termPrint(`<span class="ok">  ✓ PR #${s.pr}${flags.draft ? ' (draft)' : ''}: https://github.com/acme/${s.project}/pull/${s.pr}</span>\n`);
    }
    case 'usage':
      return termPrint(`Last 30 days: $41.80 · 512 turns in 96 sessions · 88% worked · 14 questions

By project
  api-server                          $24.10    301 turns   91% ok
  web-app                             $17.70    211 turns   84% ok

By harness · model
  claude · opus                       $29.40    344 turns   90% ok
  codex · gpt-5.5-codex               $12.40    168 turns   85% ok
`);
    case 'computer': {
      if (rest[0] === 'off') return termPrint('<span class="ok">  ✓ off: this computer left the grid</span>\n');
      if (rest[0] !== 'on') return termPrint('  ○ off. wisp computer on signs in to a wisp Grid and adds it\n');
      termPrint('\n  Sign in to grid.trywisp.dev and allow this code: WKRT-MQ7D\n    https://grid.trywisp.dev/activate?code=WKRT-MQ7D\n\n  Waiting for the browser… (Ctrl-C cancels)\n');
      await sleepT(1600);
      if (gen !== termGen) return;
      return termPrint('<span class="ok">  ✓ signed in as you</span>\n  ● studio is on grid.trywisp.dev: online\n    https://studio--you.grid.trywisp.dev\n');
    }
    case 'mcp':
      return termPrint('<span class="c">  (the MCP server talks over stdio; add it to your agent or editor)</span>\n');
    default: {
      // Anything else is a task, as in the real CLI.
      const text = args.join(' ');
      const title = text.charAt(0).toUpperCase() + text.slice(1);
      return launch(title, typeof flags.agent === 'string' ? flags.agent : 'claude', !!flags.wait, gen);
    }
  }
}

async function runCmd(line, typed) {
  if (termBusy) return;
  termBusy = true;
  const gen = termGen;
  termIn.value = '';
  if (typed) {
    for (const ch of line) {
      if (gen !== termGen) return;
      termIn.value += ch;
      await sleepT(18 + Math.random() * 34);
    }
    await sleepT(300);
  }
  if (gen !== termGen) return;
  termIn.value = '';
  termPrint(`<span class="p">$</span> ${escT(line)}\n`);
  termForm.classList.add('busy');
  await exec(line.trim(), gen);
  if (gen !== termGen) return;
  termForm.classList.remove('busy');
  termBusy = false;
  chips();
}

async function startTerm() {
  termGen++;
  termBusy = false;
  termOut.innerHTML = '';
  sessions = TERM_SESSIONS();
  shipped = new Set();
  nextPr = 186;
  termForm.classList.remove('busy');
  termChips.dataset.list = '';
  termChips.innerHTML = '';
  // The first task is the one this page follows everywhere: launch it and wait for its report.
  await runCmd('wisp "fix the flaky session-expiry test" --wait', true);
}

if (termWin) {
  new IntersectionObserver(
    ([e], obs) => {
      if (!e.isIntersecting) return;
      obs.disconnect();
      startTerm();
    },
    { threshold: 0.4 },
  ).observe(termWin);
  $('#termReplay')?.addEventListener('click', startTerm);
  termForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (termIn.value.trim()) runCmd(termIn.value, false);
  });
  termChips.addEventListener('click', (e) => {
    const b = e.target.closest('[data-cmd]');
    if (b) runCmd(b.dataset.cmd, true);
  });
  termBox.addEventListener('click', () => {
    if (!getSelection().toString()) termIn.focus({ preventScroll: true });
  });
}

// ---------- star count: nice to have, silent if GitHub says no ----------
const stars = $('[data-stars]');
fetch('https://api.github.com/repos/M0xoo/wisp')
  .then((r) => (r.ok ? r.json() : null))
  .then((repo) => {
    const n = repo?.stargazers_count;
    if (!stars || typeof n !== 'number' || n < 50) return; // a tiny count reads worse than none
    stars.textContent = n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
    stars.hidden = false;
  })
  .catch(() => {});
