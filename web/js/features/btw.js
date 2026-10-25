// /btw side questions on a card: "/btw did you also update the docs?" in the composer asks without
// interrupting the run, and the answer shows on the turn it was asked during. The server answers
// each one with a read-only run of its own (server/btw.js).

import { fmtDuration } from '../blocks.js';
import { esc, md } from '../md.js';
import { mentionHtml } from '../mention-text.js';
import { api } from '../core/api.js';
import { $, $$, el, icon } from '../core/dom.js';
import { load, S, save } from '../core/state.js';
import { fmtDate, SHORT_TIME } from '../core/format.js';
import { isBtw } from '../slash-text.js';
import { toastError } from '../ui/toast.js';
import { scheduleRefetch } from './feed.js';
import { agentName } from './runners.js';
import { avatarHtml, memberById } from './crew.js';

const waiting = new Map(); // session id -> side questions sent, not yet confirmed by the server
const gone = new Set(); // ids dismissed here, until the server has dropped them too
let seq = 0;

// Optimistic: the question is on the card at once, waiting for its answer. If the server refuses
// it, it comes off again and restore() gives the text back.
export async function askBtw(id, question, { attachments = [], files = [], restore } = {}) {
  const s = S.full.get(id);
  if (!s) return;
  retireTip(); // they know about it now
  const pending = { id: `pending-${++seq}`, question, status: 'running', askedAt: Date.now(), agent: s.agent, attachments: files.filter((f) => f.id).map((f) => ({ id: f.id, name: f.name, mime: f.mime })) };
  const mine = () => waiting.get(id) || [];
  const unwait = () => (mine().length > 1 ? waiting.set(id, mine().filter((b) => b !== pending)) : waiting.delete(id));
  waiting.set(id, [...mine(), pending]);
  paintBtw(id);
  try {
    const entry = await api(`/sessions/${id}/btw`, { method: 'POST', body: { text: question, attachments } });
    unwait();
    // Its node takes the real id, so it stays put instead of animating in a second time.
    const node = $(`.btw[data-id="${pending.id}"]`, S.nodes.get(id)?.card);
    if (node) node.dataset.id = entry.id;
    S.nodes.get(id)?.btwSeen?.add(entry.id);
    const cur = S.full.get(id);
    if (cur && !cur.turns.some((t) => t.btw?.some((b) => b.id === entry.id))) (cur.turns.at(-1).btw ||= []).push(entry);
    paintBtw(id);
  } catch (err) {
    unwait();
    paintBtw(id);
    restore?.();
    toastError(err);
  }
}

// Reply in a crew thread: a box under the last message; your reply joins the thread at once and
// the member's answer fills in under it. Off again, with the text back, if the server refuses.
document.addEventListener('click', (e) => {
  const b = e.target.closest?.('.btw-reply[data-reply]');
  if (!b) return;
  const node = b.closest('.btw');
  if ($('.btw-replyform', node)) return $('.btw-replyform input', node).focus();
  const m = memberById(S.full.get(b.closest('.item')?.dataset.id)?.turns.flatMap((t) => t.btw || []).find((x) => x.id === b.dataset.reply)?.crew?.id);
  const f = el(`<form class="btw-replyform"><input class="input sm" placeholder="Reply to ${esc(m?.name || 'them')}…" autocomplete="off" spellcheck="false"><button class="primary sm">Send</button><button type="button" class="link xs" data-cancel>Cancel</button></form>`);
  b.closest('.btw-foot').after(f);
  $('input', f).focus();
  $('[data-cancel]', f).onclick = () => {
    f.remove();
  };
  f.onsubmit = (ev) => {
    ev.preventDefault();
    const text = $('input', f).value.trim();
    if (!text) return;
    f.remove();
    replyCrew(b.closest('.item').dataset.id, b.dataset.reply, text);
  };
});

async function replyCrew(id, entryId, text) {
  const s = S.full.get(id);
  const turn = s?.turns.find((t) => t.btw?.some((b) => b.id === entryId));
  const parent = turn?.btw.find((b) => b.id === entryId);
  if (!parent) return;
  const pend = { id: `pending-${++seq}`, question: text, status: 'running', askedAt: Date.now(), crew: parent.crew, job: parent.job, thread: parent.thread || parent.id };
  turn.btw.splice(turn.btw.indexOf(parent) + 1, 0, pend);
  paintBtw(id);
  try {
    const entry = await api(`/sessions/${id}/crew-reply`, { method: 'POST', body: { entry: entryId, text } });
    const node = $(`.btw[data-id="${pend.id}"]`, S.nodes.get(id)?.card);
    if (node) node.dataset.id = entry.id;
    S.nodes.get(id)?.btwSeen?.add(entry.id);
    const cur = S.full.get(id)?.turns.find((t) => t.id === turn.id) || turn;
    cur.btw = (cur.btw || []).map((b) => (b === pend ? entry : b)).filter((b, i, a) => a.findIndex((x) => x.id === b.id) === i);
    paintBtw(id);
  } catch (err) {
    turn.btw = turn.btw.filter((b) => b !== pend);
    paintBtw(id);
    toastError(err);
  }
}

// "@Ada what do you make of this?" in a follow-up: the message goes to Ada (server/crew.js), and
// her answer lands on the card like a side answer. Optimistic, like askBtw: on the card at once,
// off again (with the text back) if the server refuses.
export async function askCrew(id, text, members, rest, { attachments = [], restore } = {}) {
  const s = S.full.get(id);
  const turn = s?.turns.at(-1);
  if (!turn) return;
  const pend = members.map((m) => ({ id: `pending-${++seq}`, question: rest, status: 'running', askedAt: Date.now(), crew: { id: m.id, name: m.name, avatar: m.avatar, color: m.color } }));
  (turn.btw ||= []).push(...pend);
  paintBtw(id);
  try {
    const r = await api(`/sessions/${id}/reply`, { method: 'POST', body: { text, attachments } });
    const cur = S.full.get(id)?.turns.find((t) => t.id === turn.id) || turn;
    cur.btw = (cur.btw || []).filter((b) => !pend.includes(b));
    (r.crew || []).forEach((e, i) => {
      // Its node takes the real id, so it stays put instead of animating in a second time.
      const node = pend[i] && $(`.btw[data-id="${pend[i].id}"]`, S.nodes.get(id)?.card);
      if (node) node.dataset.id = e.id;
      S.nodes.get(id)?.btwSeen?.add(e.id);
      if (!cur.btw.some((b) => b.id === e.id)) cur.btw.push(e);
    });
    paintBtw(id);
  } catch (err) {
    turn.btw = (turn.btw || []).filter((b) => !pend.includes(b));
    paintBtw(id);
    restore?.();
    toastError(err);
  }
}

// The tip in a working panel, so /btw gets found: until it's been used once, or hidden with its ×.
// Clicking it starts a /btw in the box below.
const TIP = 'wisp.btwTipDone';
export function btwTip(id) {
  const s = S.full.get(id);
  if (load(TIP, false) || !s || s.agent === 'wisp' || s.ask) return null;
  const node = el(`
    <span class="w-tip">
      <button class="w-tip-go" title="Ask ${esc(agentName(s.agent))} something on the side. It keeps working, and the answer shows on this card"><span class="w-tip-k">Tip</span><code>/btw</code><span class="w-tip-t">asks without interrupting</span></button>
      <button class="w-tip-x" title="Hide this tip" aria-label="Hide this tip">${icon('x')}</button>
    </span>`);
  $('.w-tip-go', node).onclick = () => {
    const ta = $('.reply', S.nodes.get(id)?.card);
    if (!ta) return;
    if (!isBtw(ta.value)) ta.value = `/btw ${ta.value.trim()}`; // a draft already there becomes the question
    ta.dispatchEvent(new Event('input'));
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  };
  $('.w-tip-x', node).onclick = retireTip;
  return node;
}

function retireTip() {
  save(TIP, true);
  $$('.w-tip').forEach((n) => n.remove());
}

// Dismissing one that's still being answered stops its run. Gone at once; back if that fails.
async function dismissBtw(id, btwId) {
  gone.add(btwId);
  paintBtw(id);
  try {
    await api(`/sessions/${id}/btw?item=${encodeURIComponent(btwId)}`, { method: 'DELETE' });
    for (const t of S.full.get(id)?.turns || []) if (t.btw) t.btw = t.btw.filter((b) => b.id !== btwId);
  } catch (err) {
    toastError(err);
    scheduleRefetch(id);
  }
  gone.delete(btwId);
  paintBtw(id);
}

// Fill each open turn's side-question list, keeping the nodes that haven't changed: only a newly
// asked one animates in, and an answer fades in where its "answering" line was.
export function paintBtw(id) {
  const s = S.full.get(id);
  const n = S.nodes.get(id);
  if (!s || !n?.turnNodes) return;
  const first = !n.btwSeen; // what's already there when the card opens doesn't animate
  n.btwSeen ||= new Set();
  const latest = s.turns.at(-1)?.id;
  for (const t of s.turns) {
    const list = n.turnNodes.get(t.id)?.node.querySelector(':scope > .btw-list');
    if (!list) continue;
    const items = [...(t.btw || []), ...(t.id === latest ? waiting.get(id) || [] : [])].filter((b) => !gone.has(b.id));
    const ids = new Set(items.map((b) => b.id));
    for (const c of [...list.children]) if (!ids.has(c.dataset.id)) c.remove();
    items.forEach((b, i) => {
      // The last message of a crew thread offers Reply; the one before it stops when yours lands.
      const last = !!b.crew && (items[i + 1]?.thread || '') !== (b.thread || b.id);
      const key = `${b.status}|${b.job || ''}|${b.queued ? 1 : 0}|${last ? 1 : 0}|${b.answer || b.error || ''}`;
      let node = [...list.children].find((c) => c.dataset.id === b.id);
      if (!node || node.dataset.key !== key) {
        if (node?.querySelector('.btw-replyform input')?.value) return; // a reply being typed stays
        const next = item(s, b, last);
        next.dataset.key = key;
        if (!node && !first && !n.btwSeen.has(b.id)) next.classList.add('new');
        if (node?.dataset.key.startsWith('running|') && b.status !== 'running') next.classList.add('landed');
        const x = $('.btw-x', next);
        if (x)
          x.onclick = () => {
            dismissBtw(id, b.id);
          };
        if (node) node.replaceWith(next);
        node = next;
      }
      n.btwSeen.add(b.id);
      if (list.children[i] !== node) list.insertBefore(node, list.children[i] || null);
    });
  }
}

// A crew member's answer to an @mention (server/crew.js): its face and name instead of "btw",
// and a link to the job it ran as.
// A thread with a member reads as one conversation: its first message has the member's tag and the
// close button; the ones after it (your replies, entry.thread) sit under it. The last one, once
// answered, offers Reply: the same job carries on, so the member remembers the thread.
function crewItem(b, last) {
  const m = memberById(b.crew.id) || { ...b.crew, log: [] };
  const job = b.job && S.sessions.has(b.job) ? `<a class="link xs btw-job" href="#/s/${esc(b.job)}">Open ${esc(m.name)}’s job</a>` : '';
  const reply = last && b.status !== 'running' && b.job && memberById(b.crew.id) ? `<button class="link xs btw-reply" data-reply="${esc(b.id)}">${icon('enter')}Reply to ${esc(m.name)}</button>` : '';
  const body =
    b.status === 'running'
      ? `<div class="btw-wait"><span class="btw-dots"><i></i><i></i><i></i></span>${esc(m.name)} ${b.queued ? 'will start on it when a job finishes' : 'is on it · this task carries on'}<span class="elapsed" data-start="${b.askedAt}">${fmtDuration(Date.now() - b.askedAt)}</span>${job}</div>`
      : b.status === 'error'
        ? `<div class="btw-err">${icon('warn')}<span>${esc(b.error || 'No answer.')}</span>${job}</div>`
        : `<div class="btw-a prose">${md(b.answer || '')}</div>`;
  const foot = b.status === 'running' ? '' : reply || job ? `<div class="btw-foot">${reply}${job}</div>` : '';
  const tag = b.thread ? `<span class="btw-tag you">You</span>` : `<span class="btw-tag crew" title="${esc(`You asked ${m.name}, ${fmtDate(b.askedAt, SHORT_TIME)}`)}">${avatarHtml(m, { size: 18, dot: false, state: b.status === 'running' ? 'live' : 'idle' })}${esc(m.name)}</span>`;
  return el(`
    <div class="btw crew st-${b.status}${b.thread ? ' thread' : ''}${last ? ' last' : ''}" data-id="${esc(b.id)}">
      <div class="btw-q">${tag}<span class="btw-text">${mentionHtml(esc(b.question), { link: false })}</span></div>
      ${body}
      ${foot}
      ${b.thread ? '' : `<button class="icon-btn btw-x" title="Dismiss">${icon('x')}</button>`}
    </div>`);
}

function item(s, b, last) {
  if (b.crew) return crewItem(b, last);
  const who = agentName(b.agent || s.agent);
  const at = fmtDate(b.askedAt, SHORT_TIME);
  const how = b.status !== 'done' ? '' : b.forked ? 'on a copy of the conversation' : 'from wisp’s record of the task';
  const tip = [`Side question, asked ${at}`, b.answeredAt && `answered in ${fmtDuration(b.answeredAt - b.askedAt)}`, how].filter(Boolean).join(' · ');
  const body =
    b.status === 'running'
      ? `<div class="btw-wait"><span class="btw-dots"><i></i><i></i><i></i></span>${esc(who)} is answering on the side · the run carries on<span class="elapsed" data-start="${b.askedAt}">${fmtDuration(Date.now() - b.askedAt)}</span></div>`
      : b.status === 'error'
        ? `<div class="btw-err">${icon('warn')}<span>${esc(b.error || 'No answer.')}</span></div>`
        : `<div class="btw-a prose">${md(b.answer || '')}</div>`;
  return el(`
    <div class="btw st-${b.status}" data-id="${esc(b.id)}">
      <div class="btw-q"><span class="btw-tag" title="${esc(tip)}">${icon('ask')}btw</span><span class="btw-text">${mentionHtml(esc(b.question), { link: false })}</span></div>
      ${b.attachments?.length ? `<div class="btw-atts">${b.attachments.map((a) => `<span class="att-pill">${icon('file')}${esc(a.name)}</span>`).join('')}</div>` : ''}
      ${body}
      <button class="icon-btn btw-x" title="${b.status === 'running' ? 'Cancel this side question' : 'Dismiss'}">${icon('x')}</button>
    </div>`);
}
