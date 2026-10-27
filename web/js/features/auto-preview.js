// What Auto will run, shown in the launcher before you send: harness logo and a short label on the
// harness pill, live as you type. Its popover says why, what else Auto weighed and what it would
// suggest, and lets you correct it: run another pick instead (Auto learns from that), or never
// pick that model for this kind of task.

import { esc } from '../md.js';
import { api } from '../core/api.js';
import { $, $$, el, icon } from '../core/dom.js';
import { S } from '../core/state.js';
import { popover } from '../ui/popover.js';
import { toast, toastError } from '../ui/toast.js';
import { agentName, AUTO_GOALS, harnessLogo } from './runners.js';
import { openSettings } from './settings.js';

// The last answer, kept across launcher re-renders so a fresh paint shows it at once.
let last = null; // { sig, r }
const DEBOUNCE = 300;

const TYPE_WORD = { ui: 'UI' };
export const typeWord = (t) => TYPE_WORD[t] || t;
// "Claude Code · Opus 4.7 · Medium" → "Opus 4.7 · Medium": the logo already says the harness.
const shortLabel = (p) => (p.model ? p.label.split(' · ').slice(1).join(' · ') : p.label);
// The model alone, no level: what a Never rule acts on.
const modelLabel = (p) => (p.model ? p.label.split(' · ')[1] || p.model : `${agentName(p.agent)}’s default model`);
const pct = (x) => `${Math.round(x * 100)}%`;
const usd = (x) => (x ? `~$${x.toFixed(2)}` : '');
export const neverRule = (p, type) => `${p.agent}:${p.model || ''}@${type}`; // 'codex:' is its default model

// btn: the preview button on the harness pill. read() says what to preview:
// { on, prompt, attachments, goal, team, machine }. pick(choice, shown) runs another pick instead.
export function autoPreview(btn, { read, pick, back }) {
  let timer = 0;
  let seq = 0;
  let loading = false;
  const sigOf = (q) => JSON.stringify([q.prompt.trim(), q.attachments, q.goal, q.team, q.machine]);
  const paint = () => {
    const q = read();
    btn.hidden = !q.on;
    if (!q.on) return;
    const r = last?.r;
    btn.classList.toggle('loading', loading && !!r);
    btn.setAttribute('aria-busy', loading ? 'true' : 'false');
    if (!r) {
      // The very first answer: a placeholder with the real shape.
      btn.classList.add('first');
      btn.innerHTML = '<span class="rb-logo"><i class="sk"></i></span><span class="sk apv-sk"></span>';
      btn.title = 'Working out what Auto will run';
      btn.setAttribute('aria-label', btn.title);
      return;
    }
    btn.classList.remove('first');
    const html = r.pick ? `<span class="rb-logo">${harnessLogo(r.pick.agent)}</span><span class="apv-l">${esc(shortLabel(r.pick))}</span>` : `<span class="rb-logo">${icon('warn')}</span><span class="apv-l">Nothing to run</span>`;
    if (btn.dataset.h !== html) (btn.innerHTML = html), (btn.dataset.h = html);
    btn.title = r.pick ? `Auto will run ${r.pick.label}: ${r.why}` : r.why;
    btn.setAttribute('aria-label', btn.title);
  };
  const fetchNow = async () => {
    const q = read();
    if (!q.on) return paint();
    const sig = sigOf(q);
    if (last?.sig === sig) return paint();
    const mine = ++seq;
    loading = true;
    paint();
    try {
      const r = await api('/router/preview', { method: 'POST', body: { prompt: q.prompt, attachments: q.attachments, goal: q.goal, team: q.team, machine: q.machine } });
      if (mine !== seq) return;
      last = { sig, r };
    } catch {
      if (mine !== seq) return;
      // Offline or refused: the last answer stays; with none, say so instead of pulsing forever.
      if (!last) last = { sig: '', r: { pick: null, why: 'Couldn’t ask Auto right now' } };
    }
    loading = false;
    paint();
    $('.auto-pop')?.repaint?.();
  };
  // Typing waits for a pause; a goal, place or team change asks at once.
  const refresh = ({ now = false } = {}) => {
    clearTimeout(timer);
    if (!read().on) return paint();
    if (now || !last) return fetchNow();
    timer = setTimeout(fetchNow, DEBOUNCE);
  };
  btn.onclick = () => openPop(btn, { read, pick, back, forget: () => (last = last && { ...last, sig: '' }), refresh });
  paint();
  refresh({ now: true });
  return {
    refresh,
    paint,
    // What's on screen now (for autoPin and autoOverride), or null.
    shown: () => (read().on && last?.r?.pick ? last.r : null),
  };
}

function openPop(anchor, { read, pick, back, forget, refresh }) {
  const open = $('.auto-pop');
  if (open) return open.close(), back?.focus();
  const node = el('<div class="menu auto-pop" role="dialog" aria-label="What Auto will run"></div>');
  const paint = () => {
    const r = last?.r;
    if (!r?.pick) {
      node.innerHTML = `<div class="ap-head"><span class="rb-logo">${icon('warn')}</span><div class="ap-title"><b>Nothing to run</b><small>${esc(r?.why || 'Auto is still looking')}</small></div></div>
        <div class="ap-sep"></div><button data-a="how">${icon('settings')}How Auto picks</button>`;
      return;
    }
    const p = r.pick;
    // "High thinking for Balanced" is already in the title and the line under it.
    const why = (r.why || '').split(' · ').filter((x) => !/ thinking for /.test(x)).join(' · ');
    const goal = AUTO_GOALS.find((g) => g.id === r.goal)?.label || 'Balanced';
    // The why may already give the chance ("87% expected from public benchmarks"): once is enough.
    const facts = [!/\d%/.test(why) && `<b>${pct(r.chance)}</b> likely to work`, usd(r.usd), r.minutes && `~${Math.round(r.minutes)} min`].filter(Boolean);
    const sug = r.suggest && r.suggest.key !== p.key ? r.suggest : null;
    const alts = (r.alternatives || []).filter((a) => a.key !== sug?.key).slice(0, 4);
    const row = (a, sug = false) =>
      `<button class="${sug ? 'ap-sug' : 'ap-alt'}" data-key="${esc(a.key)}"><span class="rb-logo">${harnessLogo(a.agent)}</span><span class="ap-text"><b>${sug ? 'Try ' : ''}${esc(shortLabel(a))}</b><small>${esc(sug ? a.why || agentName(a.agent) : agentName(a.agent))}</small></span><span class="ap-n">${pct(a.chance)}</span><span class="ap-n">${usd(a.usd)}</span></button>`;
    node.innerHTML = `
      <div class="ap-head"><span class="rb-logo">${harnessLogo(p.agent)}</span><div class="ap-title"><b>${esc(shortLabel(p))}</b><small>${esc(agentName(p.agent))} · ${esc(goal)}</small></div></div>
      <p class="ap-why">${esc(why ? why.charAt(0).toUpperCase() + why.slice(1) : '')}</p>
      ${facts.length ? `<div class="ap-facts">${facts.map((f) => `<span>${f}</span>`).join('')}</div>` : ''}
      ${sug ? `<div class="ap-h">Worth a try</div>${row(sug, true)}` : ''}
      ${alts.length ? `<div class="ap-h">Or run</div>${alts.map((a) => row(a)).join('')}` : ''}
      <div class="ap-sep"></div>
      <button data-a="never">${icon('x')}<span>Never pick ${esc(modelLabel(p))} for ${esc(typeWord(r.type))} tasks</span></button>
      <button data-a="how">${icon('settings')}How Auto picks</button>`;
  };
  node.repaint = () => {
    paint();
    place();
  };
  node.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const r = last?.r;
    if (b.dataset.a === 'how') {
      close();
      openSettings({ pane: 'auto' });
      return;
    }
    if (b.dataset.a === 'never') {
      close();
      never(r, { forget, refresh });
      back?.focus();
      return;
    }
    const key = b.dataset.key;
    const choice = key && [r.suggest, ...(r.alternatives || [])].find((a) => a?.key === key);
    if (!choice) return;
    close();
    pick(choice, r);
    back?.focus();
  };
  node.addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
    ev.preventDefault();
    const items = $$('button', node);
    const i = items.indexOf(document.activeElement);
    items[(i + (ev.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  });
  const place = () => {
    const a = anchor.getBoundingClientRect();
    const w = node.offsetWidth;
    const h = node.offsetHeight;
    node.style.left = `${Math.max(8, Math.min(a.left, innerWidth - w - 8))}px`;
    node.style.top = `${a.bottom + 6 + h < innerHeight - 8 ? a.bottom + 6 : Math.max(8, a.top - 6 - h)}px`;
  };
  paint();
  const close = popover(node, { anchor, back, onClose: () => anchor.classList.remove('open') });
  anchor.classList.add('open');
  place();
  $('button', node)?.focus();
}

// Never pick this model for this kind of task: kept at once, undone from the toast, rolled back
// if the server refuses.
async function never(r, { forget, refresh }) {
  if (!r?.pick) return;
  const rule = neverRule(r.pick, r.type);
  const router = (S.config.defaults.router ||= {});
  const before = [...(router.blocked || [])];
  if (before.includes(rule)) return;
  const set = async (list) => {
    router.blocked = list;
    forget();
    await api('/router', { method: 'PATCH', body: { blocked: list } });
    refresh({ now: true });
  };
  const words = `${esc(modelLabel(r.pick))} for ${esc(typeWord(r.type))} tasks`;
  try {
    const p = set([...before, rule]);
    toast(`Auto won’t pick ${words}`, {
      action: {
        label: 'Undo',
        run: () => {
          set(before).catch((err) => {
            router.blocked = [...before, rule];
            toastError(err);
          });
        },
      },
    });
    await p;
  } catch (err) {
    router.blocked = before;
    toastError(err);
    refresh({ now: true });
  }
}
