// wisp site: a working copy of casting spells. Pick an ask (or type one), press ↵, and an agent
// "writes" the spell: it lands in the spell list, turned on, and the little wisp window beside it
// changes the way the real app does. Switch a spell off and the window is back as it was.
// The landing page and the spells guide both mount it on [data-spells].
//
// The window's spell parts are always in the DOM; a spell only flips a class on the window, so
// turning spells on and off never re-inserts nodes (and never replays their entry animations).

(() => {
  const ICON = {
    spark: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5l1.4 4.1 4.1 1.4-4.1 1.4L8 12.5 6.6 8.4 2.5 7l4.1-1.4z" fill="currentColor"/><path d="M13 11l.6 1.4 1.4.6-1.4.6L13 15l-.6-1.4L11 13l1.4-.6z" fill="currentColor" opacity=".6"/></svg>',
    wizard: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 18.5L11.3 4.6c.3-.9 1.4-1.2 2.1-.6l4.3 3.6-3.2.3 2.6 10.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.5 19.2c5.5 1.6 11.5 1.6 17 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M11.5 10.5l.6 1.5 1.5.6-1.5.6-.6 1.5-.6-1.5-1.5-.6 1.5-.6z" fill="currentColor"/></svg>',
    github: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>',
    stats: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 13V8.5M8 13V3.5M12.5 13v-6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    agent: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="6" cy="5.5" r="2.3" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M1.8 13.5c.6-2.3 2.2-3.5 4.2-3.5s3.6 1.2 4.2 3.5M10.5 3.6a2.2 2.2 0 010 4.1M12 10.2c1.2.5 2 1.6 2.3 3.3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    check: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    code: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    search: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.3" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10.2 10.2l3.3 3.3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    bolt: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 1.5L3.5 9H8l-1 5.5L12.5 7H8z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
    x: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  };

  // The spells you can cast here. `spell` is the real file (as wisp's spell reference shows it);
  // `reach` is what the review card says about it; `match` maps a typed ask to it.
  const SPELLS = [
    {
      id: 'my-prs', chip: 'A floating button for my PRs', reach: 'Reads GitHub',
      ask: 'a floating button that opens all my open PRs, with how many there are',
      sample: 'gh search prs --author @me --state open', match: /\bprs?\b|pull|float/i,
      done: '<b>My PRs</b> floats in the corner with a live count. Click it.',
      spell: {
        wispSpell: 1, id: 'my-prs', name: 'My PRs', version: '1.0.0', description: 'Open every PR you have open on GitHub, from a floating button.',
        data: { prs: { gh: ['search', 'prs', '--author', '@me', '--state', 'open', '--json', 'url,title,repository'], refresh: 120 } },
        buttons: [{ slot: 'float', icon: 'github', label: 'My PRs', badge: { count: 'prs' }, do: { openAll: { data: 'prs', field: 'url' } } }],
      },
    },
    {
      id: 'tool-stats', chip: 'My tool stats in the top bar', reach: 'Safe',
      ask: 'a top bar button with my wisp tool stats for the last 30 days',
      sample: 'wisp /usage/tools?days=30', match: /stat|usage|tool|chart|top ?bar/i,
      done: 'A <b>Tools</b> button joined the top bar. It opens a dialog drawn from your usage.',
      spell: {
        wispSpell: 1, id: 'tool-stats', name: 'Tool stats', version: '1.0.0', description: 'A top bar button with your tool calls for the last 30 days.',
        data: { tools: { wisp: '/usage/tools?days=30' } },
        buttons: [{ slot: 'topbar', icon: 'stats', label: 'Tools', do: { panel: 'tools' } }],
        panels: [{ id: 'tools', title: 'Tool calls · last 30 days', as: 'dialog', data: ['tools'], render: 'tools' }],
        script: "export function tools({ tools: t }) {\n  return [\n    { type: 'stats', items: [{ label: 'tool calls', value: t.total.calls }, { label: 'turns', value: t.total.turns }] },\n    { type: 'chart', title: 'By kind', items: t.kinds.map((k) => ({ label: k.kind, value: k.calls })) },\n  ];\n}",
      },
    },
    {
      id: 'compact-cards', chip: 'Compact cards, Open PR on hover', reach: 'Safe',
      ask: 'compact cards with bold titles, no project chip, and an Open PR button on cards that have one',
      sample: 'card parts: head, title, project', match: /compact|card|dense|tight/i,
      done: 'Cards are tighter, titles bolder, and the PR card has an <b>Open PR</b> button.',
      spell: {
        wispSpell: 1, id: 'compact-cards', name: 'Compact cards', version: '1.0.0', description: 'Tighter cards with bold titles, the PR first, and Open PR on hover.',
        parts: { card: { props: { density: 'compact' } }, 'card.title': { style: { fontWeight: '650' } }, 'card.head': { order: ['pr', 'pill', 'time'] } },
        ui: { hide: ['card.machine', 'card.project'] },
        buttons: [{ slot: 'card.hover', icon: 'github', label: 'Open PR', when: { hasPr: true }, do: { open: '{pr.url}' } }],
      },
    },
    {
      id: 'quick-replies', chip: 'Quick replies + a second opinion', reach: 'Acts for you',
      ask: 'quick replies above the follow-up box, and a button that asks Codex for a second opinion',
      sample: 'follow-up box slots', match: /quick|repl|chip|second|opinion|follow/i,
      done: 'Quick replies sit above the follow-up box, and <b>Second opinion</b> reruns it on Codex.',
      spell: {
        wispSpell: 1, id: 'quick-replies', name: 'Quick replies', version: '1.0.0', description: 'Quick replies above the follow-up box, and a second opinion from Codex.',
        buttons: [
          { slot: 'composer.chips', label: 'Run the tests', do: { send: 'Run the tests and show me the output.' } },
          { slot: 'composer.chips', label: 'Explain why…', do: { insert: 'Explain why ' } },
          { slot: 'composer.bar', icon: 'agent', label: 'Second opinion', do: { rerun: { agent: 'codex', mode: 'plan', prompt: 'Review the changes on branch {branch} and say what you would do differently.' } } },
        ],
      },
    },
    {
      id: 'deploy-block', chip: 'A deploy block for agents', reach: 'Safe',
      ask: 'a deploy block agents can use to show where they deployed and whether it is healthy',
      sample: 'report blocks', match: /deploy|block|report|ship/i,
      done: 'Agents now know a <b>deploy</b> block. The next report that deploys ends with one.',
      spell: {
        wispSpell: 1, id: 'deploy-block', name: 'Deploy block', version: '1.0.0', description: 'A deploy block agents end their reports with: where it went, and if it is healthy.',
        blocks: [{ type: 'deploy', doc: '{"type":"deploy","env":"staging","url":"https://…","status":"ok|failed","checks":[{"label":"health","ok":true}]} After you deploy: where it went and whether it is healthy.', summary: 'Deployed {env} → {url} ({status})', render: 'deploy' }],
        script: "export function deploy(b) {\n  return [\n    { type: 'callout', tone: b.status === 'ok' ? 'success' : 'danger', title: `${b.env} · ${b.status}`, text: b.url },\n    { type: 'checklist', items: (b.checks || []).map((c) => ({ text: c.label, done: !!c.ok })) },\n  ];\n}",
      },
    },
    {
      id: 'violet', chip: 'A violet look, monospace prompt', reach: 'Safe',
      ask: 'make wisp violet, rounder, with a monospace prompt box',
      sample: 'tokens and parts', match: /violet|purple|colou?r|look|theme|mono|font|round|style/i,
      done: 'wisp is violet and rounder, and the prompt box is monospace.',
      spell: {
        wispSpell: 1, id: 'violet', name: 'Violet', version: '1.0.0', description: 'A violet, rounder wisp with a monospace prompt box.',
        ui: { tokens: { '--accent': '#7c5cff', '--radius': '14px' }, dark: { '--accent': '#a48bff' } },
        parts: { 'launcher.input': { props: { monospace: true, placeholder: 'Next task…' } } },
      },
    },
  ];

  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const wait = (ms) => new Promise((r) => setTimeout(r, calm ? Math.min(ms, 120) : ms));
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const byId = (id) => SPELLS.find((s) => s.id === id);
  const reachClass = (r) => ({ Safe: 'safe', 'Reads GitHub': 'reads', 'Acts for you': 'acts' })[r];

  // JSON.stringify(…, 2), with lists of plain values kept on one line.
  function pretty(obj) {
    return JSON.stringify(obj, null, 2).replace(/\[\s*\n((?:\s*(?:"(?:[^"\\]|\\.)*"|-?\d[\d.]*|true|false|null),?\n)+)\s*\]/g, (m, items) => `[${items.split('\n').map((x) => x.trim()).filter(Boolean).join(' ')}]`);
  }

  // A light JSON highlighter: keys, strings, numbers and booleans.
  function highlight(obj) {
    return esc(pretty(obj)).replace(/("(?:[^"\\]|\\.)*")(\s*:)?|\b(true|false|null|-?\d+(?:\.\d+)?)\b/g, (m, str, colon, lit) =>
      str ? `<span class="${colon ? 'k' : 's'}">${str}</span>${colon || ''}` : `<span class="n">${lit}</span>`);
  }

  function windowHtml() {
    return `
      <div class="sw-win" data-win>
        <div class="win-bar"><span class="lights"><i></i><i></i><i></i></span><span class="win-title">wisp</span></div>
        <div class="sw-app">
          <div class="sw-top">
            <span class="sw-brand"><i></i>wisp</span>
            <span class="sw-proj on">All <b>3</b></span><span class="sw-proj"><i style="--c:#7c6cd8"></i>api-server</span><span class="sw-proj sw-hide-s"><i style="--c:#2a9d8f"></i>web-app</span>
            <span class="sw-grow"></span>
            <button type="button" class="sw-tb sw-x" data-x="tool-stats" data-act="tools">${ICON.stats}<span>Tools</span></button>
            <span class="sw-tb sw-hide-s">${ICON.bolt}<span>Automations</span></span>
            <span class="sw-tb">${ICON.search}<span class="sw-hide-s">Search</span></span>
          </div>
          <div class="sw-launch">
            <div class="sw-ph"><span class="sw-ph-a">What should I go do?</span><span class="sw-ph-b">Next task…</span></div>
            <div class="sw-lbar"><span class="sw-runner">${ICON.spark}Auto</span><span class="sw-grow"></span><span class="sw-enter">↵</span></div>
          </div>
          <div class="sw-feed">
            <div class="sw-gh">Needs you <span>2</span></div>
            <div class="sw-card open">
              <div class="sw-head">
                <span class="sw-dot"></span>
                <span class="sw-title">Fix the flaky session-expiry test</span>
                <span class="sw-pill ok">Done</span><span class="sw-chip-proj">api-server</span><span class="sw-time">5m</span>
              </div>
              <div class="sw-body">
                <p class="sw-sub">The test slept 50 ms and raced the token TTL. SessionStore now takes a clock.</p>
                <div class="sw-deploy sw-x" data-x="deploy-block">
                  <div class="sw-callout"><b>staging · ok</b><span>https://staging.acme.dev</span></div>
                  <ul><li>${ICON.check}health</li><li>${ICON.check}migrations</li><li>${ICON.check}smoke tests</li></ul>
                </div>
                <div class="sw-chips sw-x" data-x="quick-replies">
                  <button type="button" data-act="send">Run the tests</button><button type="button" data-act="insert">Explain why…</button>
                </div>
                <div class="sw-reply">
                  <span class="sw-reply-in" data-reply>Ask a follow-up…</span>
                  <div class="sw-rbar"><button type="button" class="sw-tb sw-x" data-x="quick-replies" data-act="rerun">${ICON.agent}<span>Second opinion</span></button><span class="sw-grow"></span><span class="sw-enter">↵</span></div>
                </div>
              </div>
            </div>
            <div class="sw-card">
              <div class="sw-head">
                <span class="sw-dot"></span>
                <span class="sw-title">Paginate the /invoices endpoint</span>
                <span class="sw-pill ok sw-hide-s">Done</span><span class="sw-pill pr">#184</span>
                <button type="button" class="sw-hover sw-x" data-x="compact-cards" data-act="pr" aria-label="Open PR">${ICON.github}</button>
                <span class="sw-chip-proj">api-server</span><span class="sw-time">28m</span>
              </div>
              <p class="sw-sub">Added ?cursor and ?limit (default 50, max 200).</p>
            </div>
            <div class="sw-gh">Working <span>1</span></div>
            <div class="sw-card">
              <div class="sw-head">
                <span class="sw-dot spin"></span>
                <span class="sw-title">Upgrade to Node 22</span>
                <span class="sw-chip-proj">web-app</span><span class="sw-time">2m</span>
              </div>
              <p class="sw-sub">Running npm test · 3 failing in date-fns adapter</p>
            </div>
          </div>
          <button type="button" class="sw-float sw-x" data-x="my-prs" data-act="prs">${ICON.github}<span>My PRs</span><b>4</b></button>
          <div class="sw-dialog" data-dialog hidden>
            <div class="sw-dlg" role="dialog" aria-label="Tool calls, last 30 days">
              <div class="sw-dlg-h"><b>Tool calls · last 30 days</b><button type="button" data-act="close" aria-label="Close">${ICON.x}</button></div>
              <div class="sw-stats"><div><b>1,284</b><span>tool calls</span></div><div><b>212</b><span>turns</span></div></div>
              <div class="sw-bars">${[['Edit', 412], ['Bash', 356], ['Read', 301], ['Grep', 158], ['delegate', 57]].map(([k, v]) => `<div><span>${k}</span><i style="--w:${Math.round((v / 412) * 100)}%"></i><em>${v}</em></div>`).join('')}</div>
            </div>
          </div>
          <div class="sw-toast" data-toast hidden></div>
        </div>
      </div>`;
  }

  function mount(root) {
    const uid = root.id || 'spells';
    root.innerHTML = `
      <div class="sp-book">
        <form class="sp-cast" autocomplete="off">
          <label class="sr" for="${uid}-in">Cast a spell</label>
          <textarea class="sp-input" id="${uid}-in" rows="2" maxlength="160" spellcheck="false" placeholder="/spell what should wisp do differently?"></textarea>
          <div class="sp-bar">
            <span class="sp-hint">${ICON.wizard}<span data-hint>Pick one below, or type your own</span></span>
            <button class="sp-send" type="submit" aria-label="Cast the spell">↵</button>
          </div>
        </form>
        <div class="sp-asks" data-asks></div>
        <ol class="sp-steps" data-steps hidden></ol>
        <div class="sp-lh"><span>Your spells</span><button type="button" class="sp-alloff" data-alloff>Turn every spell off</button></div>
        <ul class="sp-list" data-list></ul>
        <div class="sp-json" data-json hidden>
          <div class="sp-json-h"><span class="sp-json-name" data-json-name></span><span class="muted">~/.wisp/spells</span></div>
          <pre><code data-code></code></pre>
        </div>
      </div>
      ${windowHtml()}
      <p class="sp-foot" data-foot aria-live="polite"></p>`;

    const $ = (s) => root.querySelector(s);
    const form = $('.sp-cast');
    const input = $('.sp-input');
    const send = $('.sp-send');
    const asks = $('[data-asks]');
    const steps = $('[data-steps]');
    const list = $('[data-list]');
    const win = $('[data-win]');
    const json = $('[data-json]');
    const foot = $('[data-foot]');
    const hint = $('[data-hint]');
    const toastEl = $('[data-toast]');
    const dialog = $('[data-dialog]');
    const reply = $('[data-reply]');

    const cast = []; // ids in the order they were cast
    const on = new Set();
    let shown = '';
    let busy = false;
    let toastT = 0;

    const say = (html) => { foot.innerHTML = html; };
    function toast(text) {
      clearTimeout(toastT);
      toastEl.textContent = text;
      toastEl.hidden = false;
      toastEl.classList.remove('in');
      void toastEl.offsetWidth;
      toastEl.classList.add('in');
      toastT = setTimeout(() => { toastEl.hidden = true; }, 2400);
    }

    function renderAsks() {
      const left = SPELLS.filter((s) => !cast.includes(s.id));
      asks.innerHTML = left.length
        ? left.map((s) => `<button type="button" class="sp-ask" data-ask="${s.id}">${esc(s.chip)}</button>`).join('')
        : '<span class="sp-asks-done">That’s every example here. In wisp, ask for anything the spell reference allows.</span>';
    }

    // Rows are added once, when a spell is cast, and only updated afterwards.
    function addRow(s) {
      const li = document.createElement('li');
      li.className = 'sp-row new';
      li.dataset.id = s.id;
      li.innerHTML = `
        <span class="sp-ic">${ICON.wizard}</span>
        <span class="sp-name"><b>${esc(s.spell.name)}</b><small>v${s.spell.version} · ${esc(s.spell.description || s.ask)}</small></span>
        <span class="sp-reach ${reachClass(s.reach)}">${esc(s.reach)}</span>
        <button type="button" class="sp-code-btn" data-show="${s.id}" aria-label="Show ${esc(s.spell.name)} JSON" aria-pressed="false">${ICON.code}</button>
        <button type="button" class="sp-switch" role="switch" aria-checked="false" aria-label="${esc(s.spell.name)}" data-toggle="${s.id}"><i></i></button>`;
      list.prepend(li);
    }

    function sync() {
      for (const s of SPELLS) win.classList.toggle(`on-${s.id}`, on.has(s.id));
      for (const li of list.children) {
        const isOn = on.has(li.dataset.id);
        li.classList.toggle('off', !isOn);
        li.querySelector('.sp-switch').setAttribute('aria-checked', String(isOn));
        li.querySelector('.sp-code-btn').setAttribute('aria-pressed', String(shown === li.dataset.id));
      }
      $('[data-alloff]').hidden = !on.size;
      if (!on.has('tool-stats')) dialog.hidden = true;
    }

    function show(id) {
      shown = id;
      const s = byId(id);
      json.hidden = !s;
      if (s) {
        $('[data-json-name]').textContent = `${s.id}.spell.json`;
        $('[data-code]').innerHTML = highlight(s.spell);
      }
      sync();
    }

    // A short glow on what a spell just changed, so the eye finds it.
    function flash(id) {
      const els = [...win.querySelectorAll(`[data-x="${id}"]`)];
      const targets = els.length ? els : id === 'violet' ? [win.querySelector('.sw-launch')] : [win.querySelector('.sw-feed')];
      for (const el of targets) {
        el.classList.remove('sw-glow');
        void el.offsetWidth;
        el.classList.add('sw-glow');
      }
    }

    async function type(text) {
      input.value = '/spell ';
      for (let i = 0; i < text.length; i += calm ? text.length : 3) {
        input.value = `/spell ${text.slice(0, i + 3)}`;
        await wait(14);
      }
      input.value = `/spell ${text}`;
    }

    async function run(s) {
      if (busy) return;
      busy = true;
      form.classList.add('sent');
      send.classList.add('press');
      setTimeout(() => send.classList.remove('press'), 140);
      steps.hidden = false;
      steps.innerHTML = '';
      const lines = ['Reading the spell reference', `Sampling your data · ${s.sample}`, 'Checking the spell with wisp'];
      for (const line of lines) {
        const li = document.createElement('li');
        li.className = 'sp-step';
        li.innerHTML = `<i></i><span>${esc(line)}</span>`;
        steps.append(li);
        await wait(620);
        li.classList.add('ok');
      }
      await wait(260);
      steps.hidden = true;
      cast.push(s.id);
      on.add(s.id);
      addRow(s);
      renderAsks();
      show(s.id);
      flash(s.id);
      // On narrow screens the window sits above the spell list: bring it back into view.
      const r = win.getBoundingClientRect();
      if (r.top < -40 || r.top > innerHeight - 160) win.scrollIntoView({ block: 'start', behavior: calm ? 'auto' : 'smooth' });
      say(`${s.done} <span class="muted">Switch it off and wisp is back as it was.</span>`);
      input.value = '';
      form.classList.remove('sent');
      hint.textContent = 'Cast another, or switch one off';
      busy = false;
    }

    asks.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-ask]');
      if (!b || busy) return;
      const s = byId(b.dataset.ask);
      b.disabled = true;
      await type(s.ask);
      await wait(220);
      run(s);
    });

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (busy) return;
      const text = input.value.replace(/^\/spell\s*/, '').trim();
      if (!text) { input.focus(); return; }
      const s = SPELLS.find((x) => !cast.includes(x.id) && x.match.test(text)) || SPELLS.find((x) => x.match.test(text));
      if (!s) {
        say('This page only knows the examples above. <span class="muted">In wisp, an agent writes whatever you ask for, within what spells can do.</span>');
        return;
      }
      if (cast.includes(s.id)) {
        on.add(s.id);
        show(s.id);
        flash(s.id);
        input.value = '';
        say(`You already have <b>${esc(s.spell.name)}</b>. In wisp, a follow-up on its card changes it.`);
        return;
      }
      run(s);
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
    });

    form.addEventListener('click', (e) => { if (!e.target.closest('button')) input.focus(); });

    list.addEventListener('click', (e) => {
      const t = e.target.closest('[data-toggle]');
      if (t) {
        const id = t.dataset.toggle;
        if (on.has(id)) on.delete(id); else { on.add(id); flash(id); }
        sync();
        const s = byId(id);
        say(on.has(id) ? `<b>${esc(s.spell.name)}</b> is on again.` : `<b>${esc(s.spell.name)}</b> is off. Everything it added or changed is gone.`);
        return;
      }
      const c = e.target.closest('[data-show]');
      if (c) show(shown === c.dataset.show ? '' : c.dataset.show);
    });

    $('[data-alloff]').addEventListener('click', () => {
      on.clear();
      sync();
      say('Every spell is off: this is plain wisp. <span class="muted">In the app: Settings → Spells, or start wisp with <code>WISP_SAFE=1</code>.</span>');
    });

    win.addEventListener('click', (e) => {
      const a = e.target.closest('[data-act]');
      if (!a) return;
      const act = a.dataset.act;
      if (act === 'prs') toast('Opens your 4 open PRs on GitHub');
      else if (act === 'pr') toast('Opens #184 on GitHub');
      else if (act === 'tools') dialog.hidden = false;
      else if (act === 'close') dialog.hidden = true;
      else if (act === 'send') toast('Sent: Run the tests and show me the output.');
      else if (act === 'insert') { reply.textContent = 'Explain why '; reply.classList.add('typed'); }
      else if (act === 'rerun') toast('Reruns the task on Codex, in Plan mode');
    });
    dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.hidden = true; });

    // Start with one spell already kept, so the window shows what a spell looks like.
    const first = byId('my-prs');
    cast.push(first.id);
    on.add(first.id);
    addRow(first);
    list.firstElementChild.classList.remove('new');
    renderAsks();
    show(first.id);
    say('<b>My PRs</b> is on: see the button in the window’s corner. Cast another one.');
  }

  document.querySelectorAll('[data-spells]').forEach(mount);
})();
