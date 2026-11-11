// The crew: named agents that stay on hand (server/crew.js). Each member is a spirit (spirit.js)
// with a name, a role, a brief, a schedule and a memory; its work runs as tasks of its own (jobs,
// `crew` on a summary), several at once. Here: the Crew section pinned above Working in the list
// (both layouts), a member's page (jobs, what it remembers, its schedule, a box to hand it work),
// the editor that adds one (from scratch, from a template, or from a task), the spirit maker, and
// the `@` picker that puts a member in any prompt box.
//
// Spells reach it through spell-schema.js: the sidebar.crew / crew.* parts and the crew.page slot.

import { aheadLabel } from './later.js';
import { esc, md } from '../md.js';
import { cleanTitle, plain } from '../mention-text.js';
import { api } from '../core/api.js';
import * as bus from '../core/bus.js';
import { $, $$, beforePaint, el, icon } from '../core/dom.js';
import { ago, STATUS_LABEL, statusKey, timeAttrs, whenLabel } from '../core/format.js';
import { fmtDuration } from '../blocks.js';
import { HERE, isForLater, launch, load, MOBILE, needsYou, S, save } from '../core/state.js';
import { canSaveForLater, setForLater } from './actions.js';
import { onBack } from '../ui/back.js';
import { overlay } from '../ui/overlay.js';
import { popover } from '../ui/popover.js';
import { ask } from '../ui/confirm.js';
import { toast, toastError, tryApi } from '../ui/toast.js';
import { PART_LABEL, PARTS, SPIRIT, isSpirit, parseSpirit, rollSpirit, spiritCode, spiritDefs, spiritSvg } from '../spirit.js';
import { collapse, feedToTop, focusReply, groups, placeCards, renderFeed, reveal } from './feed.js';
import { mentionBox } from './mentions.js';
import { crewRailOn, goBack, goHome, isSplit, isStacked, splitOpen } from './split.js';
import { projectList } from './project-list.js';
import { runnerPicker } from './runner-picker.js';
import { MODES, agentName, harnessesAt, harnessLogo, modeMenu, paintRunnerBtn, savedEffort, savedModel } from './runners.js';
import { connectMachine } from './machines.js';
import { placeMenu } from './place-menu.js';
import { canSandbox, inProject, machineById, pathAt, placeName, placesOf, projects } from './places.js';
import { slotHtml, spellProp } from './spells.js';
import { paintTeamBtn, teamEditor } from './team.js';
import { addFiles, kitClick, kitHtml, offerClick, offerHtml } from './crew-kit.js';
import { hideHold, holdNow, showHold } from './hold.js';
import { importCrew, reviewChange, shareMember } from './crew-share.js';
import { trackRecord } from './crew-record.js';
import { stuffCount, stuffMatches, stuffSub, stuffThumbHtml } from './stuff.js';
import { TEMPLATES } from '../crew-templates.js';
import { byUrgency, cardJobs, CARD_ROWS, headingForCard, holdRows, jobMark, standing, stepRow } from '../crew-jobs.js';
import { cronWords, toCron } from '../schedule.js';

// The spirits' glows, defined once for the whole page.
document.body.insertAdjacentHTML('beforeend', spiritDefs());

export const crewList = () => S.config.crew || [];
// Where a member's jobs run when it's a sandbox (services/sandbox.js), as the editor and profile say it.
const SANDBOX_LABEL = { job: 'Sandbox per job', own: 'Own sandbox' };
export const memberById = (id) => crewList().find((m) => m.id === id) || null;
const handleOf = (name) => String(name || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
const jobsOf = (m) => [...S.sessions.values()].filter((s) => s.crew?.id === m.id && !s.pending);
// Jobs sent that the server hasn't started yet (sendJob): a Starting up card under the member.
const pendingOf = (m) => [...S.sessions.values()].filter((s) => s.crew?.id === m.id && s.pending);

// A job run for another task (delegated, an @mention, a check on it) lives under its member: that
// task shows its work. The rest (check-ins, jobs you sent, triggers) are tasks in the list like any
// other, with the member's face. Saved for later: in that section either way.
const FOR_TASK = new Set(['delegated', 'mention', 'event']);
export const underMember = (s) => !!s?.crew && FOR_TASK.has(s.crew.job) && !!memberById(s.crew.id) && !isForLater(s);

// Until it needs you (a question, a report you haven't read): then it's in Needs you with your own
// tasks, and only there. Opening a report reads it, and its row stays until you close it.
const inNeedsNow = new Set();
export function inNeeds(s) {
  if (!underMember(s) || s.pending) return false;
  if (needsYou(s)) inNeedsNow.add(s.id);
  else if (!S.open.has(s.id) || !needsYou({ ...s, unread: true })) inNeedsNow.delete(s.id);
  return inNeedsNow.has(s.id);
}
// In the list's Needs you right now: a project filter leaves it under its member.
const inList = (s) => {
  const need = inNeeds(s); // first: it keeps count of what's open
  const pick = crewPick();
  return (pick ? s.crew?.id === pick : need) && (S.filter === 'all' || inProject(s, S.filter));
};

// The member picked on the rail: the list beside it shows only its jobs (groups() in feed.js) and
// New task is for it. Only with the rail: stacked, or a spell's choice, a saved pick waits unused.
// Until the config lands the member can't be known: it holds, so a reload doesn't flash the whole list.
export function crewPick() {
  const id = S.crewPick;
  if (!id || !crewRailOn()) return null;
  return !('crew' in S.config) || memberById(id) ? id : null;
}
export const inPick = (s) => {
  const pick = crewPick();
  return !pick || s?.crew?.id === pick;
};
export function setCrewPick(id) {
  S.crewPick = id;
  save('wisp.crewPick', id);
  paintCrewTint();
}

// What colour the task panel takes for a member: their glow (''), a colour they picked, or none.
export const panelTint = (m) => (!m ? '' : m.bg === 'none' ? '' : m.bg || glowOf(m));

// The list beside the rail takes a very light wash of the picked member's colour, so a glance says
// whose jobs it holds. It stays its usual colour when nothing is picked, the rail is off, the
// setting is off, or their tint is none. The c- class goes on the panel, not body, so --pc stays out
// of everything else on the page.
export function paintCrewTint() {
  const m = S.config.defaults?.crewTint === 'off' ? null : memberById(crewPick());
  const tint = panelTint(m);
  for (const n of [$('#feedWrap'), $('#topbar')]) {
    if (!n) continue;
    for (const c of SPIRIT.color) n.classList.remove(`c-${c}`);
    n.classList.toggle('crew-tint', !!tint);
    if (tint) n.classList.add(`c-${tint}`);
  }
}
// A face picks its member and opens its thread; picked already, it's All.
export function pickMember(id) {
  if (crewPick() === id) return pickAll();
  pickThread(id);
}
// Its thread, with the rail on it. The hover card's way in too: bare openMember would leave the rail
// on someone else, and the card says Open, so it never toggles back to All.
export function pickThread(id) {
  setCrewPick(id);
  openMember(id);
  feedToTop();
}
// Everything again: a member's thread goes home with it; a task that's open stays open.
export function pickAll() {
  const thread = crewViewShown();
  setCrewPick(null);
  if (thread) goHome({ focus: false });
  renderFeed();
  feedToTop();
}

// When it checks in, in words. Any other cron is read out (web/js/schedule.js), or shows as itself.
export const CADENCES = [
  ['', 'Only when asked'],
  ['*/30 * * * *', 'Every 30 min'],
  ['0 * * * *', 'Hourly'],
  ['0 9 * * 1-5', 'Weekday mornings'],
  ['0 9 * * *', 'Every morning'],
  ['0 9 * * 1', 'Mondays'],
];
export const cadenceLabel = (cron) => CADENCES.find(([c]) => c === (cron || ''))?.[1] || cronWords(cron) || cron;

// What else starts their jobs (triggers that send them work, server/triggers.js MEMBER_KINDS).
export const EVENTS = [
  ['finished', 'A task finishes', 'a task finishes'],
  ['done', 'I mark a task done', 'a task is marked done'],
  ['ci', 'CI fails', 'CI fails'],
];
export const eventsLabel = (m) => {
  const on = EVENTS.filter(([k]) => m.on?.includes(k)).map(([, , w]) => w);
  return on.length ? `When ${on.join(' or ').replace(' or a task ', ' or ')}` : ''; // "a task finishes or is marked done"
};
// Their schedule and what else wakes them, in words.
export const cadenceText = (m) => [m.cron ? cadenceLabel(m.cron) : '', eventsLabel(m)].filter(Boolean).join(' · ') || 'On call';


// --- avatars ----------------------------------------------------------------------------------

// What a member is up to, from its jobs in the list: asks (one waits on you), live (one runs),
// unread (a report you haven't opened), and the spirit's mood for it.
export function memberState(m) {
  const jobs = jobsOf(m);
  const asks = jobs.some((s) => s.state === 'waiting');
  const sent = pendingOf(m);
  const live = [...jobs.filter((s) => s.state === 'running'), ...sent];
  const unread = jobs.filter((s) => s.state === 'review' && needsYou(s)).length; // saved for later or scheduled: not a ping
  return { jobs, sent, asks, live, unread, mood: asks ? 'asks' : live.length ? 'live' : m.paused ? 'sleep' : 'idle' };
}

// The colour a member glows: its spirit's own when it has one, else the colour it was given. A
// spell or an imported member can carry a colour that doesn't match its avatar; the face and the
// task panel both go by this, so they never disagree.
export const glowOf = (m) => (isSpirit(m?.avatar) ? parseSpirit(m.avatar).color : m?.color || parseSpirit('', m?.name).color);

// A member's face: its spirit (or the emoji it was given) on a disc of its colour.
export function avatarHtml(m, { size = 30, state, dot = true, small = size < 22 } = {}) {
  const st = memberState(m);
  const mood = state || st.mood;
  const face = m.avatar && !isSpirit(m.avatar) ? `<span>${esc(m.avatar)}</span>` : spiritSvg(m.avatar, { seed: m.name, state: mood, small });
  const color = glowOf(m);
  const badge = dot && (st.asks || st.unread) ? `<i class="cr-dot${st.asks ? ' asks' : ''}"></i>` : '';
  return `<span class="cr-av c-${color}${m.avatar && !isSpirit(m.avatar) ? ' emoji' : ''}" style="--size:${size}px">${face}${badge}</span>`;
}

// A crew job's face for modelBadge: the member, not the harness they run on.
export function crewFace(s) {
  const m = memberById(s?.crew?.id);
  return m ? { name: m.name, face: avatarHtml(m, { size: 16, dot: false }) } : null;
}

// A crew job's card shows the member's face where other cards have their project dot.
export function crewDot(s) {
  const m = memberById(s.crew?.id);
  if (!m) return '';
  const what = { checkin: 'check-in', task: 'job', delegated: `job for “${s.crew.from?.title || 'another task'}”`, trigger: `job from ${s.crew.from?.title || 'a trigger'}`, mention: `answer in “${s.crew.from?.title || 'a task'}”`, event: `check on “${s.crew.from?.title || 'a task'}”` }[s.crew.job] || 'job';
  const mood = s.state === 'waiting' ? 'asks' : s.state === 'running' ? 'live' : 'idle';
  return `<span class="q-dot crew-dot" title="${esc(`${m.name}’s ${what}`)}">${avatarHtml(m, { size: 18, state: mood, dot: false })}</span>`;
}

// --- the Crew section ----------------------------------------------------------------------------
//
// One block per member: its row, then (in the feed) its thread when it's open, then its recent
// jobs as ordinary cards, nested under it: what's live first (asking you, working, an unread
// report), then what it finished, newest first, until you mark it done or archive it. The rest is in its thread.
// A job that needs you sits in Needs you instead (inNeeds), its member's row and dot still say so.
// Nothing of the crew's shows in Working or Done.

const sec = $('#secCrew');
const box = $('.cr-list', sec);
const JOBS_MAX = 3; // nested under a member; an open one also keeps every live job
const ROWS_MIN = 2; // full rows even when nobody's busy (spell prop section.crew rows)
const FACES_MAX = 4; // faces on the folded row
const pinned = new Set(); // jobs opened from a link or a toast: shown under their member until closed

// The member open in the main pane (split view) or expanded in place (the feed). Yours alone.
S.crewOpen = load('wisp.crewOpen', null);
const setOpen = (id) => {
  S.crewOpen = id;
  save('wisp.crewOpen', id);
};

export function pinJob(id) {
  pinned.add(id);
}

// A member's jobs under it (the ones for another task), most urgent first: asking you, working, an
// unread report, then the finished ones, newest first. Ones you marked done or archived are only in
// its thread.
export function memberJobs(m, st, max = JOBS_MAX) {
  const list = st.jobs.filter((s) => underMember(s) && !inList(s) && (standing(s) || S.open.has(s.id) || pinned.has(s.id))).sort(byUrgency);
  const open = S.crewOpen === m.id;
  const keep = list.filter((s, i) => i < max || (open && jobMark(s)) || S.open.has(s.id) || pinned.has(s.id));
  return { list: keep, more: list.length - keep.length };
}

// What a busy member is doing, in its own words: the job card under it already shows the live
// line, so the row says what kind of work it is. Picked from the job's id, so it holds still.
const BUSY = {
  checkin: ['Making the rounds', 'Doing a sweep', 'Looking things over', 'On patrol'],
  task: ['Heads-down on your ask', 'On it for you', 'Rolling up its sleeves', 'Deep in your request'],
  delegated: ['Lending a hand to “%”', 'Helping out “%”', 'Pitching in on “%”'],
  trigger: ['Answering %', 'Picking up %', 'Responding to %'],
  mention: ['Chiming in on “%”', 'Weighing in on “%”', 'Replying in “%”'],
};
const MANY = ['Juggling % jobs', 'Spinning % plates', 'Running % jobs at once'];
const pick = (list, id) => list[[...String(id)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0) % list.length];
function busyLine(live) {
  if (live.length > 1) return pick(MANY, live.map((s) => s.id).sort().join()).replace('%', live.length);
  const s = live[0];
  return pick(BUSY[s.crew?.job] || BUSY.task, s.id).replace('%', s.crew?.from?.title || (s.crew?.job === 'trigger' ? 'a trigger' : 'a task'));
}

export function statusLine(m, st) {
  const ask = st.jobs.find((s) => s.state === 'waiting');
  if (ask) return { cls: 'asks', text: `Asking you${ask.question ? `: ${ask.question}` : ''}` };
  if (st.live.length) return { cls: 'live', text: busyLine(st.live) };
  const report = st.jobs.filter((s) => s.state === 'review' && needsYou(s)).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (report) return { cls: 'report', text: `Reported: ${report.title}` };
  if (m.changed && m.paused) return { cls: '', text: m.changed.from ? 'Paused: their spell changed' : 'New from a spell: review to start' };
  if (m.queue?.length) return { cls: '', text: `${m.queue.length} waiting` };
  if (m.paused) return { cls: '', text: 'Paused' };
  if (m.wakeAt && m.wakeAt > Date.now()) return { cls: '', text: `Looks again ${whenLabel(m.wakeAt)}` };
  return { cls: '', text: `${cadenceText(m)}${m.machine ? ` · on ${placeName(m.machine)}` : ''}` };
}

function rowHtml(m, st) {
  const line = statusLine(m, st);
  const last = st.jobs.reduce((t, s) => Math.max(t, s.updatedAt || 0), m.log?.[0]?.at || 0);
  return `${avatarHtml(m)}
    <span class="cr-main">
      <span class="cr-top"><b class="cr-name">${esc(m.name)}</b>${m.role ? `<span class="cr-role">${esc(m.role)}</span>` : ''}</span>
      <span class="cr-sub ${line.cls}" title="${esc(line.text)}">${esc(line.text)}</span>
    </span>
    <span class="cr-side">${st.live.length ? `<span class="cr-n" title="${st.live.length} working">${st.live.length}</span>` : last ? `<span class="q-time" ${timeAttrs(last)}>${ago(last)}</span>` : ''}${icon('chevron', 'chev')}</span>`;
}

// Who gets a full row. Busy members always do: asking you, on a job (not just making their rounds,
// or scheduled members would pop in and out all day), an unread report, a job open or pinned (its
// card must stay in the list), a spell's change to review. Then idle ones in rank order up to the
// minimum; the rest fold into one row of faces. While the pointer or focus is in the section a row
// that was shown stays (promoted at once, folded later), so nothing moves under the cursor.
S.crewAll = false; // Show all: this visit only, a reload is compact again
let holding = false;
let wasFull = new Set();
const busy = (m, st) =>
  st.asks || st.unread || st.live.some((s) => s.crew?.job !== 'checkin') || (m.changed && m.paused) || st.jobs.some((s) => S.open.has(s.id) || pinned.has(s.id));

// Who comes first: the ones that need you or are working for you, then the ones you send the most
// work (jobs you handed them or @-tagged them in, last 30 days), then join order. While the pointer
// or focus is in the section the order holds (newcomers go last), so nothing moves under the cursor.
const SENT_DAYS = 30;
const BY_YOU = new Set(['task', 'mention']);
function sentByYou(st) {
  const since = Date.now() - SENT_DAYS * 864e5;
  let n = 0;
  let last = 0;
  for (const s of [...st.jobs, ...st.sent]) {
    if (!s.pending && !BY_YOU.has(s.crew?.job)) continue;
    const at = s.createdAt || s.updatedAt || 0;
    if (!s.pending && at < since) continue;
    n += 1;
    last = Math.max(last, at);
  }
  return { n, last };
}
const tier = (m, st) => (st.asks ? 0 : st.live.some((s) => s.crew?.job !== 'checkin') ? 1 : st.unread ? 2 : m.paused ? 4 : 3);
let order = [];
// Most-needed first, for the @ picker too. states: memberState per id, made when missing.
export function rankCrew(list, states = new Map()) {
  const at = new Map(crewList().map((m, i) => [m.id, i]));
  const key = new Map(
    list.map((m) => {
      const st = states.get(m.id) || memberState(m);
      return [m.id, { tier: tier(m, st), ...sentByYou(st) }];
    }),
  );
  return [...list].sort((a, b) => {
    const x = key.get(a.id);
    const y = key.get(b.id);
    return x.tier - y.tier || y.n - x.n || y.last - x.last || at.get(a.id) - at.get(b.id);
  });
}
function sortCrew(list, states) {
  if (holding && order.length) {
    const i = new Map(order.map((id, k) => [id, k]));
    return [...list].sort((a, b) => (i.get(a.id) ?? 1e9) - (i.get(b.id) ?? 1e9));
  }
  const out = rankCrew(list, states);
  order = out.map((m) => m.id);
  return out;
}

function crewRows(list, states) {
  if (S.crewAll) return { full: new Set(list.map((m) => m.id)), busyIds: new Set() };
  const busyIds = new Set(list.filter((m) => busy(m, states.get(m.id))).map((m) => m.id));
  const full = new Set(busyIds);
  const min = spellProp('section.crew', 'rows') || ROWS_MIN;
  for (const m of list) if (full.size < min) full.add(m.id);
  if (holding) for (const id of wasFull) if (states.has(id)) full.add(id);
  // Folding one alone saves nothing: show it.
  if (list.length - full.size === 1) for (const m of list) full.add(m.id);
  return { full, busyIds };
}

// The folded row, in the rows' columns: their faces (each opens its thread; a fine pointer only),
// how many and what they're doing, a chevron that shows them all.
function stripHtml(folded) {
  const faces = folded.slice(0, FACES_MAX);
  const open = folded.find((m) => m.id === S.crewOpen);
  if (open && !faces.includes(open)) faces[faces.length - 1] = open;
  const paused = folded.filter((m) => m.paused).length;
  const words = [folded.length - paused && `${folded.length - paused} on call`, paused && `${paused} paused`].filter(Boolean).join(' · ');
  const face = (m) =>
    `<button class="cr-face${m.id === S.crewOpen ? ' on' : ''}" type="button" data-face="${m.id}" title="${esc(`${m.name} · ${statusLine(m, memberState(m)).text}`)}" aria-label="${esc(`Open ${m.name}`)}">${avatarHtml(m, { size: 20, dot: false })}</button>`;
  return `<span class="cr-faces">${faces.map(face).join('')}</span><button class="cr-fold" type="button" aria-expanded="false"><span class="cr-sub">${esc(words)}</span>${icon('chevron', 'chev')}</button>`;
}

// A job kept in the list whatever else: it's open, or about to be.
const held = (s) => underMember(s) && !inList(s) && (S.open.has(s.id) || pinned.has(s.id));

let shownPick = null;

// Blocks keyed by member, rows rewritten only when what they say changed and never re-appended (a
// spirit would restart its animation). Returns the job cards it placed, so the feed keeps them.
export function paintCrew() {
  const railed = crewRailOn();
  sec.hidden = !('crew' in S.config); // until the config lands
  $('h4 .n', sec).textContent = crewList().length || '';
  if (S.crewOpen && !memberById(S.crewOpen)) setOpen(null);
  if (S.crewPick && 'crew' in S.config && !memberById(S.crewPick)) setCrewPick(null); // removed: back to All
  const pick = crewPick();
  if (pick !== shownPick) {
    shownPick = pick;
    bus.emit('crewPick'); // New task's chip; also when the window narrows and the pick stops counting
  }
  const states = new Map(crewList().map((m) => [m.id, memberState(m)]));
  const list = sortCrew(crewList(), states);
  // With the rail the section keeps only what an open job needs: its card (the body hangs off it).
  const { full, busyIds } = railed ? { full: new Set(list.filter((m) => states.get(m.id).jobs.some(held)).map((m) => m.id)), busyIds: new Set() } : crewRows(list, states);
  if (railed) {
    paintRail(list, states);
    if (!full.size) sec.hidden = true;
  } else wasFull = full;
  const folded = railed ? [] : list.filter((m) => !full.has(m.id));
  const shown = [];
  const want = list.length || railed ? list.filter((m) => full.has(m.id)) : [null];
  if (folded.length) want.push('strip');
  else if (!railed && S.crewAll && list.length > (spellProp('section.crew', 'rows') || ROWS_MIN) + 1) want.push('fewer');
  want.forEach((m, i) => {
    const key = m === 'strip' || m === 'fewer' ? m : m ? m.id : 'empty';
    let block = box.children[i];
    if (block?.dataset.crew !== key) {
      block =
        $$(':scope > [data-crew]', box).find((x) => x.dataset.crew === key) ||
        el(
          key === 'strip'
            ? `<div class="cr-strip" data-crew="strip"></div>`
            : key === 'fewer'
              ? `<button class="cr-fewer link xs" type="button" data-crew="fewer">Show fewer</button>`
              : m
                ? `<div class="cr-member" data-crew="${key}"><div class="cr-row" role="button" tabindex="0"></div><div class="cr-jobs f-list"></div><button class="cr-more link xs" hidden></button></div>`
                : `<button class="cr-row cr-empty" data-crew="empty">${icon('plus')}<span class="cr-main"><b>Add someone to your crew</b><span class="cr-sub">A named agent that checks in, reports, and answers to @name</span></span></button>`,
        );
      box.insertBefore(block, box.children[i] || null);
    }
    if (key === 'strip') {
      const html = stripHtml(folded);
      const h = html.replace(/<svg[\s\S]*?<\/svg>/g, (svg) => svg.match(/st-\w+/)?.[0] || '');
      if (block.dataset.h !== h) (block.innerHTML = html), (block.dataset.h = h);
      $('.cr-fold', block).title = `Show all ${list.length}`;
      return;
    }
    if (!m || key === 'fewer') return;
    const st = states.get(m.id);
    const row = $('.cr-row', block);
    const html = rowHtml(m, st);
    // The spirit stays (its animation keeps going); only the words around it change.
    const h = html.replace(/<svg[\s\S]*?<\/svg>/, `[${st.mood}:${m.avatar}:${m.color}]`);
    if (row.dataset.h !== h) (row.innerHTML = html), (row.dataset.h = h);
    row.title = `${m.name}${m.role ? ` · ${m.role}` : ''}: open (or type @${m.name} in any prompt)`;
    const open = S.crewOpen === m.id;
    row.classList.toggle('paused', !!m.paused);
    row.classList.toggle('open', open);
    row.setAttribute('aria-expanded', open);
    // In the feed an open member's thread sits right under its row.
    const inline = open && !isSplit();
    const view = inline ? viewFor(m.id) : null;
    if (view) {
      if (view.node.parentNode !== block) row.after(view.node);
      view.node.removeAttribute('id');
      view.node.hidden = false;
      view.paint();
    }
    if (!inline) for (const v of $$(':scope > .crew-view', block)) v.remove();
    // An idle member filling the minimum keeps one finished job under it; the rest are in its thread.
    const { list: all, more } = memberJobs(m, st, busyIds.has(m.id) || S.crewAll ? JOBS_MAX : 1);
    const jobs = railed ? all.filter(held) : all;
    placeCards($('.cr-jobs', block), jobs);
    shown.push(...jobs);
    const mb = $('.cr-more', block);
    mb.hidden = !more;
    mb.textContent = `${more} more · open ${m.name}`;
  });
  while (box.children.length > want.length) box.lastElementChild.remove();
  for (const id of pinned) if (!S.sessions.has(id)) pinned.delete(id);
  paintCrewView();
  paintCrewTint();
  return shown;
}

// --- the crew rail -------------------------------------------------------------------------------
//
// Side by side, the crew is a column of faces beside the list (split.js crewRailOn): the same order,
// moods and statuses as the section, one tile a member. Tiles stay in the DOM and only CSS order
// moves them, so a spirit never restarts; a tile's contents change only when what they say does.
const rail = $('#crewRail');
const railFaces = $('.cl-faces', rail);
const railAdd = $('.cl-add', rail);
const railAll = $('.cl-all', rail);
const railNodes = new Map(); // member id → its tile
let railOrder = [];
const railTiles = () => [railAll, ...railOrder.map((id) => railNodes.get(id))].filter((b) => b && !b.hidden);

const faceTile = (id) =>
  el(`<button class="cl-face" type="button" data-crew="${id}" tabindex="-1"><i class="cl-pip"></i><span class="cl-av"></span><i class="cl-dot" hidden></i><span class="cl-live" hidden><span class="orb live"></span><b hidden></b></span></button>`);

function paintRail(list, states) {
  for (const n of $$('.cl-sk', railFaces)) n.remove();
  railOrder = list.map((m) => m.id);
  list.forEach((m, i) => {
    const st = states.get(m.id);
    let b = railNodes.get(m.id);
    if (!b) {
      b = faceTile(m.id);
      railNodes.set(m.id, b);
      railFaces.append(b);
    }
    if (b.style.order !== String(i)) b.style.order = i;
    const face = `${st.mood}:${m.avatar}:${m.color}:${m.name}`;
    if (b.dataset.h !== face) {
      $('.cl-av', b).innerHTML = avatarHtml(m, { size: 30, dot: false });
      b.dataset.h = face;
    }
    const dot = $('.cl-dot', b);
    dot.hidden = !st.asks && !st.unread;
    dot.classList.toggle('asks', st.asks);
    const live = $('.cl-live', b);
    const n = st.live.length;
    live.hidden = !n;
    const count = $('b', live);
    count.hidden = n < 2;
    if (count.textContent !== String(n)) count.textContent = n;
    b.classList.toggle('paused', !!m.paused);
    b.setAttribute('aria-label', `${m.name}${m.role ? `, ${m.role}` : ''}: ${statusLine(m, st).text}`);
    b.setAttribute('aria-keyshortcuts', document.body.classList.contains('side-right') ? 'ArrowLeft' : 'ArrowRight'); // into its card
  });
  for (const [id, b] of railNodes)
    if (!railOrder.includes(id)) {
      b.remove();
      railNodes.delete(id);
    }
  const none = !list.length && 'crew' in S.config;
  rail.classList.toggle('empty', none);
  railAll.hidden = !list.length; // no faces, nothing to pick from
  paintRailAll();
  railAdd.dataset.tip = none ? 'Add someone to your crew' : 'Add a crew member';
  railAdd.dataset.sub = none ? 'A named agent that checks in, reports, and answers to @name' : '';
  railAdd.setAttribute('aria-label', railAdd.dataset.tip);
  const slot = slotHtml('crew.rail');
  const host = $('#railSlot');
  if (host.dataset.h !== slot) (host.innerHTML = slot), (host.dataset.h = slot);
  if ('crew' in S.config && load('wisp.crewN', null) !== list.length) save('wisp.crewN', list.length); // the next first paint's faces
  paintRailOn();
  paintRailFade();
  if (railTip.at?.isConnected) tipBody(railTip.at);
  else hideTip();
  if (card.at?.isConnected) paintCard();
  else hideCard();
}

// All's dot: what clicking it would bring back, so a pick never hides a question. Amber for a
// question, the accent for an unread report, as on a face. Nothing picked: the list shows it all.
function paintRailAll() {
  const pick = crewPick();
  const out = pick ? groups(S.filter, null).needs.filter((t) => t.crew?.id !== pick && needsYou(t)) : [];
  const asks = out.some((t) => t.state === 'waiting');
  const dot = $('.cl-dot', railAll);
  dot.hidden = !out.length;
  dot.classList.toggle('asks', asks);
  const label = out.length ? `All tasks: ${asks ? 'something is asking you' : 'an unread report'}` : 'All tasks';
  if (railAll.getAttribute('aria-label') !== label) railAll.setAttribute('aria-label', label);
}

// One tile is selected: what the list beside the rail shows, All or the picked member. One stop
// for Tab: the arrows go from there (the DOM's order isn't the rail's).
function paintRailOn() {
  const pick = crewPick();
  const sel = (pick && railNodes.get(pick)) || railAll;
  const tiles = railTiles();
  for (const b of [railAll, ...railNodes.values()]) {
    const on = b === sel;
    if (b.classList.contains('on') !== on) b.classList.toggle('on', on);
    if (on) b.setAttribute('aria-current', 'true');
    else b.removeAttribute('aria-current');
  }
  const stop = tiles.includes(document.activeElement) ? document.activeElement : tiles.includes(sel) ? sel : tiles[0];
  for (const b of [railAll, ...railNodes.values()]) b.tabIndex = b === stop ? 0 : -1;
}

// With more members than room the rail scrolls with no scrollbar: the edge with more fades.
function paintRailFade() {
  const { scrollTop: t, scrollHeight: h, clientHeight: c } = railFaces;
  railFaces.classList.toggle('up', t > 1);
  railFaces.classList.toggle('down', t + c < h - 1);
}
railFaces.addEventListener(
  'scroll',
  () => {
    paintRailFade();
    hideTip();
    // The arrow keys scroll the rail to the face they land on: that card stays, with its face.
    if (card.at && card.at === document.activeElement) placeCard();
    else hideCard();
  },
  { passive: true },
);
new ResizeObserver(paintRailFade).observe(railFaces);

// Org and +: a plain tooltip beside the rail, on the page, not in the rail: the rail scrolls, so
// anything inside it is clipped. A native title would stack with it.
const railTip = { node: el('<div class="cl-tip" role="tooltip" hidden></div>'), at: null, timer: 0, left: 0 };
document.body.append(railTip.node);
function tipBody(t) {
  const html = `<span class="cl-tname"><b>${esc(t.dataset.tip)}</b></span>${t.dataset.sub ? `<span class="cr-sub">${esc(t.dataset.sub)}</span>` : ''}`;
  if (railTip.html === html) return;
  railTip.html = html;
  railTip.node.innerHTML = html;
  placeTip(t);
}
// Beside the rail on the list, on whichever side the list is. Both the tooltip and the card.
const RAIL_GAP = 8;
function railLeft(n) {
  const box = rail.getBoundingClientRect();
  const x = document.body.classList.contains('side-right') ? box.left - RAIL_GAP - n.offsetWidth : box.right + RAIL_GAP;
  return Math.max(8, Math.min(x, innerWidth - n.offsetWidth - 8));
}
function placeTip(t) {
  const n = railTip.node;
  const r = t.getBoundingClientRect();
  n.style.left = `${railLeft(n)}px`;
  n.style.top = `${Math.max(8, Math.min(r.top + r.height / 2 - n.offsetHeight / 2, innerHeight - n.offsetHeight - 8))}px`;
}
// A moment's wait the first time, none going from one to the next.
const railWarm = () => railTip.at || card.at || Date.now() - railTip.left < 400;
function showTip(t) {
  clearTimeout(railTip.timer);
  const go = () => {
    railTip.at = t;
    railTip.node.hidden = false;
    railTip.html = '';
    tipBody(t);
  };
  if (railWarm()) go();
  else railTip.timer = setTimeout(go, 160);
}
function hideTip() {
  clearTimeout(railTip.timer);
  if (railTip.at) railTip.left = Date.now();
  railTip.at = null;
  railTip.node.hidden = true;
}

// A face's card: who it is, then the tasks it's on, each one click away. Same place as the tooltip,
// but you can go into it: the 8px to it are bridged (.cl-card::before), and leaving the face or the
// card gives CARD_GRACE to arrive. While it's up the rail holds (inCrew), the rows hold their order
// and take updates in place: nothing is rebuilt and nothing moves under the pointer.
const CARD_WAIT = 160; // first hover
const CARD_GRACE = 180; // leaving, before it closes
const CARD_SWITCH = 90; // to another face: long enough to cross one on the way to a row
const card = {
  node: el(`<div class="cl-card" role="group" hidden>
    <button class="cl-head" type="button" tabindex="-1"></button>
    <p class="cl-none" hidden></p>
    <div class="cl-rows"></div>
    <button class="cl-more" type="button" tabindex="-1" hidden></button>
  </div>`),
  at: null, // the face it belongs to
  next: null, // a face waiting for CARD_SWITCH
  timer: 0,
  leaving: 0,
  closing: false, // card.leaving is running
  ids: [], // its rows, in the order they hold
  rows: new Map(), // job id → row
  x: 0, // the pointer, and where it was when it left the card's face
  y: 0,
  fromX: 0,
  fromY: 0,
};
document.body.append(card.node);
const cardHead = $('.cl-head', card.node);
const cardRows = $('.cl-rows', card.node);
const cardMore = $('.cl-more', card.node);
const cardNone = $('.cl-none', card.node);
const inCard = () => card.node.matches(':hover') || card.node.contains(document.activeElement);

const setText = (n, text) => {
  if (n.textContent !== text) n.textContent = text;
};
// What a row says on its right: what it's doing, or when it finished.
function jobSide(s) {
  if (s.pending) return 'Starting';
  if (s.state === 'waiting') return 'Asking';
  if (s.state === 'running') return 'Working';
  const key = statusKey(s);
  return key === 'done' || key === 'info' ? ago(s.updatedAt) : STATUS_LABEL[key] || STATUS_LABEL.done;
}
function paintJobRow(row, s) {
  const mark = jobMark(s);
  const dot = row.firstElementChild;
  if (dot.dataset.m !== mark) {
    dot.dataset.m = mark;
    dot.innerHTML = mark === 'live' ? '<span class="orb live"></span>' : '';
  }
  const title = cleanTitle(s.title);
  setText(row.children[1], title);
  if (row.title !== title) row.title = title;
  setText(row.children[2], jobSide(s));
  row.disabled = !!s.pending; // the placeholder has nothing to open yet
  const open = S.open.has(s.id);
  if (row.classList.contains('on') !== open) row.classList.toggle('on', open);
}
function paintCard() {
  const m = memberById(card.at.dataset.crew);
  if (!m) return hideCard();
  const st = memberState(m);
  const line = statusLine(m, st);
  // Under the pointer or the keys the head keeps its height, or the rows would slide.
  if (!inCard()) {
    const head = `<span class="cl-tname"><b>${esc(m.name)}</b>${m.role ? `<span class="cr-role">${esc(m.role)}</span>` : ''}</span><span class="cr-sub ${line.cls}">${esc(line.text)}</span>`;
    if (cardHead.dataset.h !== head) (cardHead.innerHTML = head), (cardHead.dataset.h = head);
    cardHead.title = `Open ${m.name}’s thread`;
    card.node.setAttribute('aria-label', `${m.name}’s tasks`);
  }
  const jobs = cardJobs(st);
  card.ids = holdRows(card.ids, jobs.map((s) => s.id), (id) => !S.sessions.has(id));
  card.ids.forEach((id, i) => {
    let row = card.rows.get(id);
    if (!row) {
      row = el(`<button class="cl-row" type="button" data-job="${esc(id)}" tabindex="-1"><span class="cl-mark"></span><span class="cl-title"></span><span class="q-time"></span></button>`);
      card.rows.set(id, row);
    }
    if (cardRows.children[i] !== row) cardRows.insertBefore(row, cardRows.children[i] || null);
    const s = S.sessions.get(id);
    if (s) paintJobRow(row, s);
    else {
      // Gone from wisp while it's up: the row stays where it was, dead, until the card closes.
      row.disabled = true;
      setText(row.children[2], 'Gone');
    }
  });
  for (const [id, row] of card.rows)
    if (!card.ids.includes(id)) {
      row.remove();
      card.rows.delete(id);
    }
  cardNone.hidden = card.ids.length > 0;
  if (!cardNone.hidden) setText(cardNone, m.nextAt && !m.paused ? `Next check-in ${whenLabel(m.nextAt)}` : 'Nothing going on');
  const all = st.jobs.length + st.sent.length;
  cardMore.hidden = jobs.length <= CARD_ROWS;
  if (!cardMore.hidden) setText(cardMore, `All ${all} in the thread`);
  if (!inCard()) placeCard();
}
// Its top on the face's, so rows that arrive grow it downward and move nothing. It scrolls in what
// the window leaves.
function placeCard() {
  const n = card.node;
  const r = card.at.getBoundingClientRect();
  const scrolled = cardRows.scrollTop;
  n.style.maxHeight = '';
  const top = Math.max(8, Math.min(r.top - 1, innerHeight - n.offsetHeight - 8));
  n.style.left = `${railLeft(n)}px`;
  n.style.top = `${top}px`;
  n.style.maxHeight = `${innerHeight - top - 8}px`;
  cardRows.scrollTop = scrolled;
}
// Whatever brought the pointer back, the card isn't closing.
function keepCard() {
  clearTimeout(card.timer);
  clearTimeout(card.leaving);
  card.closing = false;
  card.next = null;
}
function showCard(face) {
  keepCard();
  hideTip();
  if (card.at === face) return;
  // Another face's card: its rows go, they were that member's.
  for (const row of card.rows.values()) row.remove();
  card.rows.clear();
  card.ids = [];
  card.at = face;
  card.node.hidden = false;
  cardRows.scrollTop = 0;
  paintCard();
}
function hideCard() {
  keepCard();
  if (!card.at) return;
  railTip.left = Date.now();
  card.at = null;
  card.node.hidden = true;
  requestAnimationFrame(release);
}
// The pointer came onto a face. Once a card is up, the switch waits a beat: on the way to a row the
// pointer can cross the next face, and a card that changes under it is a card you can't reach.
function hoverFace(face) {
  const moving = !!card.next || card.closing;
  keepCard();
  if (face === card.at) return;
  hideTip();
  if (card.at) {
    if (!moving) (card.fromX = card.x), (card.fromY = card.y); // where it left the card's face
    card.next = face;
    card.timer = setTimeout(() => showCard(face), CARD_SWITCH);
  } else if (railWarm()) showCard(face);
  else card.timer = setTimeout(() => showCard(face), CARD_WAIT);
}
const armClose = () => {
  clearTimeout(card.leaving);
  card.leaving = setTimeout(() => {
    card.closing = false;
    if (!inCard() && !card.at?.matches(':hover') && document.activeElement !== card.at) hideCard();
  }, CARD_GRACE);
};
function leaveCard() {
  const moving = !!card.next || card.closing;
  keepCard();
  if (!card.at) return;
  if (!moving) (card.fromX = card.x), (card.fromY = card.y);
  card.closing = true;
  armClose();
}
// Still crossing the rail toward the card: that's no reason to show the face it's over, or to close
// the card. Going along the rail is.
function crossing(e) {
  card.x = e.clientX;
  card.y = e.clientY;
  if (!card.next && !card.closing) return;
  const out = e.clientX - card.fromX;
  if (!headingForCard(document.body.classList.contains('side-right') ? -out : out, e.clientY - card.fromY)) return;
  if (card.closing) return armClose();
  const face = card.next;
  clearTimeout(card.timer);
  card.timer = setTimeout(() => showCard(face), CARD_SWITCH);
}
// Opening a thing from the card: it closes first, so it's gone before the pane changes.
function cardGo(run) {
  const id = card.at?.dataset.crew;
  hideCard();
  run(id);
}
function openJob(id) {
  crewHooks.leave?.(); // the Org page takes the pane: a job does too
  // Ready to type, like a click on its card. The row that had the keys has just gone.
  Promise.resolve(reveal_(id)).then(() => beforePaint(() => focusReply(id)));
}
card.node.addEventListener('click', (e) => {
  const row = e.target.closest('.cl-row');
  if (row) return cardGo(() => openJob(row.dataset.job));
  if (e.target.closest('.cl-head, .cl-more')) cardGo(pickThread);
});
card.node.addEventListener('pointerenter', keepCard);
card.node.addEventListener('pointerleave', leaveCard);
card.node.addEventListener('focusout', leaveCard);
card.node.addEventListener('focusin', keepCard);
const cardStops = () => $$('.cl-head, .cl-row:not(:disabled), .cl-more:not([hidden])', card.node);
// Into the rows from the face: the first one, or the head when there are none.
function enterCard(face) {
  showCard(face);
  (cardStops()[1] || cardHead).focus();
}
card.node.addEventListener('keydown', (e) => {
  const face = card.at;
  if (!face) return;
  const back = document.body.classList.contains('side-right') ? 'ArrowRight' : 'ArrowLeft';
  if (e.key === back) {
    e.preventDefault();
    e.stopPropagation();
    return face.focus();
  }
  // Tab leaves from the face, so the page's order goes on from the rail, not from the end of the body.
  if (e.key === 'Tab') return face.focus();
  const stops = cardStops();
  const to = stepRow(e.key, stops.indexOf(e.target), stops.length);
  if (to === null) return;
  e.preventDefault();
  e.stopPropagation();
  stops[to].focus();
});
// Escape first takes back what the card has, before anything else on the page hears it: from inside
// it to the face, then closed.
addEventListener(
  'keydown',
  (e) => {
    if (e.key !== 'Escape' || !card.at) return;
    e.preventDefault();
    e.stopPropagation();
    if (card.node.contains(document.activeElement)) card.at.focus();
    else hideCard();
  },
  true,
);
addEventListener('resize', () => {
  hideCard();
  hideTip();
});

const tipTarget = (e) => e.target.closest?.('.cl-btn');
const faceTarget = (e) => e.target.closest?.('.cl-face');
rail.addEventListener('pointerover', (e) => {
  if (e.pointerType !== 'mouse') return;
  const face = faceTarget(e);
  if (face) return hoverFace(face);
  const t = tipTarget(e);
  if (!t || t === railTip.at) return;
  hideCard();
  showTip(t);
});
rail.addEventListener('pointerout', (e) => {
  const to = e.relatedTarget?.closest?.('.cl-face, .cl-btn');
  if (faceTarget(e) && !to) leaveCard();
  if (tipTarget(e) && !to) hideTip();
});
rail.addEventListener('pointermove', crossing, { passive: true });
rail.addEventListener('focusin', (e) => {
  const face = faceTarget(e);
  if (face) paintRailOn();
  if (face?.matches(':focus-visible')) return showCard(face);
  const t = tipTarget(e);
  if (t?.matches(':focus-visible')) showTip(t);
  if (t?.matches('.cl-all')) paintRailOn();
});
rail.addEventListener('focusout', () => {
  hideTip();
  leaveCard();
});

rail.addEventListener('click', (e) => {
  hideTip();
  hideCard();
  if (e.target.closest('.cl-all')) return pickAll();
  const face = e.target.closest('.cl-face');
  if (face) return pickMember(face.dataset.crew);
  if (e.target.closest('.cl-add')) crewEditor();
});
rail.addEventListener('contextmenu', (e) => {
  const face = e.target.closest('.cl-face');
  if (!face) return;
  e.preventDefault();
  hideTip();
  hideCard();
  memberMenu(face.dataset.crew, { x: e.clientX, y: e.clientY });
});
rail.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideTip();
  const tile = e.target.closest('.cl-face, .cl-all');
  if (!tile) return;
  // Into a face's card. All has none: this key does nothing there.
  if (tile.matches('.cl-face') && e.key === (document.body.classList.contains('side-right') ? 'ArrowLeft' : 'ArrowRight')) {
    e.preventDefault();
    e.stopPropagation();
    return enterCard(tile);
  }
  const tiles = railTiles();
  const at = tiles.indexOf(tile);
  const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: tiles.length - 1 }[e.key];
  if (to === undefined) return;
  e.preventDefault();
  e.stopPropagation();
  tiles[Math.max(0, Math.min(to, tiles.length - 1))]?.focus();
});

// Leaving the section lets a row that went quiet fold again. An open card counts as being there:
// the rail holds while the pointer crosses to it, and until it closes.
const inCrew = () => !!card.at || sec.matches(':hover') || sec.contains(document.activeElement) || rail.matches(':hover') || rail.contains(document.activeElement);
const release = () => {
  if (!holding || inCrew()) return;
  holding = false;
  if (S.sessions.size) renderFeed();
  else paintCrew();
};
for (const box of [sec, rail, card.node]) {
  box.addEventListener('pointerenter', () => {
    holding = true;
  });
  box.addEventListener('focusin', () => {
    holding = true;
  });
  box.addEventListener('pointerleave', () => {
    requestAnimationFrame(release);
  });
  box.addEventListener('focusout', () => {
    requestAnimationFrame(release);
  });
}
const showAll = (on) => {
  S.crewAll = on;
  // Asked to fold: don't hold the rows that were shown (on a phone the tap leaves :hover and focus
  // in the section, so the hold would never let go).
  if (!on) wasFull = new Set();
  if (S.sessions.size) renderFeed();
  else paintCrew();
};
bus.on('spells', () => (S.sessions.size ? renderFeed() : paintCrew())); // section.crew rows

sec.addEventListener('click', (e) => {
  if (e.target.closest('.cr-add, .cr-empty')) {
    crewEditor();
    return;
  }
  const face = e.target.closest('.cr-face');
  if (face) return openMember(face.dataset.face);
  if (e.target.closest('.cr-strip')) return showAll(true);
  if (e.target.closest('.cr-fewer')) return showAll(false);
  const block = e.target.closest('.cr-member');
  if (!block) return;
  if (e.target.closest('.cr-more')) return openMember(block.dataset.crew);
  if (e.target.closest('.cr-row')) {
    // The feed: a second click folds it away, like a card. Split view: it stays (like a task).
    if (!isSplit() && S.crewOpen === block.dataset.crew) return closeMember();
    openMember(block.dataset.crew);
  }
});
sec.addEventListener('keydown', (e) => {
  const row = e.target.closest('.cr-row');
  if (row && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    row.click();
  }
});
sec.addEventListener('contextmenu', (e) => {
  const block = e.target.closest('.cr-member');
  if (!block || !e.target.closest('.cr-row')) return;
  e.preventDefault();
  memberMenu(block.dataset.crew, { x: e.clientX, y: e.clientY });
});
bus.on('config', () => (S.sessions.size ? renderFeed() : paintCrew()));
bus.on('machines', () => (S.sessions.size ? renderFeed() : paintCrew())); // a member's machine: its name, once machines load

// --- opening a member -----------------------------------------------------------------------------

// Open a member's thread: in split view it takes the main pane (any open task closes, as when
// another task opens); in the feed it unfolds under its row. entry: a job to bring into view.
export function openMember(id, { entry = null } = {}) {
  if (!memberById(id)) return;
  if (crewPick() && crewPick() !== id) setCrewPick(null); // another member's thread (Org, ⌘K): the rail mustn't say someone else
  crewHooks.back = null; // the Org page sets it again when it opened this one
  crewHooks.leave?.(); // a member takes the pane: the Org page goes
  if (isSplit()) for (const o of [...S.open]) collapse(o);
  pinned.clear(); // back in the thread: jobs opened from it go back to it
  setOpen(id);
  renderFeed();
  const v = viewFor(id);
  requestAnimationFrame(() => {
    v.reveal(entry);
    if (!entry) v.focus();
  });
  if (!isSplit()) $(`.cr-member[data-crew="${id}"]`, box)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

export function closeMember() {
  if (!S.crewOpen) return;
  setOpen(null);
  renderFeed();
}

// What the Org page (org.js) hooks in: leave() closes it when a member opens; back() returns
// to it from a member opened there.
export const crewHooks = { back: null, leave: null };

// Esc: from a member's job back to its thread; from the thread back home (or to the Org page it
// was opened from). True when it did.
export function crewBack() {
  if (!S.crewOpen || !isSplit()) return false;
  const open = splitOpen();
  // A job opened from For later goes back to the list, where it came from.
  if (open && S.sessions.get(open)?.crew?.id === S.crewOpen && !isForLater(S.sessions.get(open))) {
    openMember(S.crewOpen, { entry: open });
    return true;
  }
  if (!open) {
    closeMember();
    const back = crewHooks.back;
    crewHooks.back = null;
    if (back) back();
    else goBack({ focus: true }); // home (stacked: the list)
    return true;
  }
  return false;
}

// Nothing of the crew stays open when home is asked for (New task, Esc).
export function leaveCrew() {
  crewHooks.back = null;
  if (S.crewOpen) setOpen(null);
}

// Split view: the thread fills the main pane while nothing else is open there. Another task
// opening closes the member, unless it's one of its own jobs (then the thread is one Esc away).
export function paintCrewView() {
  const open = splitOpen();
  if (isSplit() && S.crewOpen && open && S.sessions.get(open)?.crew?.id !== S.crewOpen) setOpen(null);
  const v = isSplit() && S.crewOpen && !open ? viewFor(S.crewOpen) : null;
  // Every member opened here leaves its view in the pane: only the open one shows (two showing
  // at once stacked them, one under the other, and under home).
  for (const n of $$(':scope > .crew-view', $('#splitMain'))) {
    if (n === v?.node) continue;
    views.get(n.dataset.crew)?.about(false); // its About page goes with it, and its Back entry
    n.hidden = true;
    n.removeAttribute('id');
  }
  if (v) {
    if (v.node.parentNode !== $('#splitMain')) $('#splitMain').append(v.node);
    v.node.id = 'crewView';
    v.node.hidden = false;
    v.paint();
  }
  for (const r of $$('.cr-row.open', box)) r.classList.toggle('open', !!S.crewOpen && r.closest('.cr-member').dataset.crew === S.crewOpen);
  paintRailOn();
}
export const crewViewShown = () => isSplit() && !!S.crewOpen && !splitOpen();

// The phone app's About page, swiped in over the open thread (panel-swipe.js): its layers are the
// thread's head and body, which slide under it.
const shownView = () => (crewViewShown() ? views.get(S.crewOpen) : null);
export const aboutShown = () => shownView()?.page.hidden === false;
export const aboutPage = () => shownView()?.page;
export const aboutLayers = () => (shownView() ? [shownView().head, shownView().scroller] : []);
export const showAbout = (on) => shownView()?.about(on);

// --- actions --------------------------------------------------------------------------------------

// Optimistic: the member changes here at once, and goes back if the server refuses.
export async function patchMember(m, body, { quiet = false } = {}) {
  const before = { ...m };
  const paint = () => (renderFeed(), paintOffers());
  Object.assign(m, body);
  paint();
  try {
    Object.assign(m, await api(`/crew/${m.id}`, { method: 'PATCH', body }));
    paint();
    return true;
  } catch (err) {
    Object.assign(m, before);
    paint();
    if (!quiet) toastError(err);
    return false;
  }
}

// Kit files proposed for a member from a task (wisp_crew_kit), or by a member's own job (its crew
// block): the same offer as in its thread, under the turn that made it (a job's: its latest), so you
// pick from where you read the answer. id: one task's open card; none: every open one. Each slot
// changes only when its offers did.
export function paintOffers(id) {
  for (const [sid, n] of id ? [[id, S.nodes.get(id)]] : S.nodes) {
    const s = S.full.get(sid);
    if (!s || !n?.turnNodes?.size) continue;
    const mine = crewList().flatMap((m) => (m.offers || []).filter((o) => o.job === s.id).map((o) => [m, o]));
    for (const t of s.turns) {
      const slot = n.turnNodes.get(t.id)?.node.querySelector(':scope > .t-offers');
      if (!slot) continue;
      const here = mine.filter(([, o]) => (o.turn || s.turns.at(-1)?.id) === t.id);
      const html = here.map(([m, o]) => offerHtml(m, o)).join('');
      if (slot.dataset.html === html) continue;
      slot.dataset.html = html;
      slot.innerHTML = html;
      slot.onclick = (e) => {
        const oid = e.target.closest('[data-offer]')?.dataset.offer;
        const m = crewList().find((x) => (x.offers || []).some((o) => o.id === oid));
        if (m) offerClick(e, m, patchMember, () => paintOffers(sid));
      };
    }
  }
}

// The member's thread is in view: what you do there shows there, no toast needed.
const inView = (id) => S.crewOpen === id && (!isSplit() || !splitOpen());
export const crewInView = (id) => inView(id);

export async function checkIn(id) {
  const m = memberById(id);
  if (!m) return;
  const out = await tryApi(() => api(`/crew/${id}/checkin`, { method: 'POST', body: {} }));
  if (out?.member) Object.assign(m, out.member);
  if (out?.session && !S.sessions.has(out.session.id)) S.sessions.set(out.session.id, out.session);
  renderFeed();
  if (out && !inView(id)) toast(`${esc(m.name)} ${out.session ? 'is checking in' : 'will check in when a job finishes'}`, { action: { label: 'Open', run: () => openMember(id, { entry: out.session?.id }) } });
}

export async function togglePause(id) {
  const m = memberById(id);
  if (!m) return;
  // Their spell changed what they do (or just brought them): they resume once you've seen it.
  if (m.paused && m.changed) return reviewChange(m);
  if (await patchMember(m, { paused: !m.paused })) toast(m.paused ? `Paused ${esc(m.name)}: no check-ins until you resume` : `${esc(m.name)} is back on`);
}

export async function removeMember(id, anchor) {
  const m = memberById(id);
  if (!m) return;
  if (!(await ask(`Remove ${m.name} from your crew?\n\nTheir jobs stay as tasks. What they remember goes, and triggers that send them work are turned off.`, { ok: `Remove ${m.name}`, danger: true, anchor }))) return;
  const list = crewList();
  const at = list.indexOf(m);
  list.splice(at, 1);
  if (S.crewOpen === id) setOpen(null);
  views.get(id)?.node.remove();
  views.delete(id);
  renderFeed();
  try {
    await api(`/crew/${id}`, { method: 'DELETE' });
    toast(`Removed ${esc(m.name)}`);
  } catch (err) {
    list.splice(at, 0, m);
    renderFeed();
    toastError(err);
  }
}

// Hand a member a job. It shows in the thread at once (Starting up) and the box gets its text
// back if the server refuses.
// kit: they build their own kit (crew-kit.js): what they propose comes back under the job.
// confirm: your Start anyway near the usage limit. onHold(hold): the server says it's near the limit
// (409): the box gets its text back and the hold row shows, instead of an error toast.
export async function sendJob(m, prompt, { restore, kit = false, confirm = false, onHold } = {}) {
  const pend = { id: `sending-${Date.now()}`, prompt };
  sending.set(m.id, [...(sending.get(m.id) || []), pend]);
  // Under the member in the list too, unless it will wait for a free slot.
  const st = memberState(m);
  const card = st.live.length + st.jobs.filter((s) => s.state === 'waiting').length < (m.parallel || 1) && addPendingJob(m, prompt);
  renderFeed();
  try {
    const out = await api(`/crew/${m.id}/jobs`, { method: 'POST', body: { prompt, ...(kit && { kit: true }), ...(confirm && { confirmLimit: true }) } });
    if (card) S.sessions.delete(card);
    if (out.member) Object.assign(m, out.member);
    if (out.session && !S.sessions.has(out.session.id)) S.sessions.set(out.session.id, out.session);
    if (!inView(m.id)) toast(out.session ? `Sent to ${esc(m.name)}` : `${esc(m.name)} is busy: it starts when a job finishes`, { action: { label: 'Open', run: () => openMember(m.id, { entry: out.session?.id }) } });
  } catch (err) {
    if (card) S.sessions.delete(card);
    restore?.();
    if (err.hold && onHold) onHold(err.hold);
    else toastError(err);
  } finally {
    sending.set(m.id, (sending.get(m.id) || []).filter((x) => x !== pend));
    renderFeed();
  }
}

// A job the server hasn't started: a placeholder like the launcher's (it can't be opened), shown
// under its member. The real job replaces it (here, or live.js dropPending if its event wins).
let pendingSeq = 0;
function addPendingJob(m, prompt) {
  const id = `pending-crew-${++pendingSeq}`;
  const p = m.cwd && S.config.projects.find((x) => placesOf(x).some((k) => pathAt(x, k) === m.cwd));
  const line = plain(prompt).split('\n')[0].replace(/\s+/g, ' ');
  const now = Date.now();
  S.sessions.set(id, {
    id,
    pending: true,
    crew: { id: m.id, job: 'task' },
    title: line.length > 64 ? `${line.slice(0, 63)}…` : line,
    agent: m.agent,
    model: m.model,
    effort: m.effort,
    cwd: m.cwd || '',
    scratch: !m.cwd,
    project: p?.name || '',
    projectId: p?.id || null,
    color: p?.color || 'slate',
    state: 'running',
    live: 'Starting up',
    createdAt: now,
    updatedAt: now,
    machine: m.machine ? { id: m.machine, name: placeName(m.machine) } : null,
  });
  return id;
}

export function memberMenu(id, { x, y, anchor } = {}) {
  const m = memberById(id);
  if (!m) return;
  $('.menu.cr-menu')?.close();
  const menu = el(`<div class="menu cr-menu">
      ${inView(id) ? '' : `<button data-a="open">${icon('crew')}Open ${esc(m.name)}</button>`}
      <button data-a="checkin">${icon('clock')}Check in now</button>
      <button data-a="pause">${icon(m.paused ? 'play' : 'pause')}${m.paused ? 'Resume' : 'Pause'}</button>
      <button data-a="edit">${icon('pen')}Edit…</button>
      <button data-a="org">${icon('org')}Delegates…</button>
      <button data-a="share">${icon('arrow')}Share…</button>
      <button data-a="record">${icon('stats')}Track record…</button>
      ${m.spell ? `<button data-a="mine">${icon('wizard')}Make it mine</button>` : ''}
      <button data-a="remove" class="danger">${icon('trash')}Remove from crew</button>
    </div>`);
  menu.onclick = (e) => {
    const a = e.target.closest('button')?.dataset.a;
    close();
    if (a === 'open') openMember(id);
    if (a === 'checkin') checkIn(id);
    if (a === 'pause') togglePause(id);
    if (a === 'edit') crewEditor({ member: m });
    if (a === 'org') openDelegates(id);
    if (a === 'share') shareMember(id);
    if (a === 'record') trackRecord({ id });
    if (a === 'mine') makeMine(id);
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

// Delegates…: the Org page with the member selected (org.js, loaded on first use: it imports this file).
export const openDelegates = (id) => import('./org.js').then((o) => o.openOrg(id));

// A spell's member becomes yours: the spell lets go of them, and everything about them can change.
export async function makeMine(id, { then } = {}) {
  const m = memberById(id);
  if (!m?.spell) return;
  const was = m.spell;
  delete m.spell;
  renderFeed();
  try {
    Object.assign(m, await api(`/crew/${id}/detach`, { method: 'POST', body: {} }));
    renderFeed();
    toast(`${esc(m.name)} is yours now: the “${esc(was.name)}” spell won’t change them`);
    then?.();
  } catch (err) {
    m.spell = was;
    renderFeed();
    toastError(err);
  }
}

// The name the rest of the page knows it by.
export const openCrew = (id, opts) => openMember(id, opts);

// The crumb in a crew job's header (split.js) goes back to its member's thread.
document.addEventListener('click', (e) => {
  const b = e.target.closest?.('.sh-crumb[data-crew]');
  if (!b) return;
  e.preventDefault();
  openMember(b.dataset.crew, { entry: splitOpen() });
});

// --- a member's thread -----------------------------------------------------------------------------
//
// Its jobs as a conversation, oldest first: what each was asked and where it came from, then the
// member's answer. A job asking you shows the question with its choices and a box to answer in
// place; a finished one has Open job (the whole task) and Follow up (that job carries on). Quiet
// check-ins fold into one faint line. At the bottom, a box to hand the member a job; beside the
// thread (under it on a narrow pane), what it is and how it works, its notebook, brief and tasks.

const JOB_ICON = { checkin: 'clock', task: 'send', delegated: 'agent', trigger: 'bolt', mention: 'ask', event: 'bolt' };
const SHOW = 30; // jobs shown; Show earlier adds more
const views = new Map(); // member id -> view
const sending = new Map(); // member id -> [{ id, prompt }]: jobs sent, not started yet
const readSent = new Set(); // reports marked read from here

function viewFor(id) {
  let v = views.get(id);
  if (!v) views.set(id, (v = buildView(id)));
  return v;
}

// Where a job came from, as a chip: what kind, and from where (a task opens on click).
function origin(s) {
  const c = s.crew;
  const from = c.from?.title ? esc(c.from.title) : '';
  const link = c.from?.id && S.sessions.has(c.from.id) ? `data-session="${esc(c.from.id)}"` : '';
  const label = {
    checkin: 'Check-in',
    task: c.kit ? 'You · <b>Build your kit</b>' : 'You',
    mention: from ? `Tagged in <button class="cv-from" ${link}>“${from}”</button>` : 'Tagged in a task',
    delegated: from ? `Delegated by <button class="cv-from" ${link}>“${from}”</button>` : 'Delegated',
    trigger: from ? `Trigger <b>${from}</b>` : 'Trigger',
    event: `${c.event === 'done' ? 'Marked done' : 'Finished'}${from ? ` <button class="cv-from" ${link}>“${from}”</button>` : ''}`,
  }[c.job] || 'Job';
  return `<span class="cv-kind k-${c.job}">${icon(JOB_ICON[c.job] || 'send')}${label}</span>`;
}

const quietJob = (s) => (s.crew.job === 'checkin' || s.crew.job === 'event') && s.archived && s.state === 'done';

function jobHtml(m, s, { follow = false } = {}) {
  const live = s.state === 'running';
  const asks = s.state === 'waiting';
  const pill = asks ? '<span class="pill st-waiting"><i></i>Asking you</span>' : live ? '<span class="pill st-running"><i></i>Working</span>' : s.state === 'review' || s.state === 'done' ? `<span class="pill st-${s.status}"><i></i>${STATUS_LABEL[s.status] || STATUS_LABEL.done}</span>` : '';
  const ask = s.crew.job !== 'checkin' && s.crew.prompt ? `<div class="cv-prompt">${esc(s.crew.prompt)}</div>` : '';
  const sent = (s.crew.sent || []).map((x) => `<button class="cv-sent" data-session="${esc(x.id)}" title="Open the task">${icon('send')}Followed up in “${esc(x.title)}”</button>`).join('');
  let say;
  if (asks)
    say = `<div class="cv-asks">
        <p class="cv-q">${esc(s.question || 'Needs your approval to carry on.')}</p>
        ${s.approval ? `<div class="q-opts"><button class="opt go" data-answer="Allow">${icon('check')}Allow</button><button class="opt no" data-answer="Deny">${icon('x')}Deny</button></div>` : s.options?.length ? `<div class="q-opts">${s.options.map((o) => `<button class="opt" data-answer="${esc(o.label || o)}">${esc(o.label || o)}</button>`).join('')}</div>` : ''}
        ${s.approval ? '' : `<form class="cv-inline" data-answer-form><input class="input" placeholder="${s.options?.length ? 'Or answer in your own words…' : `Answer ${esc(m.name)}…`}" autocomplete="off" spellcheck="false"><button class="primary sm">Answer</button></form>`}
      </div>`;
  else if (live) say = `<p class="cv-live"><span class="q-live running">${esc(s.live || 'Starting up')}</span><span class="elapsed" data-start="${s.updatedAt}">${fmtDuration(Date.now() - s.updatedAt)}</span></p>`;
  else say = `<p class="cv-title">${esc(s.title)}</p>${s.preview ? `<p class="cv-sum">${esc(s.preview)}</p>` : ''}`;
  return `<article class="cv-job st-${s.state}${s.unread && s.state === 'review' ? ' unread' : ''}" data-id="${esc(s.id)}">
      <div class="cv-req">${origin(s)}<time ${timeAttrs(s.createdAt)}>${ago(s.createdAt)}</time>${ask}</div>
      <div class="cv-res">
        ${avatarHtml(m, { size: 26, dot: false, state: asks ? 'asks' : live ? 'live' : 'idle' })}
        <div class="cv-say">
          <div class="cv-head">${pill}${s.machine ? `<span class="cv-where">${icon('server')}${esc(s.machine.name)}</span>` : ''}</div>
          ${say}
          ${sent ? `<div class="cv-sents">${sent}</div>` : ''}
          ${live || asks ? '' : offerHtml(m, (m.offers || []).find((o) => o.job === s.id))}
          <div class="cv-acts">
            <button class="ghost xs" data-open="${esc(s.id)}">${icon('expand')}Open job</button>
            ${live || asks ? '' : `<button class="ghost xs" data-follow>${icon('enter')}Follow up</button>`}
            ${isForLater(s) ? `<button class="ghost xs cv-later on" data-later aria-pressed="true" title="Unsave (L)">${icon('bookmark')}Saved for later</button>` : canSaveForLater(s) && !quietJob(s) ? `<button class="ghost xs cv-later" data-later aria-pressed="false" title="Save for later (L)">${icon('bookmark')}Save for later</button>` : ''}
          </div>
          ${follow ? `<div class="c-hold cv-fhold" role="group" aria-label="Near the usage limit" aria-live="polite" hidden></div><form class="cv-inline" data-follow-form><input class="input sm" placeholder="Follow up with ${esc(m.name)} on this…" autocomplete="off" spellcheck="false"><button class="primary sm">Send</button></form>` : ''}
        </div>
      </div>
    </article>`;
}

function quietHtml(list) {
  const last = list.at(-1);
  return `<div class="cv-quiet" data-id="q-${esc(list[0].id)}">${icon('clock')}<span>${list.every((s) => s.crew.job === 'checkin') ? (list.length > 1 ? `${list.length} check-ins` : 'Check-in') : list.length > 1 ? `${list.length} jobs` : 'Job'} · nothing new</span><time ${timeAttrs(last.updatedAt)}>${ago(last.updatedAt)}</time></div>`;
}

function buildView(id) {
  const node = el(`<section class="crew-view" data-crew="${esc(id)}" hidden>
      <header class="cv-top"></header>
      <div class="cv-scroll">
        <div class="cv-cols">
          <div class="cv-main">
            <button class="link xs cv-earlier" hidden></button>
            <div class="cv-thread"></div>
          </div>
          <details class="cv-about"><summary></summary><div class="cv-side"></div></details>
        </div>
        <form class="cv-dock">
          <div class="c-hold cv-hold" role="group" aria-label="Near the usage limit" aria-live="polite" hidden></div>
          <div class="cv-box">
            <textarea class="cv-input" rows="1" spellcheck="false"></textarea>
            <div class="cv-bar">
              <button type="button" class="ghost xs" data-a="checkin" title="Start a check-in now">${icon('clock')}Check in now</button>
              <span class="grow"></span>
              <button class="send" title="Send (↵)" aria-label="Send">${icon('enter')}</button>
            </div>
          </div>
        </form>
      </div>
      <aside class="cv-page" hidden>
        <header class="cv-top cv-page-top"><button class="icon-btn sh-back" data-a="about-back" title="Back to the thread" aria-label="Back to the thread">${icon('back')}</button><h2 class="sh-title"></h2></header>
        <div class="cv-page-scroll"><div class="cv-side"></div></div>
      </aside>
    </section>`);
  const thread = $('.cv-thread', node);
  const head = $('.cv-top', node);
  const scroller = $('.cv-scroll', node);
  const page = $('.cv-page', node);
  const ta = $('.cv-input', node);
  const about = $('.cv-about', node);
  let show = SHOW;
  const following = new Set(); // jobs with their follow-up box open
  const holding = new Map(); // job -> { text, hold }: its follow-up waits for your yes (the hold row)
  const autosize = () => {
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  };
  ta.addEventListener('input', autosize);
  // The details may run down beside the box (crew.css): they need its height.
  const dock = $('.cv-dock', node);
  new ResizeObserver(() => node.style.setProperty('--cv-dock-h', `${dock.offsetHeight}px`)).observe(dock);
  // Near the usage limit (features/hold.js): the hold row over the box, as over a task's reply box,
  // with Start anyway; no Wait until (a job has no Start later). The draft stays until it goes.
  const holdRow = $('.cv-hold', node);
  const holdDock = (m, h) => showHold(holdRow, ta, { agent: m.agent, account: 'default', ...h, resetsAt: null }, { kind: 'first', go: () => sendDock(memberById(id) || m, { confirm: true }), wait: () => {} });
  const sendDock = (m, { confirm = false } = {}) => {
    const text = ta.value.trim();
    if (!text) return;
    // One on another computer: the server there decides.
    const h = !confirm && !m.machine && holdNow(m.agent, '', 'first');
    if (h) return holdDock(m, h);
    hideHold(holdRow);
    ta.value = '';
    autosize();
    return sendJob(m, text, {
      confirm,
      restore: () => {
        if (!ta.value) (ta.value = text), autosize();
      },
      onHold: (x) => holdDock(m, x),
    });
  };
  mentionBox(ta); // @ the rest of the crew, tasks pasted by id
  ta.dataset.crew = id;

  const atEnd = () => scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 40;

  const paint = () => {
    const m = memberById(id);
    if (!m) return;
    const st = memberState(m);
    const split = isSplit();
    const stacked = isStacked();
    // Header: like a task's (stacked, Back to the list first, and no Close).
    const backTo = crewHooks.back ? 'Back to Org' : 'Back to tasks';
    const top = `${stacked ? `<button class="icon-btn sh-back" data-a="close" title="${backTo}" aria-label="${backTo}">${icon('back')}</button>` : ''}${avatarHtml(m, { size: 30, dot: false })}
      <div class="cv-who"><h2 class="sh-title">${esc(m.name)}</h2>${m.role ? `<span class="cv-role">${esc(m.role)}</span>` : ''}</div>
      <span class="cv-state ${statusLine(m, st).cls}">${esc(statusLine(m, st).text)}</span>
      <span class="sh-acts">
        ${slotHtml('crew.page', null)}
        <button class="ghost sm" data-a="pause" aria-label="${m.paused ? 'Resume' : 'Pause'}" title="${m.paused ? 'Resume: check-ins and triggers start again' : 'Pause: no check-ins, triggers or delegations until you resume'}">${icon(m.paused ? 'play' : 'pause')}<span>${m.paused ? 'Resume' : 'Pause'}</span></button>
        <button class="icon-btn" data-a="more" title="More" aria-label="More">${icon('dots')}</button>
        ${split && !stacked ? `<button class="icon-btn" data-a="close" title="${crewHooks.back ? 'Close: back to Org (Esc)' : 'Close: back to New task (Esc)'}" aria-label="Close">${icon('x')}</button>` : ''}
      </span>`;
    const hd = head;
    const hkey = top.replace(/<svg[\s\S]*?<\/svg>/, `[${st.mood}:${m.avatar}]`);
    if (hd.dataset.h !== hkey) (hd.innerHTML = top), (hd.dataset.h = hkey);
    ta.placeholder = `Give ${m.name} a job… (@ to bring in someone else)`;

    // The thread: jobs oldest first, quiet check-ins folded together, then jobs sent but not started.
    const end = atEnd();
    const jobs = [...st.jobs].sort((a, b) => a.createdAt - b.createdAt);
    const earlier = Math.max(0, jobs.length - show);
    const btn = $('.cv-earlier', node);
    btn.hidden = !earlier;
    btn.textContent = `Show earlier · ${earlier}`;
    const items = [];
    for (const s of jobs.slice(earlier)) {
      if (quietJob(s) && items.at(-1)?.quiet) items.at(-1).list.push(s);
      else items.push(quietJob(s) ? { quiet: true, list: [s] } : { s });
    }
    const want = items.map((x) => (x.quiet ? { key: `q-${x.list[0].id}`, html: quietHtml(x.list) } : { key: x.s.id, html: jobHtml(m, x.s, { follow: following.has(x.s.id) }) }));
    for (const w of sending.get(id) || []) want.push({ key: w.id, html: `<article class="cv-job st-running sending" data-id="${w.id}"><div class="cv-req">${`<span class="cv-kind k-task">${icon('send')}You</span>`}<div class="cv-prompt">${esc(w.prompt)}</div></div><div class="cv-res">${avatarHtml(m, { size: 26, dot: false, state: 'live' })}<div class="cv-say"><p class="cv-live"><span class="q-live running">Starting up</span></p></div></div></article>` });
    for (const w of m.queue || []) want.push({ key: `w-${w.id}`, html: `<article class="cv-job queued" data-id="w-${w.id}"><div class="cv-req"><span class="cv-kind">${icon('queue')}Waiting for a free slot</span><div class="cv-prompt">${esc(w.prompt)}</div><button class="icon-btn" data-drop="${w.id}" title="Drop this job" aria-label="Drop this job">${icon('x')}</button></div></article>` });
    if (!want.length) want.push({ key: 'empty', html: `<div class="cv-empty">${avatarHtml(m, { size: 56, dot: false })}<p><b>${esc(m.name)}</b> hasn’t done anything yet.</p><p>Give them a job below${m.cron ? `, or wait for their first check-in (${esc(cadenceLabel(m.cron).toLowerCase())})` : ''}. In any other task, <code>@${esc(m.name)}</code> brings them in.</p></div>` });
    // Keyed: an unchanged entry stays put (its spirit keeps moving, an answer being typed stays).
    want.forEach((w, i) => {
      let n = [...thread.children].find((c) => c.dataset.key === w.key);
      const busy = n && n.contains(document.activeElement) && document.activeElement.type !== 'checkbox' && document.activeElement.value; // an answer being typed
      if (n && n.dataset.h !== w.html && !busy) {
        const next = el(w.html);
        next.dataset.key = w.key;
        next.dataset.h = w.html;
        n.replaceWith(next);
        n = next;
      }
      if (!n) {
        n = el(w.html);
        n.dataset.key = w.key;
        n.dataset.h = w.html;
        if (thread.children.length) n.classList.add('new');
      }
      if (thread.children[i] !== n) thread.insertBefore(n, thread.children[i] || null);
    });
    while (thread.children.length > want.length) thread.lastElementChild.remove();
    // A follow-up waiting for your yes keeps its row and its text when its job was drawn again.
    for (const job of holding.keys()) showFollowHold(job);
    if (end) scroller.scrollTop = scroller.scrollHeight;

    // What it is and how it works: beside the thread on a wide pane, folded above it otherwise.
    // (#splitStage is hidden while the thread shows, so measure the pane itself.)
    const wide = split && $('#splitMain').clientWidth >= 860;
    node.classList.toggle('wide', wide);
    if (wide) about.open = true;
    // Its cadence, unless the head already says the same (an idle member's status is its cadence).
    const how = [cadenceText(m), m.sandbox ? (m.sandbox === 'own' ? 'in their own sandbox' : 'in a sandbox per job') : m.machine ? `on ${placeName(m.machine)}` : ''].filter(Boolean).join(' · ');
    $('summary', about).innerHTML = `${icon('info')}About ${esc(m.name)}<span>${how === statusLine(m, st).text ? '' : esc(how)}</span>${icon('chevron', 'chev')}`;
    paintSide(m, st, $('.cv-side', about));
    // Its About page, while it's in: the same details, a page of their own.
    if (!page.hidden) {
      $('.sh-title', page).textContent = `About ${m.name}`;
      paintSide(m, st, $('.cv-side', page));
    }

    // Seen here: its reports are read.
    if (!node.hidden && node.isConnected)
      for (const s of st.jobs)
        if (s.unread && s.state === 'review' && !readSent.has(s.id)) {
          readSent.add(s.id);
          s.unread = false;
          api(`/sessions/${s.id}`, { method: 'PATCH', body: { unread: false } }).catch(() => readSent.delete(s.id));
        }
  };

  // Bring a job into view (a notification, Esc from the job) and flash it; else the latest.
  const reveal = (entry) => {
    paint();
    const n = entry && [...thread.children].find((c) => c.dataset.key === entry || c.dataset.id === entry);
    if (n) {
      n.scrollIntoView({ block: 'center' });
      n.classList.remove('flash');
      void n.offsetWidth;
      n.classList.add('flash');
    } else scroller.scrollTop = scroller.scrollHeight;
  };

  node.addEventListener('click', (e) => {
    const m = memberById(id);
    if (!m) return;
    if (e.target.closest('.cv-kit')) return kitClick(e, m, patchMember, sendJob);
    if (e.target.closest('.cv-offer')) return offerClick(e, m, patchMember, paint);
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'close') {
      const back = crewHooks.back;
      crewHooks.back = null;
      closeMember();
      return back?.();
    }
    if (a === 'about-back') return showPage(false);
    if (a === 'checkin') return checkIn(id);
    if (a === 'pause') return togglePause(id);
    if (a === 'edit') return crewEditor({ member: m });
    if (a === 'org') return openDelegates(id);
    if (a === 'share') return shareMember(id);
    if (a === 'note-edit') return notebookEditor(m);
    const clip = e.target.closest('[data-clip]')?.dataset.clip;
    if (clip) {
      const k = `${clip}:${id}`;
      unclipped[unclipped.has(k) ? 'delete' : 'add'](k);
      return paint();
    }
    if (a === 'remove') return removeMember(id, e.target.closest('[data-a]'));
    if (a === 'mine') return makeMine(id);
    if (a === 'more') return memberMenu(id, { anchor: e.target.closest('[data-a]') });
    if (e.target.closest('.cv-earlier')) {
      show += SHOW;
      return paint();
    }
    const open = e.target.closest('[data-open]')?.dataset.open;
    if (open) return reveal_(open);
    const sid = e.target.closest('[data-session]')?.dataset.session;
    if (sid) return reveal_(sid);
    const drop = e.target.closest('[data-drop]')?.dataset.drop;
    if (drop) return patchMember(m, { queue: m.queue.filter((w) => w.id !== drop).map((w) => w.id) });
    const job = e.target.closest('.cv-job')?.dataset.id;
    if (e.target.closest('[data-follow]') && job) {
      following.add(job);
      paint();
      return $(`.cv-job[data-id="${job}"] [data-follow-form] input`, node)?.focus();
    }
    if (e.target.closest('[data-later]') && job) return setForLater(job, !isForLater(S.sessions.get(job)));
    const answer = e.target.closest('[data-answer]')?.dataset.answer;
    if (answer && job) return answerJob(job, answer);
  });
  node.addEventListener('submit', (e) => {
    e.preventDefault();
    const m = memberById(id);
    const f = e.target;
    if (!m) return;
    if (f.classList.contains('cv-dock')) return sendDock(m);
    const job = f.closest('.cv-job')?.dataset.id;
    const input = $('input', f);
    const text = input?.value.trim();
    if (!job || !text) return input?.focus();
    input.value = '';
    if (f.hasAttribute('data-answer-form')) return answerJob(job, text, { restore: () => (input.value = text) });
    sendFollow(job, text);
  });
  // Follow up on a job near the usage limit (features/hold.js): the hold row over its box, as over
  // a task's reply box, with Send anyway; no Wait until (the thread has no Start later). The page
  // asks first when it can tell (a job on another computer: the server there does), and a 409 from
  // the server shows the same row with the text back in the box.
  const sendFollow = (job, text, { confirm = false } = {}) => {
    const s = S.sessions.get(job);
    if (!s) return;
    const who = { agent: s.agent, account: s.account || '' };
    const h = !confirm && !s.machine && holdNow(who.agent, who.account, 'followUp');
    if (h) return holdFollow(job, text, { ...who, ...h });
    holding.delete(job);
    following.delete(job);
    followJob(job, text, {
      confirm,
      restore: () => {
        following.add(job);
        paint();
      },
      onHold: (x) => holdFollow(job, text, { ...who, ...x }),
    });
  };
  const holdFollow = (job, text, hold) => {
    holding.set(job, { text, hold: { ...hold, account: hold.account || 'default', resetsAt: null } });
    const row = $(`.cv-job[data-id="${job}"] .cv-fhold`, node);
    if (row) delete row.dataset.held; // asked again after × (Keep editing)
    following.add(job);
    paint();
    $(`.cv-job[data-id="${job}"] [data-follow-form] input`, node)?.focus();
  };
  // Its row, once per box: × (Keep editing) leaves the row closed and the text in the box.
  const showFollowHold = (job) => {
    const x = holding.get(job);
    const art = $(`.cv-job[data-id="${job}"]`, node);
    const row = art && $('.cv-fhold', art);
    const input = art && $('[data-follow-form] input', art);
    if (!row || !input) return holding.delete(job);
    if (row.dataset.held) return row.hidden && holding.delete(job);
    if (!input.value) input.value = x.text;
    row.dataset.held = '1';
    showHold(row, input, x.hold, { kind: 'followUp', go: () => sendFollow(job, input.value.trim() || x.text, { confirm: true }), wait: () => {} });
  };
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !e.defaultPrevented) {
      e.preventDefault();
      $('.cv-dock', node).requestSubmit();
    }
  });
  // .md files dropped on Skills and instructions join the member's kit.
  node.addEventListener('dragover', (e) => {
    const kit = e.target.closest?.('.cv-kit');
    if (!kit || !e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    e.stopPropagation(); // not the page's own drop (attachments)
    kit.classList.add('drop');
  });
  node.addEventListener('dragleave', (e) => {
    const kit = e.target.closest?.('.cv-kit');
    if (kit && !kit.contains(e.relatedTarget)) kit.classList.remove('drop');
  });
  node.addEventListener('drop', (e) => {
    const kit = e.target.closest?.('.cv-kit');
    const m = memberById(id);
    if (!kit || !m || !e.dataTransfer?.files.length) return;
    e.preventDefault();
    e.stopPropagation();
    kit.classList.remove('drop');
    addFiles(m, patchMember, [...e.dataTransfer.files]);
  });
  about.addEventListener('toggle', () => {
    if (!node.classList.contains('wide')) about.dataset.user = about.open ? '1' : '';
  });
  // The About page (the phone app, swiped in): it takes one Back entry, so Back returns to the thread.
  let aboutBack = null;
  const showPage = (on) => {
    if (page.hidden === !on) return;
    page.hidden = !on;
    if (on) {
      $('.cv-page-scroll', page).scrollTop = 0;
      paint();
      aboutBack = onBack(() => {
        aboutBack = null;
        showPage(false);
      });
    } else if (aboutBack) (aboutBack(), (aboutBack = null));
  };
  return { node, head, scroller, page, paint, reveal, about: showPage, focus: () => !MOBILE && ta.focus({ preventScroll: true }) };
}

// A job opened in full: the task, under its member in the list (and in the main pane in split view).
function reveal_(id) {
  if (!S.sessions.has(id)) return toast('That task is no longer in wisp.', { tone: 'bad' });
  return reveal(id);
}

// The details: one fact a row like a task's, the actions, then the notebook, brief and tasks.
function paintSide(m, st, side) {
  const project = S.config.projects?.find((p) => pathAt(p, m.machine || '') === m.cwd);
  const facts = [
    ['clock', m.paused ? 'Paused' : `${cadenceLabel(m.cron)}${m.nextAt && !m.paused ? ` · next ${whenLabel(m.nextAt)}` : ''}`],
    // Settings → Usage → Automations stop at: its account is past it, so check-ins skip until the reset.
    // held.load: the RAM/CPU guard (server/load.js), which looks again every minute.
    ...(m.held?.load && !m.paused ? [['pause', 'Waits for the computer', `${m.held.why}. Check-ins go on once there’s room. Check in now still runs.`]] : []),
    ...(m.held && !m.held.load && !m.paused ? [['pause', `Waits for your plan · ${aheadLabel(m.held.until)}`, `Check-ins wait for your plan until ${whenLabel(m.held.until)}: ${m.held.why}. Check in now still runs.`]] : []),
    ...(eventsLabel(m) ? [['bolt', eventsLabel(m)]] : []),
    ['queue', `${m.parallel} job${m.parallel > 1 ? 's' : ''} at once${st.live.length ? ` · ${st.live.length} working` : ''}`],
    // Paired on one line each so the column fits a window without scrolling.
    ['folder', `${project?.name || (m.cwd ? m.cwd.split(/[\\/]/).pop() : 'No project')} · ${SANDBOX_LABEL[m.sandbox] || (m.machine ? placeName(m.machine) : HERE)}`],
    // No "Default model": it said nothing and cut the mode to "Full…" (the tip still names it)
    [`logo:${m.agent}`, `${agentName(m.agent)}${m.agent === 'auto' || !m.model ? '' : ` · ${m.model}`} · ${MODES.find((x) => x.id === m.mode)?.label || 'Full auto'}`, `${agentName(m.agent)}${m.agent === 'auto' ? '' : ` · ${m.model || 'Default model'}`} · ${MODES.find((x) => x.id === m.mode)?.label || 'Full auto'}`],
  ];
  const team = (m.team || []).map((t) => (t.crew && memberById(t.crew) ? `<span class="cv-mate" title="${esc(memberById(t.crew).name)}">${avatarHtml(memberById(t.crew), { size: 20, dot: false })}</span>` : `<span class="cv-mate logo" title="${esc(agentName(t.agent))}">${harnessLogo(t.agent)}</span>`)).join('');
  const html = `
    <div class="cv-facts">${facts.map(([ic, t, tip]) => `<div class="m${ic === 'pause' ? ' held' : ''}">${ic.startsWith('logo:') ? `<span class="cv-logo">${harnessLogo(ic.slice(5))}</span>` : icon(ic)}<span title="${esc(tip || t)}">${esc(t)}</span></div>`).join('')}
      <button class="m cv-dlg" data-a="org" title="Who ${esc(m.name)} hands work to: see and change it in Org">${icon('agent')}<span>${team ? `<span class="cv-team">${team}</span>` : 'No delegates'}</span>${icon('chevron', 'chev')}</button></div>
    <div class="cv-actions">
      <button class="ghost sm" data-a="checkin">${icon('clock')}<span>Check in now</span></button>
      <button class="ghost sm" data-a="edit">${icon('pen')}<span>Edit…</span></button>
      <button class="ghost sm danger" data-a="remove" title="Remove from crew" aria-label="Remove from crew">${icon('trash')}</button>
    </div>
    <div class="cv-sec cv-nb">
      <h5>Notebook <small class="cv-count"></small><button class="link xs" data-a="note-edit">Edit</button></h5>
      ${clipped(m.notebook, 'note', m.id, 'Empty so far. They add to it as they work; you can write in it too.')}
    </div>
    ${m.spell ? `<div class="cv-sec cv-spell"><p>${icon('wizard')}<span>From the “${esc(m.spell.name)}” spell, which keeps them up to date. <button class="link xs" data-a="mine">Make it mine</button></span></p></div>` : ''}
    <div class="cv-sec"><h5>Brief ${m.spell ? '' : '<button class="link xs" data-a="edit">Edit</button>'}</h5>${clipped(m.brief, 'brief', m.id, 'No brief: they do what each job asks.', !m.spell)}</div>
    ${kitHtml(m)}
    ${m.links?.length ? `<div class="cv-sec"><h5>Part of</h5><div class="cv-links">${m.links.slice(0, 6).map((l) => `<button class="cv-link" data-session="${esc(l.id)}" ${S.sessions.has(l.id) ? '' : 'disabled'}><span>${esc(l.title || 'A task')}</span>${icon('chevron')}</button>`).join('')}</div></div>` : ''}`;
  const key = html.replace(/<svg[\s\S]*?<\/svg>/g, '');
  if (side.dataset.h !== key) {
    side.innerHTML = html;
    side.dataset.h = key;
  }
  countNotebook($('.cv-count', side), m.notebook || '');
}

// A notebook or brief, read as prose; a long one shows its start. Its Edit opens the rest; a spell's
// brief has no Edit, so there Show all does.
const CLIP = 240; // characters
const unclipped = new Set(); // `${kind}:${member id}` opened in full
function clipped(text, kind, id, empty, editable = true) {
  if (!text?.trim()) return kind === 'note' ? `<button class="cv-none cv-nb-empty" data-a="note-edit">${esc(empty)}</button>` : `<p class="cv-none">${esc(empty)}</p>`;
  const long = text.length > CLIP || text.split('\n').length > 4;
  const open = !editable && unclipped.has(`${kind}:${id}`);
  return `<div class="cv-text${long && !open ? ' clip' : ''}"><div class="prose">${md(text)}</div></div>${long && !editable ? `<button class="link xs cv-all" data-clip="${kind}">${open ? 'Show less' : 'Show all'}</button>` : ''}`;
}

// The size only matters while you write, or when it's nearly full (they're asked to tidy at 6,000).
const NOTEBOOK_MAX = 6000;
function countNotebook(c, text, editing = false) {
  const n = text.length;
  c.textContent = editing || n > 4800 ? `${n.toLocaleString()} / ${NOTEBOOK_MAX.toLocaleString()}` : '';
  c.classList.toggle('over', n > NOTEBOOK_MAX);
}

// The notebook in a dialog, like a kit file: room to read and write, Save to keep it. Saving is
// optimistic (patchMember); refused, the dialog comes back with what you wrote.
function notebookEditor(m, { draft = null } = {}) {
  const start = m.notebook || '';
  const node = el(`<div class="modal nb-edit" role="dialog" aria-label="Notebook">
      <header><h2>${esc(m.name)}’s notebook</h2><button class="icon-btn close" title="Close" aria-label="Close">${icon('x')}</button></header>
      <form class="ce-form">
        <p class="hint">What they keep in mind between jobs: facts, decisions, where they left off. Every job starts with it, and they add to it as they work.</p>
        <textarea class="textarea mono nb-body" name="body" rows="16" spellcheck="false" placeholder="- The release branch is cut on Thursdays.\n- Last checked CI at 14:30: green."></textarea>
        <footer class="ce-foot">
          <span class="grow"></span><small class="nb-count"></small>
          <button type="button" class="ghost sm" data-a="cancel">Cancel</button>
          <button class="primary sm">Save</button>
        </footer>
      </form>
    </div>`);
  const close = overlay(node);
  const f = $('form', node);
  const body = $('.nb-body', f);
  body.value = draft ?? start;
  const count = () => countNotebook($('.nb-count', node), body.value, true);
  count();
  body.addEventListener('input', count);
  $('.close', node).onclick = () => {
    close();
  };
  $('[data-a="cancel"]', node).onclick = () => {
    close();
  };
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const notebook = body.value;
    const now = memberById(m.id) || m;
    if (notebook === (now.notebook || '')) return close();
    // They wrote in it while it was open here: saving replaces what they added.
    if ((now.notebook || '') !== start && !(await ask(`${now.name} wrote in their notebook while you had it open.\n\nSaving replaces what they added.`, { ok: 'Save anyway', anchor: $('.primary', f) }))) return;
    close();
    if (!(await patchMember(now, { notebook }))) notebookEditor(now, { draft: notebook });
  });
  setTimeout(() => {
    body.focus();
    body.setSelectionRange(0, 0);
    body.scrollTop = 0;
  });
}

// Answer a job's question (or Allow / Deny it) from the thread. The job carries on at once here,
// and goes back to asking (with your text back) if the server refuses.
async function answerJob(id, text, { restore } = {}) {
  const s = S.sessions.get(id);
  if (!s) return;
  const before = { ...s };
  Object.assign(s, { state: 'running', live: 'Carrying on', question: '', options: undefined, approval: false });
  renderFeed();
  try {
    await api(`/sessions/${id}/answer`, { method: 'POST', body: { text } });
  } catch (err) {
    if (S.sessions.get(id)?.state === 'running') S.sessions.set(id, before);
    renderFeed();
    restore?.();
    toastError(err);
  }
}

// Follow up on a finished job from the thread: that job carries on, with what it already knows.
// confirm: your Send anyway near the usage limit. onHold(hold): the server says it's near the limit
// (409): the hold row shows instead of an error toast.
async function followJob(id, text, { restore, confirm = false, onHold } = {}) {
  const s = S.sessions.get(id);
  if (!s) return;
  const before = { ...s };
  Object.assign(s, { state: 'running', live: 'Starting up', updatedAt: Date.now() });
  renderFeed();
  try {
    await api(`/sessions/${id}/reply`, { method: 'POST', body: { text, queue: true, ...(confirm && { confirmLimit: true }) } });
  } catch (err) {
    S.sessions.set(id, before);
    renderFeed();
    restore?.();
    if (err.hold && onHold) onHold(err.hold);
    else toastError(err);
  }
}

// --- the editor: add, edit, or make a task a member ---------------------------------------------------

// member: edit it. task: a task (summary) joining the crew; its folder and harness come with it.
export function crewEditor({ member = null, task = null, draft = null } = {}) {
  const editing = !!member;
  const locked = !!member?.spell; // a spell's member: the spell owns who they are (server/crew-share.js)
  const d = draft || {
    name: member?.name || '',
    role: member?.role || '',
    avatar: member?.avatar || '',
    color: member?.color || '',
    bg: member?.bg || '', // the task panel's tint while they're picked
    brief: member?.brief ?? '',
    cron: member?.cron ?? '',
    on: (member?.on || []).filter((k) => EVENTS.some(([e]) => e === k)), // what else starts their jobs
    parallel: member?.parallel || 2,
    team: member?.team || [], // its delegates: any harness, other crew members
    cwd: member?.cwd ?? (task ? '' : S.config.projects?.find((p) => p.id === launch.project)?.path || ''),
    machine: member?.machine || '', // '' = this computer
    sandbox: member?.sandbox || '', // '' | 'job' | 'own': their jobs in a box on your grid
    agent: member?.agent || S.config.defaults?.agent || 'auto',
    model: member?.model || '',
    effort: member?.effort || '',
    mode: member?.mode || 'auto',
    checkin: !editing && !task,
  };
  if (!d.avatar) d.avatar = rollSpirit(Math.random());
  // Custom: a schedule typed in words ("8am every weekday"), kept open once picked.
  let typing = !CADENCES.some(([c]) => c === d.cron);
  const custom = () => typing;
  const node = el(`<div class="modal crew-edit" role="dialog">
      <header><h2>${editing ? `Edit ${esc(member.name)}` : task ? 'Add this task to your crew' : 'Add to your crew'}</h2><button class="icon-btn close" title="Close" aria-label="Close">${icon('x')}</button></header>
      ${editing || task ? '' : `<div class="ce-templates"><span class="ce-lbl">Start from</span>${TEMPLATES.map((t) => `<button type="button" class="lp-chip" data-tpl="${t.key}"><span class="ce-tav">${spiritSvg(t.avatar, { small: true })}</span>${esc(t.role)}</button>`).join('')}<button type="button" class="lp-chip ce-import" data-a="import" title="A member someone shared: a .crew.json file, its JSON or a link">${icon('download')}Import…</button></div>`}
      ${locked ? `<div class="ce-spell">${icon('wizard')}<span>The “${esc(member.spell.name)}” spell sets who they are, their job, schedule and mode. Where and how they run is yours.</span><button type="button" class="ghost xs" data-a="mine">Make it mine</button></div>` : ''}
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
          <div class="ce-cron" hidden><input class="input sm" name="cron" placeholder="every monday, 8am every weekday…" spellcheck="false" autocomplete="off"><span class="ce-cron-read" aria-live="polite"></span></div>
        </div>
        <div class="ce-stack ce-events"><span>Also starts when <small>with a job about that task, in their project (any, if they have none)</small></span>
          <div class="ce-cadence ce-on">${EVENTS.map(([k, l]) => `<button type="button" class="lp-chip" data-on="${k}" aria-pressed="false">${icon(k === 'ci' ? 'warn' : k === 'done' ? 'done' : 'bolt')}${l}</button>`).join('')}</div>
        </div>
        <div class="ce-stack ce-tint"><span>Task panel <small>the list’s very light tint while they’re picked on the rail</small></span>
          <div class="ce-tints" role="group" aria-label="Task panel tint">
            <button type="button" class="cm-opt ce-bg" data-bg="" title="Their glow (default)" aria-label="Their glow (default)" aria-pressed="false"><i class="cm-sw ce-glow"></i></button>
            <button type="button" class="cm-opt ce-bg ce-none" data-bg="none" title="No tint" aria-label="No tint" aria-pressed="false">${icon('x')}</button>
            ${SPIRIT.color.map((c) => `<button type="button" class="cm-opt ce-bg" data-bg="${c}" title="${c}" aria-label="${c}" aria-pressed="false"><i class="cm-sw c-${c}"></i></button>`).join('')}
          </div>
        </div>
        <div class="ce-bar">
          ${task ? '' : `<button type="button" class="tog-btn where-btn ce-place" title="The computer their jobs run on" aria-haspopup="menu"></button>
          <button type="button" class="tog-btn ce-proj" title="The project their jobs run in">${icon('folder')}<span></span>${icon('chevron', 'chev')}</button>
          <button type="button" class="runner-btn ce-runner" title="Harness, model and thinking level" aria-haspopup="dialog"></button>`}
          <button type="button" class="tog-btn team-btn ce-team" aria-haspopup="dialog"></button>
          <button type="button" class="mode-btn ce-mode" aria-haspopup="menu"></button>
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
  if (locked) for (const x of $$('[name="name"], [name="role"], [name="brief"], [name="cron"], [data-cron], [data-on], .ce-face, .ce-mode, .ce-team', node)) x.disabled = true;
  $f('brief').value = d.brief;
  $f('cron').value = cronWords(d.cron) || d.cron;
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
    paintTint();
  };
  // The colour their task panel takes when nothing else is picked: their glow, or the server's
  // colour for a member that has an emoji instead of a spirit.
  const glowColor = () => (isSpirit(d.avatar) ? parseSpirit(d.avatar).color : d.color || SPIRIT.color[crewList().length % SPIRIT.color.length]);
  const paintTint = () => {
    const glow = $('.ce-glow', node);
    if (glow) glow.className = `cm-sw ce-glow c-${glowColor()}`;
    $$('[data-bg]', node).forEach((b) => {
      const on = b.dataset.bg === (d.bg || '');
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on);
    });
  };
  const paintHandle = () => {
    const n = $f('name').value.trim();
    $('.ce-handle', node).innerHTML = n ? `Reach them with <code>@${esc(n)}</code> in any prompt or follow-up` : 'Pick a name you can type: you’ll reach them with @name';
  };
  // What the typed schedule will do, read back in words, or how to say it.
  const paintRead = () => {
    const said = $f('cron').value.trim();
    const cron = toCron(said);
    const r = $('.ce-cron-read', node);
    r.classList.toggle('bad', !!said && !cron);
    const words = cron && (cronWords(cron) || cron);
    // Read back only when it says something new: the box already shows "Mondays at 9:00".
    r.textContent = !said ? 'Say it like you would to a person' : !cron ? 'Try “every monday” or “every 2 hours”' : words.toLowerCase() === said.toLowerCase() ? 'Understood' : `= ${words}`;
  };
  const paintCadence = () => {
    $$('.ce-cadence [data-cron]', node).forEach((b) => b.classList.toggle('on', custom() ? b.dataset.cron === 'custom' : b.dataset.cron === d.cron));
    $('.ce-cron', node).hidden = !custom();
    paintRead();
    $$('.ce-on [data-on]', node).forEach((b) => {
      const on = d.on.includes(b.dataset.on);
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on);
    });
  };
  const paintBar = () => {
    $('.ce-par b', node).textContent = `${d.parallel} at once`;
    $('[data-par="-1"]', node).disabled = d.parallel <= 1;
    $('[data-par="1"]', node).disabled = d.parallel >= 5;
    // Its delegates: the button the launcher has, with the member as the lead.
    paintTeamBtn($('.ce-team', node), d.team, '', d.agent || task?.agent);
    // What they may do without asking: the launcher's mode button and menu.
    const m = MODES.find((x) => x.id === d.mode) || MODES[0];
    const mb = $('.ce-mode', node);
    mb.className = `mode-btn ce-mode m-${m.id}`;
    mb.innerHTML = `${icon(m.icon)}<span>${m.label}</span>`;
    mb.title = `${m.label}: ${m.hint}`;
    $('.ce-team', node).title = d.team.length ? `${$('.ce-team', node).title}\n\nEvery job of theirs can hand work to these.` : 'Delegates: agents (or other crew members) every job of theirs can hand work to';
    if (task) return;
    const p = S.config.projects?.find((x) => pathAt(x, d.machine) === d.cwd);
    $('.ce-proj span', node).textContent = p?.name || (d.cwd ? d.cwd.split(/[\\/]/).pop() : 'No project');
    paintRunnerBtn($('.ce-runner', node), d.agent, d.model, d.effort);
    // Where they live: this computer, or one of your machines (memory and schedule stay here).
    const pb = $('.ce-place', node);
    pb.classList.toggle('on', !!(d.machine || d.sandbox));
    pb.innerHTML = `${icon(d.sandbox ? 'box' : d.machine ? 'server' : 'laptop')}<span>${esc(SANDBOX_LABEL[d.sandbox] || placeName(d.machine))}</span>${icon('chevron', 'chev')}`;
    pb.hidden = !S.machines.length && !d.machine && !d.sandbox && !canSandbox();
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
    if (isSpirit(code)) d.color = parseSpirit(code).color;
    paintFace();
    if (!maker.hidden) paintMaker();
  };

  node.addEventListener('click', (e) => {
    if (e.target.closest('[data-a="import"]')) {
      close();
      return importCrew();
    }
    if (e.target.closest('[data-a="mine"]')) {
      close();
      return makeMine(member.id, { then: () => crewEditor({ member: memberById(member.id) }) });
    }
    if (locked && e.target.closest('[disabled]')) return;
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
    const bgBtn = e.target.closest('[data-bg]');
    if (bgBtn) {
      d.bg = bgBtn.dataset.bg;
      paintTint();
      return;
    }
    if (e.target.closest('[data-a="roll"]')) return setFace(rollSpirit(Math.random()));
    const tpl = TEMPLATES.find((t) => t.key === e.target.closest('[data-tpl]')?.dataset.tpl);
    if (tpl) {
      $$('[data-tpl]', node).forEach((b) => b.classList.toggle('on', b.dataset.tpl === tpl.key));
      // A name you typed stays; the template's is a suggestion.
      if (!$f('name').value.trim() || TEMPLATES.some((t) => t.name === $f('name').value.trim())) $f('name').value = tpl.name;
      $f('role').value = tpl.role;
      $f('brief').value = tpl.brief;
      d.cron = tpl.cron;
      d.on = tpl.on || [];
      if ($f('checkin')) $f('checkin').checked = !!tpl.cron; // one that waits for tasks has nothing to check yet
      $f('cron').value = cronWords(tpl.cron) || tpl.cron;
      typing = !CADENCES.some(([c]) => c === d.cron);
      setFace(tpl.avatar);
      paintHandle();
      paintCadence();
      return;
    }
    const ev = e.target.closest('[data-on]')?.dataset.on;
    if (ev) {
      d.on = d.on.includes(ev) ? d.on.filter((k) => k !== ev) : [...d.on, ev];
      paintCadence();
      return;
    }
    const c = e.target.closest('[data-cron]')?.dataset.cron;
    if (c !== undefined) {
      typing = c === 'custom';
      if (!typing) d.cron = c;
      $f('cron').value = d.cron ? cronWords(d.cron) || d.cron : '';
      paintCadence();
      if (typing) $f('cron').select();
      return;
    }
    const par = Number(e.target.closest('[data-par]')?.dataset.par);
    if (par) {
      d.parallel = Math.min(5, Math.max(1, d.parallel + par));
      paintBar();
      return;
    }
    if (e.target.closest('.ce-place')) {
      const extra = canSandbox() || d.sandbox ? [
        { k: 'sandbox:job', icon: 'box', name: 'A sandbox per job', sub: 'Fresh each time, with the project as it is here · Claude Code' },
        { k: 'sandbox:own', icon: 'box', name: 'A sandbox of their own', sub: 'Kept for them: what they install stays · Claude Code' },
      ] : [];
      placeMenu(e.target.closest('.ce-place'), { title: 'Their jobs run on', current: d.sandbox ? `sandbox:${d.sandbox}` : d.machine, note: 'Their memory and schedule stay on this computer', extra }, (k) => {
        // A sandbox: their project here goes along each time; only Claude Code signs in there so far.
        if (k.startsWith('sandbox:')) {
          const p = S.config.projects?.find((x) => x.path === d.cwd || Object.values(x.copies || {}).includes(d.cwd));
          Object.assign(d, { sandbox: k.slice(8), machine: '', cwd: (p && pathAt(p, '')) || (d.machine ? '' : d.cwd) });
          if (d.agent !== 'claude') Object.assign(d, { agent: 'auto', model: '', effort: '' });
          return paintBar();
        }
        if (k === d.machine && !d.sandbox) return;
        d.sandbox = '';
        d.machine = k;
        if (k && machineById(k)?.state === 'off') connectMachine(k);
        // The project, where it has a checkout there; the harness, if it's installed there.
        const p = S.config.projects?.find((x) => x.path === d.cwd || Object.values(x.copies || {}).includes(d.cwd));
        d.cwd = (p && pathAt(p, k)) || '';
        const pool = harnessesAt([k], { auto: true });
        if (!pool.some((a) => a.id === d.agent && a.available)) Object.assign(d, { agent: 'auto', model: '', effort: '' });
        paintBar();
      });
      return;
    }
    if (e.target.closest('.ce-proj')) {
      projectList(e.target.closest('.ce-proj'), {
        projects: projects().filter((p) => placesOf(p).includes(d.machine)),
        current: S.config.projects?.find((p) => pathAt(p, d.machine) === d.cwd)?.id,
        extras: [{ id: '', icon: 'x', label: 'No project' }],
        label: 'Works in',
        onPick: (pid) => {
          const p = S.config.projects?.find((x) => x.id === pid);
          d.cwd = (p && pathAt(p, d.machine)) || '';
          paintBar();
        },
      });
      return;
    }
    if (e.target.closest('.ce-mode')) {
      const mb = e.target.closest('.ce-mode');
      modeMenu(mb, d.mode, (id) => {
        d.mode = id;
        paintBar();
      }, mb);
      return;
    }
    if (e.target.closest('.ce-team')) {
      teamEditor(e.target.closest('.ce-team'), { lead: d.agent || task?.agent || 'auto', leadModel: d.model, leadEffort: d.effort, team: d.team, places: [d.machine || ''], exclude: member?.id || '' }, (team) => {
        d.team = team;
        paintBar();
      });
      return;
    }
    if (e.target.closest('.ce-runner')) {
      runnerPicker(e.target.closest('.ce-runner'), { agent: d.agent, model: d.model, effort: d.effort, savedModel, savedEffort, places: [d.sandbox ? 'sandbox' : d.machine], auto: true }, (a, mo, ef) => {
        Object.assign(d, { agent: a, model: mo, effort: ef });
        paintBar();
      });
    }
  });
  $f('name').addEventListener('input', () => {
    paintHandle();
  });
  $f('cron').addEventListener('input', () => {
    const said = $f('cron').value.trim();
    d.cron = toCron(said) || said; // words it can't read go as typed: the server says what's wrong
    paintRead();
  });

  f.onsubmit = async (e) => {
    e.preventDefault();
    const body = { name: $f('name').value.trim(), role: $f('role').value.trim(), avatar: d.avatar, color: glowColor(), bg: d.bg, brief: $f('brief').value.trim(), cron: d.cron, on: d.on, parallel: d.parallel, mode: d.mode, team: d.team, ...(task ? {} : { cwd: d.cwd, machine: d.machine, sandbox: d.sandbox, agent: d.agent, model: d.model, effort: d.effort }) };
    if (!body.name) return $f('name').focus();
    if (!locked && body.cron && !toCron(body.cron)) return $f('cron').focus();
    // A spell's member: only where and how they run is yours to change.
    if (locked) for (const k of ['name', 'role', 'avatar', 'color', 'brief', 'cron', 'on', 'mode', 'team']) delete body[k];
    const again = () => crewEditor({ member, task, draft: { ...d, ...body, checkin: $f('checkin')?.checked } });
    close();
    if (editing) {
      if (await patchMember(member, body)) toast(`Saved ${esc(member.name)}`);
      else again();
      return;
    }
    // Optimistic: the row is there at once, and goes (with the dialog back) if the server refuses.
    const temp = { ...body, id: `new-${Date.now()}`, log: [], queue: [], notebook: '', paused: false };
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
  paintTint();
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

// New task with a member picked on the rail (launcher.js): what goes out is `@Ada …`, as the @
// picker writes it, so it takes the same road as a typed one. A typed @Other wins, and a slash
// command isn't a job: null, it goes as typed.
export function pickedPrompt(text, m) {
  const t = String(text || '').trim();
  if (!m || t.startsWith('/') || addressedTo(t).members.length) return null;
  return `@[${m.name.replace(/[\]\n]/g, '')}](crew:${m.id}) ${t}`;
}

// --- @ in a prompt box ---------------------------------------------------------------------------------

// Typing @ and a few letters in any prompt or follow-up box offers the crew, then what's in My Stuff
// (stuff.js); picking one puts it in as a mention (`@[Ada](crew:<id>)` or `@[Logo](stuff:<id>)` in
// what's sent; the box shows @Ada). A message that starts with a member is theirs; a member further
// in lets the task's agent hand them work; a thing from My Stuff hands the agent its file.
let picker = null; // { ta, close, list, act, start }
const NATIVE = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');

// Files for @: the task's folder in its reply box, the project picked in New task. Fetched once a
// minute per place; the picker paints again when they come.
const fileLists = new Map(); // url -> { at, files, p }
function filesFor(ta) {
  const id = ta.closest('.item[data-id]')?.dataset.id;
  const project = ta.id === 'prompt' && launch.picks[''] && launch.picks[''] !== 'none' && launch.where.length === 1 && !launch.where[0] ? launch.picks[''] : null;
  const url = id && S.sessions.get(id)?.agent !== 'wisp' ? `/sessions/${id}/files` : project ? `/files?project=${encodeURIComponent(project)}` : null;
  if (!url) return [];
  const got = fileLists.get(url);
  if (!got || Date.now() - got.at > 60_000) {
    const p = (got?.p && !got.files ? got.p : api(url).then((r) => r.files, () => []))
      .then((files) => {
        fileLists.set(url, { at: Date.now(), files });
        if (picker?.ta === ta || document.activeElement === ta) pickerFor(ta);
      });
    if (!got) fileLists.set(url, { at: Date.now(), files: null, p });
  }
  return got?.files || [];
}
// A path typed after @: its name first, then anywhere in it
function fileMatches(files, q, n) {
  if (!q) return [];
  const hit = (f) => {
    const name = f.slice(f.lastIndexOf('/') + 1).toLowerCase();
    return name.startsWith(q) ? 3 : f.toLowerCase().startsWith(q) ? 2 : f.toLowerCase().includes(q) ? 1 : 0;
  };
  return files.map((f) => [f, hit(f)]).filter(([, h]) => h).sort((a, b) => b[1] - a[1] || a[0].length - b[0].length).slice(0, n).map(([f]) => f);
}

function pickerFor(ta) {
  if (!ta?.mentions) return closePicker();
  const caret = ta.selectionStart;
  if (caret !== ta.selectionEnd) return closePicker();
  const before = NATIVE.get.call(ta).slice(0, caret); // what the box shows, not the stored form
  const m = before.match(/(^|[\s(])@([\p{L}\p{N}._\/-]{0,80})$/u);
  if (!m) return closePicker();
  const q = m[2].toLowerCase();
  const crew = q.includes('/') ? [] : rankCrew(crewList().filter((x) => x.id !== ta.dataset.crew && (!q || x.name.toLowerCase().startsWith(q) || handleOf(x.name).startsWith(q) || x.role?.toLowerCase().includes(q)))).slice(0, 6);
  const stuff = q.includes('/') ? [] : stuffMatches(q, crew.length ? 5 : 8);
  const files = fileMatches(filesFor(ta), q, crew.length || stuff.length ? 5 : 8);
  const list = [...crew.map((m) => ({ kind: 'crew', id: m.id, title: m.name, m })), ...stuff.map((it) => ({ kind: 'stuff', id: it.id, title: cleanTitle(it.title), it })), ...files.map((f) => ({ kind: 'file', id: f, title: f }))];
  if (!list.length) return closePicker();
  const start = caret - m[2].length - 1;
  if (!picker || picker.ta !== ta) {
    closePicker();
    const node = el(`<div class="menu cr-pick" role="listbox" aria-label="Mention"></div>`);
    node.addEventListener('mousedown', (e) => {
      e.preventDefault(); // keep the box focused
      const b = e.target.closest('[data-i]');
      if (b) choose(Number(b.dataset.i));
    });
    picker = { ta, node, close: popover(node, { anchor: ta, back: ta, onClose: () => (picker = null) }), act: 0 };
  }
  Object.assign(picker, { list, start, act: Math.min(picker.act, list.length - 1) });
  const row = (x, i) =>
    x.kind === 'file'
      ? `<button type="button" class="cr-pick-row fl-pick${i === picker.act ? ' act' : ''}" data-i="${i}" role="option"><span class="fl-ic">${icon('file')}</span><span class="cr-main"><b>${esc(x.id.slice(x.id.lastIndexOf('/') + 1))}</b>${x.id.includes('/') ? `<small>${esc(x.id.slice(0, x.id.lastIndexOf('/')))}</small>` : ''}</span></button>`
      : x.kind === 'crew'
      ? `<button type="button" class="cr-pick-row${i === picker.act ? ' act' : ''}" data-i="${i}" role="option">${avatarHtml(x.m, { size: 24, dot: false })}<span class="cr-main"><b>${esc(x.m.name)}</b>${x.m.role ? `<small>${esc(x.m.role)}</small>` : ''}</span></button>`
      : `<button type="button" class="cr-pick-row st-pick${i === picker.act ? ' act' : ''}" data-i="${i}" role="option">${stuffThumbHtml(x.it)}<span class="cr-main"><b>${esc(x.it.title)}</b><small>${esc(stuffSub(x.it))}</small></span></button>`;
  picker.node.innerHTML = [
    crew.length ? `<div class="wm-h">Crew <small>↵ to tag · a message that starts with them is theirs</small></div>${crew.map((x, i) => row(list[i], i)).join('')}` : '',
    stuff.length ? `<div class="wm-h">My Stuff <small>the agent gets the file</small></div>${stuff.map((x, i) => row(list[crew.length + i], crew.length + i)).join('')}` : '',
    files.length ? `<div class="wm-h">Files <small>the agent reads it first</small></div>${files.map((x, i) => row(list[crew.length + stuff.length + i], crew.length + stuff.length + i)).join('')}` : '',
  ].join('');
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
  // A file goes in as its path (@src/a.js), the way the harnesses read a file mention
  if (m.kind !== 'file' && !ta.mentions.some((x) => x.id === m.id)) ta.mentions.push({ id: m.id, title: m.title, kind: m.kind });
  ta.focus();
  ta.setSelectionRange(p.start, ta.selectionStart);
  closePicker();
  if (!document.execCommand('insertText', false, `@${m.title} `)) {
    ta.setRangeText(`@${m.title} `, ta.selectionStart, ta.selectionEnd, 'end');
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
