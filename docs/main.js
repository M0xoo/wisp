// wisp — landing page interactions. No dependencies.
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ───────── count-up ─────────
  function countUp(el, dur = 1400) {
    const to = parseFloat(el.dataset.count);
    const dec = +(el.dataset.dec || 0);
    const fmt = (v) => v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
    if (reduced) return (el.textContent = fmt(to));
    const t0 = performance.now();
    const tick = (t) => {
      const p = clamp((t - t0) / dur);
      el.textContent = fmt(to * (1 - Math.pow(1 - p, 4)));
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // ───────── reveal on scroll ─────────
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add('in');
      $$('[data-count]', e.target).forEach((n) => countUp(n));
      io.unobserve(e.target);
    }
  }, { threshold: 0.15, rootMargin: '0px 0px -40px 0px' });
  // stagger siblings
  $$('.reveal').forEach((el) => {
    const sibs = $$(':scope > .reveal', el.parentElement);
    el.style.setProperty('--d', `${sibs.indexOf(el) * 0.08}s`);
    io.observe(el);
  });

  // ───────── nav ─────────
  const nav = $('#nav');
  addEventListener('scroll', () => nav.classList.toggle('scrolled', scrollY > 30), { passive: true });

  // ───────── copy ─────────
  async function copy(text, btn, labelEl = btn) {
    try { await navigator.clipboard.writeText(text); } catch { return; }
    const prev = labelEl.textContent;
    btn.classList.add('copied');
    labelEl.textContent = 'Copied';
    setTimeout(() => { btn.classList.remove('copied'); labelEl.textContent = prev; }, 1600);
  }
  $$('.copy-cmd').forEach((b) => b.addEventListener('click', () => copy(b.dataset.copy, b, $('.copy-label', b))));

  // ───────── spotlight cards ─────────
  $$('.spot').forEach((c) => c.addEventListener('pointermove', (e) => {
    const r = c.getBoundingClientRect();
    c.style.setProperty('--mx', `${e.clientX - r.left}px`);
    c.style.setProperty('--my', `${e.clientY - r.top}px`);
  }));

  // ───────── hero: drifting wisps ─────────
  (function wisps() {
    const cv = $('#wisps');
    const ctx = cv.getContext('2d');
    const hero = $('.hero');
    let w, h, dpr, parts = [], visible = true, t = 0;
    const COLORS = ['143,132,255', '47,208,180', '217,255,246', '106,92,255'];
    const resize = () => {
      dpr = Math.min(2, devicePixelRatio || 1);
      w = cv.clientWidth; h = cv.clientHeight;
      cv.width = w * dpr; cv.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#07070a'; ctx.fillRect(0, 0, w, h);
      const n = Math.round(clamp((w * h) / 9000, 60, 180));
      parts = Array.from({ length: n }, spawn);
    };
    function spawn() {
      return { x: Math.random() * w, y: Math.random() * h, life: 0, max: 200 + Math.random() * 400, c: COLORS[(Math.random() * COLORS.length) | 0], s: 0.4 + Math.random() * 0.9 };
    }
    function frame() {
      if (visible) {
        t += 0.0025;
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = 'rgba(7,7,10,0.07)';
        ctx.fillRect(0, 0, w, h);
        ctx.globalCompositeOperation = 'lighter';
        const cx = w / 2, cy = h * 0.42;
        for (const p of parts) {
          const a = Math.sin(p.x * 0.0021 + t * 3) * 2.2 + Math.cos(p.y * 0.0026 - t * 2) * 2.2 + Math.sin((p.x + p.y) * 0.0009 + t);
          // gentle swirl around the orb
          const dx = p.x - cx, dy = p.y - cy, d = Math.hypot(dx, dy) + 1;
          const swirl = clamp(260 / d, 0, 1.2);
          const vx = Math.cos(a) * p.s + (-dy / d) * swirl * 0.9;
          const vy = Math.sin(a) * p.s * 0.7 - 0.25 * p.s + (dx / d) * swirl * 0.9;
          const nx = p.x + vx, ny = p.y + vy;
          const k = Math.sin((p.life / p.max) * Math.PI);
          ctx.strokeStyle = `rgba(${p.c},${0.35 * k})`;
          ctx.lineWidth = 1.1;
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(nx, ny); ctx.stroke();
          p.x = nx; p.y = ny; p.life++;
          if (p.life > p.max || p.x < -20 || p.x > w + 20 || p.y < -20 || p.y > h + 20) Object.assign(p, spawn());
        }
      }
      requestAnimationFrame(frame);
    }
    new IntersectionObserver(([e]) => (visible = e.isIntersecting)).observe(hero);
    addEventListener('resize', resize);
    resize();
    if (!reduced) frame();
  })();

  // ───────── distill: transcript → presentation ─────────
  (function distill() {
    const sec = $('.distill');
    const tScroll = $('#tScroll');
    const transcript = $('#transcript');
    const lineCount = $('#lineCount');
    const orb = $('#collapseOrb');
    const caps = $$('.caps li');
    const blks = $$('.present .blk');
    const meter = $('#meterFill');
    const status = $('#winStatus');
    const statusText = $('#statusText');
    const statusLbl = $('#statusLbl');
    const TOTAL = 3417;

    const files = ['src/auth/session.ts', 'src/auth/refresh.ts', 'test/auth.test.ts', 'src/lib/clock.ts', 'src/auth/token.ts', 'package.json', 'test/helpers/fake-clock.ts', 'src/server.ts'];
    const thoughts = [
      'The failure only happens when the test crosses a second boundary…',
      'setTimeout(50) is racing Date.now() — classic.',
      'Let me check whether RefreshQueue also reads the wall clock.',
      'I should inject the clock rather than mocking Date globally.',
      'Running the suite 200× to make sure the flake is actually gone.',
      'v1 tokens use a different exp format; keep that path intact.',
    ];
    const pick = (a, i) => a[(i * 7 + 3) % a.length];
    const rows = [];
    for (let i = 0; i < 160; i++) {
      const f = pick(files, i);
      switch (i % 9) {
        case 0: rows.push(`<div class="tool">● <b>Read</b> ${f}</div><div class="sub">⎿ ${80 + ((i * 37) % 300)} lines</div>`); break;
        case 1: rows.push(`<div class="think">✻ ${pick(thoughts, i)}</div>`); break;
        case 2: rows.push(`<div class="tool">● <b>Grep</b> "${['Date.now', 'setTimeout', 'isExpired', 'clock'][i % 4]}" src/</div><div class="sub">⎿ ${1 + (i % 7)} matches</div>`); break;
        case 3: rows.push(`<div class="tool">● <b>Bash</b> npm test -- auth</div><div class="${i < 90 ? 'fail' : 'pass'}">  ${i < 90 ? '✗ auth › rejects expired token (flaky, 3/10)' : '✓ 48 passed'}</div>`); break;
        case 4: rows.push(`<div class="tool">● <b>Edit</b> ${f}</div><div class="sub">⎿ +${1 + (i % 6)} −${i % 4}</div>`); break;
        case 5: rows.push(`<div class="sub">  at SessionStore.isExpired (${f}:${12 + (i % 40)})</div><div class="sub">  at Object.&lt;anonymous&gt; (test/auth.test.ts:${30 + (i % 20)})</div>`); break;
        case 6: rows.push(`<div class="tool">● <b>Read</b> node_modules/jest-environment/build/index.js</div><div class="sub">⎿ 612 lines</div>`); break;
        case 7: rows.push(`<div class="think">✻ ${pick(thoughts, i + 2)}</div>`); break;
        default: rows.push(`<div class="tool">● <b>Glob</b> **/*.test.ts</div><div class="sub">⎿ ${20 + (i % 9)} files</div>`);
      }
    }
    tScroll.innerHTML = rows.join('');

    const statuses = ['Reading session.ts', 'Grepping for Date.now', 'Running npm test', 'Editing refresh.ts', 'Thinking…', 'Running suite 200×', 'Writing presentation'];
    let lastP = -1;
    const counted = new WeakSet();

    function render() {
      const r = sec.getBoundingClientRect();
      const p = reduced ? 1 : clamp(-r.top / (r.height - innerHeight));
      if (Math.abs(p - lastP) < 0.0005) return;
      lastP = p;

      caps.forEach((li, i) => {
        const next = caps[i + 1];
        li.classList.toggle('on', p >= +li.dataset.at && (!next || p < +next.dataset.at));
      });
      meter.style.width = `${p * 100}%`;

      // transcript scrolls + counts
      const tp = clamp(p / 0.5);
      const maxScroll = Math.max(0, tScroll.scrollHeight - transcript.clientHeight);
      tScroll.style.transform = `translateY(${-tp * maxScroll}px)`;
      lineCount.textContent = Math.round(tp * TOTAL).toLocaleString('en-US');

      // collapse into the orb
      const c = clamp((p - 0.44) / 0.12);
      transcript.style.transform = `scale(${1 - c * 0.85})`;
      transcript.style.opacity = 1 - c;
      transcript.style.filter = `blur(${c * 10}px)`;
      const o = clamp((p - 0.46) / 0.08) * (1 - clamp((p - 0.58) / 0.06));
      orb.style.opacity = o;
      orb.style.transform = `translate(-50%, -50%) scale(${0.2 + o * 0.8 + clamp((p - 0.58) / 0.06) * 1.5})`;

      // presentation blocks
      blks.forEach((b) => {
        const on = p >= +b.dataset.at;
        b.classList.toggle('in', on);
        if (on && !counted.has(b)) {
          counted.add(b);
          $$('[data-count]', b).forEach((n) => countUp(n, 1000));
        }
        if (!on && counted.has(b) && p < +b.dataset.at - 0.05) counted.delete(b);
      });

      const done = p >= 0.56;
      status.classList.toggle('done', done);
      statusLbl.textContent = done ? 'Needs you' : 'Working';
      statusText.textContent = done ? 'ready in 47 min' : statuses[Math.min(statuses.length - 1, Math.floor(tp * statuses.length))];
    }

    addEventListener('scroll', () => requestAnimationFrame(render), { passive: true });
    addEventListener('resize', () => { lastP = -1; render(); });
    render();
  })();

  // ───────── manifesto words ─────────
  (function words() {
    const el = $('.reveal-words');
    const walk = (node) => {
      for (const n of [...node.childNodes]) {
        if (n.nodeType === 3) {
          const frag = document.createDocumentFragment();
          n.textContent.split(/(\s+)/).forEach((part) => {
            if (!part.trim()) return frag.append(part);
            const s = document.createElement('span'); s.className = 'w'; s.textContent = part; frag.append(s);
          });
          n.replaceWith(frag);
        } else walk(n);
      }
    };
    walk(el);
    const ws = $$('.w', el);
    const upd = () => {
      const r = el.getBoundingClientRect();
      const p = reduced ? 1 : clamp((innerHeight * 0.85 - r.top) / (r.height + innerHeight * 0.35));
      const k = Math.round(p * ws.length);
      ws.forEach((w, i) => w.classList.toggle('on', i < k));
    };
    addEventListener('scroll', () => requestAnimationFrame(upd), { passive: true });
    upd();
  })();

  // only run looping demos while on screen
  function whenVisible(el, start) {
    let timer = null;
    new IntersectionObserver(([e]) => {
      if (e.isIntersecting && !timer) timer = start();
      else if (!e.isIntersecting && timer) { clearInterval(timer); timer = null; }
    }, { threshold: 0.2 }).observe(el);
  }

  // ───────── queue ─────────
  (function queue() {
    const root = $('#queue');
    const lists = { needs: $('[data-col="needs"] .q-list', root), working: $('[data-col="working"] .q-list', root), done: $('[data-col="done"] .q-list', root) };
    const pool = [
      ['Fix flaky auth test', ['Reading session.ts', 'Running npm test', 'Editing clock.ts']],
      ['Dark mode for settings', ['Grepping tokens.css', 'Taking screenshot', 'Editing Settings.tsx']],
      ['Bump to Node 22', ['Reading .nvmrc', 'Running CI matrix', 'Updating lockfile']],
      ['Audit deps', ['npm outdated', 'Reading advisories', 'Writing report']],
      ['Paginate /orders', ['Reading routes.ts', 'Writing migration', 'Running e2e']],
      ['Kill dead feature flags', ['Grepping flags', 'Editing 14 files', 'Running tsc']],
    ];
    const needsCopy = ['Ready · 6 blocks', 'Asks: keep v1 compat?', 'Ready · 3 files changed'];
    let n = 0;
    const item = (title, sub) => {
      const d = document.createElement('div');
      d.className = 'q-item';
      d.innerHTML = `<span class="qt"></span><span class="qs"></span>`;
      d.firstChild.textContent = title; d.lastChild.textContent = sub;
      return d;
    };
    const counts = () => $$('.q-col', root).forEach((c) => ($('.qn', c).textContent = $('.q-list', c).children.length));
    const add = (col) => { const [t, s] = pool[n++ % pool.length]; const el = item(t, s[0]); el._s = s; el._i = 0; lists[col].prepend(el); return el; };
    add('done').lastChild.textContent = 'Done'; add('done').lastChild.textContent = 'Done'; add('working'); add('working'); const nd = add('needs'); nd.lastChild.textContent = needsCopy[0];
    counts();
    let tick = 0;
    whenVisible(root, () => setInterval(() => {
      tick++;
      $$('.q-item', lists.working).forEach((el) => { el._i = (el._i + 1) % el._s.length; el.lastChild.textContent = el._s[el._i]; });
      if (tick % 2) return;
      // needs → done, working → needs, new → working
      const nlast = lists.needs.lastElementChild;
      if (nlast) { lists.done.prepend(nlast); nlast.lastChild.textContent = 'Done'; nlast.style.animation = 'none'; void nlast.offsetWidth; nlast.style.animation = ''; }
      while (lists.done.children.length > 2) lists.done.lastElementChild.remove();
      const w = lists.working.lastElementChild;
      if (w) { lists.needs.prepend(w); w.lastChild.textContent = needsCopy[tick % needsCopy.length]; w.style.animation = 'none'; void w.offsetWidth; w.style.animation = ''; }
      add('working');
      counts();
    }, 1500));
  })();

  // ───────── ask_user ─────────
  (function ask() {
    const btns = $$('#ask .ask-opts button');
    const sent = $('#askSent');
    const txt = $('#askText');
    btns.forEach((b) => b.addEventListener('click', () => {
      btns.forEach((x) => { x.disabled = true; x.classList.toggle('picked', x === b); });
      txt.textContent = `“${b.dataset.r}”`;
      sent.classList.add('on');
      setTimeout(() => {
        sent.classList.remove('on');
        btns.forEach((x) => { x.disabled = false; x.classList.remove('picked'); });
      }, 3800);
    }));
  })();

  // ───────── take over terminal ─────────
  (function term() {
    const el = $('#term .typed');
    const text = el.dataset.type;
    const line = el.parentNode, ghost = line.cloneNode(true);
    ghost.classList.add('t-ghost');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.querySelector('.typed').textContent = text;
    line.before(ghost);
    if (reduced) return (el.textContent = text);
    let i = 0, hold = 0;
    whenVisible($('#term'), () => setInterval(() => {
      if (i <= text.length) el.textContent = text.slice(0, i++);
      else if (++hold > 30) { i = 0; hold = 0; }
    }, 70));
  })();

  // ───────── permission modes ─────────
  (function modes() {
    const btns = $$('#modes .seg button');
    const ind = $('#modes .seg-ind');
    const desc = $('#modeDesc');
    const D = [
      ['Read-only. The agent investigates and proposes a plan — nothing on disk changes.', 'linear-gradient(180deg,#1f3a36,#16262a)'],
      ['File edits are auto-accepted. Everything else asks.', 'linear-gradient(180deg,#2a2a38,#1e1e28)'],
      ['Full auto. It runs commands, edits, and tests without stopping.', 'linear-gradient(180deg,#3a2550,#251a35)'],
    ];
    const set = (i) => {
      btns.forEach((b, j) => b.classList.toggle('on', i === j));
      ind.style.transform = `translateX(${i * 100}%)`;
      ind.style.background = D[i][1];
      desc.textContent = D[i][0];
    };
    btns.forEach((b, i) => b.addEventListener('click', () => set(i)));
    set(1);
  })();

  // ───────── zero deps ─────────
  (function zero() {
    const el = $('#zeroCount');
    let ran = false;
    new IntersectionObserver(([e]) => {
      if (!e.isIntersecting || ran) return;
      ran = true;
      if (reduced) return (el.textContent = '0');
      const from = 1284, t0 = performance.now(), dur = 1800;
      const tick = (t) => {
        const p = clamp((t - t0) / dur);
        el.textContent = Math.round(from * Math.pow(1 - p, 3)).toLocaleString('en-US');
        if (p < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }, { threshold: 0.6 }).observe(el);
  })();

  // ───────── blocks marquee ─────────
  (function blocks() {
    const bars = (...cls) => cls.map((c, i) => `<span class="bar ${c}" style="width:${[88, 62, 74, 45][(i + cls.length) % 4]}%"></span>`).join('');
    const B = [
      ['hero', '#8f84ff', `<span class="big">Fixed.</span>${bars('')}`],
      ['diff', '#4cc38a', bars('r', 'g', 'g')],
      ['tests', '#4cc38a', `<span class="bar g" style="width:100%"></span><span class="bar" style="width:40%"></span>`],
      ['stats', '#2fd0b4', `<span class="big">48<small style="font-size:12px;color:#4cc38a"> +6</small></span>`],
      ['chart', '#8f84ff', '', 'row', [70, 40, 90, 25, 60, 35]],
      ['flow', '#8f84ff', '<i></i><s></s><i></i><s></s><i></i>', 'nodes'],
      ['steps', '#2fd0b4', bars('t', 't', '')],
      ['files', '#f0a33a', bars('v', '', 'v')],
      ['commits', '#f0a33a', bars('v', 'v')],
      ['question', '#8f84ff', bars('v', '', '')],
      ['callout', '#f0a33a', bars('', 't')],
      ['compare', '#2fd0b4', bars('r', 'g')],
      ['terminal', '#d9fff6', bars('t', '', '')],
      ['code', '#8f84ff', bars('v', '', 't')],
      ['tree', '#2fd0b4', bars('', 't', '')],
      ['checklist', '#4cc38a', bars('g', 'g', '')],
      ['markdown', '#c9c8d3', bars('', '', '')],
      ['image', '#ff8a8e', `<span class="bar v" style="height:100%;width:100%;border-radius:6px;background:linear-gradient(135deg,#6a5cff55,#2fd0b455)"></span>`],
      ['next', '#8f84ff', bars('v', 'v')],
    ];
    const chip = ([name, c, art, mode, cols]) => {
      const inner = cols ? cols.map((h) => `<span class="col" style="height:${h}%"></span>`).join('') : art;
      return `<div class="chip" style="--c:${c}"><span class="cn">${name}</span><div class="art ${mode || ''}">${inner}</div></div>`;
    };
    const a = B.slice(0, 10).map(chip).join('');
    const b = B.slice(10).concat(B.slice(0, 1)).map(chip).join('');
    $('#trackA').innerHTML = a + a;
    $('#trackB').innerHTML = b + b;
  })();

  // ───────── keyboard demo ─────────
  (function keyboard() {
    const list = $('#kbList');
    const toastEl = $('#kbToast');
    const sec = $('#keys');
    const ITEMS = [
      ['Flaky auth test fixed', 'api-server · 47 min · 6 blocks', 'Fake clock injected into SessionStore. 48 tests passing, 0 flakes in 200 runs.'],
      ['Drop Node 18 from CI?', 'cli · waiting on you', 'The matrix still runs 18. Drop it now, or keep it for one more release?'],
      ['Dark mode for settings', 'web · 12 min · 2 screenshots', '4 files changed. Contrast checked against WCAG AA in both themes.'],
      ['Audit dependencies', 'monorepo · plan mode · 6 min', '3 outdated majors, 1 low-severity advisory. Plan only — nothing changed.'],
    ];
    let items = [], focus = 0, active = false, toastT;

    const draw = () => {
      if (!items.length) {
        list.innerHTML = `<li class="empty"><b>Inbox zero.</b>Your agents are all caught up.</li>`;
        setTimeout(reset, 2200);
        return;
      }
      list.innerHTML = items.map((it, i) => `<li class="${i === focus ? 'focus' : ''} ${it.open ? 'open' : ''}" data-i="${i}"><div class="t">${it.t}</div><div class="s">${it.s}</div><div class="x"><div><p>${it.x}</p></div></div></li>`).join('');
    };
    const reset = () => { items = ITEMS.map(([t, s, x]) => ({ t, s, x, open: false })); focus = 0; draw(); };
    const toast = (m) => { toastEl.textContent = m; toastEl.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('on'), 1600); };
    const press = (k) => {
      const key = $(`.key[data-k="${CSS.escape(k)}"]`);
      if (key) { key.classList.add('down'); setTimeout(() => key.classList.remove('down'), 160); }
      if (!items.length) return;
      const cur = items[focus];
      switch (k) {
        case 'j': focus = Math.min(items.length - 1, focus + 1); draw(); break;
        case 'k': focus = Math.max(0, focus - 1); draw(); break;
        case 'o': cur.open = !cur.open; draw(); break;
        case 'e': {
          const li = $(`li[data-i="${focus}"]`, list);
          li.classList.add('done', 'gone');
          toast('✓ marked done → next');
          setTimeout(() => { items.splice(focus, 1); focus = Math.min(focus, items.length - 1); if (items[focus]) items[focus].open = true; draw(); }, 350);
          break;
        }
        case 't': toast('↗ claude --resume · Ghostty'); break;
        case 'r': cur.open = false; draw(); setTimeout(() => { cur.open = true; draw(); }, 250); toast('▶ replaying presentation'); break;
        case 'n': toast('✎ launcher focused'); break;
        case '/': toast(`↩ replying to “${cur.t}”`); break;
      }
    };
    $$('.key').forEach((b) => b.addEventListener('click', () => press(b.dataset.k)));
    list.addEventListener('click', (e) => {
      const li = e.target.closest('li[data-i]');
      if (!li) return;
      focus = +li.dataset.i; items[focus].open = !items[focus].open; draw();
    });
    new IntersectionObserver(([e]) => (active = e.isIntersecting), { threshold: 0.35 }).observe(sec);
    addEventListener('keydown', (e) => {
      if (!active || e.metaKey || e.ctrlKey || e.altKey || /input|textarea/i.test(e.target.tagName)) return;
      const k = e.key.toLowerCase();
      if (!'njko/ter'.includes(k) || k.length !== 1) return;
      e.preventDefault();
      press(k);
    });
    reset();
  })();

  // ───────── install tabs ─────────
  (function install() {
    const code = $('#installCode');
    const T = {
      desktop: [
        ['c', '# Opens the wisp desktop app. Electron downloads on first run.'],
        ['p', 'npx wisp-agents'],
        ['c', '# or launch a task in the current folder:'],
        ['c', '# npx wisp-agents "fix the flaky auth test"'],
      ],
      browser: [
        ['c', '# Same wisp in a browser tab. Node built-ins only.'],
        ['p', 'npx wisp-agents --browser'],
        ['o', '→ wisp running at http://localhost:4477'],
      ],
      cli: [
        ['c', '# Put wisp on your PATH, then use it from any folder.'],
        ['p', 'npm install -g wisp-agents'],
        ['p', 'wisp "fix the flaky auth test"'],
        ['p', 'wisp --mode plan "audit deps"'],
        ['p', 'wisp add ~/code/api-server'],
      ],
    };
    let cur = 'desktop';
    const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
    const show = (k) => {
      cur = k;
      $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === k));
      code.innerHTML = T[k].map(([t, s]) => t === 'p' ? `<span class="p">$ </span>${esc(s)}` : `<span class="${t}">${esc(s)}</span>`).join('\n');
    };
    $$('.tabs button').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
    const btn = $('#copyInstall');
    btn.addEventListener('click', () => copy(T[cur].filter(([t]) => t === 'p').map(([, s]) => s).join('\n'), btn));
    show('desktop');
  })();
})();
