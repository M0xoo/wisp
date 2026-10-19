// wisp site: the morning story, the transcript/report switch, the terminal, and small things.

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

// ---------- install tabs ----------
// The hero and the install section each have npx / npm / curl / brew tabs. Picking one updates the
// command, its copy button and the note, and the other box follows. A box with data-task set (the
// hero, once the visitor typed a task) shows the command that installs wisp and starts that task.
const tabBoxes = $$('[data-tabs]').map((box) => {
  const tabs = $$('[role="tab"]', box);
  const code = $('[data-tab-code]', box);
  const copy = $('[data-tab-copy]', box);
  const note = $('[data-tab-note]', box) || $('[data-tab-note]', box.parentElement);
  const panel = $('[role="tabpanel"]', box);
  let current = tabs.find((t) => t.getAttribute('aria-selected') === 'true') || tabs[0];
  const commandFor = (tab) => {
    const task = box.dataset.task;
    if (!task) return tab.dataset.cmd;
    return tab.dataset.tab === 'npx' ? `npx wisp-agents "${task}"` : `${tab.dataset.cmd} && wisp "${task}"`;
  };
  const pick = (tab, focus) => {
    current = tab;
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', on);
      t.tabIndex = on ? 0 : -1;
    }
    code.textContent = copy.dataset.copy = commandFor(tab);
    if (note && !box.dataset.task) note.textContent = tab.dataset.note;
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
$$('.hero-top > *, .desk, .strip, .m-intro, .r-head, .c-head, .cmp-shot, .sec-head, .tile, .modes, .takeover, .cli-text, .term-win, .more, .install h2, .install .sub, .steps li, .faq, .final h2, .final .cta').forEach((el, i) => {
  el.classList.add('rise');
  if (el.closest('.hero')) el.style.transitionDelay = `${i * 80}ms`;
  if (el.matches('.steps li, .tile')) el.style.transitionDelay = `${[...el.parentElement.children].indexOf(el) * 90}ms`;
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
    const logo = agent === 'auto' ? '<span class="q-logo auto">✦</span>' : `<img class="q-logo" src="${LOGO[agent]}" alt="" width="16" height="16" />`;
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
const track = $('#mTrack');
const scenes = $$('.scene');
const chapters = $$('#chapters li');
const ring = $('#ring');
const note = $('#note');
const clock = $('#clock');
const rail = $('#railFill');
// Where to look in each scene, as % of the 1280×800 app window.
const zoom = $('#zoom');
// [x, y, w, h, zoom] per scene
const RINGS = [
  [20.4, 40.0, 59.2, 27.0, 1.25], // three tasks working
  [25.6, 74.4, 51.4, 26.4, 1.35], // the question
  [21.8, 63.4, 56.4, 28.4, 1.3], // report headline and stats
  [56.2, 73.4, 17.2, 5.8, 1.45], // commit, push & open PR
  [20.4, 63.2, 59.2, 18.8, 1.3], // merged
];
let scene = -1;
let shownTime = 9 * 60 + 2;
let clockTimer = 0;

const toMin = (t) => +t.slice(0, 2) * 60 + +t.slice(3);
const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

function tickClock(to) {
  cancelAnimationFrame(clockTimer);
  const from = shownTime;
  if (calm || from === to) return void ((shownTime = to), (clock.textContent = fmt(to)));
  const t0 = performance.now();
  const dur = Math.min(900, 120 + Math.abs(to - from) * 14);
  const step = (now) => {
    const k = Math.min(1, (now - t0) / dur);
    shownTime = Math.round(from + (to - from) * (1 - (1 - k) ** 3));
    clock.textContent = fmt(shownTime);
    if (k < 1) clockTimer = requestAnimationFrame(step);
  };
  clockTimer = requestAnimationFrame(step);
}

function setScene(i) {
  if (i === scene) return;
  scene = i;
  scenes.forEach((s, k) => s.classList.toggle('on', k === i));
  chapters.forEach((c, k) => c.classList.toggle('on', k === i));
  const [x, y, w, h, z] = RINGS[i];
  Object.assign(ring.style, { left: `${x}%`, top: `${y}%`, width: `${w}%`, height: `${h}%` });
  // Lean in toward what matters in this scene; the ring scales with the picture.
  zoom.style.transformOrigin = `${x + w / 2}% ${y + h / 2}%`;
  zoom.style.transform = calm ? '' : `scale(${z})`;
  note.classList.toggle('on', i === 1);
  tickClock(toMin(chapters[i].dataset.t));
}

const heroCmd = $('#heroCmd');
function onScroll() {
  nav.classList.toggle('scrolled', scrollY > 8);
  if (heroCmd) nav.classList.toggle('cmd-away', heroCmd.getBoundingClientRect().bottom < 64);
  if (track && !small()) {
    const r = track.getBoundingClientRect();
    const p = Math.max(0, Math.min(0.9999, -r.top / (r.height - innerHeight)));
    setScene(Math.floor(p * chapters.length));
    rail.style.height = `${p * 100}%`;
  }
}
addEventListener('scroll', onScroll, { passive: true });
addEventListener('resize', onScroll);
setScene(0);
onScroll();

// On small screens the story is a list: give each chapter its own screenshot.
if (small()) {
  chapters.forEach((li, i) => {
    const pic = scenes[i]?.cloneNode(true);
    if (!pic) return;
    pic.className = 'ch-shot';
    $('img', pic).loading = 'lazy';
    li.append(pic);
  });
}

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
// Commands and output in the real CLI's formats (bin/wisp.js), against the demo projects.
const SCRIPT = [
  { cmd: 'wisp "fix the flaky session-expiry test" --wait' },
  { out: '<span class="c">  ◌ launched: Fix the flaky session-expiry test  (7f3ac21b9e04) — waiting…</span>', wait: 1400 },
  { out: '◌ Fix the flaky session-expiry test  [review]  7f3ac21b9e04\n' },
  { out: '<span class="h">## Session-expiry test no longer flakes</span>\n' },
  { out: '<span class="ok">**✅ Done**</span> — The test slept 50 ms and raced the token TTL. SessionStore now takes an injectable clock; the test ticks it instead of sleeping.\n' },
  { out: '- **flaky runs / 200:** 0 <span class="ok">(−34)</span>\n- **tests passing:** 212 <span class="ok">(+2)</span>\n' },
  { out: '```diff\n<span class="del">-    return Date.now() > t.exp;</span>\n<span class="add">+    return this.clock.now() >= t.exp;</span>\n```\n' },
  { cmd: 'wisp ls --state waiting', wait: 600 },
  { out: '9c21e07d4a18  waiting  claude    api-server        Migrate billing webhooks to the new Stripe API  <span class="warn">— asks: Keep a v1 handler alongside v2?</span>\n' },
  { cmd: 'wisp reply 9c21e07d4a18 "keep both until the cutover"' },
  { out: '<span class="ok">  ✓ answered</span>\n' },
  { cmd: 'wisp ship 7f3ac21b9e04' },
  { out: '<span class="ok">  ✓ PR #186: https://github.com/acme/api-server/pull/186</span>\n' },
];
const term = $('#term');
let termRun = 0;
async function playTerm() {
  const run = ++termRun;
  const live = () => run === termRun;
  const sleep = (ms) => new Promise((r) => setTimeout(r, calm ? 0 : ms));
  term.innerHTML = '';
  const caret = '<span class="caret"></span>';
  let html = '';
  for (const step of SCRIPT) {
    if (!live()) return;
    if (step.cmd) {
      await sleep(step.wait || 500);
      html += '<span class="p">$</span> ';
      for (const ch of step.cmd) {
        if (!live()) return;
        html += ch.replace('<', '&lt;');
        term.innerHTML = html + caret;
        await sleep(18 + Math.random() * 40);
      }
      html += '\n';
      term.innerHTML = html + caret;
      await sleep(350);
    } else {
      await sleep(step.wait || 160);
      html += step.out + '\n';
      term.innerHTML = html + caret;
      term.scrollTop = term.scrollHeight;
    }
  }
}
if (term) {
  new IntersectionObserver(
    ([e], obs) => {
      if (!e.isIntersecting) return;
      obs.disconnect();
      playTerm();
    },
    { threshold: 0.4 },
  ).observe(term);
  $('#termReplay')?.addEventListener('click', playTerm);
}

// ---------- modes: hover shows each; leaving returns to the default ----------
const modes = $$('.mode');
modes.forEach((m) => m.addEventListener('mouseenter', () => modes.forEach((x) => x.classList.toggle('on', x === m))));
$('.modes')?.addEventListener('mouseleave', () => modes.forEach((x, i) => x.classList.toggle('on', i === 1)));

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
