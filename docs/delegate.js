// wisp site: a working copy of Delegate. The lead (Claude Code on this computer) has three
// delegates; put each one with the lead or on a machine and press Delegate. Ones with the lead work
// in its folder; ones on a machine get a copy of the lead's work sent there, and their changes come
// back as a patch, as server/services/relay.js does.
//
// The rows, machine chips and live lines are in the DOM from the start and only updated as a run
// goes, so nothing replays its entry animation when you move a delegate and it runs again.

(() => {
  const ICON = {
    laptop: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="3.5" width="10" height="7" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M1.5 12.5h13" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    server: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="4.5" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="2.5" y="9" width="11" height="4.5" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="5" cy="4.75" r=".8" fill="currentColor"/><circle cx="5" cy="11.25" r=".8" fill="currentColor"/></svg>',
    team: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="6" cy="5.5" r="2.3" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M1.8 13c.6-2.3 2.2-3.5 4.2-3.5s3.6 1.2 4.2 3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M10.5 3.6a2.2 2.2 0 0 1 0 4M12 9.8c1.1.5 1.9 1.6 2.2 3.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    check: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    send: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 8h9.5M8.5 4.5 12 8l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };
  const PLACES = [
    { id: '', name: 'With the lead', short: 'With the lead', icon: 'team' },
    { id: 'gpu', name: 'gpu-box', short: 'gpu-box', icon: 'server' },
    { id: 'dev', name: 'devbox', short: 'devbox', icon: 'server' },
  ];
  const LEAD = { name: 'Claude Code', model: 'Opus', logo: 'claudecode-color.svg' };
  const TASK = 'Move billing to the new payments API';
  // Each delegate: its run, what it changes, and where it runs to begin with.
  const TEAM = [
    {
      id: 'heavy', name: 'Claude Code', model: { '': 'Opus', gpu: 'Opus · max thinking', dev: 'Opus' }, logo: 'claudecode-color.svg', use: 'the big refactor', place: 'gpu',
      task: 'Move src/billing/* to PaymentsClient', steps: ['Reading src/billing/invoice.ts', 'Editing 9 files in src/billing', 'Running tsc --noEmit'], title: 'billing/* uses PaymentsClient', diff: '+212 −148', files: 9,
    },
    {
      id: 'tester', name: 'Codex', model: { '': 'gpt-5.5-codex', gpu: 'gpt-5.5-codex', dev: 'gpt-5.5-codex' }, logo: 'codex-color.svg', use: 'writing and running tests', place: '',
      task: 'Test PaymentsClient: retries, refunds, webhooks', steps: ['Reading src/payments/client.ts', 'Writing tests/payments.test.ts', 'Running npm test'], title: '18 new tests pass', diff: '+164', files: 1,
    },
    {
      id: 'docs', name: 'opencode', model: { '': 'a cheap model', gpu: 'qwen3-coder (local)', dev: 'a cheap model' }, logo: 'opencode.svg', mono: true, use: 'README and changelog', place: 'dev',
      task: 'Document the payments switch in README and CHANGELOG', steps: ['Reading README.md', 'Editing README.md', 'Editing CHANGELOG.md'], title: 'Docs updated', diff: '+15 −2', files: 2,
    },
  ];

  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const wait = (ms) => new Promise((r) => setTimeout(r, calm ? Math.min(ms, 60) : ms));
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const place = (id) => PLACES.find((p) => p.id === id);
  const logo = (a, size = 16) => `<img src="/assets/logos/${a.logo}" alt="" width="${size}" height="${size}"${a.mono ? ' class="mono"' : ''} />`;

  function mount(root) {
    const picks = Object.fromEntries(TEAM.map((m) => [m.id, m.place]));
    root.innerHTML = `
      <div class="dg-book">
        <div class="sp-lh"><span><em>1</em>Put each delegate somewhere</span></div>
        <div class="dg-pop">
          <div class="dg-lead"><span class="dg-tag">Lead</span>${logo(LEAD)}<span class="dg-lrun">${esc(LEAD.name)} · ${esc(LEAD.model)}</span><span class="dg-on">on</span><span class="dg-chip">${ICON.laptop}<span>This computer</span></span></div>
          ${TEAM.map((m) => `
            <div class="dg-row" data-row="${m.id}">
              <div class="dg-top">${logo(m)}<b>@${m.id}</b><span class="dg-model" data-model></span></div>
              <div class="dg-places" role="radiogroup" aria-label="Where @${m.id} runs">
                ${PLACES.map((p) => `<button type="button" role="radio" aria-checked="false" data-place="${p.id}">${ICON[p.icon]}<span>${esc(p.short)}</span></button>`).join('')}
              </div>
              <small class="dg-use">Use for: ${esc(m.use)}</small>
            </div>`).join('')}
        </div>
        <div class="sp-lh"><span><em>2</em>Let the lead hand out the work</span></div>
        <button type="button" class="ct-take dg-go" data-go>${ICON.send}<span>Delegate</span></button>
        <p class="ct-note">Each machine runs the harness and model installed there.</p>
      </div>
      <div class="dg-stage">
        <div class="ct-win" data-ui>
          <div class="win-bar"><span class="lights"><i></i><i></i><i></i></span><span class="win-title">wisp</span></div>
          <div class="ct-app dg-app">
            <div class="ct-card">
              <div class="ct-head"><span class="ct-dot" data-dot></span><span class="ct-title">${esc(TASK)}</span></div>
              <div class="ct-meta"><span class="ct-who">${logo(LEAD, 14)}${esc(LEAD.name)}</span><span class="ct-mode">This computer</span><span class="ct-pill" data-pill hidden></span></div>
              <div class="dg-live">
                ${TEAM.map((m) => `
                  <div class="dg-tl" data-tl="${m.id}">
                    <span class="dg-tlogo">${logo(m, 12)}</span>
                    <b>@${m.id}</b>
                    <span class="dg-where" data-where></span>
                    <span class="dg-text" data-text>Waiting for the lead</span>
                    <span class="dg-st" data-st></span>
                  </div>`).join('')}
              </div>
              <div class="ct-rep" data-rep hidden><b data-rtitle></b><small data-rsub></small></div>
            </div>
            <div class="dg-map" data-map>
              ${[{ id: 'here', name: 'This computer', icon: 'laptop' }, { id: 'gpu', name: 'gpu-box', icon: 'server' }, { id: 'dev', name: 'devbox', icon: 'server' }].map((p) => `
                <div class="dg-node" data-node="${p.id}">${ICON[p.icon]}<span>${esc(p.name)}</span><i class="dg-n" data-n></i></div>`).join('')}
              <span class="dg-packet" data-packet hidden></span>
            </div>
          </div>
        </div>
        <p class="sp-foot" data-foot aria-live="polite"></p>
      </div>`;

    const $ = (s, el = root) => el.querySelector(s);
    const foot = $('[data-foot]');
    const map = $('[data-map]');
    let run = 0; // bumps on every new run, so an old one stops where it is
    const say = (html) => { foot.innerHTML = html; };

    function sync() {
      for (const m of TEAM) {
        const row = $(`[data-row="${m.id}"]`);
        for (const b of row.querySelectorAll('[data-place]')) b.setAttribute('aria-checked', String(b.dataset.place === picks[m.id]));
        $('[data-model]', row).textContent = `${m.name} · ${m.model[picks[m.id]]}`;
        const tl = $(`[data-tl="${m.id}"]`);
        const p = place(picks[m.id]);
        $('[data-where]', tl).innerHTML = p.id ? `${ICON.server}${esc(p.name)}` : '';
        $('[data-where]', tl).hidden = !p.id;
      }
      // How many delegates each machine runs (the lead counts on this computer).
      for (const n of map.querySelectorAll('[data-node]')) {
        const k = n.dataset.node;
        const count = k === 'here' ? 1 + TEAM.filter((m) => !picks[m.id]).length : TEAM.filter((m) => picks[m.id] === k).length;
        $('[data-n]', n).textContent = count ? String(count) : '';
        n.classList.toggle('used', count > 0);
      }
    }

    // A packet from one machine chip to another: the lead's work out, a patch back.
    async function fly(from, to, label, back) {
      const pk = $('[data-packet]');
      const box = map.getBoundingClientRect();
      const at = (k) => {
        const r = $(`[data-node="${k}"]`, map).getBoundingClientRect();
        return [r.left - box.left + r.width / 2, r.top - box.top + r.height / 2];
      };
      const [x0, y0] = at(from);
      const [x1, y1] = at(to);
      pk.className = `dg-packet${back ? ' back' : ''}`;
      pk.textContent = label;
      pk.style.transition = 'none';
      pk.style.transform = `translate(${x0}px, ${y0}px) translate(-50%, -50%)`;
      pk.hidden = false;
      void pk.offsetWidth;
      pk.style.transition = calm ? 'none' : 'transform 0.75s cubic-bezier(.5,0,.3,1)';
      pk.style.transform = `translate(${x1}px, ${y1}px) translate(-50%, -50%)`;
      await wait(780);
      pk.hidden = true;
    }

    const tl = (m) => $(`[data-tl="${m.id}"]`);
    function line(m, text, st = '') {
      const row = tl(m);
      $('[data-text]', row).textContent = text;
      row.className = `dg-tl ${st}`;
      const pill = $('[data-st]', row);
      pill.innerHTML = st === 'done' ? `${ICON.check}${esc(m.diff)}` : '';
    }

    async function play() {
      const me = ++run;
      const live = () => me === run;
      const dot = $('[data-dot]');
      const pill = $('[data-pill]');
      const rep = $('[data-rep]');
      rep.hidden = true;
      pill.hidden = true;
      dot.className = 'ct-dot spin';
      for (const m of TEAM) line(m, 'Waiting for the lead');
      say('The lead reads the task and splits it up.');
      await wait(700);
      if (!live()) return;
      const away = TEAM.filter((m) => picks[m.id]);
      say(away.length
        ? `The lead delegates. <b>${away.map((m) => `@${m.id}`).join(', ')}</b> ${away.length > 1 ? 'get' : 'gets'} a copy of its work on ${[...new Set(away.map((m) => place(picks[m.id]).name))].join(' and ')}.`
        : 'The lead delegates. Everyone works in its folder, on this computer.');
      // Staggered, as parallel tasks start; packets queue on the one map so they read one by one.
      let lane = Promise.resolve();
      const queue = (fn) => (lane = lane.then(fn));
      await Promise.all(
        TEAM.map(async (m, i) => {
          await wait(i * 260);
          if (!live()) return;
          // With the lead: straight to work in its folder. On a machine: the work goes out first.
          const k = picks[m.id];
          if (k)
            await queue(async () => {
              line(m, `Sending the lead's work to ${place(k).name}`, 'live');
              await fly('here', k, 'work →');
            });
          if (!live()) return;
          for (const s of m.steps) {
            line(m, s, 'live');
            await wait(700 + Math.random() * 400);
            if (!live()) return;
          }
          if (k)
            await queue(async () => {
              line(m, `Patch back from ${place(k).name}`, 'live');
              await fly(k, 'here', `← ${m.diff}`, true);
            });
          if (live()) line(m, m.title, 'done');
        }),
      );
      if (!live()) return;
      await wait(350);
      if (!live()) return;
      dot.className = 'ct-dot ok';
      pill.className = 'ct-pill ok';
      pill.textContent = 'Done';
      pill.hidden = false;
      const files = TEAM.reduce((n, m) => n + m.files, 0);
      $('[data-rtitle]').textContent = 'Billing runs on the payments API';
      $('[data-rsub]').textContent = `${files} files changed by 3 delegates${away.length ? `, ${away.length} of them on other machines` : ''}. All in one worktree, one diff, one PR.`;
      rep.hidden = false;
      say(away.length
        ? `Every patch landed in the lead's worktree. <span class="muted">Move a delegate and it runs again.</span>`
        : `Everything ran next to the lead. <span class="muted">Put a delegate on gpu-box or devbox and run it again.</span>`);
    }

    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-place]');
      if (b) {
        picks[b.closest('[data-row]').dataset.row] = b.dataset.place;
        sync();
        play();
        return;
      }
      if (e.target.closest('[data-go]')) play();
    });

    new IntersectionObserver(([e]) => {
      if (e.isIntersecting && !run) play();
    }, { threshold: 0.3 }).observe(root);

    sync();
    say('Pick where each delegate runs, then press Delegate.');
  }

  document.querySelectorAll('[data-delegate]').forEach(mount);
})();
