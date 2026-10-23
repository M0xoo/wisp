// wisp site: a working copy of the Compare view. Pick who races Claude Code, press Run both, and
// the two columns fill in the way the app's do: time and cost climbing, the tool call each is on,
// then their reports and test runs. Keep this keeps one branch and archives the other.
//
// Both columns are drawn once; a run only updates their text and classes, so nothing is
// re-inserted (and no entry animation replays) when you race again.

(() => {
  const ICON = {
    check: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    x: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    again: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };
  const PROMPT = 'Migrate validation to zod 4';
  // min: minutes the run takes; cost in dollars; tests [passed, failed]; tools: what it's seen doing.
  const AGENTS = {
    claude: {
      name: 'Claude Code', model: 'claude-opus-5-5', logo: 'claudecode-color.svg', min: 16, cost: 0.94, files: 12, lines: '+148 −131', tests: [341, 0], asked: 0,
      title: 'zod 4 everywhere, error messages unchanged', sub: 'Migrated 31 schemas. Wrapped .format() so API error bodies stay byte-for-byte the same.',
      tools: ['Grep "z.object" src/', 'Read src/schemas/user.ts', 'Edit src/schemas/user.ts', 'Edit src/schemas/invoice.ts', 'Edit src/http/errors.ts', 'Bash npm test'],
    },
    codex: {
      name: 'Codex', model: 'gpt-5.5-codex', logo: 'codex-color.svg', min: 11, cost: 0.38, files: 9, lines: '+121 −117', tests: [339, 2], asked: 0,
      title: 'zod 4 migrated, 2 snapshot tests changed', sub: 'All schemas compile on zod 4. The error format moved to the new issue shape, so two API snapshot tests were updated.',
      tools: ['rg "from \'zod\'"', 'Edit src/schemas/user.ts', 'Edit src/schemas/order.ts', 'Bash npx tsc --noEmit', 'Bash npm test'],
    },
    opencode: {
      name: 'opencode', model: 'any provider', logo: 'opencode.svg', mono: true, min: 14, cost: 0.21, files: 12, lines: '+152 −131', tests: [341, 0], asked: 1,
      title: 'zod 4 migrated, old error shape kept', sub: 'Asked once whether API errors should change shape, then kept the old one behind a small adapter.',
      tools: ['Glob src/schemas/**', 'Read src/schemas/user.ts', 'Edit src/schemas/user.ts', 'Asks: keep the old error shape?', 'Edit src/http/errors.ts', 'Bash npm test'],
    },
    cursor: {
      name: 'Cursor', model: 'composer', logo: 'cursor.svg', mono: true, min: 9, cost: 0.52, files: 10, lines: '+117 −109', tests: [337, 4], asked: 0,
      title: 'Schemas migrated, refinements need work', sub: 'Most schemas are on zod 4; four .superRefine checks now report on the wrong path.',
      tools: ['Read package.json', 'Edit src/schemas/user.ts', 'Edit src/schemas/order.ts', 'Bash npm test'],
    },
  };
  const RIVALS = ['codex', 'opencode', 'cursor'];

  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const logo = (a, size = 18) => `<img src="/assets/logos/${a.logo}" alt="" width="${size}" height="${size}"${a.mono ? ' class="mono"' : ''} />`;
  const clock = (min) => `${Math.floor(min)}m ${String(Math.round((min % 1) * 60)).padStart(2, '0')}s`;
  const ok = (a) => !a.tests[1];
  const MS_PER_MIN = calm ? 40 : 290; // a 16 minute run takes under five seconds here

  function colHtml(side) {
    return `
      <div class="cm-col" data-col="${side}">
        <div class="cm-ch">
          <span class="cm-logo" data-logo></span>
          <span class="cm-who"><b data-name></b><small data-model></small></span>
          <span class="cm-state" data-state></span>
        </div>
        <dl class="cm-stats">
          <div data-k="time"><dt>Time</dt><dd>—</dd></div>
          <div data-k="cost"><dt>Cost</dt><dd>—</dd></div>
          <div data-k="files"><dt>Files</dt><dd>—</dd></div>
          <div data-k="tests"><dt>Tests</dt><dd>—</dd></div>
          <div data-k="asked"><dt>Asked</dt><dd>—</dd></div>
        </dl>
        <div class="cm-body">
          <ol class="cm-live" data-live></ol>
          <div class="cm-rep" data-rep>
            <b data-title></b>
            <p data-sub></p>
            <div class="cm-run">
              <span class="cm-ring" data-ring></span>
              <span><b data-tres></b><small><span data-tcount></span> · <code>npm test</code></small></span>
            </div>
          </div>
        </div>
        <div class="cm-foot">
          <span class="cm-note" data-note></span>
          <button type="button" class="cm-keep" data-keep="${side}" disabled>${ICON.check}<span>Keep this</span></button>
        </div>
      </div>`;
  }

  function mount(root) {
    root.innerHTML = `
      <div class="cm-top">
        <span class="cm-title">Compare</span>
        <span class="cm-prompt">${esc(PROMPT)}</span>
        <span class="cm-pick">
          <span class="cm-vs">${logo(AGENTS.claude, 16)}Claude Code <i>vs</i></span>
          <span class="cm-seg" role="radiogroup" aria-label="Race Claude Code against">
            ${RIVALS.map((id) => `<button type="button" role="radio" aria-checked="false" data-rival="${id}">${logo(AGENTS[id], 14)}<span>${esc(AGENTS[id].name)}</span></button>`).join('')}
          </span>
        </span>
        <button type="button" class="cm-go" data-go><span>Run both</span><i>↵</i></button>
      </div>
      <div class="cm-cols">${colHtml('a')}${colHtml('b')}</div>
      <p class="cm-msg" data-msg aria-live="polite"></p>`;

    const $ = (s, r = root) => r.querySelector(s);
    const cols = { a: $('[data-col="a"]'), b: $('[data-col="b"]') };
    const go = $('[data-go]');
    const msg = $('[data-msg]');
    let rival = 'codex';
    let race = 0;
    let phase = 'ready'; // ready | running | done | kept

    const who = (side) => AGENTS[side === 'a' ? 'claude' : rival];
    const set = (col, k, html) => { $(`[data-k="${k}"] dd`, col).innerHTML = html; };
    const say = (html) => { msg.innerHTML = html; };

    function state(col, cls, text) {
      const el = $('[data-state]', col);
      el.className = `cm-state ${cls}`;
      el.textContent = text;
    }

    // Puts a column back to "ready" for whoever is in it now.
    function reset(side) {
      const col = cols[side];
      const a = who(side);
      $('[data-logo]', col).innerHTML = logo(a);
      $('[data-name]', col).textContent = a.name;
      $('[data-model]', col).textContent = a.model;
      for (const k of ['time', 'cost', 'files', 'tests', 'asked']) set(col, k, '—');
      col.className = 'cm-col';
      state(col, '', 'Ready');
      $('[data-live]', col).innerHTML = '<li class="wait">Its own worktree, from the same commit.</li>';
      $('[data-note]', col).textContent = '';
      $('[data-keep]', col).disabled = true;
    }

    function finish(side) {
      const col = cols[side];
      const a = who(side);
      set(col, 'time', clock(a.min));
      set(col, 'cost', `$${a.cost.toFixed(2)}`);
      set(col, 'files', `${a.files} <small>${a.lines.replace(/(\+\d+)/, '<em class="g">$1</em>').replace(/(−\d+)/, '<em class="r">$1</em>')}</small>`);
      set(col, 'tests', `${a.tests[0]} <em class="g">✓</em>${a.tests[1] ? ` ${a.tests[1]} <em class="r">✗</em>` : ''}`);
      set(col, 'asked', String(a.asked));
      $('[data-title]', col).textContent = a.title;
      $('[data-sub]', col).textContent = a.sub;
      $('[data-ring]', col).innerHTML = ok(a) ? ICON.check : ICON.x;
      $('[data-tres]', col).textContent = ok(a) ? 'All green' : `${a.tests[1]} failing`;
      $('[data-tcount]', col).textContent = `${a.tests[0]} passed${a.tests[1] ? `, ${a.tests[1]} failed` : ''}`;
      col.classList.add('done', ok(a) ? 'green' : 'red');
      state(col, ok(a) ? 'ok' : 'warn', ok(a) ? 'Done' : 'Partly done');
      $('[data-keep]', col).disabled = false;
    }

    // After both finish: mark the faster, the cheaper and the one with more passing tests.
    function best() {
      const A = who('a');
      const B = who('b');
      const mark = (k, aWins, bWins) => {
        $(`[data-k="${k}"]`, cols.a).classList.toggle('best', aWins);
        $(`[data-k="${k}"]`, cols.b).classList.toggle('best', bWins);
      };
      mark('time', A.min < B.min, B.min < A.min);
      mark('cost', A.cost < B.cost, B.cost < A.cost);
      mark('tests', A.tests[0] > B.tests[0], B.tests[0] > A.tests[0]);
    }

    function run() {
      const me = ++race;
      phase = 'running';
      reset('a');
      reset('b');
      for (const el of root.querySelectorAll('.best')) el.classList.remove('best');
      go.disabled = true;
      go.querySelector('span').textContent = 'Running…';
      say(`One prompt, two worktrees: <b>${esc(who('a').name)}</b> and <b>${esc(who('b').name)}</b> start from the same commit.`);
      const t0 = performance.now();
      const left = new Set(['a', 'b']);
      for (const side of left) {
        state(cols[side], 'run', 'Working');
        cols[side].classList.add('running');
      }
      const tick = (now) => {
        if (me !== race) return;
        const min = (now - t0) / MS_PER_MIN;
        for (const side of [...left]) {
          const a = who(side);
          const col = cols[side];
          if (min >= a.min) {
            left.delete(side);
            col.classList.remove('running');
            finish(side);
            if (left.size) say(`<b>${esc(a.name)}</b> finished first, in ${clock(a.min)}. <span class="muted">The other is still going.</span>`);
            continue;
          }
          set(col, 'time', clock(min));
          set(col, 'cost', `$${((a.cost * min) / a.min).toFixed(2)}`);
          set(col, 'files', String(Math.min(a.files, Math.ceil((a.files * min) / (a.min * 0.8)))));
          const tool = a.tools[Math.min(a.tools.length - 1, Math.floor((min / a.min) * a.tools.length))];
          // One row per tool call, added as it starts; earlier rows stay where they are.
          const live = $('[data-live]', col);
          if (live.lastElementChild?.textContent !== tool) {
            live.querySelector('.wait')?.remove();
            live.insertAdjacentHTML('beforeend', `<li>${esc(tool)}</li>`);
          }
        }
        if (left.size) requestAnimationFrame(tick);
        else {
          phase = 'done';
          best();
          go.disabled = false;
          go.querySelector('span').textContent = 'Run again';
          say('Both are done. Read the two reports, then <b>Keep this</b> on the one you want.');
        }
      };
      requestAnimationFrame(tick);
    }

    function keep(side) {
      if (phase !== 'done') return;
      phase = 'kept';
      const other = side === 'a' ? 'b' : 'a';
      cols[side].classList.add('kept');
      cols[other].classList.add('gone');
      state(cols[side], 'ok', 'Kept');
      state(cols[other], '', 'Archived');
      $('[data-note]', cols[side]).textContent = 'Ship it opens the PR';
      $('[data-note]', cols[other]).textContent = 'Worktree archived';
      for (const b of root.querySelectorAll('[data-keep]')) b.disabled = true;
      say(`Kept <b>${esc(who(side).name)}</b>’s branch. ${esc(who(other).name)}’s worktree is archived, and its card stays in history.`);
    }

    function pickRival(id) {
      rival = id;
      for (const b of root.querySelectorAll('[data-rival]')) b.setAttribute('aria-checked', String(b.dataset.rival === id));
    }

    root.addEventListener('click', (e) => {
      const r = e.target.closest('[data-rival]');
      if (r) {
        pickRival(r.dataset.rival);
        run();
        return;
      }
      if (e.target.closest('[data-go]')) { run(); return; }
      const k = e.target.closest('[data-keep]');
      if (k) keep(k.dataset.keep);
    });

    pickRival(rival);
    reset('a');
    reset('b');
    say('Press <b>Run both</b>, or pick who races Claude Code.');
    new IntersectionObserver(([e], obs) => {
      if (!e.isIntersecting) return;
      obs.disconnect();
      if (phase === 'ready') run();
    }, { threshold: 0.45 }).observe(root);
  }

  document.querySelectorAll('[data-compare]').forEach(mount);
})();
