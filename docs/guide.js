// The guides (scripts/site.mjs guidePage): the reading bar, the table of contents that follows you,
// copy buttons on code, and the motion figures (scripts/figures.mjs).
//
// A motion figure is a list of steps. Each part says when it shows (data-at, data-until), and may
// set a value (data-v, as --v), a text (data-text) or a class (data-add="3:dim") per step; CSS does
// the moving. Figures play while on screen, pause off screen, and sit on their last step for people
// who prefer reduced motion.
(() => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const list = (s) => (s == null ? null : s.split(','));

  // ---------- reading bar ----------
  const bar = document.querySelector('.g-progress');
  const art = document.querySelector('.g-art');
  if (bar && art) {
    let raf = 0;
    const paint = () => {
      raf = 0;
      const r = art.getBoundingClientRect();
      const p = Math.min(1, Math.max(0, -r.top / Math.max(1, r.height - innerHeight)));
      bar.style.setProperty('--p', p.toFixed(4));
    };
    addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(paint); }, { passive: true });
    addEventListener('resize', paint);
    paint();
  }

  // ---------- table of contents: mark the section being read ----------
  const toc = [...document.querySelectorAll('.g-toc a[href^="#"]')];
  if (toc.length) {
    const heads = toc.map((a) => document.getElementById(a.hash.slice(1))).filter(Boolean);
    let current = null;
    const pick = () => {
      let h = heads[0];
      for (const x of heads) if (x.getBoundingClientRect().top < innerHeight * 0.3) h = x;
      if (h === current) return;
      current = h;
      for (const a of toc) a.toggleAttribute('aria-current', a.hash === `#${h.id}`);
    };
    addEventListener('scroll', pick, { passive: true });
    pick();
  }

  // ---------- ways to get wisp (the landing page's tabs, docs/main.js) ----------
  // Picking a tab updates the command, its Copy and the note, and every other box on the page
  // follows. Download shows this OS's app; on a Mac, the curl --app install (no "can't verify").
  const DL = 'https://github.com/M0xoo/wisp/releases/latest/download/';
  const MAC_APP = 'curl -fsSL https://trywisp.dev/install.sh | bash -s -- --app';
  const BUILDS = { mac: ['macOS', 'wisp-mac-arm64.dmg'], 'mac-x64': ['macOS', 'wisp-mac-x64.dmg'], win: ['Windows', 'wisp-windows-x64-setup.exe'], 'win-arm64': ['Windows', 'wisp-windows-arm64-setup.exe'], linux: ['Linux', 'wisp-linux-x64.deb'], 'linux-arm64': ['Linux', 'wisp-linux-arm64.deb'] };
  const plat = `${navigator.userAgentData?.platform || ''} ${navigator.platform || ''} ${navigator.userAgent}`;
  const os = /Win/i.test(plat) ? 'win' : /Linux|X11|CrOS/i.test(plat) && !/Android/i.test(plat) ? 'linux' : 'mac';
  let build = os;
  const file = (k = build) => DL + BUILDS[k][1];
  const link = (href, text) => `<a href="${href}">${text}</a>`;
  const others = () => ['mac', 'win', 'linux'].filter((k) => k !== os).map((k) => link(file(k), BUILDS[k][0])).join(', ');
  const appNote = () => ({
    mac: `No Node needed · or the ${link(file(), '.dmg')}: allow it in Privacy &amp; Security → Open Anyway · Also for ${others()}`,
    win: `No Node needed · if Windows says it protected your PC: More info → Run anyway · Also for ${others()}`,
    linux: `No Node needed · Debian and Ubuntu, or the ${link(file().replace('.deb', '.AppImage'), 'AppImage')} · Also for ${others()}`,
  })[os];
  const boxes = [...document.querySelectorAll('.g-install[data-tabs]')].map((box) => {
    const tabs = [...box.querySelectorAll('[role="tab"]')];
    const code = box.querySelector('[data-tab-code]');
    const copy = box.querySelector('[data-tab-copy]');
    const dl = box.querySelector('[data-tab-dl]');
    const note = box.querySelector('[data-tab-note]');
    const panel = box.querySelector('[role="tabpanel"]');
    let current = tabs[0];
    const pick = (tab, focus) => {
      current = tab;
      const app = tab.dataset.tab === 'app' && os !== 'mac';
      for (const t of tabs) {
        t.setAttribute('aria-selected', t === tab);
        t.tabIndex = t === tab ? 0 : -1;
      }
      dl.hidden = !app;
      copy.hidden = app;
      if (app) {
        dl.href = file();
        dl.querySelector('[data-dl-label]').textContent = `Download for ${BUILDS[build][0]}`;
        dl.querySelector('[data-dl-kind]').textContent = file().slice(file().lastIndexOf('.'));
      } else code.textContent = copy.dataset.copy = tab.dataset.tab === 'app' ? MAC_APP : tab.dataset.cmd;
      if (tab.dataset.tab === 'app') note.innerHTML = appNote(); else note.textContent = tab.dataset.note;
      panel.setAttribute('aria-labelledby', tab.id);
      if (focus) tab.focus();
    };
    const choose = (tab, focus) => {
      pick(tab, focus);
      for (const b of boxes) if (b.box !== box) b.show(tab.dataset.tab);
    };
    tabs.forEach((tab, i) => {
      tab.addEventListener('click', () => { choose(tab); });
      tab.addEventListener('keydown', (e) => {
        const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
        if (!step && e.key !== 'Home' && e.key !== 'End') return;
        e.preventDefault();
        choose(tabs[e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + step + tabs.length) % tabs.length], true);
      });
    });
    return { box, show: (k) => { pick(tabs.find((t) => t.dataset.tab === k) || tabs[0]); }, refresh: () => { pick(current); } };
  });
  navigator.userAgentData?.getHighEntropyValues?.(['architecture']).then(({ architecture }) => {
    if (architecture === 'arm' && os !== 'mac') build = `${os}-arm64`;
    if (architecture === 'x86' && os === 'mac') build = 'mac-x64';
    for (const b of boxes) b.refresh();
  }).catch(() => {});
  document.addEventListener('click', (e) => {
    const a = e.target.closest(`a[href^="${DL}"]`);
    if (a) window.posthog?.capture?.('download_clicked', { file: a.href.slice(DL.length) }, { transport: 'sendBeacon' });
  });

  // ---------- copy a link to the guide ----------
  for (const b of document.querySelectorAll('[data-link]')) b.addEventListener('click', async () => {
    const l = b.querySelector('span');
    try { await navigator.clipboard.writeText(location.href.split('#')[0]); if (l) l.textContent = 'Link copied'; } catch { if (l) l.textContent = 'Copy the address bar'; }
    setTimeout(() => { if (l) l.textContent = 'Copy link'; }, 1600);
  });

  // ---------- code: a bar with what it is and a Copy button ----------
  const LANG = { sh: 'Terminal', json: 'JSON' };
  for (const pre of document.querySelectorAll('.g-body pre')) {
    const wrap = document.createElement('div');
    wrap.className = 'g-code';
    const head = document.createElement('div');
    head.className = 'g-code-bar';
    const name = document.createElement('span');
    name.textContent = LANG[pre.dataset.lang] || 'Code';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'Copy';
    copy.setAttribute('aria-label', `Copy ${name.textContent.toLowerCase()} code`);
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(pre.innerText.trim()); copy.textContent = 'Copied'; } catch { copy.textContent = 'Select it'; }
      setTimeout(() => { copy.textContent = 'Copy'; }, 1600);
    });
    head.append(name, copy);
    pre.replaceWith(wrap);
    wrap.append(head, pre);
  }

  // ---------- motion figures ----------
  for (const fig of document.querySelectorAll('.mfig[data-steps]')) {
    const n = +fig.dataset.steps;
    const ms = +(fig.dataset.ms || 1500);
    const parts = [...fig.querySelectorAll('[data-at],[data-until],[data-v],[data-text],[data-add]')];
    const dots = [...fig.querySelectorAll('.mf-dots button')];
    const play = fig.querySelector('.mf-play');
    let step = 0;
    let timer = 0;
    let seen = false;
    let held = false; // paused by the person, not by scrolling away

    const paint = (s) => {
      step = s;
      for (const el of parts) {
        const d = el.dataset;
        if (d.at != null || d.until != null) {
          const on = s >= +(d.at || 0) && (d.until == null || s < +d.until);
          el.classList.toggle('on', on);
        }
        const v = list(d.v);
        if (v) el.style.setProperty('--v', v[Math.min(s, v.length - 1)]);
        const t = d.text != null ? d.text.split('|') : null;
        if (t) el.textContent = t[Math.min(s, t.length - 1)];
        if (d.add) for (const pair of d.add.split(',')) {
          const [k, cls] = pair.split(':');
          el.classList.toggle(cls, s >= +k);
        }
      }
      for (const b of dots) b.toggleAttribute('aria-current', s >= +b.dataset.step && s < +(b.dataset.end ?? Infinity));
    };
    // Back to the start without playing the way back: hide, jump, show.
    const rewind = () => {
      fig.classList.add('rewind');
      timer = setTimeout(() => {
        fig.classList.add('still');
        paint(0);
        void fig.offsetWidth;
        fig.classList.remove('still', 'rewind');
        timer = setTimeout(next, ms);
      }, 320);
    };
    const next = () => {
      if (step >= n - 1) return rewind();
      paint(step + 1);
      timer = setTimeout(next, step >= n - 1 ? ms * 2.4 : ms);
    };
    const stop = () => { clearTimeout(timer); timer = 0; };
    const start = () => { stop(); if (seen && !held && !reduce.matches) timer = setTimeout(next, step ? ms : 500); };
    const setHeld = (h) => {
      held = h;
      if (play) {
        play.setAttribute('aria-label', h ? 'Play the animation' : 'Pause the animation');
        play.title = play.getAttribute('aria-label');
        play.classList.toggle('paused', h);
      }
      if (h) stop(); else start();
    };

    fig.classList.add('still');
    paint(reduce.matches ? n - 1 : 0);
    void fig.offsetWidth;
    fig.classList.remove('still');
    if (reduce.matches) {
      fig.classList.add('done');
      play?.setAttribute('aria-label', 'Play the animation');
      if (play) play.title = 'Play the animation';
    }

    new IntersectionObserver(([e]) => {
      seen = e.isIntersecting;
      if (seen) start(); else stop();
    }, { threshold: 0.35 }).observe(fig);

    play?.addEventListener('click', () => {
      if (reduce.matches) { fig.classList.remove('done'); held = false; paint(0); seen = true; timer = setTimeout(next, ms); return; }
      setHeld(!held);
    });
    for (const b of dots) b.addEventListener('click', () => { setHeld(true); paint(+b.dataset.step); });
  }
})();
