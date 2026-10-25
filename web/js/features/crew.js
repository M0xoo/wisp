// The crew: named agents that stay on hand (server/crew.js). Each member is a spirit (spirit.js)
// with a name, a role, a brief, a schedule and a memory; its work runs as tasks of its own (jobs,
// `crew` on a summary), several at once. Here: the Crew section pinned above Working in the list
// (both layouts), a member's page (jobs, what it remembers, its schedule, a box to hand it work),
// the editor that adds one (from scratch, from a template, or from a task), the spirit maker, and
// the `@` picker that puts a member in any prompt box.
//
// Spells reach it through spell-schema.js: the sidebar.crew / crew.* parts and the crew.page slot.

import { esc, md } from '../md.js';
import { api } from '../core/api.js';
import * as bus from '../core/bus.js';
import { $, $$, el, icon } from '../core/dom.js';
import { ago, timeAttrs, whenLabel } from '../core/format.js';
import { launch, S } from '../core/state.js';
import { overlay } from '../ui/overlay.js';
import { popover } from '../ui/popover.js';
import { ask } from '../ui/confirm.js';
import { toast, toastError, tryApi } from '../ui/toast.js';
import { PART_LABEL, PARTS, SPIRIT, isSpirit, parseSpirit, rollSpirit, spiritCode, spiritDefs, spiritSvg } from '../spirit.js';
import { reveal } from './feed.js';
import { projectList } from './project-list.js';
import { runnerPicker } from './runner-picker.js';
import { MODES, agentName, paintRunnerBtn, savedEffort, savedModel } from './runners.js';
import { slotHtml } from './spells.js';

// The spirits' glows, defined once for the whole page.
document.body.insertAdjacentHTML('beforeend', spiritDefs());

export const crewList = () => S.config.crew || [];
export const memberById = (id) => crewList().find((m) => m.id === id) || null;
const handleOf = (name) => String(name || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
const jobsOf = (m) => [...S.sessions.values()].filter((s) => s.crew?.id === m.id && !s.pending);

// When it checks in, in words. A cron that isn't one of these shows as itself.
export const CADENCES = [
  ['', 'Only when asked'],
  ['*/30 * * * *', 'Every 30 min'],
  ['0 * * * *', 'Hourly'],
  ['0 9 * * 1-5', 'Weekday mornings'],
  ['0 9 * * *', 'Every morning'],
  ['0 9 * * 1', 'Mondays'],
];
export const cadenceLabel = (cron) => CADENCES.find(([c]) => c === (cron || ''))?.[1] || cron;

// Ready-made members: a name, a spirit, a schedule and a brief that already work.
const TEMPLATES = [
  { key: 'ci', name: 'Scout', role: 'CI watcher', avatar: 'ghost.sky.visor.flat.antenna', cron: '*/30 * * * *', brief: 'Watch CI on the default branch (`gh run list`). When a run fails, find the cause in its logs (`gh run view <id> --log-failed`) and fix it on a branch, or say why it is flaky. When everything is green, stay quiet.' },
  { key: 'review', name: 'Quill', role: 'PR reviewer', avatar: 'blob.violet.wide.flat.headphones', cron: '0 * * * *', brief: 'Review pull requests that are new or changed since your last check-in (`gh pr list`, `gh pr diff`). Look for bugs, missing tests and risky changes, worst first, one short review per PR. Never push, approve or merge.' },
  { key: 'triage', name: 'Sorter', role: 'Issue triager', avatar: 'bean.amber.happy.smile.leaf', cron: '0 9 * * 1-5', brief: 'Read new GitHub issues. Spot duplicates, note missing repro steps, and list the ones worth doing first with a one-line plan each. Never close an issue.' },
  { key: 'deps', name: 'Tinker', role: 'Dependency keeper', avatar: 'star.lime.dots.grin.beanie', cron: '0 9 * * 1', brief: 'Check for outdated and vulnerable dependencies (`npm outdated`, `npm audit`, or the project’s own). Update the safe ones on a branch, run the tests, and report what changed and what needs a decision.' },
  { key: 'notes', name: 'Echo', role: 'Release notes', avatar: 'drop.rose.happy.cat.halo', cron: '0 17 * * 5', brief: 'Read what merged this week (git log, merged PRs) and draft the CHANGELOG entries in the project’s voice. Leave them uncommitted for me to review.' },
];

// --- avatars ----------------------------------------------------------------------------------

// What a member is up to, from its jobs in the list: asks (one waits on you), live (one runs),
// unread (a report you haven't opened), and the spirit's mood for it.
export function memberState(m) {
  const jobs = jobsOf(m);
  const asks = jobs.some((s) => s.state === 'waiting');
  const live = jobs.filter((s) => s.state === 'running');
  const unread = jobs.filter((s) => s.state === 'review' && s.unread && !s.archived).length;
  return { jobs, asks, live, unread, mood: asks ? 'asks' : live.length ? 'live' : m.paused ? 'sleep' : 'idle' };
}

// A member's face: its spirit (or the emoji it was given) on a disc of its colour.
export function avatarHtml(m, { size = 30, state, dot = true, small = size < 22 } = {}) {
  const st = memberState(m);
  const mood = state || st.mood;
  const face = m.avatar && !isSpirit(m.avatar) ? `<span>${esc(m.avatar)}</span>` : spiritSvg(m.avatar, { seed: m.name, state: mood, small });
  const color = isSpirit(m.avatar) ? parseSpirit(m.avatar).color : m.color || parseSpirit('', m.name).color;
  const badge = dot && (st.asks || st.unread) ? `<i class="cr-dot${st.asks ? ' asks' : ''}"></i>` : '';
  return `<span class="cr-av c-${color}${m.avatar && !isSpirit(m.avatar) ? ' emoji' : ''}" style="--size:${size}px">${face}${badge}</span>`;
}

// A crew job's card shows the member's face where other cards have their project dot.
export function crewDot(s) {
  const m = memberById(s.crew?.id);
  if (!m) return '';
  const what = { checkin: 'check-in', task: 'job', delegated: `job for “${s.crew.from?.title || 'another task'}”`, trigger: `job from ${s.crew.from?.title || 'a trigger'}`, mention: `answer in “${s.crew.from?.title || 'a task'}”` }[s.crew.job] || 'job';
  const mood = s.state === 'waiting' ? 'asks' : s.state === 'running' ? 'live' : 'idle';
  return `<span class="q-dot crew-dot" title="${esc(`${m.name}’s ${what}`)}">${avatarHtml(m, { size: 18, state: mood, dot: false })}</span>`;
}

// --- the Crew section ----------------------------------------------------------------------------

const sec = $('#secCrew');
const box = $('.cr-list', sec);

function statusLine(m, st) {
  if (st.asks) return { cls: 'asks', text: 'Asking you' };
  if (st.live.length) {
    const s = st.live[0];
    return { cls: 'live', text: `${s.live || 'Working'}${st.live.length > 1 ? ` · ${st.live.length} jobs` : ''}` };
  }
  if (m.queue?.length) return { cls: '', text: `${m.queue.length} waiting` };
  if (m.paused) return { cls: '', text: 'Paused' };
  if (m.wakeAt && m.wakeAt > Date.now()) return { cls: '', text: `Looks again ${whenLabel(m.wakeAt)}` };
  return { cls: '', text: m.cron ? cadenceLabel(m.cron) : 'On call' };
}

function rowHtml(m) {
  const st = memberState(m);
  const line = statusLine(m, st);
  const last = m.log?.[0];
  return `${avatarHtml(m)}
    <span class="cr-main">
      <span class="cr-top"><b class="cr-name">${esc(m.name)}</b>${m.role ? `<span class="cr-role">${esc(m.role)}</span>` : ''}</span>
      <span class="cr-sub ${line.cls}">${esc(line.text)}</span>
    </span>
    <span class="cr-side">${st.live.length ? `<span class="cr-n" title="${st.live.length} running">${st.live.length}</span>` : last ? `<span class="q-time" ${timeAttrs(last.at)}>${ago(last.at)}</span>` : ''}</span>`;
}

// Rows keyed by member: a row is only rewritten when what it says changed, and never re-appended
// (its spirit would restart its animation).
export function paintCrew() {
  const list = crewList();
  sec.hidden = !('crew' in S.config); // until the config lands
  $('h4 .n', sec).textContent = list.length || '';
  const want = list.length ? list : [null];
  want.forEach((m, i) => {
    const key = m ? m.id : 'empty';
    let row = box.children[i];
    if (row?.dataset.crew !== key) {
      row = $$(':scope > [data-crew]', box).find((x) => x.dataset.crew === key) || el(m ? `<div class="cr-row" role="button" tabindex="0" data-crew="${key}"></div>` : `<button class="cr-row cr-empty" data-crew="empty">${icon('plus')}<span class="cr-main"><b>Add someone to your crew</b><span class="cr-sub">A named agent that checks in, reports, and answers to @name</span></span></button>`);
      box.insertBefore(row, box.children[i] || null);
    }
    if (!m) return;
    const html = rowHtml(m);
    // The spirit stays (its animation keeps going); only the words around it change.
    const h = html.replace(/<svg[\s\S]*?<\/svg>/, `[${memberState(m).mood}:${m.avatar}:${m.color}]`);
    if (row.dataset.h !== h) {
      row.innerHTML = html;
      row.dataset.h = h;
    }
    row.title = `${m.name}${m.role ? ` · ${m.role}` : ''}: open (or type @${m.name} in any prompt)`;
    row.classList.toggle('paused', !!m.paused);
  });
  while (box.children.length > want.length) box.lastElementChild.remove();
  page?.paint();
}

sec.addEventListener('click', (e) => {
  if (e.target.closest('.cr-add, .cr-empty')) {
    crewEditor();
    return;
  }
  const row = e.target.closest('.cr-row[data-crew]');
  if (row) openCrew(row.dataset.crew);
});
sec.addEventListener('keydown', (e) => {
  const row = e.target.closest('.cr-row[data-crew]');
  if (row && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    row.click();
  }
});
sec.addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.cr-row[data-crew]:not(.cr-empty)');
  if (!row) return;
  e.preventDefault();
  memberMenu(row.dataset.crew, { x: e.clientX, y: e.clientY });
});
bus.on('config', () => paintCrew());

// --- actions --------------------------------------------------------------------------------------

// Optimistic: the member changes here at once, and goes back if the server refuses.
async function patchMember(m, body, { quiet = false } = {}) {
  const before = { ...m };
  Object.assign(m, body);
  paintCrew();
  try {
    Object.assign(m, await api(`/crew/${m.id}`, { method: 'PATCH', body }));
    paintCrew();
    return true;
  } catch (err) {
    Object.assign(m, before);
    paintCrew();
    if (!quiet) toastError(err);
    return false;
  }
}

export async function checkIn(id) {
  const m = memberById(id);
  if (!m) return;
  const out = await tryApi(() => api(`/crew/${id}/checkin`, { method: 'POST', body: {} }));
  if (out?.session) toast(`${esc(m.name)} is checking in`, { action: { label: 'Open', run: () => reveal(out.session.id) } });
  else if (out?.queued) toast(`${esc(m.name)} will check in when a job finishes`);
}

export async function togglePause(id) {
  const m = memberById(id);
  if (!m) return;
  if (await patchMember(m, { paused: !m.paused })) toast(m.paused ? `Paused ${esc(m.name)}: no check-ins until you resume` : `${esc(m.name)} is back on`);
}

export async function removeMember(id, anchor) {
  const m = memberById(id);
  if (!m) return;
  if (!(await ask(`Remove ${m.name} from your crew?\n\nTheir jobs stay as tasks. What they remember goes, and triggers that send them work are turned off.`, { ok: `Remove ${m.name}`, danger: true, anchor }))) return;
  const list = crewList();
  const at = list.indexOf(m);
  list.splice(at, 1);
  page?.id === id && page.close();
  paintCrew();
  try {
    await api(`/crew/${id}`, { method: 'DELETE' });
    toast(`Removed ${esc(m.name)}`);
  } catch (err) {
    list.splice(at, 0, m);
    paintCrew();
    toastError(err);
  }
}

// Hand a member a job. The box empties at once and gets its text back if the server refuses.
export async function sendJob(m, prompt, { restore } = {}) {
  try {
    const out = await api(`/crew/${m.id}/jobs`, { method: 'POST', body: { prompt } });
    if (out.member) Object.assign(m, out.member);
    paintCrew();
    if (out.session) toast(`Sent to ${esc(m.name)}`, { action: { label: 'Open', run: () => reveal(out.session.id) } });
    else toast(`${esc(m.name)} is busy: it starts when a job finishes (${out.queued} waiting)`);
  } catch (err) {
    restore?.();
    toastError(err);
  }
}

function memberMenu(id, { x, y, anchor } = {}) {
  const m = memberById(id);
  if (!m) return;
  $('.menu.cr-menu')?.close();
  const menu = el(`<div class="menu cr-menu">
      <button data-a="open">${icon('crew')}Open ${esc(m.name)}</button>
      <button data-a="checkin">${icon('clock')}Check in now</button>
      <button data-a="pause">${icon(m.paused ? 'play' : 'pause')}${m.paused ? 'Resume' : 'Pause'}</button>
      <button data-a="edit">${icon('pen')}Edit…</button>
      <button data-a="remove" class="danger">${icon('trash')}Remove from crew</button>
    </div>`);
  menu.onclick = (e) => {
    const a = e.target.closest('button')?.dataset.a;
    close();
    if (a === 'open') openCrew(id);
    if (a === 'checkin') checkIn(id);
    if (a === 'pause') togglePause(id);
    if (a === 'edit') crewEditor({ member: m });
    if (a === 'remove') removeMember(id, anchor);
  };
  const close = popover(menu, { anchor });
  const r = anchor?.getBoundingClientRect();
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  const left = r ? r.right - w : x;
  const top = r ? (r.bottom + 6 + h > innerHeight ? r.top - h - 6 : r.bottom + 6) : y;
  menu.style.left = `${Math.max(8, Math.min(left, innerWidth - w - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(top, innerHeight - h - 8))}px`;
}

// --- a member's page --------------------------------------------------------------------------------

let page = null; // the open one: { id, node, paint, close }

const JOB_ICON = { checkin: 'clock', task: 'send', delegated: 'agent', trigger: 'bolt', mention: 'ask' };
const JOB_WORD = { checkin: 'Check-in', task: 'Job', delegated: 'Delegated', trigger: 'Trigger', mention: 'Tagged' };

export function openCrew(id) {
  const m0 = memberById(id);
  if (!m0) return;
  page?.close();
  const node = el(`<div class="modal crew-page" role="dialog" aria-label="${esc(m0.name)}">
      <header class="cp-head"></header>
      <form class="cp-ask">
        <textarea class="cp-prompt" rows="1" spellcheck="false"></textarea>
        <button class="primary sm" title="Send (↵)">${icon('send')}<span>Send</span></button>
      </form>
      <div class="cp-grid">
        <section class="cp-jobs"></section>
        <section class="cp-mem">
          <h4>Notebook <small>what they remember between jobs</small></h4>
          <textarea class="textarea mono cp-notebook" spellcheck="false" placeholder="Empty so far. They add to it as they work; you can edit it too."></textarea>
          <p class="cp-meta"><span class="cp-count"></span><span class="cp-saved"></span></p>
          <h4>Brief <button class="link xs" data-a="edit">Edit</button></h4>
          <div class="cp-brief"></div>
          <h4>How they work</h4>
          <dl class="cp-facts"></dl>
        </section>
      </div>
    </div>`);
  const close = overlay(node, { onClose: () => page?.node === node && (page = null) });
  const ta = $('.cp-prompt', node);
  const nb = $('.cp-notebook', node);
  const autosize = (t) => {
    t.style.height = 'auto';
    t.style.height = `${Math.min(t.scrollHeight, 220)}px`;
  };
  ta.addEventListener('input', () => {
    autosize(ta);
  });

  const paint = () => {
    const m = memberById(id);
    if (!m) return close();
    const st = memberState(m);
    const project = S.config.projects?.find((p) => p.path === m.cwd);
    const head = `${avatarHtml(m, { size: 56, dot: false })}
      <div class="cp-who"><h2>${esc(m.name)}</h2><small>${esc([m.role, statusLine(m, st).text].filter(Boolean).join(' · '))}</small></div>
      <span class="grow"></span>
      ${slotHtml('crew.page', null)}
      <button class="ghost sm" data-a="checkin" title="Start a check-in now">${icon('clock')}<span>Check in</span></button>
      <button class="icon-btn" data-a="more" title="More" aria-label="More">${icon('dots')}</button>
      <button class="icon-btn close" title="Close" aria-label="Close">${icon('x')}</button>`;
    const hd = $('.cp-head', node);
    const hkey = head.replace(/<svg[\s\S]*?<\/svg>/, `[${st.mood}:${m.avatar}]`);
    if (hd.dataset.h !== hkey) {
      hd.innerHTML = head;
      hd.dataset.h = hkey;
      $('.close', hd).onclick = () => {
        close();
      };
    }
    ta.placeholder = `Give ${m.name} a job…`;
    // Jobs: running and waiting first, then what they did (the log, quiet check-ins faded).
    const running = st.jobs.filter((s) => s.state === 'running' || s.state === 'waiting').sort((a, b) => b.createdAt - a.createdAt);
    const jobRow = (s) => `<button class="cp-job ${s.state}" data-session="${s.id}">
        <span class="cp-ji">${icon(JOB_ICON[s.crew.job] || 'send')}</span>
        <span class="cp-jt"><b>${esc(s.title)}</b><small>${esc(s.state === 'waiting' ? 'Asking you' : s.live || 'Working')}</small></span>
        <span class="cp-jk">${JOB_WORD[s.crew.job] || 'Job'}</span>
      </button>`;
    const logRow = (l) => `<button class="cp-log ${l.quiet ? 'quiet' : ''} st-${esc(l.status || 'done')}" ${l.sessionId && S.sessions.has(l.sessionId) ? `data-session="${l.sessionId}"` : 'disabled'}>
        <span class="cp-ji">${icon(JOB_ICON[l.job] || 'send')}</span>
        <span class="cp-jt"><b>${esc(l.title)}</b>${l.summary ? `<small>${esc(l.summary)}</small>` : ''}</span>
        <span class="q-time" ${timeAttrs(l.at)}>${ago(l.at)}</span>
      </button>`;
    const queue = (m.queue || []).map((w) => `<div class="cp-job queued"><span class="cp-ji">${icon('queue')}</span><span class="cp-jt"><b>${esc(w.prompt.split('\n')[0].slice(0, 120))}</b><small>Waiting for a free slot</small></span><button class="icon-btn" data-drop="${w.id}" title="Drop this job" aria-label="Drop this job">${icon('x')}</button></div>`).join('');
    const jobs = `<h4>Working on <span class="n">${running.length + (m.queue?.length || 0) || ''}</span></h4>
      ${running.length || queue ? running.map(jobRow).join('') + queue : `<p class="cp-empty">Nothing right now${m.paused ? ' (paused)' : m.cron ? ` · ${esc(cadenceLabel(m.cron).toLowerCase())}` : ''}.</p>`}
      <h4>Recent</h4>
      ${m.log?.length ? m.log.slice(0, 25).map(logRow).join('') : `<p class="cp-empty">No jobs yet. Send one above, or check in.</p>`}`;
    const jb = $('.cp-jobs', node);
    if (jb.dataset.h !== jobs) (jb.innerHTML = jobs), (jb.dataset.h = jobs);
    if (document.activeElement !== nb && nb.value !== (m.notebook || '')) nb.value = m.notebook || '';
    $('.cp-count', node).textContent = `${(nb.value.length).toLocaleString()} / 6,000`;
    $('.cp-count', node).classList.toggle('over', nb.value.length > 6000);
    $('.cp-brief', node).innerHTML = m.brief ? `<div class="prose">${md(m.brief)}</div>` : '<p class="cp-empty">No brief: they do what each job asks.</p>';
    $('.cp-facts', node).innerHTML = [
      ['Checks in', m.paused ? 'Paused' : cadenceLabel(m.cron)],
      ['At once', `${m.parallel} job${m.parallel > 1 ? 's' : ''}`],
      ['Works in', project?.name || (m.cwd ? m.cwd.split(/[\\/]/).pop() : 'No project')],
      ['Runs on', `${agentName(m.agent)}${m.model ? ` · ${m.model}` : ''}`],
      ['Mode', MODES.find((x) => x.id === m.mode)?.label || 'Full auto'],
    ]
      .map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`)
      .join('');
  };

  node.addEventListener('click', (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    const m = memberById(id);
    if (!m) return;
    if (a === 'checkin') checkIn(id);
    if (a === 'edit') crewEditor({ member: m });
    if (a === 'more') memberMenu(id, { anchor: e.target.closest('[data-a]') });
    const sid = e.target.closest('[data-session]')?.dataset.session;
    if (sid) {
      close();
      reveal(sid);
    }
    const drop = e.target.closest('[data-drop]')?.dataset.drop;
    if (drop) patchMember(m, { queue: m.queue.filter((w) => w.id !== drop).map((w) => w.id) }).then(() => paint());
  });
  $('.cp-ask', node).onsubmit = (e) => {
    e.preventDefault();
    const text = ta.value.trim();
    const m = memberById(id);
    if (!text || !m) return;
    ta.value = '';
    autosize(ta);
    sendJob(m, text, {
      restore: () => {
        ta.value = text;
        autosize(ta);
      },
    });
  };
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $('.cp-ask', node).requestSubmit();
    }
  });
  // The notebook saves itself a moment after you stop typing (and when you leave it).
  let typing;
  const saveNotebook = async () => {
    clearTimeout(typing);
    const m = memberById(id);
    if (!m || nb.value === (m.notebook || '')) return;
    $('.cp-saved', node).textContent = 'Saving…';
    const ok = await patchMember(m, { notebook: nb.value });
    $('.cp-saved', node).textContent = ok ? 'Saved' : '';
  };
  nb.addEventListener('input', () => {
    $('.cp-count', node).textContent = `${nb.value.length.toLocaleString()} / 6,000`;
    $('.cp-saved', node).textContent = '';
    clearTimeout(typing);
    typing = setTimeout(saveNotebook, 900);
  });
  nb.addEventListener('blur', saveNotebook);

  page = { id, node, paint, close };
  paint();
  requestAnimationFrame(() => ta.focus());
}

// --- the editor: add, edit, or make a task a member ---------------------------------------------------

// member: edit it. task: a task (summary) joining the crew; its folder and harness come with it.
export function crewEditor({ member = null, task = null, draft = null } = {}) {
  const editing = !!member;
  const d = draft || {
    name: member?.name || '',
    role: member?.role || '',
    avatar: member?.avatar || '',
    brief: member?.brief ?? '',
    cron: member?.cron ?? '',
    parallel: member?.parallel || 2,
    cwd: member?.cwd ?? (task ? '' : S.config.projects?.find((p) => p.id === launch.project)?.path || ''),
    agent: member?.agent || S.config.defaults?.agent || 'auto',
    model: member?.model || '',
    effort: member?.effort || '',
    mode: member?.mode || 'auto',
    checkin: !editing && !task,
  };
  if (!d.avatar) d.avatar = rollSpirit(Math.random());
  const custom = () => !CADENCES.some(([c]) => c === d.cron);
  const node = el(`<div class="modal crew-edit" role="dialog">
      <header><h2>${editing ? `Edit ${esc(member.name)}` : task ? 'Add this task to your crew' : 'Add to your crew'}</h2><button class="icon-btn close" title="Close" aria-label="Close">${icon('x')}</button></header>
      ${editing || task ? '' : `<div class="ce-templates"><span class="ce-lbl">Start from</span>${TEMPLATES.map((t) => `<button type="button" class="lp-chip" data-tpl="${t.key}"><span class="ce-tav">${spiritSvg(t.avatar, { small: true })}</span>${esc(t.role)}</button>`).join('')}</div>`}
      <form class="ce-form">
        <div class="ce-who">
          <button type="button" class="ce-face" title="Change how they look" aria-label="Change how they look"></button>
          <div class="ce-names">
            <label class="field ce-name"><span>Name</span><input name="name" maxlength="24" placeholder="Ada" spellcheck="false" autocomplete="off" required></label>
            <label class="field ce-role"><span>Role</span><input name="role" maxlength="60" placeholder="CI watcher, PR reviewer…" spellcheck="false" autocomplete="off"></label>
            <p class="ce-handle"></p>
          </div>
        </div>
        <div class="ce-maker" hidden></div>
        <label class="ce-stack"><span>Their job <small>in every job’s prompt, with what they remember</small></span>
          <textarea class="textarea" name="brief" rows="4" maxlength="4000" placeholder="What they look after, how you like it done, and what they should never do. E.g. Watch CI on main; fix failures on a branch; stay quiet when it’s green."></textarea></label>
        <div class="ce-stack"><span>Checks in <small>on their own, between the jobs you give them</small></span>
          <div class="ce-cadence">${CADENCES.map(([c, l]) => `<button type="button" class="lp-chip" data-cron="${c}">${l}</button>`).join('')}<button type="button" class="lp-chip" data-cron="custom">Custom…</button></div>
          <input class="input sm mono ce-cron" name="cron" placeholder="*/15 9-18 * * 1-5" spellcheck="false" hidden>
        </div>
        <div class="ce-bar">
          ${task ? '' : `<button type="button" class="tog-btn ce-proj" title="The project their jobs run in">${icon('folder')}<span></span>${icon('chevron', 'chev')}</button>
          <button type="button" class="runner-btn ce-runner" title="Harness, model and thinking level" aria-haspopup="dialog"></button>`}
          <select class="ce-mode" name="mode" title="What they may do without asking">${MODES.map((x) => `<option value="${x.id}">${x.label}</option>`).join('')}</select>
          <span class="ce-par" title="Jobs they run at the same time; more wait their turn">
            <button type="button" data-par="-1" aria-label="One fewer at once">${icon('minus')}</button><b></b><button type="button" data-par="1" aria-label="One more at once">${icon('plus')}</button>
          </span>
        </div>
        <footer class="ce-foot">
          ${editing || task ? '' : `<label class="check"><input type="checkbox" name="checkin"> First check-in now</label>`}
          <span class="grow"></span>
          <button type="button" class="ghost sm" data-a="cancel">Cancel</button>
          <button class="primary sm">${editing ? 'Save' : 'Add to crew'}</button>
        </footer>
      </form>
    </div>`);
  const close = overlay(node);
  const f = $('form', node);
  const $f = (n) => $(`[name="${n}"]`, f);
  $('.close', node).onclick = () => {
    close();
  };
  $('[data-a="cancel"]', node).onclick = () => {
    close();
  };
  $f('name').value = d.name;
  $f('role').value = d.role;
  $f('brief').value = d.brief;
  $f('mode').value = d.mode;
  $f('cron').value = d.cron;
  if ($f('checkin')) $f('checkin').checked = !!d.checkin;
  if (task && !d.brief) {
    // The task's first prompt is a good start for the brief.
    api(`/sessions/${task.id}`)
      .then((s) => {
        if (!$f('brief').value) $f('brief').value = s.turns?.[0]?.prompt?.replace(/@\[([^\]]+)\]\((?:wisp|crew):[a-z0-9]+\)/g, '@$1') || '';
      })
      .catch(() => {});
  }

  const paintFace = () => {
    $('.ce-face', node).innerHTML = `${avatarHtml({ ...d, id: '' }, { size: 64, dot: false, state: 'idle' })}<span class="ce-dice">${icon('rerun')}</span>`;
  };
  const paintHandle = () => {
    const n = $f('name').value.trim();
    $('.ce-handle', node).innerHTML = n ? `Reach them with <code>@${esc(n)}</code> in any prompt or follow-up` : 'Pick a name you can type: you’ll reach them with @name';
  };
  const paintCadence = () => {
    $$('.ce-cadence [data-cron]', node).forEach((b) => b.classList.toggle('on', b.dataset.cron === 'custom' ? custom() : b.dataset.cron === d.cron));
    $('.ce-cron', node).hidden = !custom();
  };
  const paintBar = () => {
    $('.ce-par b', node).textContent = `${d.parallel} at once`;
    $('[data-par="-1"]', node).disabled = d.parallel <= 1;
    $('[data-par="1"]', node).disabled = d.parallel >= 5;
    if (task) return;
    const p = S.config.projects?.find((x) => x.path === d.cwd);
    $('.ce-proj span', node).textContent = p?.name || (d.cwd ? d.cwd.split(/[\\/]/).pop() : 'No project');
    paintRunnerBtn($('.ce-runner', node), d.agent, d.model, d.effort);
  };

  // The spirit maker: a big preview, the dice, and a row of choices per part.
  const maker = $('.ce-maker', node);
  const paintMaker = () => {
    const p = parseSpirit(isSpirit(d.avatar) ? d.avatar : '', d.name || 'wisp');
    maker.innerHTML = `${PARTS.map(
      (k) => `<div class="cm-row"><span class="ce-lbl">${PART_LABEL[k]}</span><div class="cm-opts">${SPIRIT[k]
        .map((v) => {
          const code = spiritCode({ ...p, [k]: v });
          const on = p[k] === v && isSpirit(d.avatar);
          return `<button type="button" class="cm-opt${on ? ' on' : ''}" data-code="${code}" title="${esc(v)}" aria-label="${PART_LABEL[k]}: ${esc(v)}" aria-pressed="${on}">${k === 'color' ? `<i class="cm-sw c-${v}"></i>` : spiritSvg(code, { state: 'idle' })}</button>`;
        })
        .join('')}</div></div>`,
    ).join('')}
      <div class="cm-foot"><button type="button" class="ghost xs" data-a="roll">${icon('rerun')}Surprise me</button>
        <label class="field sm cm-emoji" title="Or use an emoji"><span>or an emoji</span><input maxlength="8" value="${isSpirit(d.avatar) ? '' : esc(d.avatar)}" placeholder="🦊" autocomplete="off"></label></div>`;
    $('.cm-emoji input', maker).oninput = (e) => {
      const v = e.target.value.trim();
      d.avatar = v || rollSpirit(d.name || Math.random());
      paintFace();
    };
  };
  const setFace = (code) => {
    d.avatar = code;
    paintFace();
    if (!maker.hidden) paintMaker();
  };

  node.addEventListener('click', (e) => {
    if (e.target.closest('.ce-face')) {
      // The first click on the face opens the maker; the dice on it rolls a new one.
      if (e.target.closest('.ce-dice') || !maker.hidden) setFace(rollSpirit(Math.random()));
      if (maker.hidden) {
        maker.hidden = false;
        paintMaker();
      }
      return;
    }
    const opt = e.target.closest('[data-code]');
    if (opt) return setFace(opt.dataset.code);
    if (e.target.closest('[data-a="roll"]')) return setFace(rollSpirit(Math.random()));
    const tpl = TEMPLATES.find((t) => t.key === e.target.closest('[data-tpl]')?.dataset.tpl);
    if (tpl) {
      $$('[data-tpl]', node).forEach((b) => b.classList.toggle('on', b.dataset.tpl === tpl.key));
      // A name you typed stays; the template's is a suggestion.
      if (!$f('name').value.trim() || TEMPLATES.some((t) => t.name === $f('name').value.trim())) $f('name').value = tpl.name;
      $f('role').value = tpl.role;
      $f('brief').value = tpl.brief;
      d.cron = tpl.cron;
      $f('cron').value = tpl.cron;
      setFace(tpl.avatar);
      paintHandle();
      paintCadence();
      return;
    }
    const c = e.target.closest('[data-cron]')?.dataset.cron;
    if (c !== undefined) {
      d.cron = c === 'custom' ? (custom() ? d.cron : '*/15 * * * *') : c;
      $f('cron').value = d.cron;
      paintCadence();
      if (c === 'custom') $f('cron').focus();
      return;
    }
    const par = Number(e.target.closest('[data-par]')?.dataset.par);
    if (par) {
      d.parallel = Math.min(5, Math.max(1, d.parallel + par));
      paintBar();
      return;
    }
    if (e.target.closest('.ce-proj')) {
      projectList(e.target.closest('.ce-proj'), {
        projects: S.config.projects || [],
        current: S.config.projects?.find((p) => p.path === d.cwd)?.id,
        extras: [{ id: '', icon: 'x', label: 'No project' }],
        label: 'Works in',
        onPick: (pid) => {
          d.cwd = S.config.projects?.find((x) => x.id === pid)?.path || '';
          paintBar();
        },
      });
      return;
    }
    if (e.target.closest('.ce-runner')) {
      runnerPicker(e.target.closest('.ce-runner'), { agent: d.agent, model: d.model, effort: d.effort, savedModel, savedEffort, auto: true }, (a, mo, ef) => {
        Object.assign(d, { agent: a, model: mo, effort: ef });
        paintBar();
      });
    }
  });
  $f('name').addEventListener('input', () => {
    paintHandle();
  });
  $f('cron').addEventListener('input', () => {
    d.cron = $f('cron').value.trim();
  });

  f.onsubmit = async (e) => {
    e.preventDefault();
    const body = { name: $f('name').value.trim(), role: $f('role').value.trim(), avatar: d.avatar, ...(isSpirit(d.avatar) && { color: parseSpirit(d.avatar).color }), brief: $f('brief').value.trim(), cron: d.cron, parallel: d.parallel, mode: $f('mode').value, ...(task ? {} : { cwd: d.cwd, agent: d.agent, model: d.model, effort: d.effort }) };
    if (!body.name) return $f('name').focus();
    const again = () => crewEditor({ member, task, draft: { ...d, ...body, checkin: $f('checkin')?.checked } });
    close();
    if (editing) {
      if (await patchMember(member, body)) toast(`Saved ${esc(body.name)}`);
      else again();
      return;
    }
    // Optimistic: the row is there at once, and goes (with the dialog back) if the server refuses.
    const temp = { ...body, id: `new-${Date.now()}`, color: parseSpirit(d.avatar).color, log: [], queue: [], notebook: '', paused: false };
    S.config.crew = [...crewList(), temp];
    paintCrew();
    try {
      const m = await api(task ? `/sessions/${task.id}/crew` : '/crew', { method: 'POST', body: { ...body, checkin: !!$f('checkin')?.checked } });
      S.config.crew = crewList().map((x) => (x === temp ? m : x));
      if (task) {
        const s = S.sessions.get(task.id);
        if (s) s.crew = { id: m.id, job: 'task' };
      }
      paintCrew();
      toast(`${esc(m.name)} joined your crew`, { action: { label: 'Open', run: () => openCrew(m.id) } });
    } catch (err) {
      S.config.crew = crewList().filter((x) => x !== temp);
      paintCrew();
      toastError(err);
      again();
    }
  };
  paintFace();
  paintHandle();
  paintCadence();
  paintBar();
  requestAnimationFrame(() => $f('name').focus());
}

export function addToCrew(id) {
  const s = S.sessions.get(id);
  if (s) crewEditor({ task: s });
}

// The members a message starts with (a stored `@[Ada](crew:<id>)` or a typed `@Ada`): it's for
// them, not for the task's agent. rest: the message without them. Mirrors crewMentions() in
// server/crew.js.
export function addressedTo(text) {
  const list = crewList();
  const members = [];
  let rest = String(text || '').trimStart();
  const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  while (list.length) {
    const tok = rest.match(/^@\[[^\]\n]{1,200}\]\(crew:([a-z0-9]{6,40})\)[\s,:]*/);
    let m = tok && memberById(tok[1]);
    let len = tok?.[0].length || 0;
    if (!m)
      for (const x of [...list].sort((a, b) => b.name.length - a.name.length)) {
        const hit = rest.match(new RegExp(`^@(?:${escRe(x.name)}|${escRe(handleOf(x.name))})(?![\\p{L}\\p{N}_-])[\\s,:]*`, 'iu'));
        if (hit) {
          m = x;
          len = hit[0].length;
          break;
        }
      }
    if (!m) break;
    if (!members.includes(m)) members.push(m);
    rest = rest.slice(len);
  }
  return { members, rest: rest.trim() };
}

// --- @ in a prompt box ---------------------------------------------------------------------------------

// Typing @ and a few letters in any prompt or follow-up box offers the crew; picking one puts them in
// as a mention (`@[Ada](crew:<id>)` in what's sent; the box shows @Ada). A message that starts with
// them is theirs; a mention further in lets the task's agent hand them work.
let picker = null; // { ta, close, list, act, start }
const NATIVE = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');

function pickerFor(ta) {
  if (!ta?.mentions || !crewList().length) return closePicker();
  const caret = ta.selectionStart;
  if (caret !== ta.selectionEnd) return closePicker();
  const before = NATIVE.get.call(ta).slice(0, caret); // what the box shows, not the stored form
  const m = before.match(/(^|[\s(])@([\p{L}\p{N}._-]{0,24})$/u);
  if (!m) return closePicker();
  const q = m[2].toLowerCase();
  const list = crewList().filter((x) => !q || x.name.toLowerCase().startsWith(q) || handleOf(x.name).startsWith(q) || x.role?.toLowerCase().includes(q)).slice(0, 6);
  if (!list.length) return closePicker();
  const start = caret - m[2].length - 1;
  if (!picker || picker.ta !== ta) {
    closePicker();
    const node = el(`<div class="menu cr-pick" role="listbox" aria-label="Crew"></div>`);
    node.addEventListener('mousedown', (e) => {
      e.preventDefault(); // keep the box focused
      const b = e.target.closest('[data-i]');
      if (b) choose(Number(b.dataset.i));
    });
    picker = { ta, node, close: popover(node, { anchor: ta, back: ta, onClose: () => (picker = null) }), act: 0 };
  }
  Object.assign(picker, { list, start, act: Math.min(picker.act, list.length - 1) });
  picker.node.innerHTML = `<div class="wm-h">Crew <small>↵ to tag · a message that starts with them is theirs</small></div>${list
    .map((x, i) => `<button type="button" class="cr-pick-row${i === picker.act ? ' act' : ''}" data-i="${i}" role="option">${avatarHtml(x, { size: 24, dot: false })}<span class="cr-main"><b>${esc(x.name)}</b>${x.role ? `<small>${esc(x.role)}</small>` : ''}</span></button>`)
    .join('')}`;
  // Under the box where there's room, else over it.
  const r = ta.getBoundingClientRect();
  const h = picker.node.offsetHeight;
  picker.node.style.left = `${Math.max(8, Math.min(r.left + 8, innerWidth - picker.node.offsetWidth - 8))}px`;
  picker.node.style.top = `${r.bottom + 6 + h < innerHeight ? r.bottom + 6 : Math.max(8, r.top - h - 6)}px`;
}

function closePicker() {
  picker?.close();
  picker = null;
}

function choose(i) {
  const p = picker;
  const m = p?.list[i];
  if (!m) return;
  const { ta } = p;
  if (!ta.mentions.some((x) => x.id === m.id)) ta.mentions.push({ id: m.id, title: m.name, kind: 'crew' });
  ta.focus();
  ta.setSelectionRange(p.start, ta.selectionStart);
  closePicker();
  if (!document.execCommand('insertText', false, `@${m.name} `)) {
    ta.setRangeText(`@${m.name} `, ta.selectionStart, ta.selectionEnd, 'end');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

document.addEventListener('input', (e) => {
  if (e.target instanceof HTMLTextAreaElement && e.target.mentions) pickerFor(e.target);
});
document.addEventListener(
  'keydown',
  (e) => {
    if (!picker || e.target !== picker.ta || e.isComposing) return;
    const n = picker.list.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      picker.act = (picker.act + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
      $$('.cr-pick-row', picker.node).forEach((b, i) => b.classList.toggle('act', i === picker.act));
    } else if (e.key === 'Enter' || e.key === 'Tab') choose(picker.act);
    else if (e.key === 'Escape') closePicker();
    else return;
    e.preventDefault();
    e.stopImmediatePropagation();
  },
  true,
);
document.addEventListener('focusout', (e) => {
  if (picker && e.target === picker.ta) setTimeout(() => document.activeElement !== picker?.ta && closePicker());
});

// A crew chip in a sent prompt opens the member's page.
document.addEventListener('click', (e) => {
  const b = e.target.closest?.('.mn.crew[data-crew]');
  if (!b) return;
  e.preventDefault();
  if (memberById(b.dataset.crew)) openCrew(b.dataset.crew);
  else toast('They’re no longer on your crew.', { tone: 'bad' });
});
