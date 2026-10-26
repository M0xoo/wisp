import { esc } from '../md.js';
import { api } from '../core/api.js';
import * as bus from '../core/bus.js';
import { $, $$, el, icon } from '../core/dom.js';
import { S, setAgents } from '../core/state.js';
import { popover } from '../ui/popover.js';
import { toast, toastError } from '../ui/toast.js';
import { placeName } from './places.js';
import { accountMark, AUTO, AUTO_GOALS, effortLabel, effortsFor, harnessesAt, harnessLogo, limitLine, savedAccount as rememberedAccount } from './runners.js';
import { openSettings } from './settings.js';
import { copySetupCommand, INSTALLABLE, installHarness, setupCommand, setupDocs, setupTip, setupTitle } from './setup.js';
import { CAN, loginControl, loginPanel, wireLogins } from './agent-login.js';

const ACCOUNT = { claude: 'Claude', codex: 'ChatGPT', cursor: 'Cursor', grok: 'xAI' };

// One popover for all the choices: harnesses on the left, the focused harness's models on the
// right, its thinking levels underneath and, when it has two or more, its accounts under those.
// Clicking (or arrowing to) a harness previews its models; picking a model commits harness +
// model, picking a thinking level or an account commits it in place. pick(agent, model, effort, account).
// places: the "Run on" picks, so the list is what's installed there rather than only on this computer.
// back: the prompt it's for, where the caret goes once it closes.
export function runnerPicker(anchor, { agent, model, effort, account = '', savedModel, savedEffort, savedAccount = rememberedAccount, places, auto = false, back }, pick) {
  const open = $('.picker');
  if (open) return open.close(), back?.focus();
  const agents = places ? harnessesAt(places, { auto }) : auto ? [AUTO, ...S.agents] : S.agents;
  const remote = places?.length > 1 || !!places?.[0];
  const sub = (a) => {
    if (a.id === 'auto') return 'Picks harness and model for you';
    if (!a.available && signedOut(a)) return remote ? 'Signed out there' : 'Signed out';
    if (!a.available) return remote ? 'Not installed there' : 'Not installed';
    const models = (a.models || []).length > 1 ? `${a.models.length - 1} models` : 'Default model';
    return a.missing?.length ? `Not on ${a.missing.map(placeName).join(', ')}` : models;
  };
  let focusAgent = agents.find((a) => a.id === agent && a.available) ? agent : agents.find((a) => a.available)?.id;
  // Where a harness that isn't available is signed out (and wisp can sign it in): '' here, or a machine.
  function signedOut(a) {
    return CAN.has(a.id) && a.signedOut?.length ? { scope: a.signedOut[0] } : null;
  }

  const r = anchor.getBoundingClientRect();
  const width = Math.min(580, innerWidth - 24);
  // Stay inside the launcher card when there's room, else inside the window.
  const box = anchor.closest('.launcher')?.getBoundingClientRect();
  const right = Math.min(innerWidth - 12, box && box.width >= width ? box.right : innerWidth - 12);
  const left = Math.max(12, Math.min(r.left, right - width));
  const below = r.bottom + 440 < innerHeight;
  const node = el(`
    <div class="picker" role="dialog" aria-label="Harness, model and thinking level" style="left:${left}px;width:${width}px;${below ? `top:${r.bottom + 6}px` : `bottom:${innerHeight - r.top + 6}px`}">
      <div class="pk-side" role="listbox" aria-label="Harness">
        <div class="pk-head">Harness</div>
        ${agents
          .map(
            (a) => `<button class="pk-h${a.available ? '' : ' off'}" role="option" data-id="${esc(a.id)}" ${a.available ? '' : signedOut(a) ? 'title="Signed out: sign in to use it"' : `aria-disabled="true" title="${esc(setupTitle(a))}"`}>
              <span class="pk-logo">${harnessLogo(a.id)}</span>
              <span class="pk-text"><b>${esc(a.name)}</b><small${a.missing?.length ? ' class="warn"' : ''}>${esc(sub(a))}</small></span>
              ${a.id === agent ? '<span class="pk-dot" title="In use"></span>' : ''}
            </button>`,
          )
          .join('')}
      </div>
      <div class="pk-main">
        <label class="field pk-search">${icon('search')}<input spellcheck="false" autocomplete="off"></label>
        <div class="pk-list" role="listbox" aria-label="Model"></div>
        <div class="pk-effort" role="radiogroup" aria-label="Thinking level"></div>
        <div class="pk-effort pk-acct" role="radiogroup" aria-label="Account" hidden></div>
      </div>
    </div>`);
  const input = $('.pk-search input', node);
  const list = $('.pk-list', node);
  const sideRows = $$('.pk-h', node);
  const seg = $('.pk-effort', node);
  const acctSeg = $('.pk-acct', node);
  const modelOf = (id) => (id === agent ? model : savedModel(id));
  const effortOf = (id) => (id === agent ? effort : savedEffort(id, modelOf(id)));
  const accountOf = (id) => (id === agent ? account : savedAccount(id));
  // The accounts of the place it runs on (a machine has its own), only when there are two or more.
  const accountsAt = (id) => {
    const a = agents.find((x) => x.id === id);
    return a?.available && a.accounts?.length > 1 ? a.accounts : [];
  };

  // Auto first (your saved account; one already at its limit is skipped when you start a task, never
  // mid-run), then each account in your order.
  // State is never in the initial: a clock on the segment and one line under the row.
  const paintAccounts = () => {
    const list = accountsAt(focusAgent);
    const current = accountOf(focusAgent);
    acctSeg.hidden = !list.length;
    if (!list.length) return (acctSeg.innerHTML = '');
    const part = (id, inner, { on, off, tip, cls = '' }) =>
      `<button role="radio" aria-checked="${on}" class="${on ? 'on' : ''}${off ? ' off' : ''}${cls}" data-acc="${esc(id)}" title="${esc(tip)}"${off ? ' aria-disabled="true"' : ''}>${inner}</button>`;
    const notes = list.filter((x) => x.state === 'limit' || x.state === 'signedOut').map((x) => `${x.label} is ${x.state === 'limit' ? limitLine(x) : 'signed out'}.`);
    acctSeg.innerHTML = `<span class="pk-ehead">Account</span><span class="pk-seg">${part('', 'Auto', { on: !current, tip: 'Your saved account; one already at its limit is skipped when you start a task' })}${list
      .map((x) =>
        part(x.id, `${accountMark(x)}<span>${esc(x.label)}</span>${x.state === 'limit' ? icon('clock', 'acc-clock') : ''}`, {
          on: x.id === current,
          off: x.state === 'signedOut',
          cls: ' acc',
          tip: [x.email, x.plan].filter(Boolean).join(' · ') + (x.state === 'signedOut' ? '\nSigned out: sign in from Settings → Agents' : x.state === 'limit' ? `\n${x.label} is ${limitLine(x)}` : ''),
        }),
      )
      .join('')}</span>${notes.length ? `<p class="pk-anote">${esc(notes.join(' '))}</p>` : ''}`;
  };

  const paintEffort = () => {
    const levels = effortsFor(focusAgent, modelOf(focusAgent));
    const current = effortOf(focusAgent);
    seg.hidden = !levels.length;
    seg.innerHTML = `<span class="pk-ehead">Thinking</span><span class="pk-seg">${['', ...levels]
      .map((e) => `<button role="radio" aria-checked="${e === current}" class="${e === current ? 'on' : ''}" data-e="${esc(e)}" title="${e ? `${esc(effortLabel(e))} reasoning effort` : 'Whatever the harness is set to'}">${esc(e ? effortLabel(e) : 'Default')}</button>`)
      .join('')}</span>`;
  };
  const markInUse = (id) => {
    $$('.pk-dot', node).forEach((d) => d.remove());
    sideRows.find((b) => b.dataset.id === id)?.insertAdjacentHTML('beforeend', '<span class="pk-dot" title="In use"></span>');
  };
  const chooseEffort = (e) => {
    const m = modelOf(focusAgent);
    if (focusAgent === agent && e === effort) return;
    if (focusAgent !== agent) (markInUse(focusAgent), (account = savedAccount(focusAgent)));
    agent = focusAgent;
    model = m;
    effort = e;
    pick(agent, model, effort, account);
    paintEffort();
    $(`button[data-e="${CSS.escape(e)}"]`, seg)?.focus();
  };
  // Like a thinking level: commits in place, the picker stays open.
  const chooseAccount = (id) => {
    if (accountsAt(focusAgent).find((x) => x.id === id)?.state === 'signedOut') return;
    if (focusAgent === agent && id === account) return;
    if (focusAgent !== agent) {
      markInUse(focusAgent);
      model = modelOf(focusAgent);
      effort = effortOf(focusAgent);
    }
    agent = focusAgent;
    account = id;
    pick(agent, model, effort, account);
    paintAccounts();
    $(`button[data-acc="${CSS.escape(id)}"]`, acctSeg)?.focus();
  };

  const paintModels = () => {
    const a = agents.find((x) => x.id === focusAgent);
    sideRows.forEach((b) => b.classList.toggle('on', b.dataset.id === focusAgent));
    const models = a?.models || [{ id: '', label: 'Default' }];
    const current = focusAgent === agent ? model : savedModel(focusAgent);
    input.placeholder = `Search ${a?.name || ''} models`;
    if (a && !a.available && signedOut(a)) return paintSignIn(a);
    if (a && !a.available) return paintSetup(a);
    if (a?.id === 'auto') {
      list.innerHTML = `<div class="pk-group"><div class="pk-ghead">Goal</div>${AUTO_GOALS.map((g) => `<button class="pk-m${g.id === current ? ' on' : ''}" role="option" aria-selected="${g.id === current}" data-id="${g.id}"><span class="pk-text"><b>${g.label}</b><small>${g.hint}</small></span>${icon('check', 'pk-check')}</button>`).join('')}</div><p class="pk-note">wisp picks the harness and model for each task from what worked before, and learns from how it went. ${'<a href="#" class="pk-auto-more">How Auto picks</a>'}</p><div class="pk-empty" hidden>No models match</div>`;
      $('.pk-search', node).hidden = true;
      $('.pk-auto-more', list).onclick = (e) => {
        e.preventDefault();
        close();
        openSettings({ pane: 'auto' });
      };
      paintEffort();
      paintAccounts();
      return;
    }
    $('.pk-search', node).hidden = models.length <= 6;
    // opencode-style ids (provider/model) group by provider.
    const groups = new Map();
    for (const m of models) {
      const g = m.id && m.id.includes('/') ? m.hint || '' : '';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(m);
    }
    list.innerHTML = [...groups]
      .map(
        ([g, ms]) =>
          `<div class="pk-group">${g ? `<div class="pk-ghead">${esc(g)}</div>` : ''}${ms
            .map(
              (m) => `<button class="pk-m${m.id === current ? ' on' : ''}" role="option" aria-selected="${m.id === current}" data-id="${esc(m.id)}">
                <span class="pk-text"><b>${esc(m.id ? m.label : 'Default')}</b><small>${esc(m.id ? (m.hint && m.hint !== g ? m.hint : '') : m.hint || `Whatever ${a?.name} is set to`)}</small></span>${icon('check', 'pk-check')}
              </button>`,
            )
            .join('')}</div>`,
      )
      .join('') + '<div class="pk-empty" hidden>No models match</div>';
    filter();
    paintEffort();
    paintAccounts();
  };
  // A harness that's installed but signed out: sign it in right here (its own login, on the
  // computer it runs on), then use it.
  const paintSignIn = (a) => {
    $('.pk-search', node).hidden = true;
    seg.hidden = acctSeg.hidden = true;
    const { scope } = signedOut(a);
    list.innerHTML = `<div class="pk-setup pk-signin">
      <b>${esc(a.name)} is signed out${scope ? ` on ${esc(placeName(scope))}` : ''}</b>
      <p>Sign in with your ${esc(ACCOUNT[a.id] || a.name)} account: a link and a code, no terminal.${scope ? ' The login stays on that computer.' : ''}</p>
      <div class="pk-setup-actions">${loginControl(a.id, scope)}<button class="primary sm pk-use" hidden>Use ${esc(a.name)}</button></div>
      ${loginPanel(a.id, scope)}
    </div>`;
  };
  // A harness that isn't installed: how to get it, in place of its models.
  const paintSetup = (a) => {
    $('.pk-search', node).hidden = true;
    seg.hidden = acctSeg.hidden = true;
    const canInstall = !remote && INSTALLABLE.has(a.id);
    list.innerHTML = `<div class="pk-setup">
      <b>${esc(a.name)} isn’t installed${remote ? ' there' : ''}</b>
      <p>${esc(setupTip(a))}</p>
      ${a.setup?.command && !canInstall ? setupCommand(a.setup.command) : ''}
      <div class="pk-setup-actions">
        ${canInstall ? `<button class="primary sm pk-install">Install ${esc(a.name)}</button>` : ''}
        ${setupDocs(a)}
        <button class="ghost sm pk-recheck" title="Look for harnesses again">${icon('replay')}<span>Re-check</span></button>
      </div>
    </div>`;
    const c = $('.setup-cmd', list);
    if (c) c.onclick = () => {
      copySetupCommand(c);
    };
    const inst = $('.pk-install', list);
    if (inst) inst.onclick = () => {
      close();
      installHarness(a.id);
    };
    $('.pk-recheck', list).onclick = async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.classList.add('busy');
      try {
        setAgents(await api('/agents/recheck', { method: 'POST', body: {} }));
        $('#launcher')?.placesChanged?.();
        bus.emit('agents');
        const found = S.agents.find((x) => x.id === a.id)?.available;
        if (found) {
          close();
          toast(`<b>${esc(a.name)}</b> found`);
        } else if (node.isConnected) toast(`Still no ${esc(a.name)}. Install it, sign in, then re-check.`);
      } catch (err) {
        toastError(err);
      } finally {
        btn.disabled = false;
        btn.classList.remove('busy');
      }
    };
  };
  const rows = () => $$('.pk-m', list).filter((b) => !b.hidden);
  const filter = () => {
    const q = input.value.trim().toLowerCase();
    for (const b of $$('.pk-m', list)) b.hidden = !!q && !`${b.dataset.id} ${b.textContent}`.toLowerCase().includes(q);
    for (const g of $$('.pk-group', list)) g.hidden = !$$('.pk-m', g).some((b) => !b.hidden);
    $('.pk-empty', list).hidden = rows().length > 0;
  };
  const focusModels = () => {
    const rs = rows();
    const target = rs.find((b) => b.classList.contains('on')) || rs[0];
    target?.focus();
    target?.scrollIntoView({ block: 'nearest' });
  };
  const preview = (id, { focus } = {}) => {
    if (id !== focusAgent) {
      focusAgent = id;
      input.value = '';
      paintModels();
    }
    if (focus) sideRows.find((b) => b.dataset.id === id)?.focus();
  };

  // Picking a harness applies it straight away with the model and level it shows as selected.
  const useAgent = (id) => {
    preview(id);
    if (id === agent || !agents.find((x) => x.id === id)?.available) return;
    markInUse(id);
    agent = id;
    model = savedModel(id);
    effort = savedEffort(id, model);
    account = savedAccount(id);
    pick(agent, model, effort, account);
    paintAccounts();
  };

  const choose = (m) => {
    close();
    (back || anchor).focus();
    // Carry the thinking level over when the new model accepts it, else fall back to the saved one.
    const cur = effortOf(focusAgent);
    const e = effortsFor(focusAgent, m).includes(cur) ? cur : savedEffort(focusAgent, m);
    if (focusAgent !== agent || m !== model || e !== effort) pick(focusAgent, m, e, accountOf(focusAgent));
  };
  const step = (items, d) => {
    if (!items.length) return;
    const i = items.indexOf(document.activeElement);
    const next = items[i < 0 ? (d > 0 ? 0 : items.length - 1) : (i + d + items.length) % items.length];
    next.focus();
    next.scrollIntoView({ block: 'nearest' });
    return next;
  };
  const keys = (e) => {
    if (document.activeElement?.closest?.('.sx-login')) return; // pasting a sign-in code
    const inSide = sideRows.includes(document.activeElement);
    // The rows under the models (thinking levels, accounts), top to bottom.
    const groups = [seg, acctSeg].filter((g) => !g.hidden).map((g) => $$('.pk-seg button', g));
    const gi = groups.findIndex((g) => g.includes(document.activeElement));
    const inSeg = gi >= 0;
    const segBtns = groups[gi] || [];
    const enter = (g) => (g.find((b) => b.classList.contains('on')) || g[0]).focus();
    const up = () => (gi > 0 ? enter(groups[gi - 1]) : focusModels());
    // Tab hops from the model list down through those rows and back; anywhere else it leaves.
    if (e.key === 'Tab' && groups.length && !inSide && (inSeg ? e.shiftKey || gi < groups.length - 1 : !e.shiftKey)) {
      e.preventDefault();
      return !inSeg ? enter(groups[0]) : e.shiftKey ? up() : enter(groups[gi + 1]);
    }
    if (e.key === 'Tab') return close();
    if (inSeg && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      e.stopPropagation();
      return step(segBtns, e.key === 'ArrowRight' ? 1 : -1);
    }
    if (inSeg && e.key === 'ArrowUp') return e.preventDefault(), up();
    if (inSeg && e.key === 'ArrowDown') return e.preventDefault(), gi < groups.length - 1 && enter(groups[gi + 1]);
    if (inSeg && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      const b = document.activeElement;
      return b.dataset.acc !== undefined ? chooseAccount(b.dataset.acc) : chooseEffort(b.dataset.e);
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      const d = e.key === 'ArrowDown' ? 1 : -1;
      if (inSide) preview(step(sideRows, d)?.dataset.id); // not-installed ones too: they show how to get them
      else step(rows(), d);
    } else if (e.key === 'ArrowLeft' && document.activeElement !== input) {
      e.preventDefault();
      preview(focusAgent, { focus: true });
    } else if ((e.key === 'ArrowRight' || e.key === 'Enter') && inSide) {
      e.preventDefault();
      if (e.key === 'Enter') useAgent(focusAgent);
      focusModels();
    } else if (e.key === 'Enter' && document.activeElement === input && rows()[0]) {
      e.preventDefault();
      choose(rows()[0].dataset.id);
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !$('.pk-search', node).hidden && document.activeElement !== input) {
      input.focus(); // type-to-search from anywhere in the picker
    }
  };
  sideRows.forEach((b) => (b.onclick = () => useAgent(b.dataset.id)));
  list.onclick = (e) => {
    const b = e.target.closest('.pk-m');
    if (b) choose(b.dataset.id);
    // Signed in from here: use it, with the model and level it had last time.
    if (e.target.closest('.pk-use')) {
      const id = focusAgent;
      close();
      (back || anchor).focus();
      const m = savedModel(id);
      pick(id, m, savedEffort(id, m), savedAccount(id));
    }
  };
  // Sign-ins started from the picker: the harnesses signed out here or on the Run on machine.
  wireLogins(node, () => agents.filter(signedOut).map((a) => [signedOut(a).scope, [a.id]]));
  bus.on(
    'agent-login-state',
    (v) => {
      const a = agents.find((x) => x.id === v.id);
      if (!a || focusAgent !== v.id || signedOut(a)?.scope !== v.scope) return;
      const use = $('.pk-use', list);
      if (use) use.hidden = v.signedIn !== true;
      if (v.signedIn === true) {
        a.available = true; // it's usable now, even before the harness list is looked up again
        const row = sideRows.find((r) => r.dataset.id === v.id);
        row?.classList.remove('off');
        if (row) $('small', row).textContent = sub(a);
        const head = $('.pk-signin > b', list);
        if (head) head.textContent = `Signed in to ${a.name}${v.scope ? ` on ${placeName(v.scope)}` : ''}`;
      }
    },
    { node },
  );
  input.oninput = filter;
  seg.onclick = (e) => {
    const b = e.target.closest('button[data-e]');
    if (b) chooseEffort(b.dataset.e);
  };
  acctSeg.onclick = (e) => {
    const b = e.target.closest('button[data-acc]');
    if (b) chooseAccount(b.dataset.acc);
  };

  paintModels();
  const close = popover(node, {
    anchor,
    back,
    onClose: () => {
      anchor.classList.remove('open');
      document.removeEventListener('keydown', keys, true);
    },
  });
  document.addEventListener('keydown', keys, true);
  anchor.classList.add('open');
  focusModels(); // scrolls the current model into view…
  if (!$('.pk-search', node).hidden) input.focus({ preventScroll: true }); // …then search is ready to type
}
