// Settings → This Mac (This PC, This computer; design/machine-page.md): what agents cost this
// computer, and acting on it. Three gauges, what's using it, processes left behind, folders to
// free, automations, the last 24 h. Plus the top-bar chip that opens it when it matters. The
// numbers come from GET /machine (server/machine.js), read every 10 s while the pane shows; the
// chip reads GET /load. Words and sums live in ../machine-view.js.
import { esc } from '../md.js';
import { api } from '../core/api.js';
import * as bus from '../core/bus.js';
import { $, $$, icon } from '../core/dom.js';
import { ago } from '../core/format.js';
import { S } from '../core/state.js';
import { ask } from '../ui/confirm.js';
import { toast, tryApi } from '../ui/toast.js';
import { automationsLine, chipOf, clock, dayStats, LATER_TEXT, laterChoices, machineLabel, pauseChoices, pctText, plural, reclaimRows, size, span, spark, usingRows } from '../machine-view.js';
import { reveal } from './feed.js';
import { scheduleFollowUp, timeMenu } from './later.js';
import { slotHtml } from './spells.js';

const POLL_MS = 10_000;
const CHIP_MS = 15_000;
const CACHE = 'wisp.machine';
const FALLBACK_CEILING = 200; // server/load.js LOAD_DEFAULTS

export const paneLabel = () => machineLabel(S.config?.platform);

// The last answer: a new open paints it first, then replaces it quietly.
let last = null;
try {
  last = JSON.parse(localStorage.getItem(CACHE) || 'null');
} catch {}
const keep = (m) => {
  last = m;
  try {
    localStorage.setItem(CACHE, JSON.stringify(m));
  } catch {}
  paintChip();
};

// --- the top-bar chip --------------------------------------------------------------------------

let load = null;
export function paintChip() {
  const b = $('#machineChip');
  if (!b) return;
  const c = chipOf({ load: load || last, pausedUntil: Number(S.config?.defaults?.automationsPausedUntil) || last?.guard?.pausedUntil || 0, left: last?.leftovers?.length || 0 });
  b.hidden = !c;
  if (!c) return;
  b.className = `mh-chip${c.tone ? ` ${c.tone}` : ''}`;
  const html = `${icon('laptop')}<b>${esc(c.lead)}</b><span>${esc(c.rest)}</span>`;
  if (b.dataset.html !== html) (b.innerHTML = html), (b.dataset.html = html);
  b.title = `${paneLabel()}: ${c.text}${c.why ? `. ${c.why}` : ''}`;
  b.setAttribute('aria-label', b.title);
}

async function readLoad() {
  if (document.hidden) return;
  const r = await api('/load').catch(() => null);
  if (r) load = r;
  paintChip();
}

export function startChip() {
  const b = $('#machineChip');
  if (!b) return;
  b.onclick = () => {
    openMachine();
  };
  readLoad();
  setInterval(readLoad, CHIP_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) readLoad();
  });
  bus.on('config', paintChip);
}

export function openMachine() {
  import('./settings.js').then((m) => m.openSettings({ pane: 'machine' }));
}

// --- the pane ---------------------------------------------------------------------------------

const sk = (w, h = 11) => `<span class="rec-sk" style="width:${w}px;height:${h}px"></span>`;

function gaugeHtml({ name, value, sub, path, mark, markLabel, tone = '' }) {
  return `<div class="mh-gauge">
    <span class="mh-g-name">${name}</span>
    <b class="mh-g-val${tone ? ` ${tone}` : ''}">${value}</b>
    <small class="mh-g-sub">${sub}</small>
    <svg class="mh-spark" viewBox="0 0 120 32" preserveAspectRatio="none" aria-hidden="true">${mark != null ? `<line class="mh-mark" x1="0" x2="120" y1="${mark}" y2="${mark}"/>` : ''}${path ? `<path d="${path}"/>` : ''}</svg>
    <small class="mh-g-foot">${markLabel || '&nbsp;'}</small>
  </div>`;
}

function gaugesHtml(m) {
  if (!m) return [0, 1, 2].map(() => `<div class="mh-gauge" aria-hidden="true"><span class="mh-g-name">${sk(54)}</span><b class="mh-g-val">${sk(72, 20)}</b><small class="mh-g-sub">${sk(120)}</small><svg class="mh-spark" viewBox="0 0 120 32"></svg><small class="mh-g-foot">${sk(80)}</small></div>`).join('');
  const g = m.guard || {};
  const free = m.mem?.freePct;
  const floor = g.floor ?? null;
  const ceiling = g.ceiling ?? FALLBACK_CEILING;
  const mem = spark(m.history, 'freePct', { mark: floor });
  const cpu = spark(m.history, 'cpu', { mark: g.ceiling ?? null });
  const disk = spark(m.history, 'worktreeBytes');
  const used = m.mem?.total && free != null ? m.mem.total * (1 - free / 100) : null;
  return [
    gaugeHtml({ name: 'Memory', value: `${pctText(free)} free`, sub: used != null ? `${size(used)} of ${size(m.mem.total)} used` : '', path: mem.d, mark: mem.mark, markLabel: floor != null ? `Automations wait under ${floor}%` : 'No floor set', tone: free != null && floor != null ? (free < floor ? 'bad' : free < floor + 10 ? 'warn' : '') : '' }),
    gaugeHtml({ name: 'CPU', value: pctText(m.cpu?.pct), sub: m.cpu?.cores ? `of ${plural(m.cpu.cores, 'core')}` : '', path: cpu.d, mark: cpu.mark, markLabel: g.ceiling != null ? `Automations wait over ${ceiling}%` : 'No ceiling set', tone: g.ceiling != null && m.cpu?.pct > g.ceiling ? 'warn' : '' }),
    gaugeHtml({ name: 'Disk', value: `${size(m.disk?.free) || '—'} free`, sub: m.disk?.worktrees != null ? `wisp’s folders take ${size(m.disk.worktrees)}` : '', path: disk.d, mark: null, markLabel: m.disk?.reclaimable ? `${size(m.disk.reclaimable)} can go` : '' }),
  ].join('');
}

const using = (x, busy) => `
  <span class="mh-who">${x.kind === 'task' ? `<button class="link mh-name" data-mh="open" title="${esc(x.title)}">${esc(x.title)}</button>` : `<b class="mh-name" title="${esc(x.title)}">${esc(x.title)}</b>`}<small>${x.kind === 'crew' ? `Crew · ${plural(x.ids.length, 'job')} running` : plural(x.procs || 1, 'process', 'processes')}</small></span>
  <span class="mh-n" data-l="RAM">${size(x.rss)}</span><span class="mh-n" data-l="CPU">${pctText(x.cpu)}</span><span class="mh-n" data-l="Folder">${x.bytes == null ? '' : size(x.bytes)}</span>
  <span class="mh-acts">${x.kind === 'wisp' ? '' : `<button class="ghost xs" data-mh="later" ${busy ? 'disabled' : ''} aria-haspopup="menu">Later${icon('chevron', 'mh-down')}</button><button class="ghost xs danger" data-mh="stop" ${busy ? 'disabled' : ''}>${busy ? 'Stopping…' : 'Stop'}</button>`}</span>`;

const leftRow = (p, busy) => {
  const task = p.task && (S.sessions.get(p.task)?.title || 'a finished task');
  return `<span class="mh-who"><b class="mh-name mono" title="${esc(p.command)}">${esc(p.command)}</b><small>${task ? `From ${esc(task)}` : 'No task'} · ${p.since ? `${esc(ago(p.since))} old` : ''} · pid ${p.pid}</small></span>
  <span class="mh-n" data-l="RAM">${size(p.rss)}</span>
  <span class="mh-acts"><button class="ghost xs danger" data-mh="kill" ${busy ? 'disabled' : ''}>${busy ? 'Stopping…' : 'Stop'}</button></span>`;
};

const skRows = (n, cols) => `<div class="mh-row mh-wait ${cols}" aria-hidden="true"><span class="mh-who">${sk(200)}${sk(110)}</span>${'<span class="mh-n">' + sk(40) + '</span>'}${cols === 'mh-r5' ? `<span class="mh-n">${sk(30)}</span><span class="mh-n">${sk(40)}</span>` : ''}<span class="mh-acts">${sk(96, 24)}</span></div>`.repeat(n);

export function mountMachine(box, { show } = {}) {
  let v = last;
  let timer = null;
  const gone = new Set(); // rows stopped or removed here, until the server agrees
  const busy = new Set();
  let paused = null; // a pause sent but not yet seen back: { until }

  box.innerHTML = `
    <div class="mh-box">
      <div class="mh-top"><small class="mh-at"></small><span class="mh-slot"></span></div>
      <div class="mh-gauges"></div>
      <div class="sx-head"><div><b>What’s using it</b><small>Running tasks and crew members, by memory</small></div></div>
      <div class="sx-group mh-using"><div class="mh-row mh-cols mh-r5" aria-hidden="true"><span></span><span class="mh-n">RAM</span><span class="mh-n">CPU</span><span class="mh-n">Folder</span><span></span></div><div class="mh-rows"></div></div>
      <div class="mh-left" hidden>
        <div class="sx-head"><div><b>Left behind</b><small>Still running after their task finished</small></div><button class="ghost sm danger" data-mh="kill-all">Stop all</button></div>
        <div class="sx-group"><div class="mh-rows"></div></div>
      </div>
      <div class="sx-head"><div><b>Free up space</b><small class="mh-free-sum"></small></div></div>
      <div class="sx-group mh-free"><div class="mh-rows"></div><p class="mh-next"></p></div>
      <div class="sx-head"><div><b>Automations</b><small>Check-ins, triggers, goal rounds and agents’ own follow-ups. What you start always runs</small></div></div>
      <div class="sx-group mh-auto">
        <div class="sx-row"><div class="sx-text"><b class="mh-auto-now"></b><small class="mh-auto-why"></small></div><div class="sx-ctl"><button class="ghost sm" data-mh="pause" aria-haspopup="menu"></button></div></div>
        <div class="sx-row"><div class="sx-text"><b>Limits</b><small class="mh-limits"></small></div><div class="sx-ctl"><button class="ghost sm" data-mh="limits">Change</button></div></div>
      </div>
      <div class="sx-head"><div><b>Last 24 hours</b></div></div>
      <div class="sx-group mh-day"></div>
    </div>`;

  const lists = { using: $('.mh-using .mh-rows', box), left: $('.mh-left .mh-rows', box), free: $('.mh-free .mh-rows', box) };
  const keyed = new Map(); // key → { node, html }
  // Only what changed is rewritten, and only what's out of place moves: a refresh replays nothing
  // and keeps focus.
  const fill = (list, items, cls, htmlOf) => {
    const keys = new Set(items.map((x) => x.key));
    for (const n of [...list.children]) if (!keys.has(n.dataset.key)) (keyed.delete(n.dataset.key), n.remove());
    let at = null;
    for (const x of items) {
      let r = keyed.get(x.key);
      if (!r) {
        const node = Object.assign(document.createElement('div'), { className: `mh-row ${cls}` });
        node.dataset.key = x.key;
        keyed.set(x.key, (r = { node, html: null }));
      }
      const html = htmlOf(x);
      if (r.html !== html) (r.node.innerHTML = html), (r.html = html);
      if ((at ? at.nextElementSibling : list.firstElementChild) !== r.node) (at ? at.after(r.node) : list.prepend(r.node));
      at = r.node;
    }
  };
  const setHtml = (node, html) => {
    if (node.dataset.html !== html) (node.innerHTML = html), (node.dataset.html = html);
  };

  const pausedUntil = () => (paused ? paused.until : Math.max(Number(S.config?.defaults?.automationsPausedUntil) || 0, v?.guard?.pausedUntil || 0));

  const paint = () => {
    if (!box.isConnected) return;
    setHtml($('.mh-slot', box), slotHtml('machine.head', null));
    $('.mh-at', box).textContent = v ? `Updated ${ago(v.at) === 'now' ? 'just now' : `${ago(v.at)} ago`}` : 'Reading…';
    setHtml($('.mh-gauges', box), gaugesHtml(v));

    // What's using it
    if (!v) {
      if (!$('.mh-wait', lists.using)) lists.using.innerHTML = skRows(3, 'mh-r5');
    } else {
      $$('.mh-wait', lists.using).forEach((n) => n.remove());
      const rows = usingRows(v).filter((x) => !gone.has(x.key));
      if (v.wisp) rows.push({ key: 'wisp', kind: 'wisp', title: 'wisp', rss: v.wisp.rss, cpu: v.wisp.cpu, procs: 1, bytes: null, ids: [] });
      fill(lists.using, rows, 'mh-r5', (x) => using(x, busy.has(x.key)));
      $('.mh-empty', lists.using.parentNode)?.remove();
      if (!rows.some((x) => x.kind !== 'wisp')) lists.using.insertAdjacentHTML('beforebegin', '<p class="mh-empty">No task is running.</p>');
    }

    // Left behind: only when there's something.
    const left = (v?.leftovers || []).map((p) => ({ ...p, key: `p:${p.pid}` })).filter((p) => !gone.has(p.key));
    $('.mh-left', box).hidden = !left.length;
    fill(lists.left, left, 'mh-r3', (p) => leftRow(p, busy.has(p.key)));

    // Free up space
    const groups = v ? reclaimRows(v).filter((g) => !gone.has(`r:${g.kind}`)) : [];
    const sum = groups.reduce((n, g) => n + (g.bytes || 0), 0);
    $('.mh-free-sum', box).innerHTML = !v ? sk(160) : groups.length ? `${esc(size(sum))} wisp can give back` : 'Nothing to free';
    if (!v) {
      if (!$('.mh-wait', lists.free)) lists.free.innerHTML = skRows(2, 'mh-r3');
    } else {
      $$('.mh-wait', lists.free).forEach((n) => n.remove());
      fill(lists.free, groups.map((g) => ({ ...g, key: `r:${g.kind}` })), 'mh-r3', (g) => `<span class="mh-who"><b class="mh-name">${esc(g.label)}</b><small>${g.safe ? 'Branches stay, and replying to a task brings its folder back' : 'Look first: nothing brings these back'}</small></span><span class="mh-n">${esc(size(g.bytes))}</span><span class="mh-acts"><button class="ghost xs" data-mh="review">Review</button><button class="ghost xs${g.safe ? '' : ' danger'}" data-mh="remove" ${busy.has(g.key) ? 'disabled' : ''}>Remove</button></span>`);
    }
    const days = S.config?.defaults?.worktreeCleanup ?? '7';
    $('.mh-next', box).textContent = days === 'off' ? 'Automatic cleanup is off: folders stay until you remove them.' : `By itself, the next cleanup removes clean folders of merged PRs, Done tasks after a day, and the rest after ${days} idle days. Uncommitted work, kept folders and open PRs stay.`;

    // Automations
    const until = pausedUntil();
    $('.mh-auto-now', box).innerHTML = v ? esc(automationsLine(v, until)) : sk(180);
    const g = v?.guard || {};
    const batt = g.battery?.pct != null ? `Battery ${pctText(g.battery.pct)}${g.battery.charging === false ? ', on battery' : ''}${g.battery.hold ? `: they wait under ${g.battery.hold}% off the charger` : ''}` : '';
    $('.mh-auto-why', box).textContent = until > Date.now() ? 'Resume to let them run now' : batt || 'Pause them while you need the computer';
    const pb = $('[data-mh="pause"]', box);
    pb.innerHTML = until > Date.now() ? 'Resume now' : `Pause automations${icon('chevron', 'mh-down')}`;
    pb.setAttribute('aria-haspopup', until > Date.now() ? 'false' : 'menu');
    const lim = [g.floor != null ? `under ${g.floor}% free memory` : '', g.ceiling != null ? `over ${g.ceiling}% CPU` : '', g.maxRuns ? `at ${g.maxRuns} runs going` : ''].filter(Boolean);
    $('.mh-limits', box).textContent = !v ? '' : lim.length ? `They wait ${lim.join(', ').replace(/, ([^,]*)$/, ' or $1')}` : 'Off: they never wait for the computer';

    // Last 24 h
    const d = v && dayStats(v.history);
    const stat = (n, l) => `<div class="mh-stat"><b>${n}</b><small>${l}</small></div>`;
    setHtml($('.mh-day', box), !v ? [0, 1, 2, 3].map(() => stat(sk(48, 18), sk(80))).join('') : [stat(d?.lowFree == null ? '—' : pctText(d.lowFree), 'Lowest free memory'), stat(d ? d.peakRuns : '—', 'Most runs at once'), stat(d ? (d.waited ? span(d.waited) : 'None') : '—', 'Automations waited'), stat(d ? (d.freed ? size(d.freed) : 'None') : '—', 'Disk freed')].join(''));
  };

  async function refresh() {
    clearTimeout(timer);
    const next = await api('/machine').catch(() => null);
    if (!box.isConnected) return;
    // Nothing read yet and none cached: say so where the time goes; the shapes stay till it answers.
    if (!next && !v) $('.mh-at', box).textContent = 'Can’t read this computer right now. Trying again…';
    if (next) {
      v = next;
      keep(next);
      const live = new Set([...usingRows(next).map((x) => x.key), ...(next.leftovers || []).map((p) => `p:${p.pid}`), ...reclaimRows(next).map((g) => `r:${g.kind}`)]);
      for (const k of gone) if (!live.has(k)) gone.delete(k);
      for (const k of busy) if (!live.has(k)) busy.delete(k);
      if (paused && Math.abs((next.guard?.pausedUntil || 0) - paused.until) < 1000) paused = null;
      paint();
    }
    timer = setTimeout(() => {
      if (box.isConnected && !box.closest('[hidden]')) refresh();
    }, POLL_MS);
  }

  // Goes at once; back with a toast when the server refuses.
  const act = async (keys, fn, { hide = true } = {}) => {
    for (const k of keys) (hide ? gone : busy).add(k);
    paint();
    const ok = await tryApi(fn);
    if (!ok) for (const k of keys) (gone.delete(k), busy.delete(k));
    paint();
    if (ok && keys.some((k) => k.startsWith('r:'))) {
      // A group comes back with what's left in it (new folders since), not hidden till it's empty.
      await refresh();
      for (const k of keys) gone.delete(k);
      paint();
    }
    return !!ok;
  };
  const stopTasks = (ids) => Promise.all(ids.map((id) => api(`/sessions/${id}/stop`, { method: 'POST', body: {} }))).then(() => true);
  const kill = (pids) => Promise.all(pids.map((pid) => api('/machine/stop', { method: 'POST', body: { pid } }))).then(() => true);
  const setPause = async (until) => {
    const was = S.config.defaults.automationsPausedUntil;
    paused = { until };
    S.config.defaults.automationsPausedUntil = until;
    paint();
    paintChip();
    const ok = await tryApi(() => api('/automations/pause', { method: 'POST', body: { until } }));
    if (!ok) {
      paused = null;
      S.config.defaults.automationsPausedUntil = was;
    }
    paint();
    paintChip();
  };

  box.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-mh]');
    if (!b || b.disabled) return;
    const a = b.dataset.mh;
    const row = b.closest('.mh-row');
    const key = row?.dataset.key;
    if (a === 'pause') {
      if (pausedUntil() > Date.now()) return setPause(0);
      return timeMenu(b, { back: b, choices: pauseChoices(), pick: (at) => setPause(at) });
    }
    if (a === 'limits') return show?.('usage');
    if (a === 'kill-all') {
      const all = (v?.leftovers || []).filter((p) => !gone.has(`p:${p.pid}`));
      if (!all.length) return;
      if (!(await ask(`Stop ${plural(all.length, 'process', 'processes')} left behind?\n\nThey’re from runs that already finished. Unsaved work in them is lost.`, { ok: 'Stop all', danger: true, anchor: b }))) return;
      return act(all.map((p) => `p:${p.pid}`), () => kill(all.map((p) => p.pid)));
    }
    if (!key) return;
    if (key.startsWith('p:') && a === 'kill') return act([key], () => kill([Number(key.slice(2))]));
    if (key.startsWith('r:')) {
      const g = reclaimRows(v).find((x) => `r:${x.kind}` === key);
      if (!g) return;
      if (a === 'review') return show?.('worktrees', g.kind === 'leftover' ? 'left' : 'all');
      if (!g.safe && !(await ask(`Remove ${g.label}?\n\nNo task uses them, so nothing brings them back, uncommitted changes included.`, { ok: 'Remove', danger: true, anchor: b }))) return;
      return act([key], () => api('/worktrees/clean', { method: 'POST', body: g.kind === 'leftover' ? { leftovers: g.ids } : { ids: g.ids } }).then(() => true));
    }
    const x = usingRows(v).find((y) => y.key === key);
    if (!x) return;
    if (a === 'open') return reveal(x.id);
    // Both ask first, as Stop does on the task itself (turns.js): Later stops it now too.
    const what = x.kind === 'crew' ? `${x.title}’s ${plural(x.ids.length, 'job')}` : x.title;
    if (a === 'stop') {
      if (!(await ask(`Stop ${what}?\n\nThe run ends where it is. Queued follow-ups stay, held until you send one.`, { ok: 'Stop', danger: true, anchor: b }))) return;
      return act([key], () => stopTasks(x.ids));
    }
    if (a === 'later') {
      return timeMenu(b, {
        back: b,
        choices: laterChoices(),
        pick: async (at) => {
          if (!(await ask(`Stop ${what} now?\n\nThe run ends where it is and carries on ${clock(at)}.`, { ok: 'Stop', danger: true, anchor: b }))) return;
          if (!(await act([key], () => stopTasks(x.ids)))) return;
          const ok = (await Promise.all(x.ids.map((id) => scheduleFollowUp(id, { at, text: LATER_TEXT })))).every(Boolean);
          if (ok) toast(`Stopped. ${x.kind === 'crew' ? 'Its jobs carry' : 'It carries'} on ${esc(clock(at))}`);
        },
      });
    }
  });
  bus.on('spells', paint, { node: box });
  bus.on('config', paint, { node: box });
  paint();
  return refresh;
}
