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
