// wisp site: a working copy of "pick the agent, set the leash, take the wheel". Pick a harness (or
// Auto), pick a permission mode, and the same task runs the way it would in wisp: Plan only reads,
// Edits writes files but has its shell commands denied, Full auto runs everything. Take over (T)
// opens the task in a terminal with that harness's own resume command.
//
// Runs are in the DOM from the start of each run and only updated as it goes, so nothing replays
// its entry animation when you switch the agent or the mode back and forth.

(() => {
  const ICON = {
    spark: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5l1.4 4.1 4.1 1.4-4.1 1.4L8 12.5 6.6 8.4 2.5 7l4.1-1.4z" fill="currentColor"/><path d="M13 11l.6 1.4 1.4.6-1.4.6L13 15l-.6-1.4L11 13l1.4-.6z" fill="currentColor" opacity=".6"/></svg>',
    check: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    deny: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M4.2 11.8l7.6-7.6" stroke="currentColor" stroke-width="1.5"/></svg>',
    term: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M4.5 6l2 2-2 2M8.5 10.5h3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    back: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5L5.5 8l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };
  // The resume commands are the ones each adapter really uses (server/adapters/*).
  const AGENTS = [
    { id: 'auto', name: 'Auto', model: 'picks for you' },
    { id: 'claude', name: 'Claude Code', model: 'Opus', logo: 'claudecode-color.svg', resume: 'claude --resume 4e1c9a2b' },
    { id: 'codex', name: 'Codex', model: 'gpt-5.5-codex', logo: 'codex-color.svg', resume: 'codex resume 0199f3ac' },
    { id: 'cursor', name: 'Cursor', model: 'composer', logo: 'cursor.svg', mono: true, resume: 'cursor-agent --resume b81d07e2' },
    { id: 'opencode', name: 'opencode', model: 'any provider', logo: 'opencode.svg', mono: true, resume: 'opencode --session ses_7f3ac2' },
    { id: 'antigravity', name: 'Antigravity', model: 'Gemini', logo: 'antigravity-color.svg', resume: 'agy --conversation 7f3ac21b' },
    { id: 'grok', name: 'Grok', model: 'grok-code', logo: 'grok.svg', mono: true, resume: 'grok --resume 7f3ac21b' },
    { id: 'copilot', name: 'Copilot', model: 'GitHub', logo: 'githubcopilot.svg', mono: true, resume: 'copilot --resume=7f3ac21b' },
  ];
  const AUTO_PICK = 'claude';
  const MODES = [
    { id: 'plan', name: 'Plan', note: 'Read-only. It investigates and proposes; nothing on disk changes.' },
    { id: 'edits', name: 'Edits', note: 'File edits are accepted; shell commands that need approval are denied.' },
    { id: 'auto', name: 'Full auto', note: 'No prompts. Its own worktree, and a checkpoint before every turn.', def: true },
  ];
  const TASK = 'Add rate limiting to /login: 5 attempts per minute per IP';
  // What the same task does in each mode: the tool calls, then the report's headline.
  const RUNS = {
    plan: {
      steps: [['Read', 'src/routes/login.ts'], ['Grep', '"rateLimit|express-rate"'], ['Read', 'src/middleware/index.ts']],
      pill: ['plan', 'Plan ready'], title: 'Plan: a sliding-window limiter on /login',
      sub: '3 steps proposed. Nothing on disk changed.', next: 'auto',
    },
    edits: {
      steps: [['Read', 'src/routes/login.ts'], ['Edit', 'src/middleware/limit.ts', '+38'], ['Edit', 'src/routes/login.ts', '+4 −1'], ['Bash', 'npm test', 'denied', 'needs approval: denied in Edits']],
      pill: ['warn', 'Partly done'], title: 'Limiter added, tests not run',
      sub: 'The shell command needed approval, so Edits denied it.', next: 'auto',
    },
    auto: {
      steps: [['Read', 'src/routes/login.ts'], ['Edit', 'src/middleware/limit.ts', '+38'], ['Edit', 'src/routes/login.ts', '+4 −1'], ['Bash', 'npm test', '214 passed']],
      pill: ['ok', 'Done'], title: '/login is rate-limited',
      sub: '5 attempts per minute per IP; the 6th gets a 429. 214 tests pass.',
    },
  };

  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const wait = (ms) => new Promise((r) => setTimeout(r, calm ? Math.min(ms, 80) : ms));
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const agent = (id) => AGENTS.find((a) => a.id === id);
  const runner = (id) => agent(id === 'auto' ? AUTO_PICK : id);
  const mode = (id) => MODES.find((m) => m.id === id);
  const logo = (a, size = 16) => (a.logo ? `<img src="/assets/logos/${a.logo}" alt="" width="${size}" height="${size}"${a.mono ? ' class="mono"' : ''} />` : `<span class="ct-auto">${ICON.spark}</span>`);

  function mount(root) {
    root.innerHTML = `
      <div class="ct-book">
        <div class="sp-lh"><span><em>1</em>Pick the agent</span></div>
        <div class="ct-agents" role="radiogroup" aria-label="Harness">
          ${AGENTS.map((a) => `<button type="button" class="ct-agent" role="radio" aria-checked="false" data-agent="${a.id}">${logo(a)}<span>${esc(a.name)}</span></button>`).join('')}
        </div>
        <p class="ct-note" data-agent-note></p>
        <div class="sp-lh"><span><em>2</em>Set the leash</span></div>
        <div class="ct-modes" role="radiogroup" aria-label="Permission mode">
          ${MODES.map((m) => `<button type="button" role="radio" aria-checked="false" data-mode="${m.id}">${esc(m.name)}</button>`).join('')}
        </div>
        <p class="ct-note" data-mode-note></p>
        <div class="sp-lh"><span><em>3</em>Take the wheel</span></div>
        <button type="button" class="ct-take" data-take>${ICON.term}<span>Take over in your terminal</span><kbd>T</kbd></button>
        <p class="ct-note">Ghostty, iTerm, Warp, kitty, WezTerm, Terminal, Windows Terminal and more.</p>
      </div>
      <div class="ct-stage">
        <div class="ct-win" data-ui>
          <div class="win-bar"><span class="lights"><i></i><i></i><i></i></span><span class="win-title" data-wtitle>wisp</span></div>
          <div class="ct-app">
            <div class="ct-card">
              <div class="ct-head">
                <span class="ct-dot" data-dot></span>
                <span class="ct-title">${esc(TASK)}</span>
              </div>
              <div class="ct-meta"><span class="ct-who" data-who></span><span class="ct-mode" data-mpill></span><span class="ct-pill" data-pill hidden></span></div>
              <ol class="ct-steps" data-steps></ol>
              <div class="ct-rep" data-rep hidden><b data-rtitle></b><small data-rsub></small></div>
              <div class="ct-bar">
                <button type="button" class="ct-btn" data-next hidden></button>
                <span class="sw-grow"></span>
                <button type="button" class="ct-btn" data-take>${ICON.term}<span>Take over</span><kbd>T</kbd></button>
              </div>
            </div>
          </div>
          <div class="ct-term" data-term hidden>
            <button type="button" class="ct-back" data-back>${ICON.back}<span>Back to wisp</span></button>
            <pre data-tout></pre>
          </div>
        </div>
        <p class="sp-foot" data-foot aria-live="polite"></p>
      </div>`;

    const $ = (s) => root.querySelector(s);
    const steps = $('[data-steps]');
    const rep = $('[data-rep]');
    const pill = $('[data-pill]');
    const next = $('[data-next]');
    const term = $('[data-term]');
    const tout = $('[data-tout]');
    const foot = $('[data-foot]');
    let pick = 'auto';
    let leash = 'auto';
    let run = 0; // bumps on every new run, so an old one stops where it is
    let termRun = 0;

    const say = (html) => { foot.innerHTML = html; };

    function sync() {
      for (const b of root.querySelectorAll('[data-agent]')) b.setAttribute('aria-checked', String(b.dataset.agent === pick));
      for (const b of root.querySelectorAll('[data-mode]')) b.setAttribute('aria-checked', String(b.dataset.mode === leash));
      const r = runner(pick);
      $('[data-agent-note]').innerHTML = pick === 'auto'
        ? `Auto picked <b>${esc(r.name)} · ${esc(r.model)}</b>: it ran 9 of your last 10 merged api-server tasks.`
        : `<b>${esc(r.name)}</b> · ${esc(r.model)}. Pick a model and thinking level per task, too.`;
      $('[data-mode-note]').textContent = mode(leash).note;
      $('[data-who]').innerHTML = `${logo(r, 14)}${esc(r.name)}${pick === 'auto' ? '<small>via Auto</small>' : ''}`;
      $('[data-mpill]').textContent = mode(leash).name;
    }

    function stepHtml([tool, arg, result, why]) {
      const denied = result === 'denied';
      return `<li class="ct-step${denied ? ' deny' : ''}"><i class="ct-si"></i><b>${tool}</b><code>${esc(arg)}</code>${result && !denied ? `<em>${esc(result)}</em>` : ''}${denied ? `<em class="bad">${esc(why)}</em>` : ''}</li>`;
    }

    async function play() {
      const me = ++run;
      const live = () => me === run;
      const plan = RUNS[leash];
      steps.innerHTML = '';
      rep.hidden = true;
      pill.hidden = true;
      next.hidden = true;
      $('[data-dot]').className = 'ct-dot spin';
      for (const s of plan.steps) {
        await wait(420);
        if (!live()) return;
        steps.insertAdjacentHTML('beforeend', stepHtml(s));
        await wait(380);
        if (!live()) return;
        const li = steps.lastElementChild;
        li.classList.add(s[2] === 'denied' ? 'no' : 'ok');
        li.querySelector('.ct-si').innerHTML = s[2] === 'denied' ? ICON.deny : ICON.check;
      }
      await wait(300);
      if (!live()) return;
      $('[data-dot]').className = `ct-dot ${plan.pill[0]}`;
      $('[data-rtitle]').textContent = plan.title;
      $('[data-rsub]').textContent = plan.sub;
      rep.hidden = false;
      pill.className = `ct-pill ${plan.pill[0]}`;
      pill.textContent = plan.pill[1];
      pill.hidden = false;
      if (plan.next) {
        next.textContent = `Run it in ${mode(plan.next).name}`;
        next.hidden = false;
      }
      const r = runner(pick);
      say(leash === 'auto'
        ? `${esc(r.name)} did it all on its own, in its own worktree. <span class="muted"><b>Take over</b> picks it up in your terminal.</span>`
        : leash === 'plan'
          ? `${esc(r.name)} only read and proposed. <span class="muted">Issue triggers always start here.</span>`
          : `${esc(r.name)} edited files, and Edits stopped it at the shell. <span class="muted">Try Full auto.</span>`);
    }

    async function typeTerm() {
      const me = ++termRun;
      const r = runner(pick);
      const head = `<span class="c">~/.wisp/worktrees/api-server-7f3ac2</span> <span class="p">(wisp/add-rate-limiting)</span>\n<span class="p">$</span> `;
      $('[data-wtitle]').textContent = 'Ghostty — api-server';
      tout.innerHTML = head;
      for (let i = 1; i <= r.resume.length; i += calm ? r.resume.length : 2) {
        if (me !== termRun) return;
        tout.innerHTML = `${head}${esc(r.resume.slice(0, i))}<span class="caret"></span>`;
        await wait(22);
      }
      await wait(260);
      if (me !== termRun) return;
      tout.innerHTML = `${head}${esc(r.resume)}\n\n<span class="ok">↳</span> ${esc(r.name)} · resumed “Add rate limiting to /login” · 4 turns\n  same worktree, same branch, same history\n\n<span class="p">›</span> <span class="caret"></span>`;
    }

    function take(open) {
      term.hidden = !open;
      if (open) {
        typeTerm();
        say(`${esc(runner(pick).name)}’s own resume command opened the task in your terminal. <span class="muted">Esc or Back to return to wisp.</span>`);
      } else {
        termRun++;
        $('[data-wtitle]').textContent = 'wisp';
      }
    }

    root.addEventListener('click', (e) => {
      const a = e.target.closest('[data-agent]');
      const m = e.target.closest('[data-mode]');
      if (a || m) {
        if (a) pick = a.dataset.agent;
        if (m) leash = m.dataset.mode;
        sync();
        if (!term.hidden && a) typeTerm(); else { take(false); play(); }
        return;
      }
      if (e.target.closest('[data-take]')) { take(true); return; }
      if (e.target.closest('[data-back]')) { take(false); return; }
      if (e.target.closest('[data-next]')) {
        leash = RUNS[leash].next;
        sync();
        play();
      }
    });

    // T takes over, as in the app, while the demo is on screen and you aren't typing somewhere.
    let seen = false;
    new IntersectionObserver(([e]) => {
      seen = e.isIntersecting;
      if (seen && !run) play();
    }, { threshold: 0.3 }).observe(root);
    document.addEventListener('keydown', (e) => {
      if (!seen || e.metaKey || e.ctrlKey || e.altKey || e.target.closest('input, textarea, [contenteditable]')) return;
      if (e.key === 't' || e.key === 'T') take(term.hidden);
      else if (e.key === 'Escape' && !term.hidden) take(false);
    });

    sync();
    say('Pick an agent or a mode and the task runs again.');
  }

  document.querySelectorAll('[data-control]').forEach(mount);
})();
