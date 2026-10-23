// wisp site: the hero launcher, the transcript/report switch, the terminal, and small things.

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
const small = () => matchMedia('(max-width: 960px)').matches;

// ---------- copy buttons ----------
for (const btn of $$('[data-copy]')) {
  btn.addEventListener('click', async () => {
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
  });
}

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
$$('.hero-top > *, .desk, .strip, .r-head, .c-head, .cmp-shot, .cli-text, .term-win, .more, .install h2, .install .sub, .steps li, .faq, .final h2, .final .cta').forEach((el, i) => {
  el.classList.add('rise');
  if (el.closest('.hero')) el.style.transitionDelay = `${i * 80}ms`;
  if (el.matches('.steps li')) el.style.transitionDelay = `${[...el.parentElement.children].indexOf(el) * 90}ms`;
  io.observe(el);
});

// ---------- hero: a working copy of the launcher ----------
// It types three tasks and sends them off; their rows move from Working to Asking to Done the
// way the app's do. Type your own and you get the command that runs it for real.
const desk = $('#desk');
if (desk) {
  const form = $('#launch');
  const input = $('#task');
  const hint = $('#hint');
  const send = $('.l-send', form);
  const lists = { needs: $('[data-g="needs"] .q-list', desk), working: $('[data-g="working"] .q-list', desk) };
  const cta = $('#deskCta');
  const LOGO = { claude: 'assets/logos/claudecode-color.svg', codex: 'assets/logos/codex-color.svg' };
  const PROJ = { 'api-server': 'c-violet', 'web-app': 'c-teal', 'your-repo': 'c-sky' };
  const wait = (ms) => new Promise((r) => setTimeout(r, calm ? 0 : ms));
  let demo = true; // false once the visitor starts typing
  let sent = 0;
  const esc = (t) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  const counts = () => {
    for (const [g, list] of Object.entries(lists)) $(`[data-g="${g}"] .n`, desk).textContent = list.children.length;
  };
  // Move a row between groups without a jump: measure, move, play the difference (FLIP).
  const move = (row, group, first = true) => {
    const rows = $$('.q-row', desk);
    const before = new Map(rows.map((r) => [r, r.getBoundingClientRect().top]));
    const list = lists[group];
    first ? list.prepend(row) : list.append(row);
    counts();
    if (calm) return;
    for (const r of rows) {
      const dy = before.get(r) - r.getBoundingClientRect().top;
      if (dy) r.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 450, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
  };

  const trim = () => {
    const rows = $$('.q-row', desk);
    if (rows.length <= 4) return;
    const old = $$('.q-row[data-s="done"]', desk).at(-1);
    if (!old) return;
    old.animate([{ opacity: 1 }, { opacity: 0 }], { duration: calm ? 0 : 250 }).finished.then(() => (old.remove(), counts()));
  };

  function row({ title, agent, project, mine }) {
    const el = document.createElement('div');
    el.className = `q-row new${mine ? ' mine' : ''}`;
    el.dataset.s = 'working';
    const logo = agent === 'auto' ? '<svg class="q-logo auto" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5 9.6 6.4 14.5 8 9.6 9.6 8 14.5 6.4 9.6 1.5 8 6.4 6.4Z" fill="currentColor"/></svg>' : `<span class="q-logo" style="background-image: url(${LOGO[agent]})"></span>`;
    el.innerHTML = `<span class="q-dot"></span><span class="q-main"><span class="q-title">${esc(title)}</span><span class="q-sub">Starting up</span></span>
      <span class="q-side"><span class="pill working"></span>${logo}<span class="q-proj"><i class="${PROJ[project]}"></i>${project}</span><span class="q-time">now</span></span>`;
    let min = 0;
    el._clock = setInterval(() => ($('.q-time', el).textContent = `${++min}m`), 1100);
    return el;
  }
  const status = (el, text) => {
    const sub = $('.q-sub', el);
    sub.textContent = text;
    sub.classList.remove('swap');
    void sub.offsetWidth;
    sub.classList.add('swap');
  };
  const state = (el, s, pill) => {
    el.dataset.s = s;
    const p = $('.pill', el);
    p.className = `pill ${s}`;
    p.textContent = pill || '';
  };

  // Type into the launcher, press send, and fly the words down into a new row.
  async function launch(text, opts) {
    if (!demo && !opts.mine) return null;
    if (!opts.mine) {
      form.classList.add('typing');
      for (const ch of text) {
        if (!demo) return (form.classList.remove('typing'), null);
        input.value += ch;
        await wait(28 + Math.random() * 45);
      }
      await wait(380);
      form.classList.remove('typing');
    }
    // "off" leaves the headline, once, as the first task is sent.
    if (!sent++ && !calm) $('h1 .off')?.classList.add('fly');
    send.classList.add('press');
    setTimeout(() => send.classList.remove('press'), 140);
    trim();
    const el = row({ title: text, ...opts });
    const from = input.getBoundingClientRect();
    move(el, 'working');
    if (!calm) {
      const to = $('.q-title', el).getBoundingClientRect();
      const fly = document.createElement('span');
      fly.className = 'flyer';
      fly.textContent = text;
      const pad = parseFloat(getComputedStyle(input).paddingLeft);
      Object.assign(fly.style, { left: `${from.left + pad}px`, top: `${from.top + parseFloat(getComputedStyle(input).paddingTop)}px` });
      document.body.append(fly);
      const scale = 14.5 / parseFloat(getComputedStyle(fly).fontSize);
      $('.q-title', el).style.opacity = 0;
      fly.animate(
        [{ transform: 'none', opacity: 1 }, { transform: `translate(${to.left - from.left - pad}px, ${to.top - from.top - 16}px) scale(${scale})`, opacity: 1, fontWeight: 600 }],
        { duration: 620, easing: 'cubic-bezier(.5,0,.2,1)' },
      ).finished.then(() => {
        fly.remove();
        $('.q-title', el).style.opacity = '';
      });
    }
    input.value = '';
    return el;
  }

  async function script() {
    await wait(900);
    const a = await launch('Fix the flaky session-expiry test', { agent: 'claude', project: 'api-server' });
    if (!a) return;
    await wait(700);
    status(a, 'Reading test/auth.test.ts');
    const b = await launch('Upgrade to Node 22 and fix whatever breaks', { agent: 'codex', project: 'web-app' });
    if (!b) return;
    status(a, 'Searching for “Date.now”');
    await wait(600);
    status(b, 'Reading package.json');
    const c = await launch('Migrate billing webhooks to the new Stripe API', { agent: 'claude', project: 'api-server' });
    if (!c) return;
    status(a, 'Running npm test -- --repeat 200 auth');
    await wait(900);
    status(c, 'Reading src/billing/webhooks.ts');
    status(b, 'Editing .nvmrc');
    await wait(1600);
    // The Stripe task needs a decision: it jumps to Needs you with its options.
    ask(c);
    await wait(1400);
    status(b, 'Running npm test · 3 failing in date-fns adapter');
    await wait(1200);
    done(a, 'Session-expiry test no longer flakes · 212 passed');
    if (demo) hint.classList.add('on');
    await wait(2600);
    done(b, 'Node 22: builds and tests pass, one dependency pinned');
  }

  function ask(el) {
    state(el, 'asking', 'Asking');
    status(el, 'Asks: Keep a v1 handler alongside v2?');
    const opts = document.createElement('div');
    opts.className = 'q-opts';
    opts.innerHTML = '<button type="button"><kbd>1</kbd>Keep both until the cutover</button><button type="button"><kbd>2</kbd>v2 only</button>';
    $('.q-main', el).append(opts);
    move(el, 'needs');
    let answered = false;
    const answer = (txt) => {
      if (answered) return;
      answered = true;
      opts.remove();
      state(el, 'working');
      status(el, `↳ ${txt} · delivered to the running agent`);
      move(el, 'working');
      setTimeout(() => status(el, 'Editing src/billing/verify.ts'), 1800);
      setTimeout(() => done(el, 'Webhooks on thin events, v1 kept until the cutover'), 5200);
    };
    $$('button', opts).forEach((btn) => btn.addEventListener('click', () => answer(btn.textContent.slice(1))));
    setTimeout(() => answer('Keep both until the cutover'), demo ? 6500 : 60000);
  }

  function done(el, text) {
    clearInterval(el._clock);
    state(el, 'done', 'Done');
    status(el, text);
    move(el, 'needs', false);
  }

  // The visitor's turn.
  input.addEventListener('focus', () => {
    if (!demo) return;
    demo = false;
    input.value = '';
    form.classList.remove('typing');
    hint.classList.add('on');
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return input.focus();
    hint.classList.remove('on');
    const el = await launch(text, { agent: 'auto', project: 'your-repo', mine: true });
    const steps = ['Auto is picking a harness and model', 'Auto picked Claude Code · Balanced', 'Reading the codebase'];
    steps.forEach((t, i) => setTimeout(() => status(el, t), 900 + i * 1300));
    setTimeout(() => status(el, 'A web page can’t reach your code. Copy the command to run it for real.'), 900 + steps.length * 1300 + 600);
    // Hand back the real command, with their task in it.
    cta.dataset.task = text.replace(/["\\$`]/g, '\\$&');
    tabBoxes.find((t) => t.box === cta)?.refresh();
    cta.classList.add('mine');
    $('#deskFine').innerHTML = '<b>Run it in your project folder.</b> It opens wisp and starts this task.';
    window.posthog?.capture?.('hero_task_typed');
  });

  counts();
  if (calm) {
    // No motion: show the finished state.
    const a = row({ title: 'Fix the flaky session-expiry test', agent: 'claude', project: 'api-server' });
    const c = row({ title: 'Migrate billing webhooks to the new Stripe API', agent: 'claude', project: 'api-server' });
    const b = row({ title: 'Upgrade to Node 22 and fix whatever breaks', agent: 'codex', project: 'web-app' });
    move(b, 'working');
    status(b, 'Running npm test · 3 failing in date-fns adapter');
    ask(c);
    done(a, 'Session-expiry test no longer flakes · 212 passed');
    hint.classList.add('on');
  } else {
    script();
  }
}

// ---------- scroll-driven bits ----------
const nav = $('.nav');
const heroCmd = $('#heroCmd');
function onScroll() {
  nav.classList.toggle('scrolled', scrollY > 8);
  if (heroCmd) nav.classList.toggle('cmd-away', heroCmd.getBoundingClientRect().bottom < 64);
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
