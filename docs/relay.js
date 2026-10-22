// wisp site: a working copy of a task card's follow-up box, for "move a task to another computer
// or agent". Pick where the next follow-up runs (the Runs on button) and which harness takes it,
// press ↵, and the card does what the app does: packs the work, hands the history over, and
// carries on there. The landing page and the guide both mount it on [data-relay].

(() => {
  const ICON = {
    laptop: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 4.5h9v6h-9zM1.5 12.5h13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    server: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="4.5" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="2.5" y="9" width="11" height="4.5" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="5" cy="4.75" r=".9" fill="currentColor"/><circle cx="5" cy="11.25" r=".9" fill="currentColor"/></svg>',
    check: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    caret: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 6.5l3.5 3.5 3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };
  const PLACES = [
    { id: '', name: 'MacBook', sub: 'This computer', icon: 'laptop' },
    { id: 'devbox', name: 'devbox', sub: 'dev@devbox · has a checkout', icon: 'server' },
    { id: 'gpu', name: 'gpu-box', sub: 'ubuntu@gpu-box.tail · no checkout yet', icon: 'server' },
  ];
  const AGENTS = [
    { id: 'claude', name: 'Claude Code', model: 'Opus', logo: 'claudecode-color.svg' },
    { id: 'codex', name: 'Codex', model: 'gpt-5.5-codex', logo: 'codex-color.svg' },
    { id: 'opencode', name: 'opencode', model: 'any provider', logo: 'opencode.svg', mono: true },
  ];
  const FOLLOW_UP = 'Finish the other 5 call sites and run the full suite';
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const wait = (ms) => new Promise((r) => setTimeout(r, calm ? Math.min(ms, 120) : ms));
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const logo = (a, size = 16) => `<img src="/assets/logos/${a.logo}" alt="" width="${size}" height="${size}"${a.mono ? ' class="mono"' : ''} />`;
  const place = (id) => PLACES.find((p) => p.id === id);
  const agent = (id) => AGENTS.find((a) => a.id === id);
  const where = (p) => `<span class="rl-where">${ICON[p.icon]}${esc(p.name)}</span>`;

  function mount(root) {
    root.innerHTML = `
      <div class="rl-card">
        <div class="rl-head">
          <span class="rl-title">Migrate billing to Stripe v2</span>
          <span class="rl-pills" data-pills></span>
        </div>
        <ol class="rl-turns" data-turns></ol>
        <ol class="rl-steps" data-steps hidden></ol>
        <form class="rl-dock" autocomplete="off">
          <label class="sr" for="${root.id || 'relay'}-in">Follow-up</label>
          <input class="rl-input" id="${root.id || 'relay'}-in" value="${esc(FOLLOW_UP)}" maxlength="120" spellcheck="false" />
          <div class="rl-bar">
            <button type="button" class="rl-btn" data-pick="agent" aria-haspopup="menu" aria-expanded="false"></button>
            <button type="button" class="rl-btn" data-pick="place" aria-haspopup="menu" aria-expanded="false"></button>
            <span class="rl-hint" data-hint></span>
            <button class="rl-send" type="submit" aria-label="Send follow-up">↵</button>
          </div>
          <div class="rl-menu" role="menu" hidden></div>
        </form>
      </div>
      <p class="rl-foot"><span data-foot></span><button type="button" class="rl-replay" hidden>Replay</button></p>`;

    const $ = (s) => root.querySelector(s);
    const form = $('.rl-dock');
    const input = $('.rl-input');
    const menu = $('.rl-menu');
    const btnAgent = $('[data-pick="agent"]');
    const btnPlace = $('[data-pick="place"]');
    let st;
    let touched = false; // the visitor clicked something: stop the self-running demo
    let busy = false;

    function reset() {
      st = { at: '', ran: 'claude', next: { place: '', agent: 'claude' }, moved: null, n: 1, seen: { claude: 1 } };
      busy = false;
      input.disabled = false;
      input.value = FOLLOW_UP;
      input.placeholder = 'Follow up…';
      $('[data-turns]').innerHTML = turn({ n: 1, agent: 'claude', at: '', title: '9 of 14 call sites on Stripe v2', sub: '212 tests pass · stopped: the laptop is at 6%', state: 'done' });
      $('[data-steps]').hidden = true;
      $('[data-steps]').innerHTML = '';
      $('[data-foot]').textContent = '';
      $('.rl-replay').hidden = true;
      form.classList.remove('sent');
      paint();
    }

    function turn({ n, agent: a, at, title, sub, state }) {
      return `<li class="rl-turn" data-s="${state}">
        <div class="rl-meta"><span class="rl-n">Turn ${n}</span>${logo(agent(a), 14)}<span>${esc(agent(a).name)}</span>${where(place(at))}</div>
        <div class="rl-rep"><i class="rl-dot"></i><span><b>${esc(title)}</b><small>${esc(sub)}</small></span></div>
      </li>`;
    }

    function paint() {
      const p = place(st.next.place);
      const a = agent(st.next.agent);
      const movedPlace = st.next.place !== st.at;
      const movedAgent = st.next.agent !== st.ran;
      btnAgent.innerHTML = `${logo(a)}<span>${esc(a.name)}</span>${ICON.caret}`;
      btnAgent.classList.toggle('changed', movedAgent);
      btnPlace.innerHTML = `${ICON[p.icon]}<span>${esc(p.name)}</span>${ICON.caret}`;
      btnPlace.classList.toggle('changed', movedPlace);
      btnAgent.title = `Next follow-up runs on ${a.name}`;
      btnPlace.title = movedPlace ? `Your next follow-up moves this task from ${place(st.at).name} to ${p.name}, with its work and history` : `Runs on ${p.name}. Pick another computer for your next follow-up`;
      $('[data-hint]').textContent = busy ? '' : movedPlace || movedAgent ? `Follow up on ${p.name} with ${a.name}` : 'Pick a computer or an agent, then ↵';
      const here = place(st.at);
      $('[data-pills]').innerHTML = `${st.moved ? `<span class="rl-pill muted">From ${esc(st.moved)}</span>` : ''}<span class="rl-pill">${ICON[here.icon]}${esc(here.name)}</span>`;
    }

    function open(kind) {
      const btn = kind === 'agent' ? btnAgent : btnPlace;
      if (!menu.hidden && menu.dataset.kind === kind) return close();
      const rows = kind === 'agent'
        ? AGENTS.map((a) => row(a.id, logo(a, 18), a.name, a.id === st.ran ? 'Resumes its conversation' : `${a.model} · gets the turns it missed`, st.next.agent === a.id)).join('')
        : PLACES.map((p) => row(p.id, ICON[p.icon], p.name, p.id === st.at ? 'Where it is now' : p.sub, st.next.place === p.id)).join('');
      menu.innerHTML = `<div class="rl-mh">${kind === 'agent' ? 'Next follow-up runs with' : 'Next follow-up runs on'}</div>${kind === 'place' ? '<p class="rl-mnote">Another computer takes the task with it: its branch, uncommitted changes and history.</p>' : ''}${rows}`;
      menu.dataset.kind = kind;
      menu.style.left = `${btn.offsetLeft}px`;
      menu.hidden = false;
      btnAgent.setAttribute('aria-expanded', String(kind === 'agent'));
      btnPlace.setAttribute('aria-expanded', String(kind === 'place'));
    }
    function row(id, ic, name, sub, on) {
      return `<button type="button" class="rl-row${on ? ' on' : ''}" role="menuitemradio" aria-checked="${on}" data-k="${id}"><span class="rl-check">${ICON.check}</span><span class="rl-ic">${ic}</span><span class="rl-name"><b>${esc(name)}</b><small>${esc(sub)}</small></span></button>`;
    }
    function close() {
      menu.hidden = true;
      btnAgent.setAttribute('aria-expanded', 'false');
      btnPlace.setAttribute('aria-expanded', 'false');
    }
    function pick(kind, k) {
      st.next[kind] = k;
      close();
      paint();
    }

    async function send() {
      if (busy) return;
      close();
      busy = true;
      const from = place(st.at);
      const to = place(st.next.place);
      const a = agent(st.next.agent);
      const moving = to.id !== from.id;
      const switching = a.id !== st.ran;
      const text = input.value.trim() || 'Carry on';
      const n = st.n + 1;
      const missed = n - 1 - (moving ? 0 : st.seen[a.id] || 0); // turns this agent hasn't seen
      const handed = missed > 1 ? `turns ${n - missed}–${n - 1}` : `turn ${n - 1}`;
      input.value = '';
      input.placeholder = '';
      $('[data-foot]').textContent = '';
      $('.rl-replay').hidden = true;
      input.disabled = true;
      form.classList.add('sent');
      paint();

      const steps = $('[data-steps]');
      steps.hidden = false;
      const lines = moving
        ? [
            `Packed the branch and its uncommitted changes into a git bundle`,
            to.id === 'gpu' ? `Cloned the repo from origin on ${to.name}` : to.id ? `Found the project’s checkout on ${to.name}` : `Back to the project’s checkout on ${to.name}`,
            `Worktree on ${to.name}, same branch: wisp/stripe-v2`,
            `${a.name} starts a session there, with ${n > 2 ? `turns 1–${n - 1}` : 'turn 1'} handed over`,
          ]
        : switching
          ? st.seen[a.id]
            ? [`${a.name} resumes its own conversation`, `Told it what it missed: ${handed}`]
            : [`${a.name} starts its own conversation in the same folder`, `Handed it ${handed}: requests, reports, files edited`]
          : [`${a.name} resumes its conversation`];
      for (const l of lines) {
        steps.insertAdjacentHTML('beforeend', `<li class="rl-step"><i></i>${esc(l)}</li>`);
        const li = steps.lastElementChild;
        await wait(650);
        li.classList.add('ok');
      }
      await wait(300);
      if (moving) {
        st.moved = from.name;
        st.seen = {}; // conversations stay on the computer they ran on
      }
      st.at = to.id;
      st.ran = a.id;
      st.n = n;
      st.seen[a.id] = n;
      st.next = { place: st.at, agent: st.ran };
      paint();
      const first = n === 2;
      const list = $('[data-turns]');
      while (list.children.length > 2) list.firstElementChild.remove(); // the card shows the latest few
      $('[data-turns]').insertAdjacentHTML('beforeend', turn({ n, agent: a.id, at: to.id, title: text, sub: first ? 'Working · migrating invoices.ts' : 'Working…', state: 'working' }));
      const tn = $('[data-turns]').lastElementChild;
      tn.classList.add('new');
      tn.querySelector('b').textContent = text;
      await wait(900);
      tn.querySelector('small').textContent = 'Working · npm test (231 tests)';
      await wait(1100);
      tn.dataset.s = 'done';
      if (first) tn.querySelector('b').textContent = 'All 14 call sites on Stripe v2';
      tn.querySelector('small').textContent = '231 tests pass · ready to ship';
      steps.hidden = true;
      steps.innerHTML = '';
      $('[data-foot]').innerHTML = moving
        ? `The ${esc(from.name)} session is archived with <b>Continues on ${esc(to.name)}</b>. Each turn still says where it ran.`
        : switching
          ? `Each agent keeps its own conversation. Switch back and ${esc(agent('claude').name)} hears only what it missed.`
          : `Same agent, same computer: a plain follow-up.`;
      $('.rl-replay').hidden = false;
      busy = false;
      input.disabled = false;
      input.placeholder = `Follow up with ${a.name} on ${to.name}…`;
      form.classList.remove('sent');
      paint();
    }

    // The menus and the send button.
    root.addEventListener('pointerdown', () => { touched = true; }, { capture: true });
    btnAgent.addEventListener('click', () => { if (!busy) open('agent'); });
    btnPlace.addEventListener('click', () => { if (!busy) open('place'); });
    menu.addEventListener('click', (e) => {
      const r = e.target.closest('.rl-row');
      if (r) pick(menu.dataset.kind, r.dataset.k);
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      send();
    });
    document.addEventListener('pointerdown', (e) => { if (!root.contains(e.target)) close(); });
    root.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    $('.rl-replay').addEventListener('click', () => { reset(); });

    // Once on screen, it shows itself: devbox, Codex, ↵. Any click hands it over to the visitor.
    async function demo() {
      const steps = [
        () => open('place'),
        () => menu.querySelector('[data-k="devbox"]')?.classList.add('hover'),
        () => pick('place', 'devbox'),
        () => open('agent'),
        () => menu.querySelector('[data-k="codex"]')?.classList.add('hover'),
        () => pick('agent', 'codex'),
        () => $('.rl-send').classList.add('press'),
      ];
      for (const s of steps) {
        await wait(700);
        if (touched) return close();
        s();
      }
      await wait(160);
      $('.rl-send').classList.remove('press');
      if (!touched) send();
    }

    reset();
    if (calm) return;
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) {
        io.disconnect();
        setTimeout(() => { if (!touched) demo(); }, 500);
      }
    }, { threshold: 0.6 });
    io.observe(root);
  }

  document.querySelectorAll('[data-relay]').forEach(mount);
})();
