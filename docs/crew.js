// wisp site: a working copy of the crew. Hire members from the app's own templates, open one and
// read its thread, press Check in now and watch a job run, answer the one that's asking you, and
// see what it learned land in its notebook. The faces are the app's spirits: scripts/site.mjs
// copies web/js/spirit.js here as spirit.js, so the site and the app draw them the same way.
//
// Every member's row is in the DOM from the start (unhired ones hidden) and only updated, and a
// thread repaints just the job that changed, so nothing replays its entry animation.

import { spiritSvg, spiritDefs, parseSpirit } from './spirit.js';

const ICON = {
  check: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  clock: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.8" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 4.8V8l2.2 1.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  plus: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  wake: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5l1.4 4.1 4.1 1.4-4.1 1.4L8 12.5 6.6 8.4 2.5 7l4.1-1.4z" fill="currentColor"/></svg>',
  note: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="2" width="10" height="12" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
};

// The app's templates (web/js/features/crew.js TEMPLATES): same names, roles, faces and schedules.
// Each has a thread so far, a notebook, and what its next check-in does.
const CREW = [
  {
    id: 'scout', name: 'Scout', role: 'CI watcher', avatar: 'ghost.sky.visor.flat.antenna', every: 'Every 30 min', when: 'every 30 minutes', hired: true,
    jobs: [
      { from: 'Check-in · 09:30', quiet: 'CI green on main, build 41' },
      { from: 'Check-in · 10:00', title: 'Fixed the flaky session test', sub: 'Run 42 failed in auth.test.js: a timer raced the expiry. Fix on fix/session-timer, 214 tests pass.' },
    ],
    notes: ['build 41 green', 'auth.test.js flaked twice: timer race, fixed in run 42', 'the user wants fixes on a branch, never on main'],
    next: { steps: ['gh run list --branch main', 'Reading run 43', 'All 6 jobs passed'], quiet: 'CI green on main, build 43', learn: 'build 43 green (10:30)' },
  },
  {
    id: 'quill', name: 'Quill', role: 'PR reviewer', avatar: 'blob.violet.wide.flat.headphones', every: 'Hourly', when: 'every hour', hired: true,
    jobs: [
      { from: 'Check-in · 09:00', title: 'Reviewed #126 and #127', sub: '#126 looks good. #127 misses a test for the empty cart.' },
      { from: 'Check-in · 10:00', ask: '#128 drops the retry on payment webhooks. Request changes, or just comment?', choices: ['Request changes', 'Comment only'],
        after: { title: 'Reviewed #128', sub: 'One blocking note on webhook retries, two nits. Nothing pushed, approved or merged.' } },
    ],
    notes: ['reviewed up to #127', 'short reviews, worst first', 'webhooks must retry (see #98)'],
    next: { steps: ['gh pr list --state open', 'No new or changed PRs'], quiet: 'No new pull requests since #128', learn: 'checked 11:00: nothing new after #128' },
  },
  {
    id: 'sorter', name: 'Sorter', role: 'Issue triager', avatar: 'bean.amber.happy.smile.leaf', every: 'Weekdays 9:00', when: 'on weekdays at 9:00', hired: true,
    jobs: [{ from: 'Check-in · 09:00', title: '3 issues worth doing first', sub: '#311 is a dupe of #290. #305 needs repro steps. Start with #309: the export loses dates.', unread: true }],
    notes: ['triaged up to #311', 'label "good first issue" only with a plan'],
    next: { steps: ['gh issue list --state open', 'Reading #312', 'Checking for duplicates'], title: '1 new issue: #312', sub: 'Looks like #309 again, on Windows. Linked it there.', learn: 'triaged up to #312' },
  },
  {
    id: 'tinker', name: 'Tinker', role: 'Dependency keeper', avatar: 'star.lime.dots.grin.beanie', every: 'Mondays 9:00', when: 'on Mondays at 9:00',
    jobs: [],
    notes: [],
    next: { steps: ['npm outdated', 'Updating 4 safe packages', 'npm test'], title: '4 updates on deps/oct-27', sub: 'Tests pass. vite 7 is a major: it needs your call.', learn: 'vite 7 waits on the user' },
  },
  {
    id: 'echo', name: 'Echo', role: 'Release notes', avatar: 'drop.rose.happy.cat.halo', every: 'Fridays 17:00', when: 'on Fridays at 17:00',
    jobs: [],
    notes: [],
    next: { steps: ['git log v0.41.0..main', 'Reading 9 merged PRs', 'Editing CHANGELOG.md'], title: 'Drafted 7 CHANGELOG entries', sub: 'Uncommitted, in the project’s voice, for you to review.', learn: 'notes drafted up to v0.42 (Oct 25)' },
  },
];

const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
const wait = (ms) => new Promise((r) => setTimeout(r, calm ? Math.min(ms, 60) : ms));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const color = (m) => parseSpirit(m.avatar).color;
const face = (m, size, mood = 'idle', small = false) => `<span class="cw-av c-${color(m)}" style="--size:${size}px">${spiritSvg(m.avatar, { state: mood, small })}<i class="cw-dot"></i></span>`;

function mount(root) {
  const st = Object.fromEntries(CREW.map((m) => [m.id, { hired: !!m.hired, live: false, ran: 0, jobs: m.jobs.map((j) => ({ ...j })), notes: [...m.notes] }]));
  let open = 'scout';
  root.innerHTML = `
    <div class="ct-book cw-book">
      <div class="sp-lh"><span><em>1</em>Hire from a template</span></div>
      <div class="cw-tpls">
        ${CREW.map((m) => `<button type="button" class="cw-tpl" data-tpl="${m.id}" aria-pressed="false">${face(m, 22, 'idle', true)}<span><b>${esc(m.name)}</b><small>${esc(m.role)}</small></span><i class="cw-tpl-i">${ICON.plus}</i></button>`).join('')}
      </div>
      <p class="ct-note" data-tnote></p>
      <div class="sp-lh"><span><em>2</em>Let them check in</span></div>
      <button type="button" class="ct-take" data-wake>${ICON.wake}<span data-wlabel>Check in now</span></button>
      <p class="ct-note" data-wnote></p>
      <div class="sp-lh"><span><em>3</em>Or tag them in any prompt</span></div>
      <div class="cw-tag"><span class="cw-at">@Quill</span> does this look right?</div>
      <p class="ct-note">Quill answers under your message and the task's agent carries on.</p>
    </div>
    <div class="ct-stage cw-stage">
      <div class="ct-win" data-ui>
        <div class="win-bar"><span class="lights"><i></i><i></i><i></i></span><span class="win-title">wisp</span></div>
        <div class="cw-app">
          <div class="cw-side">
            <h4>Crew</h4>
            <div class="cw-list">
              ${CREW.map((m) => `
                <button type="button" class="cw-row" data-row="${m.id}" hidden>
                  ${face(m, 28)}
                  <span class="cw-who"><b>${esc(m.name)}</b><small data-status></small></span>
                </button>`).join('')}
            </div>
            <h4 class="cw-dim">Working</h4>
            <div class="cw-task"><span class="cw-tdot"></span><span>Move billing to the new API</span></div>
          </div>
          <div class="cw-main">
            <div class="cw-head" data-head></div>
            <div class="cw-thread" data-thread></div>
          </div>
          <aside class="cw-aside" data-aside></aside>
        </div>
      </div>
      <p class="sp-foot" data-foot aria-live="polite"></p>
    </div>
    ${spiritDefs()}`;

  const $ = (s, el = root) => el.querySelector(s);
  const foot = $('[data-foot]');
  const say = (html) => { foot.innerHTML = html; };
  const member = (id) => CREW.find((m) => m.id === id);

  function mood(id) {
    const s = st[id];
    if (s.live) return 'live';
    if (s.jobs.some((j) => j.ask && !j.answered)) return 'asks';
    return 'idle';
  }
  function status(id) {
    const s = st[id];
    const m = member(id);
    if (s.live) return s.live;
    const ask = s.jobs.find((j) => j.ask && !j.answered);
    if (ask) return `Asking you: ${ask.ask}`;
    const unread = s.jobs.find((j) => j.unread);
    if (unread) return `Reported: ${unread.title}`;
    return m.every;
  }
  // A face's mood is a class on its spirit, so the face itself is never redrawn.
  function setMood(av, md) {
    const svg = $('svg.spirit', av);
    svg.setAttribute('class', svg.getAttribute('class').replace(/st-\w+/, `st-${md}`));
  }

  function syncList() {
    for (const m of CREW) {
      const s = st[m.id];
      const row = $(`[data-row="${m.id}"]`);
      row.hidden = !s.hired;
      row.classList.toggle('on', open === m.id);
      row.setAttribute('aria-current', String(open === m.id));
      $('[data-status]', row).textContent = status(m.id);
      const md = mood(m.id);
      setMood($('.cw-av', row), md);
      const av = $('.cw-av', row);
      av.classList.toggle('asks', md === 'asks');
      av.classList.toggle('unread', md !== 'asks' && s.jobs.some((j) => j.unread));
      const tpl = $(`[data-tpl="${m.id}"]`);
      tpl.setAttribute('aria-pressed', String(s.hired));
      tpl.classList.toggle('on', open === m.id);
    }
    const m = member(open);
    $('[data-tnote]').innerHTML = `<b>${esc(m.name)} · ${esc(m.role)}</b> checks in ${esc(m.when)}. Each job is a task of its own, with a fresh context.`;
    const wake = $('[data-wake]');
    wake.disabled = !!st[open].live;
    $('[data-wlabel]').textContent = st[open].live ? `${m.name} is working` : `Check in ${m.name} now`;
    $('[data-wnote]').textContent = st[open].live ? 'Its face floats while a job runs.' : `Or let the schedule do it, ${m.when}. A check-in that finds nothing stays quiet.`;
  }

  function jobHtml(j, i) {
    let body;
    if (j.live) body = `<div class="cw-live"><span class="cw-spin"></span><span>${esc(j.live)}</span></div>`;
    else if (j.ask && !j.answered)
      body = `<div class="cw-ask"><p>${esc(j.ask)}</p><div class="cw-choices">${j.choices.map((c, k) => `<button type="button" class="ct-btn${k ? '' : ' cw-pri'}" data-choice="${i}:${k}">${esc(c)}</button>`).join('')}</div></div>`;
    else if (j.quiet) return `<div class="cw-job cw-quiet" data-job="${i}"><span class="cw-from">${esc(j.from)}</span><span>${ICON.check}${esc(j.quiet)}</span></div>`;
    else body = `<div class="cw-rep"><b>${esc(j.title)}</b><small>${esc(j.sub)}</small><div class="cw-acts"><span class="ct-btn">Open job</span><span class="ct-btn">Follow up</span></div></div>`;
    const asked = j.answered ? `<div class="cw-you">${esc(j.answered)}</div>` : '';
    return `<div class="cw-job" data-job="${i}"><span class="cw-from">${esc(j.from)}</span>${j.ask && j.answered ? `<p class="cw-q">${esc(j.ask)}</p>${asked}` : ''}${body}</div>`;
  }

  function paintThread() {
    const m = member(open);
    const s = st[open];
    const head = $('[data-head]');
    head.innerHTML = `${face(m, 34, mood(open))}<div class="cw-name"><b>${esc(m.name)}</b><small>${esc(m.role)}</small></div><span class="cw-sched">${ICON.clock}${esc(m.every)}</span>`;
    $('[data-thread]').innerHTML = s.jobs.length ? s.jobs.map(jobHtml).join('') : `<p class="cw-empty">Just hired. ${esc(m.name)}’s first check-in is ${esc(m.when)}, or press Check in now.</p>`;
    paintAside();
  }
  function paintAside() {
    const m = member(open);
    const s = st[open];
    $('[data-aside]').innerHTML = `<h5>${ICON.note}Notebook</h5>${s.notes.length ? `<ul>${s.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : `<p class="cw-empty">Empty. ${esc(m.name)} writes here what it learns.</p>`}<h5>Brief</h5><p class="cw-brief">${esc(BRIEF[m.id])}</p>`;
  }
  // Only the job that changed is redrawn; a new one is appended.
  function paintJob(i) {
    if (!$('[data-job]')) return paintThread();
    const html = jobHtml(st[open].jobs[i], i);
    const old = $(`[data-job="${i}"]`);
    if (old) old.outerHTML = html;
    else $('[data-thread]').insertAdjacentHTML('beforeend', html);
  }
  function headMood() {
    const av = $('[data-head] .cw-av');
    if (av) setMood(av, mood(open));
  }

  function openMember(id) {
    open = id;
    const s = st[id];
    for (const j of s.jobs) j.unread = false;
    paintThread();
    syncList();
    if (s.live) return;
    const m = member(id);
    say(mood(id) === 'asks' ? `<b>${esc(m.name)}</b> is asking you. Answer right in its thread.` : `<b>${esc(m.name)}</b>’s thread: every job, oldest first. <span class="muted">Its notebook is beside it.</span>`);
  }

  async function checkIn(id) {
    const m = member(id);
    const s = st[id];
    if (s.live) return;
    const now = ['10:30', '11:00', '11:30', '12:00'][s.ran++ % 4];
    const job = { from: `Check-in · ${now}`, live: 'Starting up' };
    s.jobs.push(job);
    const i = s.jobs.length - 1;
    s.live = 'Starting up';
    if (open === id) { paintJob(i); headMood(); }
    syncList();
    say(`<b>${esc(m.name)}</b> starts a job: a new task, with its brief, notebook and recent log in the prompt.`);
    for (const step of m.next.steps) {
      await wait(900 + Math.random() * 400);
      job.live = step;
      s.live = step;
      if (open === id) paintJob(i);
      syncList();
    }
    await wait(800);
    delete job.live;
    s.live = false;
    if (m.next.quiet) {
      job.quiet = m.next.quiet;
      say(`Nothing changed, so <b>${esc(m.name)}</b> stays quiet: one line in its thread, nothing in <i>Needs you</i>.`);
    } else {
      job.title = m.next.title;
      job.sub = m.next.sub;
      job.unread = open !== id;
      say(`<b>${esc(m.name)}</b> reported. <span class="muted">What it learned went into its notebook.</span>`);
    }
    if (!s.notes.includes(m.next.learn)) s.notes.push(m.next.learn);
    if (open === id) { paintJob(i); headMood(); paintAside(); }
    syncList();
  }

  root.addEventListener('click', (e) => {
    const tpl = e.target.closest('[data-tpl]');
    if (tpl) {
      const id = tpl.dataset.tpl;
      const fresh = !st[id].hired;
      st[id].hired = true;
      openMember(id);
      if (fresh) say(`<b>${esc(member(id).name)}</b> joined your crew. <span class="muted">Press Check in now to give it a first job.</span>`);
      return;
    }
    const row = e.target.closest('[data-row]');
    if (row) {
      openMember(row.dataset.row);
      return;
    }
    const ch = e.target.closest('[data-choice]');
    if (ch) {
      const [i, k] = ch.dataset.choice.split(':').map(Number);
      const j = st[open].jobs[i];
      j.answered = j.choices[k];
      Object.assign(j, j.after);
      paintJob(i);
      headMood();
      syncList();
      say(`You answered in the thread, without opening the task. <b>${esc(member(open).name)}</b> carries on.`);
      return;
    }
    if (e.target.closest('[data-wake]')) checkIn(open);
  });

  // The first time it scrolls into view, Scout checks in on its own.
  let played = false;
  new IntersectionObserver(([e]) => {
    if (e.isIntersecting && !played) {
      played = true;
      setTimeout(() => checkIn('scout'), calm ? 0 : 600);
    }
  }, { threshold: 0.35 }).observe(root);

  paintThread();
  syncList();
  say('Click a member to open its thread. Quill is asking you something.');
}

// Short versions of the templates' briefs.
const BRIEF = {
  scout: 'Watch CI on the default branch. When a run fails, find the cause and fix it on a branch. When everything is green, stay quiet.',
  quill: 'Review new or changed pull requests, worst first, one short review each. Never push, approve or merge.',
  sorter: 'Read new issues. Spot duplicates, note missing repro steps, list the ones worth doing first. Never close one.',
  tinker: 'Update the safe dependencies on a branch, run the tests, say what needs a decision.',
  echo: 'Draft this week’s CHANGELOG entries from what merged. Leave them uncommitted.',
};

document.querySelectorAll('[data-crew]').forEach(mount);
