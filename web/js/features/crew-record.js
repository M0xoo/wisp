// Track record: where the crew's usage went, and how its jobs did (GET /crew/stats, server/usage.js
// crewStats). One dialog with one header: a subject picker (a member, or the whole crew) and the
// range. A member's view (right-click or ⋯ → Track record…) leads with the plan limits it used,
// then its tokens per day, where they went by kind of job (its schedule and triggers are the
// repeating work, often the bulk), its biggest jobs, and how its jobs went in one line. The
// crew's (Crew track record: ⌘K, Settings → Usage, or the picker) ranks members by tokens, with
// your own tasks for scale. Shares of usage are percentages; outcomes stay "x of y" counts.
// design/crew.md → Track record.
//
// Spells: the crew.record part (the dialog; its tips prop turns the suggestion off),
// crew.record.subject (the picker) and crew.compare (the crew's table).

import { esc } from '../md.js';
import { api } from '../core/api.js';
import * as bus from '../core/bus.js';
import { $, $$, el, icon } from '../core/dom.js';
import { fmtDate, money } from '../core/format.js';
import { load, S, save } from '../core/state.js';
import { present } from '../ui/overlay.js';
import { popover } from '../ui/popover.js';
import { placeName } from './places.js';
import { spellProp } from './spells.js';
import { toast } from '../ui/toast.js';
import { isSpirit, parseSpirit } from '../spirit.js';
import { reveal } from './feed.js';
import { avatarHtml, cadenceLabel, crewEditor, crewList, eventsLabel, memberById } from './crew.js';

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
          save('wisp.crewRecord', { 30: cache.get('30') }); // the range it opens on
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

const finishedTip = (r) => [`${r.done} finished`, r.partial && `${r.partial} partial`, r.blocked && `${r.blocked} blocked`, r.failed && `${r.failed} failed`].filter(Boolean).join(' · ') + '. Counts the jobs that ended, without quiet check-ins or jobs you stopped.';
const checkinTip = (r) => [`${plural(r.quiet, 'check-in')} found nothing`, r.later && `${r.later} filed for later`].filter(Boolean).join(' · ');
const neededTip = (r) => [r.questions && plural(r.questions, 'question'), r.approvals && plural(r.approvals, 'approval')].filter(Boolean).join(' · ') || 'Never stopped to ask you';

// --- words for usage --------------------------------------------------------------------------

const KIND_LABEL = { checkin: 'Check-ins', trigger: 'Triggers', task: 'Jobs you sent', mention: 'Tagged in tasks', delegated: 'Delegated' };
const KIND_SHORT = { checkin: 'Check-in', trigger: 'Trigger', task: 'Job', mention: 'Tagged', delegated: 'Delegated' };
const REPEATING = ['checkin', 'trigger'];
const share = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const pctOf = (a, b) => `${share(a, b)}%`;
const perDay = (n, r) => n / (r.span || 1);
const colorOf = (m) => (isSpirit(m.avatar) ? parseSpirit(m.avatar).color : m.color) || 'violet';
const whenAt = (t) => fmtDate(t, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
// Dollars where the harness prices, else a faint "no price"; never $0.00 for unknown.
const money_ = (r) => (r.priced ? money(r.cost) : r.tokens ? '<span class="faint">no price</span>' : '');
const kindSub = (k, u, r, m) => {
  if (!REPEATING.includes(k)) return `${plural(u.runs, 'job')} · ${toks(Math.round(u.tokens / (u.runs || 1)))} each`;
  const runs = perDay(u.runs, r);
  const rate = runs >= 1 ? `${Math.round(runs)} run${Math.round(runs) === 1 ? '' : 's'} a day` : `${plural(u.runs, 'run')}`;
  return `${rate} × ${toks(Math.round(u.tokens / (u.runs || 1)))} = ${toks(Math.round(perDay(u.tokens, r)))} a day${u.quiet ? ` · ${pctOf(u.quiet, u.runs)} found nothing` : ''}`;
};
const kindWhen = (k, m) => (k === 'checkin' && m.cron ? cadenceLabel(m.cron).toLowerCase() : k === 'trigger' ? eventsLabel(m).toLowerCase() : '');

// The plan windows this member (or the crew) used: the fullest first, two at most.
function limitsHtml(st, ids, name) {
  const ws = (st?.windows || []).filter((w) => ids.some((id) => w.members[id])).sort((a, b) => b.used - a.used).slice(0, 2);
  return ws
    .map((w) => {
      const mine = ids.reduce((n, id) => n + (w.members[id] || 0), 0);
      const crewAll = Object.values(w.members).reduce((n, v) => n + v, 0);
      const since = `Since ${whenAt(w.since)}`;
      const who =
        ids.length === 1
          ? `${since}, ${esc(name)} used ${pctOf(mine, w.tokens)} of the tokens${crewAll > mine ? `, the crew ${pctOf(crewAll, w.tokens)}` : ''}`
          : `${since}, the crew used ${pctOf(crewAll, w.tokens)} of the tokens: ${Object.entries(w.members)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 3)
              .map(([id, n]) => `${esc(memberById(id)?.name || 'a member')} ${pctOf(n, w.tokens)}`)
              .join(', ')} · your tasks ${pctOf(w.tokens - crewAll, w.tokens)}`;
      const acc = w.account && w.account !== 'default' ? ` (${esc(w.account)})` : '';
      return `<div class="rec-limit" title="${Math.round(w.used * 100)}% used. The darker part is ${ids.length === 1 ? esc(name) : 'the crew'}’s share of the tokens spent since it reset (a limit doesn’t count tokens one for one)."><div class="rec-lim-top"><span>${esc(w.label)} limit${acc}</span><span class="rec-meter"><i style="width:${Math.round(w.used * 100)}%"></i><i class="crew" style="width:${Math.round(w.used * (mine / (w.tokens || 1)) * 100)}%"></i></span><span>${Math.round(w.used * 100)}% · resets ${esc(whenAt(w.resetsAt))}</span></div><p>${who}</p></div>`;
    })
    .join('');
}

// One line that turns the numbers into a change, only with enough to go on (first match wins):
// repeating work that mostly finds nothing, one job that ate most of it, a big share of a limit,
// then how its jobs went.
function insight(r, m, st) {
  if (m.paused || spellProp('crew.record', 'tips') === false) return '';
  const fix = (label, a = 'edit') => `<button class="link xs" data-a="${a}">${label}</button>`;
  const c = r.byKind.checkin;
  if (c.runs >= 10 && c.quiet >= c.runs * 0.7 && c.tokens >= r.tokens * 0.3) {
    const when = kindWhen('checkin', m);
    return `Check-ins${when ? ` ${esc(when)}` : ''} use ${toks(Math.round(perDay(c.tokens, r)))} tokens a day; ${pctOf(c.quiet, c.runs)} found nothing. Checking in a quarter as often would use about ${toks(Math.round(perDay(c.tokens, r) / 4))}. ${fix('Change schedule…')}`;
  }
  const big = r.top[0];
  if (big && r.jobs >= 5 && big.tokens >= r.tokens * 0.4) return `One job used ${pctOf(big.tokens, r.tokens)} of ${esc(m.name)}’s tokens: “${esc(big.title || 'a job')}”. <button class="link xs" data-job="${esc(big.id)}">Open job</button>`;
  const w = (st?.windows || []).filter((x) => x.members[m.id] && x.used >= 0.5).sort((a, b) => b.used - a.used)[0];
  if (w && w.members[m.id] >= w.tokens * 0.3) return `Since your ${esc(w.label.toLowerCase())} limit reset, ${esc(m.name)} used ${pctOf(w.members[m.id], w.tokens)} of the tokens. ${fix(m.cron ? 'Change schedule…' : 'Edit…')}`;
  const missed = r.partial + r.blocked + r.failed;
  const sent = r.jobs - r.kinds.checkin;
  if (r.counted >= 5 && missed >= r.counted * 0.4) return `Many jobs end partial or blocked: a stronger model or a clearer brief may help. ${fix('Edit…')}`;
  if (sent >= 5 && r.followedUp >= sent * 0.5) return `Most jobs needed a second message. ${fix('Edit brief…')}`;
  return '';
}

// --- the strip --------------------------------------------------------------------------------

// Tokens per day (per week past 45 days), a slim bar centred in each day's slot, stacked by part:
// repeating and asked for a member, a member each for the crew. An empty day is a tick on the
// baseline. parts: [[key, class, label, (day) → tokens]].
const binned = (daily) => {
  if (daily.length <= 45) return daily;
  const out = [];
  for (let i = 0; i < daily.length; i += 7) {
    const w = daily.slice(i, i + 7);
    const kinds = {};
    for (const d of w) for (const [k, v] of Object.entries(d.kinds || {})) kinds[k] = (kinds[k] || 0) + v;
    out.push({ date: w[0].date, to: w.at(-1).date, tokens: w.reduce((n, d) => n + (d.tokens || 0), 0), quiet: w.reduce((n, d) => n + (d.quiet || 0), 0), kinds, by: w.map((d) => d.by || {}).reduce((a, b) => (Object.entries(b).forEach(([k, v]) => (a[k] = (a[k] || 0) + v)), a), {}) });
  }
  return out;
};
export function usageStrip(daily, parts, { label = '' } = {}) {
  const bins = binned(daily);
  const val = (d) => parts.reduce((n, p) => n + p[3](d), 0);
  const max = Math.max(1, ...bins.map(val));
  const all = bins.reduce((n, d) => n + val(d), 0);
  const bar = (d) => {
    const n = val(d);
    const when = d.to ? `${day(d.date)} – ${day(d.to)}` : day(d.date);
    const tip = `${when}: ${n ? `${toks(n)} tokens` : 'nothing'}${parts.length > 1 && n ? ` · ${parts.filter((p) => p[3](d)).map((p) => `${p[2]} ${toks(p[3](d))}`).join(' · ')}` : ''}${d.quiet ? ` · ${plural(d.quiet, 'quiet check-in')}` : ''}`;
    const seg = parts.map((p) => (p[3](d) ? `<i class="${p[1]}" style="flex-grow:${p[3](d)}"></i>` : '')).reverse().join('');
    return `<span class="rec-bar${n ? '' : ' none'}" data-tip="${esc(tip)}"><span style="height:${n ? Math.max(6, (n / max) * 100) : 0}%">${seg}</span></span>`;
  };
  return { html: `<div class="rec-strip" role="img" aria-label="${esc(`${label}: ${toks(all)} tokens`)}">${bins.map(bar).join('')}</div>`, max };
}
function axis(daily, parts, max, step) {
  const shown = parts.filter((p) => daily.some((d) => p[3](d))); // only what the strip shows
  return `<div class="rec-axis"><span>${esc(day(daily[0].date))}</span><span class="rec-legend">${shown.length > 1 ? shown.map(([, cls, label]) => `<span><i class="${cls}"></i>${esc(label)}</span>`).join('') : ''}</span><span>max ${toks(max)} a ${step}</span><span>today</span></div>`;
}

// --- a member ---------------------------------------------------------------------------------

const SK = '<i class="rec-sk"></i>';
const head = (tokens, cost, priced, sharePct, days) => `<div class="rec-total"><b>${toks(tokens)}</b><span>tokens</span>${priced ? `<b class="sm">${money(cost)}</b>` : tokens ? '<span class="faint">no price</span>' : ''}<span class="rec-share">${sharePct} of all wisp usage in ${days} days</span></div>`;

function memberHtml(m, r, days, st) {
  if (!r) return `<div class="rec-total">${SK}</div><div class="rec-strip skel"></div><div class="rec-axis"><span>&nbsp;</span></div><div class="rec-kinds">${'<div class="rec-kind"><span>&nbsp;</span><span class="rec-meter"></span>' + SK + '</div>'.repeat(3)}</div>`;
  if (r.remote) return `<p class="rec-none">${esc(m.name)} runs on ${esc(placeName(m.machine))}, so its usage is counted there. ${r.jobs ? `${plural(r.jobs, 'job')} in the last ${days} days.` : ''}</p>`;
  if (!r.jobs) return `<p class="rec-none">Nothing in the last ${days} days. Their jobs show up here as they do them.</p>`;
  const tip = insight(r, m, st);
  const parts = [
    ['rep', 'k-rep', 'Repeating', (d) => (d.kinds?.checkin || 0) + (d.kinds?.trigger || 0)],
    ['ask', 'k-ask', 'Asked', (d) => (d.kinds?.task || 0) + (d.kinds?.mention || 0) + (d.kinds?.delegated || 0)],
  ];
  const strip = usageStrip(r.daily, parts, { label: `${m.name}, last ${days} days` });
  const kinds = Object.entries(r.byKind)
    .filter(([, u]) => u.runs)
    .sort((a, b) => b[1].tokens - a[1].tokens)
    .map(([k, u]) => {
      const when = kindWhen(k, m);
      return `<div class="rec-kind${REPEATING.includes(k) ? ' rep' : ''}"><span class="rec-k">${KIND_LABEL[k]}${when ? ` <small>${esc(when)}</small>` : ''}</span><span class="rec-meter"><i style="width:${share(u.tokens, r.tokens)}%"></i></span><b>${toks(u.tokens)}</b><span class="rec-pc">${pctOf(u.tokens, r.tokens)}</span><span class="rec-c">${u.cost ? money(u.cost) : ''}</span><small class="rec-sub">${esc(kindSub(k, u, r, m))}</small></div>`;
    })
    .join('');
  const top = r.top
    .slice(0, 5)
    .map((j) => `<button class="rec-job" data-job="${esc(j.id)}"${S.sessions.has(j.id) ? '' : ' disabled title="No longer in wisp"'}><span class="rec-jt">${esc(j.title || 'A job')}</span><span class="rec-jk">${KIND_SHORT[j.kind]}${j.quiet ? ' · nothing new' : ''}</span><span class="rec-jw">${esc(whenAt(j.at))}</span><b>${toks(j.tokens)}</b><span class="rec-c">${j.priced ? money(j.cost) : ''}</span></button>`)
    .join('');
  const outcomes = [
    plural(r.jobs, 'job'),
    r.counted && `<span title="${esc(finishedTip(r))}">${of(r.done, r.counted)} finished</span>`,
    r.checkins && `<span title="${esc(checkinTip(r))}">${of(reported(r), r.checkins)} check-ins reported</span>`,
    `<span title="${esc(neededTip(r))}">needed you ${r.questions + r.approvals}</span>`,
    r.followups && plural(r.followups, 'follow-up'),
    r.prs.merged && `${plural(r.prs.merged, 'PR')} merged`,
  ].filter(Boolean);
  return `${limitsHtml(st, [m.id], m.name)}${head(r.tokens, r.cost, r.priced, pctOf(r.tokens, st?.all?.tokens), days)}${tip ? `<p class="rec-hint">${icon('spark')}<span>${tip}</span></p>` : ''}
    ${strip.html}${axis(r.daily, parts, strip.max, r.daily.length > 45 ? 'week' : 'day')}
    <h4 class="rec-h">Where it went</h4><div class="rec-kinds">${kinds}</div>
    ${top ? `<h4 class="rec-h">Biggest jobs</h4><div class="rec-jobs">${top}</div>` : ''}
    <p class="rec-outcomes">${outcomes.join(' · ')}</p>`;
}

// --- the whole crew ---------------------------------------------------------------------------

// Members ranked by tokens, each a bar of the crew's share, then your own tasks for scale.
function crewHtml(st, days) {
  if (!st) return `<div class="rec-total">${SK}</div><div class="rec-strip skel"></div><div class="rec-axis"><span>&nbsp;</span></div><div class="rec-ranks">${crewList().map((m) => `<div class="rec-rank">${avatarHtml(m, { size: 24, dot: false })}<span>${esc(m.name)}</span><span class="rec-meter"></span>${SK}</div>`).join('')}</div>`;
  const rows = crewList().map((m) => ({ m, r: statOf(st, m.id) })).filter((x) => x.r);
  const tokens = rows.reduce((n, x) => n + (x.r.remote ? 0 : x.r.tokens), 0);
  const cost = rows.reduce((n, x) => n + (x.r.remote ? 0 : x.r.cost), 0);
  const priced = rows.some((x) => x.r.priced);
  const busy = rows.filter((x) => !x.r.remote && x.r.tokens).sort((a, b) => b.r.tokens - a.r.tokens);
  const idle = rows.filter((x) => x.r.remote || !x.r.tokens);
  const parts = busy.slice(0, 6).map(({ m }) => [m.id, `c-${colorOf(m)} mem`, m.name, (d) => d.by?.[m.id] || 0]);
  // The crew's days: a member each.
  const daily = (busy[0]?.r.daily || rows[0]?.r.daily || []).map((d, i) => ({ date: d.date, tokens: 0, quiet: busy.reduce((n, x) => n + (x.r.daily[i]?.quiet || 0), 0), by: Object.fromEntries(busy.map((x) => [x.m.id, x.r.daily[i]?.tokens || 0])) }));
  const strip = daily.length && tokens ? usageStrip(daily, parts, { label: `The crew, last ${days} days` }) : null;
  const top = (x) => {
    const [k, u] = Object.entries(x.r.byKind).sort((a, b) => b[1].tokens - a[1].tokens)[0] || [];
    return k ? `${KIND_LABEL[k].toLowerCase()} ${toks(u.tokens)}${u.quiet ? ` · ${pctOf(u.quiet, u.runs)} found nothing` : ''}` : '';
  };
  const ranks = busy
    .map((x) => `<button class="rec-rank c-${colorOf(x.m)}" data-member="${esc(x.m.id)}">${avatarHtml(x.m, { size: 24, dot: false })}<span class="rec-k">${esc(x.m.name)}</span><span class="rec-meter mem"><i style="width:${share(x.r.tokens, tokens)}%"></i></span><b>${toks(x.r.tokens)}</b><span class="rec-pc">${pctOf(x.r.tokens, tokens)}</span><span class="rec-c">${money_(x.r)}</span><small class="rec-sub">${esc(top(x))}</small></button>`)
    .join('');
  const quiet = idle
    .map((x) => `<button class="rec-rank idle" data-member="${esc(x.m.id)}">${avatarHtml(x.m, { size: 24, dot: false })}<span class="rec-k">${esc(x.m.name)}</span><small class="rec-sub">${x.r.remote ? `on ${esc(placeName(x.m.machine))}: usage counted there` : `nothing in ${days} days`}</small></button>`)
    .join('');
  const yours = Math.max(0, (st.all?.tokens || 0) - tokens);
  return `${limitsHtml(st, rows.map((x) => x.m.id), '')}${head(tokens, cost, priced, pctOf(tokens, st.all?.tokens), days)}
    ${strip ? `${strip.html}${axis(daily, parts, strip.max, daily.length > 45 ? 'week' : 'day')}` : ''}
    <h4 class="rec-h">By member</h4><div class="rec-ranks rec-compare">${ranks}${quiet}<div class="rec-rank yours"><span class="rec-k">Your own tasks</span><b>${toks(yours)}</b><span class="rec-pc" title="of all wisp usage in ${days} days">${pctOf(yours, st.all?.tokens)}</span></div></div>`;
}

// --- the dialog -------------------------------------------------------------------------------

// The title is the picker: a member, or the whole crew. Only its words change between views.
const subjectHtml = (m) =>
  `${m ? avatarHtml(m, { size: 24, dot: false }) : `<span class="rec-crew-ic">${icon('stats')}</span>`}<span>${m ? `${esc(m.name)}’s track record` : 'Crew track record'}</span>${icon('chevron', 'chev')}`;

function subjectMenu(anchor, current, pick) {
  $('.menu.rec-menu')?.close();
  const row = (id, face, name, sub) => `<button data-pick="${esc(id)}" role="menuitemradio" aria-checked="${id === current}">${face}<span class="rec-mi">${esc(name)}${sub ? `<small>${esc(sub)}</small>` : ''}</span>${id === current ? icon('check', 'rec-on') : ''}</button>`;
  const menu = el(`<div class="menu rec-menu" role="menu">
      ${row('', `<span class="rec-crew-ic sm">${icon('stats')}</span>`, 'Whole crew')}
      <hr>
      ${crewList().map((m) => row(m.id, avatarHtml(m, { size: 20, dot: false }), m.name, m.role)).join('')}
    </div>`);
  menu.onclick = (e) => {
    const b = e.target.closest('[data-pick]');
    if (!b) return;
    close();
    pick(b.dataset.pick);
    anchor.focus();
  };
  const close = popover(menu, { anchor, back: anchor });
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.min(r.bottom + 6, innerHeight - menu.offsetHeight - 8)}px`;
  menu.querySelector('[aria-checked="true"]')?.focus();
}

// id: open on that member's track record; none: on the crew's.
export function trackRecord({ id = '', days = 30, host } = {}) {
  if (id && !memberById(id)) id = '';
  const node = el(`<div class="modal usage-modal crew-record">
      <header><h2><button class="rec-subject" aria-haspopup="menu"></button></h2><div class="mem-tabs us-range">${[7, 30, 90].map((d) => `<button data-days="${d}">${d} days</button>`).join('')}</div><button class="icon-btn close">${icon('x')}</button></header>
      <div class="rec-body"></div>
    </div>`);
  const close = present(node, host);
  const body = $('.rec-body', node);
  const subject = $('.rec-subject', node);
  const paint = () => {
    const m = memberById(id);
    if (id && !m) id = '';
    $$('.us-range button', node).forEach((b) => b.classList.toggle('on', Number(b.dataset.days) === days));
    const sh = subjectHtml(m);
    if (subject.dataset.h !== sh) (subject.innerHTML = sh), (subject.dataset.h = sh);
    node.classList.toggle('crew', !m);
    const r = record(days);
    const html = m ? memberHtml(m, statOf(r, m.id), days, r) : crewHtml(r, days);
    if (body.dataset.h !== html) (body.innerHTML = html), (body.dataset.h = html);
  };
  const pick = (next) => {
    id = next;
    paint();
  };
  bus.on('crewRecord', paint, { node });
  bus.on('config', paint, { node });
  node.addEventListener('click', (e) => {
    if (e.target.closest('.rec-subject')) return subjectMenu(subject, id, pick);
    const d = Number(e.target.closest('[data-days]')?.dataset.days);
    if (d) {
      days = d;
      return paint();
    }
    if (e.target.closest('[data-a="edit"]') && memberById(id)) {
      close();
      return crewEditor({ member: memberById(id) });
    }
    const job = e.target.closest('[data-job]')?.dataset.job;
    if (job) {
      if (!S.sessions.has(job)) return toast('That job is no longer in wisp.', { tone: 'bad' });
      close();
      return reveal(job);
    }
    if (e.target.closest('.rec-bar')) return; // a tap on a day shows its count
    const row = e.target.closest('[data-member]')?.dataset.member;
    if (row && memberById(row)) pick(row);
  });
  paint();
  return close;
}
export const crewRecord = (opts = {}) => trackRecord({ ...opts, id: '' });

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

