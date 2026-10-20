// /btw side questions on a card: "/btw did you also update the docs?" in the composer asks without
// interrupting the run, and the answer shows on the turn it was asked during. The server answers
// each one with a read-only run of its own (server/btw.js).

import { fmtDuration } from '../blocks.js';
import { esc, md } from '../md.js';
import { mentionHtml } from '../mention-text.js';
import { api } from '../core/api.js';
import { $, $$, el, icon } from '../core/dom.js';
import { load, S, save } from '../core/state.js';
import { isBtw } from '../slash-text.js';
import { toastError } from '../ui/toast.js';
import { scheduleRefetch } from './feed.js';
import { agentName } from './runners.js';

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
      const key = `${b.status}|${b.answer || b.error || ''}`;
      let node = [...list.children].find((c) => c.dataset.id === b.id);
      if (!node || node.dataset.key !== key) {
        const next = item(s, b);
        next.dataset.key = key;
        if (!node && !first && !n.btwSeen.has(b.id)) next.classList.add('new');
        if (node?.dataset.key.startsWith('running|') && b.status !== 'running') next.classList.add('landed');
        $('.btw-x', next).onclick = () => {
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

function item(s, b) {
  const who = agentName(b.agent || s.agent);
  const at = new Date(b.askedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
