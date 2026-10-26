// Accounts in Settings → Agents: more than one subscription per harness (Claude, Codex). Each row
// is one account (initial, label, email · plan · kind, its state only when it isn't ready); ⋯
// renames, makes it a work or personal account, reorders, signs out or removes it. Adding one opens
// a small box by its button (name, Personal / Work, the notice about whose accounts these may be),
// then shows its sign-in (link + code) right under its row. wisp never moves a task to another
// account by itself (design/accounts.md, Hitting a limit). Every change shows at once and goes back
// with a red toast if the server refuses; the server then broadcasts 'agents'.

import { esc } from '../md.js';
import { api } from '../core/api.js';
import { $, $$, el, icon } from '../core/dom.js';
import { inGrid, S } from '../core/state.js';
import { ask } from '../ui/confirm.js';
import { popover } from '../ui/popover.js';
import { toast, toastError } from '../ui/toast.js';
import { accKey, loginControl, loginPanel, loginState, refreshAgents } from './agent-login.js';
import { accountMark, limitUntil } from './runners.js';

// What "Add another … account" calls the harness: the subscription, not the CLI.
const BRAND = { claude: 'Claude', codex: 'Codex' };
const KIND = { personal: 'Personal', work: 'Work' };
export const kindLabel = (k) => KIND[k] || '';
const renaming = new Map(); // harness -> account id whose label is being edited

const path = (id, acc = '') => `/agents/${id}/accounts${acc ? `/${encodeURIComponent(acc)}` : ''}`;
// Put a list in place at once (optimistic) and repaint every list that shows it.
const setList = (a, accounts) => {
  a.accounts = accounts;
  bus?.();
};
let bus = null;

// The count for the harness's small line: "· 2 accounts", only once there's a choice.
export const accountCount = (a) => (a.accounts?.length > 1 ? `${a.accounts.length} accounts` : '');
// The harness row keeps its own Sign in / Signed in control only while it has one account.
export const manyAccounts = (a) => a.accounts?.length > 1;

export function accountsHtml(a) {
  if (!a.accounts || !(a.available || a.signedIn === false)) return '';
  const many = manyAccounts(a);
  const rows = many
    ? a.accounts
        .map((x, i) => {
          const state = loginState(a.id, '', x.id).signedIn === true && x.state === 'signedOut' ? 'ready' : x.state;
          const line = [x.email, x.plan, kindLabel(x.kind)].filter(Boolean).join(' · ');
          const name =
            renaming.get(a.id) === x.id
              ? `<form class="sx-acct-form" data-acc-rename="${esc(x.id)}"><input class="input" name="label" value="${esc(x.label)}" maxlength="40" aria-label="Account name" autocomplete="off" spellcheck="false"></form>`
              : `<b>${esc(x.label)}</b>`;
          return `<div class="sx-acct" data-acc-row data-acc="${esc(x.id)}">
            ${accountMark(x, 'acc-i lg')}
            <span class="sx-acct-text">${name}${line ? `<small>${esc(line)}</small>` : ''}</span>
            ${state === 'limit' ? `<span class="sx-state warn" title="${esc(x.why || '')}">${icon('clock')}At its limit${x.until ? ` until ${esc(limitUntil(x))}` : ''}</span>` : state === 'signedOut' ? '<span class="sx-state warn"><i class="dot warn"></i>Signed out</span>' : ''}
            ${loginControl(a.id, '', accKey(x.id))}
            <button class="icon-btn sx-acct-more" data-acc-more data-i="${i}" aria-haspopup="menu" aria-label="More for ${esc(x.label)}" title="More for ${esc(x.label)}">${icon('dots')}</button>
          </div>${accKey(x.id) || many ? loginPanel(a.id, '', x.id) : ''}`;
        })
        .join('')
    : '';
  const brand = BRAND[a.id] || a.name;
  const add = `<button class="sx-acct sx-acct-add" data-acc-add aria-haspopup="dialog">${icon('plus')}<span>Add another ${esc(brand)} account</span></button>`;
  return `<div class="sx-accts${many ? ' many' : ''}" data-accts="${esc(a.id)}">${rows}${add}</div>`;
}

// On wisp Grid, once at the top of Settings → Agents: a login is one person's.
export const gridAccountsNote = () => (inGrid() ? `<p class="sx-acct-grid">${icon('user')}<span>Sign in with your own account. Each person on this wisp signs in for themselves; a login can’t be shared.</span></p>` : '');

// Add another account: the small box by its button (as ask() is), with the notice the providers'
// terms call for above Sign in. Resolves { label, kind }, or null for Cancel, Escape or a click away.
function addBox(a, anchor) {
  const brand = BRAND[a.id] || a.name;
  return new Promise((resolve) => {
    let kind = 'personal';
    let answer = null;
    const node = el(`<div class="menu ask-pop acc-add" role="dialog" aria-label="Add another ${esc(brand)} account">
      <form>
        <p class="ap-q">Add another ${esc(brand)} account</p>
        <label class="aa-f"><span>Name</span><input class="input" name="label" maxlength="40" placeholder="Like Personal (optional)" autocomplete="off" spellcheck="false"></label>
        <div class="aa-f"><span id="aaKind">Kind</span><div class="pk-seg aa-kind" role="radiogroup" aria-labelledby="aaKind">${Object.entries(KIND)
          .map(([k, l]) => `<button type="button" role="radio" data-k="${k}" aria-checked="${k === kind}" class="${k === kind ? 'on' : ''}">${l}</button>`)
          .join('')}</div></div>
        <div class="aa-notice">
          <p><b>Only add accounts that are yours.</b> Each account must belong to you: your own plan, or a seat your employer gave you. Sharing a login with someone else is against Anthropic’s and OpenAI’s terms and can get the account closed.</p>
          <p>Each account keeps its own usage limits. wisp doesn’t combine them, and it won’t switch accounts to get around a limit: when one runs out, it asks you first. Before you use a work account on personal projects, or the other way round, check your employer’s rules.</p>
        </div>
        <div class="ap-acts"><button type="button" class="ghost sm" data-a="no">Cancel</button><button type="submit" class="primary sm">${icon('lock')}Sign in</button></div>
      </form>
    </div>`);
    const f = $('form', node);
    const close = popover(node, { anchor, capture: true, onClose: () => resolve(answer) });
    const seg = $$('.aa-kind button', node);
    const pickKind = (k) => {
      kind = k;
      for (const b of seg) (b.classList.toggle('on', b.dataset.k === k), b.setAttribute('aria-checked', b.dataset.k === k));
    };
    node.addEventListener('click', (e) => {
      const b = e.target.closest('.aa-kind button');
      if (b) pickKind(b.dataset.k);
      if (e.target.closest('[data-a="no"]')) (close(), anchor.focus());
    });
    // Arrows move the choice, as in the other segmented controls.
    $('.aa-kind', node).addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const next = seg[(seg.findIndex((b) => b.dataset.k === kind) + 1) % seg.length];
      pickKind(next.dataset.k);
      next.focus();
    });
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      answer = { label: f.label.value.trim(), kind };
      close();
    });
    const r = anchor.getBoundingClientRect();
    const w = node.offsetWidth;
    const h = node.offsetHeight;
    node.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
    node.style.top = `${Math.max(8, r.bottom + 6 + h < innerHeight - 8 ? r.bottom + 6 : r.top - 6 - h)}px`;
    f.label.focus();
  });
}

// Clicks and forms for every account list in box. paint() repaints the lists from S.agents.
export function wireAccounts(box, paint, logins) {
  bus = () => box.isConnected && paint();
  const agentOf = (n) => S.agents.find((a) => a.id === n.closest('[data-accts]')?.dataset.accts);
  const focusIn = (sel) => requestAnimationFrame(() => $(sel, box)?.focus());

  box.addEventListener('click', (e) => {
    const t = e.target;
    const a = t.closest('[data-accts]') && agentOf(t);
    if (!a) return;
    const addBtn = t.closest('[data-acc-add]');
    if (addBtn) {
      if ($('.menu.acc-add')) return $('.menu.acc-add').close();
      addBox(a, addBtn).then((v) => v && add(a, v));
      return;
    }
    const more = t.closest('[data-acc-more]');
    if (more) moreMenu(a, Number(more.dataset.i), more);
  });
  box.addEventListener('keydown', (e) => {
    const f = e.target.closest('[data-acc-rename]');
    if (!f || e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation(); // not Settings: just this box
    renaming.delete(agentOf(f).id);
    paint();
  });
  // Clicking away from a rename keeps what was typed, as Enter does.
  box.addEventListener('focusout', (e) => {
    const f = e.target.closest('[data-acc-rename]');
    if (f && !f.contains(e.relatedTarget)) f.requestSubmit();
  });
  box.addEventListener('submit', async (e) => {
    const f = e.target.closest('[data-acc-rename]');
    if (!f) return;
    e.preventDefault();
    const a = agentOf(f);
    if (renaming.get(a.id) !== f.dataset.accRename) return; // Enter, then the blur it causes
    rename(a, f.dataset.accRename, f.label.value.trim(), f.contains(document.activeElement)); // Enter: focus back on its ⋯
  });

  // At once: a row stands in for the account until it exists, and its sign-in follows under it.
  async function add(a, { label, kind }) {
    const before = a.accounts;
    const temp = { id: `new-${Date.now()}`, label: label || 'New account', email: '', plan: '', kind, state: 'signedOut', until: null, why: '' };
    setList(a, [...before, temp]);
    try {
      const r = await api(path(a.id), { method: 'POST', body: { label, kind } });
      setList(a, r.accounts);
      // Its sign-in, right under its row: the link to open and the code.
      if (r.login) logins.start('', a.id, r.account.id, { state: 'running', url: '', code: '', ...r.login });
      focusIn(`[data-accts="${CSS.escape(a.id)}"] [data-acc="${CSS.escape(r.account.id)}"] + [data-login-panel] a, [data-accts="${CSS.escape(a.id)}"] [data-acc="${CSS.escape(r.account.id)}"] + [data-login-panel] input`);
    } catch (err) {
      setList(a, before);
      toastError(err);
    }
  }

  async function rename(a, id, label, back) {
    renaming.delete(a.id);
    const before = a.accounts;
    const was = before.find((x) => x.id === id);
    if (label && label !== was?.label) setList(a, before.map((x) => (x.id === id ? { ...x, label } : x)));
    else paint();
    if (back) $(`[data-accts="${CSS.escape(a.id)}"] [data-acc="${CSS.escape(id)}"] [data-acc-more]`, box)?.focus();
    if (!label || label === was?.label) return;
    try {
      setList(a, (await api(path(a.id, id), { method: 'PATCH', body: { label } })).accounts);
    } catch (err) {
      setList(a, before);
      toastError(err);
    }
  }

  async function setKind(a, x, kind) {
    const before = a.accounts;
    setList(a, before.map((y) => (y.id === x.id ? { ...y, kind } : y)));
    try {
      setList(a, (await api(path(a.id, x.id), { method: 'PATCH', body: { kind } })).accounts);
    } catch (err) {
      setList(a, before);
      toastError(err);
    }
  }

  async function move(a, i, d) {
    const before = a.accounts;
    const list = [...before];
    [list[i], list[i + d]] = [list[i + d], list[i]];
    setList(a, list);
    try {
      setList(a, (await api(path(a.id, before[i].id), { method: 'PATCH', body: { move: d < 0 ? 'up' : 'down' } })).accounts);
    } catch (err) {
      setList(a, before);
      toastError(err);
    }
  }

  async function signOut(a, x) {
    const before = a.accounts;
    setList(a, before.map((y) => (y.id === x.id ? { ...y, state: 'signedOut' } : y)));
    try {
      await api(`/agents/${a.id}/logout${accKey(x.id) ? `?account=${encodeURIComponent(accKey(x.id))}` : ''}`, { method: 'POST', body: {} });
      toast(`Signed out of <b>${esc(x.label)}</b>`);
      refreshAgents();
    } catch (err) {
      setList(a, before);
      toastError(err);
    }
  }

  async function remove(a, x, anchor) {
    const sure = await ask(`Remove ${x.label}?\n\nwisp signs it out and forgets it. Tasks that ran on it keep their history.`, { ok: 'Remove account', danger: true, anchor });
    if (!sure) return;
    const before = a.accounts;
    setList(a, before.filter((y) => y.id !== x.id));
    try {
      setList(a, (await api(path(a.id, x.id), { method: 'DELETE' })).accounts);
      toast(`Removed <b>${esc(x.label)}</b>`);
      refreshAgents();
    } catch (err) {
      setList(a, before);
      toastError(err);
    }
  }

  // ⋯: Rename, Make it a work / personal account, Move up, Move down, Sign out, Remove. Items that can't apply stay, disabled, so
  // the menu has the same shape on every row.
  function moreMenu(a, i, anchor) {
    const open = $('.menu.acc-menu');
    if (open) return open.close();
    const x = a.accounts[i];
    const last = a.accounts.length - 1;
    const out = x.state === 'signedOut';
    const menu = el(`<div class="menu acc-menu" role="menu" aria-label="${esc(x.label)}">
      <button role="menuitem" data-a="rename">${icon('pen')}Rename</button>
      <button role="menuitem" data-a="kind">${icon('user')}${x.kind === 'work' ? 'Make it a personal account' : 'Make it a work account'}</button>
      <button role="menuitem" data-a="up" ${i === 0 ? 'disabled' : ''}>${icon('arrow', 'mv-up')}Move up</button>
      <button role="menuitem" data-a="down" ${i === last ? 'disabled' : ''}>${icon('arrow', 'mv-down')}Move down</button>
      <button role="menuitem" data-a="out" ${out ? 'disabled' : ''}>${icon('lock')}Sign out</button>
      <button role="menuitem" class="danger" data-a="remove" ${x.id === 'default' ? 'disabled title="The account the CLI signs in with on its own stays; sign it out instead"' : ''}>${icon('trash')}Remove</button>
    </div>`);
    menu.onclick = (e) => {
      const b = e.target.closest('button[data-a]');
      if (!b || b.disabled) return;
      close();
      const k = b.dataset.a;
      if (k === 'rename') {
        renaming.set(a.id, x.id);
        paint();
        const input = $(`[data-accts="${CSS.escape(a.id)}"] [data-acc-rename] input`, box);
        input?.focus();
        input?.select();
      }
      if (k === 'up' || k === 'down') {
        move(a, i, k === 'up' ? -1 : 1);
        $(`[data-accts="${CSS.escape(a.id)}"] [data-acc="${CSS.escape(x.id)}"] [data-acc-more]`, box)?.focus();
      }
      if (k === 'kind') {
        setKind(a, x, x.kind === 'work' ? 'personal' : 'work');
        $(`[data-accts="${CSS.escape(a.id)}"] [data-acc="${CSS.escape(x.id)}"] [data-acc-more]`, box)?.focus();
      }
      if (k === 'out') signOut(a, x);
      if (k === 'remove') remove(a, x, anchor);
    };
    menu.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const items = [...menu.querySelectorAll('button:not([disabled])')];
      const j = items.indexOf(document.activeElement);
      items[(j + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
    });
    const close = popover(menu, { anchor });
    const r = anchor.getBoundingClientRect();
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    menu.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`;
    menu.style.top = `${Math.max(8, r.bottom + 6 + h > innerHeight ? r.top - h - 6 : r.bottom + 6)}px`;
    $('button:not([disabled])', menu)?.focus();
  }
}
