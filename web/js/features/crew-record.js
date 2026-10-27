// Track record: how each crew member did (GET /crew/stats, server/usage.js crewStats). A section in
// a member's About column (always 30 days) and Compare crew, a dialog with every member side by
// side over 7, 30 or 90 days. Counts read "x of y", never a percentage: with a handful of jobs
// 1 of 1 is honest and 100% isn't. Quiet check-ins stay out of the strip, or a member checking in
// every half hour would bury its real work in grey. design/crew.md → Track record.
//
// Spells: the crew.record and crew.compare parts, and crew.record's tips prop (the suggestion line).

import { esc } from '../md.js';
import { api } from '../core/api.js';
import * as bus from '../core/bus.js';
import { $, $$, el, icon } from '../core/dom.js';
import { fmtDate, money } from '../core/format.js';
import { load, S, save } from '../core/state.js';
import { present } from '../ui/overlay.js';
import { agentName } from './runners.js';
import { placeName } from './places.js';
import { spellProp } from './spells.js';
import { avatarHtml, crewList, memberById, openMember } from './crew.js';

// Last answer per range, painted first (also after a reload: the phone app opens on cached data).
const cache = new Map(Object.entries(load('wisp.crewRecord', {})));
const sigs = new Map(); // range → the crew's jobs as they were when it was fetched
const inFlight = new Map();
const sig = () => {
  let n = 0;
  let t = 0;
  for (const s of S.sessions.values()) if (s.crew && !s.pending) (n += 1), (t = Math.max(t, s.updatedAt || 0));
  return `${crewList().length}:${n}:${t}`;
};

// The stats for a range: cached at once, fetched again when the crew's jobs moved. Emits
// crewRecord when new numbers land.
export function record(days = 30) {
  const k = String(days);
  const now = sig();
  if (sigs.get(k) !== now && !inFlight.has(k)) {
    sigs.set(k, now);
    inFlight.set(
      k,
      api(`/crew/stats?days=${days}`)
        .then((r) => {
          const changed = JSON.stringify(r) !== JSON.stringify(cache.get(k));
          cache.set(k, r);
          save('wisp.crewRecord', { 30: cache.get('30') }); // the About column's range
          if (changed) bus.emit('crewRecord', { days });
        })
        .catch(() => sigs.delete(k))
        .finally(() => inFlight.delete(k)),
    );
  }
  return cache.get(k) || null;
}
const statOf = (r, id) => r?.members.find((x) => x.id === id) || null;

// --- numbers and words ------------------------------------------------------------------------

const of = (a, b) => `${a} of ${b}`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const toks = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const day = (k) => fmtDate(`${k}T12:00:00`, { month: 'short', day: 'numeric' });
const reported = (r) => r.checkins - Math.min(r.quiet, r.checkins);

function kindsText(r) {
  const k = r.kinds;
  return [k.checkin && plural(k.checkin, 'check-in'), k.task && `${k.task} from you`, k.mention && `${k.mention} tagged`, k.delegated && `${k.delegated} delegated`, k.trigger && plural(k.trigger, 'trigger')].filter(Boolean).join(' · ');
}
const finishedTip = (r) => [`${r.done} finished`, r.partial && `${r.partial} partial`, r.blocked && `${r.blocked} blocked`, r.failed && `${r.failed} failed`].filter(Boolean).join(' · ') + '. Quiet check-ins and jobs you stopped don’t count.';
const checkinTip = (r) => [`${plural(r.quiet, 'check-in')} found nothing`, r.later && `${r.later} filed for later`].filter(Boolean).join(' · ');
const neededTip = (r) => [r.questions && plural(r.questions, 'question'), r.approvals && plural(r.approvals, 'approval')].filter(Boolean).join(' · ') || 'Never stopped to ask you';

// Spend: dollars when its harness prices jobs, tokens when it doesn't, a dash on another machine.
function spend(r, m, { short = false } = {}) {
  if (r.remote) return { text: '—', tip: `Runs on ${placeName(m?.machine)}: only summaries come back, so no spend`, faint: true };
  const per = (v) => (r.jobs ? v / r.jobs : 0);
  if (r.priced) return { text: short ? money(r.cost) : `${money(r.cost)} · ${money(per(r.cost))} a job`, tip: r.unpriced ? `${plural(r.unpriced, 'job')} without a price aren’t included` : '' };
  if (r.tokens) return { text: short ? `${toks(r.tokens)} tok` : `${toks(r.tokens)} tokens · ${toks(Math.round(per(r.tokens)))} a job`, tip: `${r.unpricedAgents.map(agentName).join(', ') || 'Its harness'} reports tokens, not cost`, faint: true };
  return { text: '—', tip: 'Nothing reported yet', faint: true };
}

// One line that turns the numbers into a change, only with enough to go on (first match wins).
function suggestion(r, m) {
  if (m.paused || spellProp('crew.record', 'tips') === false) return '';
  const fix = (label) => `<button class="link xs" data-a="edit">${label}</button>`;
  const missed = r.partial + r.blocked + r.failed;
  if (r.checkins >= 10 && reported(r) <= r.checkins * 0.1) return `Most check-ins find nothing. ${fix('Change schedule…')}`;
  if (r.counted >= 5 && missed >= r.counted * 0.4) return `Many jobs end partial or blocked: a stronger model or a clearer brief may help. ${fix('Edit…')}`;
  if (r.jobs - r.kinds.checkin >= 5 && r.followedUp >= (r.jobs - r.kinds.checkin) * 0.5) return `Most jobs needed a second message. ${fix('Edit brief…')}`;
  if (r.jobs >= 5 && r.approvals >= r.jobs * 0.5 && (m.mode || 'auto') !== 'auto') return `Most jobs stop for your OK: Full auto would let them run. ${fix('Edit…')}`;
  return '';
}

// --- the strip --------------------------------------------------------------------------------

// Jobs per day (per week past 45 days), stacked: finished, partial, blocked or failed, stopped (the
// pills' tones). Quiet check-ins only in the tooltip.
export function recordStrip(daily, { label = '' } = {}) {
  daily = daily.map((d) => ({ done: 0, partial: 0, missed: 0, stopped: 0, quiet: 0, ...d })); // a cached answer from before a key existed
  let bins = daily;
  if (daily.length > 45) {
    bins = [];
    for (let i = 0; i < daily.length; i += 7) {
      const w = daily.slice(i, i + 7);
      bins.push({ date: w[0].date, to: w.at(-1).date, ...Object.fromEntries(['done', 'partial', 'missed', 'stopped', 'quiet'].map((k) => [k, w.reduce((n, d) => n + d[k], 0)])) });
    }
  }
  const total = (d) => d.done + d.partial + d.missed + d.stopped;
  const max = Math.max(1, ...bins.map(total));
  const sum = (k) => bins.reduce((n, d) => n + d[k], 0);
  const all = sum('done') + sum('partial') + sum('missed') + sum('stopped');
  const aria = `${label}: ${plural(all, 'job')}, ${sum('done')} finished${sum('partial') + sum('missed') ? `, ${sum('partial') + sum('missed')} didn’t` : ''}${sum('quiet') ? `; ${plural(sum('quiet'), 'quiet check-in')}` : ''}`;
  const bar = (d) => {
    const n = total(d);
    const when = d.to ? `${day(d.date)} – ${day(d.to)}` : day(d.date);
    const tip = `${when}: ${[n ? plural(n, 'job') : 'no jobs', d.done && `${d.done} finished`, d.partial && `${d.partial} partial`, d.missed && `${d.missed} blocked`, d.stopped && `${d.stopped} stopped`, d.quiet && plural(d.quiet, 'quiet check-in')].filter(Boolean).join(' · ')}`;
    const seg = (k) => (d[k] ? `<i class="${k}" style="flex-grow:${d[k]}"></i>` : '');
    return `<span class="rec-bar" data-tip="${esc(tip)}"><span style="height:${n ? Math.max(8, (n / max) * 100) : 0}%">${seg('stopped')}${seg('missed')}${seg('partial')}${seg('done')}</span></span>`;
  };
  return `<div class="rec-strip" role="img" aria-label="${esc(aria)}">${bins.map(bar).join('')}</div>`;
}

// --- the About section ------------------------------------------------------------------------

const rowsOf = (r, m) => {
  const sp = spend(r, m);
  return [
    ['Jobs', String(r.jobs), kindsText(r)],
    r.counted ? ['Finished', of(r.done, r.counted), finishedTip(r)] : null,
    m.cron || r.checkins ? ['Check-ins', `${of(reported(r), r.checkins)} reported`, checkinTip(r)] : null,
    ['Needed you', String(r.questions + r.approvals), neededTip(r)],
    ['Your follow-ups', String(r.followups), 'Messages you sent on its jobs (answers to its questions don’t count)'],
    ['Spend', sp.text, sp.tip, sp.faint],
    r.prs.merged + r.prs.open ? ['PRs', [r.prs.merged && `${r.prs.merged} merged`, r.prs.open && `${r.prs.open} open`].filter(Boolean).join(' · '), ''] : null,
  ].filter(Boolean);
};
const skeleton = () => `<div class="rec-strip skel"></div><dl class="rec-rows">${Array.from({ length: 6 }, () => '<dt><i class="rec-sk"></i></dt><dd><i class="rec-sk"></i></dd>').join('')}</dl>`;

export function recordHtml(m) {
  const r = statOf(record(30), m.id);
  const joined = m.createdAt && m.createdAt > Date.now() - 30 * 864e5;
  const range = joined ? `since ${fmtDate(m.createdAt, { month: 'short', day: 'numeric' })}` : '30 days';
  const head = `<h5>Track record <small>${range}</small>${crewList().length > 1 ? '<button class="link xs" data-a="compare">Compare crew</button>' : ''}</h5>`;
  if (!r) return `<div class="cv-sec cv-record">${head}${skeleton()}</div>`;
  if (!r.jobs) return `<div class="cv-sec cv-record">${head}<p class="cv-none">Nothing to go on yet: their first jobs show up here.</p></div>`;
  // A member who joined this month: the strip starts on its first day.
  // (A task turned into a member brings its earlier job: start there if that's sooner.)
  const active = (d) => d.done + d.partial + d.missed + d.stopped + d.quiet;
  const from = joined ? Math.min(...[r.daily.findIndex((d) => d.date >= new Date(m.createdAt).toLocaleDateString('sv')), r.daily.findIndex(active)].filter((i) => i >= 0)) : 0;
  const tip = suggestion(r, m);
  return `<div class="cv-sec cv-record">${head}${recordStrip(r.daily.slice(Math.max(0, from)), { label: `Last ${range}` })}
    <dl class="rec-rows">${rowsOf(r, m).map(([k, v, t, faint]) => `<dt>${k}</dt><dd${t ? ` title="${esc(t)}"` : ''}${faint ? ' class="faint"' : ''}>${esc(v)}</dd>`).join('')}</dl>
    ${tip ? `<p class="rec-tip-line">${tip}</p>` : ''}</div>`;
}

// --- Compare crew -----------------------------------------------------------------------------

const COLS = [
  ['jobs', 'Jobs', (r) => r.jobs],
  ['finished', 'Finished', (r) => (r.counted ? r.done / r.counted + r.done / 1e6 : -1)],
  ['checkins', 'Check-ins reported', (r) => (r.checkins ? reported(r) / r.checkins + reported(r) / 1e6 : -1)],
  ['needed', 'Needed you', (r) => r.questions + r.approvals],
  ['followups', 'Follow-ups', (r) => r.followups],
  ['spend', 'Spend', (r) => (r.remote ? -1 : r.priced ? 1 + r.cost : r.tokens / 1e12)], // dollars above tokens
];
const cells = (r, m) => {
  const sp = spend(r, m, { short: true });
  return {
    jobs: String(r.jobs),
    finished: r.counted ? of(r.done, r.counted) : '—',
    checkins: r.checkins ? of(reported(r), r.checkins) : '—',
    needed: String(r.questions + r.approvals),
    followups: String(r.followups),
    spend: `<span${sp.tip ? ` title="${esc(sp.tip)}"` : ''}${sp.faint ? ' class="faint"' : ''}>${esc(sp.text)}</span>`,
  };
};

export function compareCrew({ from = '', days = 30, host } = {}) {
  let sort = { col: '', dir: -1 }; // join order until a header is clicked
  const node = el(`<div class="modal usage-modal crew-record">
      <header><h2>Crew track record</h2><div class="mem-tabs us-range">${[7, 30, 90].map((d) => `<button data-days="${d}">${d} days</button>`).join('')}</div><button class="icon-btn close">${icon('x')}</button></header>
      <div class="rec-body"></div>
    </div>`);
  const close = present(node, host);
  const body = $('.rec-body', node);
  const paint = () => {
    $$('.us-range button', node).forEach((b) => b.classList.toggle('on', Number(b.dataset.days) === days));
    const r = record(days);
    const list = crewList().map((m, i) => ({ m, i, r: statOf(r, m.id) }));
    if (sort.col) {
      const f = COLS.find((c) => c[0] === sort.col)[2];
      list.sort((a, b) => (a.r && b.r ? (f(a.r) - f(b.r)) * sort.dir : 0) || a.i - b.i);
    }
    const sk = '<i class="rec-sk"></i>';
    const who = (m) => `<span class="rec-who">${avatarHtml(m, { size: 20, dot: false })}<span>${esc(m.name)}</span></span>`;
    const th = COLS.map(([k, label]) => `<th aria-sort="${sort.col === k ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'}"><button data-sort="${k}">${label}</button></th>`).join('');
    const rows = list
      .map(({ m, r: x }) => {
        const c = x && cells(x, m);
        const nums = !x ? COLS.map(() => `<td>${sk}</td>`).join('') : !x.jobs ? `<td colspan="${COLS.length}" class="rec-empty">No jobs yet</td>` : COLS.map(([k]) => `<td>${c[k]}</td>`).join('');
        return `<tr data-member="${esc(m.id)}" tabindex="0"${m.id === from ? ' class="sel"' : ''}><td>${who(m)}</td><td class="rec-cell">${x?.jobs ? recordStrip(x.daily, { label: `${m.name}, last ${days} days` }) : x ? '' : sk}</td>${nums}</tr>`;
      })
      .join('');
    // Phones: a block a member instead of a table that can't fit.
    const cards = list
      .map(({ m, r: x }) => {
        const c = x && cells(x, m);
        const pairs = COLS.slice(0, -1).filter(([k]) => k !== 'checkins' || !x || x.checkins || m.cron).map(([k, label]) => `<dt>${label}</dt><dd>${x ? c[k] : sk}</dd>`).join('');
        return `<button class="rec-card${m.id === from ? ' sel' : ''}" data-member="${esc(m.id)}"><span class="rec-card-top">${who(m)}<span class="rec-spend">${x ? c.spend : sk}</span></span>${x && !x.jobs ? '<span class="rec-empty">No jobs yet</span>' : `${x ? recordStrip(x.daily, { label: `${m.name}, last ${days} days` }) : '<div class="rec-strip skel"></div>'}<dl class="rec-rows">${pairs}</dl>`}</button>`;
      })
      .join('');
    const html = `<table class="us-table rec-table"><thead><tr><th></th><th>Per day</th>${th}</tr></thead><tbody>${rows}</tbody></table><div class="rec-cards">${cards}</div>
      <p class="hint">Finished counts the jobs that ended, without quiet check-ins or jobs you stopped. The strips leave quiet check-ins out too; hover a day for its count.</p>`;
    if (body.dataset.h !== html) (body.innerHTML = html), (body.dataset.h = html);
  };
  bus.on('crewRecord', paint, { node });
  node.addEventListener('click', (e) => {
    const d = Number(e.target.closest('[data-days]')?.dataset.days);
    if (d) {
      days = d;
      return paint();
    }
    const col = e.target.closest('[data-sort]')?.dataset.sort;
    if (col) {
      sort = sort.col === col ? (sort.dir < 0 ? { col, dir: 1 } : { col: '', dir: -1 }) : { col, dir: -1 };
      return paint();
    }
    if (e.target.closest('.rec-bar')) return; // a tap on a day shows its count
    const id = e.target.closest('[data-member]')?.dataset.member;
    if (id && memberById(id)) {
      close();
      openMember(id);
    }
  });
  node.addEventListener('keydown', (e) => {
    const row = e.target.closest?.('tr[data-member]');
    if (row && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      row.click();
    }
  });
  paint();
  $('tr.sel', node)?.scrollIntoView({ block: 'nearest' });
  return close;
}

// One tooltip for every strip (their bars are too thin to label): hover, or tap on touch.
const tip = el('<div class="us-tip rec-tip" hidden></div>');
document.body.append(tip);
const showTip = (b) => {
  tip.hidden = !b;
  if (!b) return;
  tip.textContent = b.dataset.tip;
  const r = b.getBoundingClientRect();
  tip.style.left = `${Math.max(8 + tip.offsetWidth / 2, Math.min(r.left + r.width / 2, innerWidth - 8 - tip.offsetWidth / 2))}px`;
  tip.style.top = `${r.top - 6}px`;
};
document.addEventListener('mouseover', (e) => showTip(e.target.closest?.('.rec-bar')));
document.addEventListener('click', (e) => showTip(e.target.closest?.('.rec-bar')), true);
document.addEventListener('scroll', () => showTip(null), true);

