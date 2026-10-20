import { esc } from '../md.js';
import { api } from '../core/api.js';
import * as bus from '../core/bus.js';
import { $, $$, el, icon } from '../core/dom.js';
import { S, setAgents } from '../core/state.js';
import { popover } from '../ui/popover.js';
import { toast, toastError } from '../ui/toast.js';
import { placeName } from './places.js';
import { AUTO, AUTO_GOALS, effortLabel, effortsFor, harnessesAt, harnessLogo } from './runners.js';
import { openSettings } from './settings.js';
import { copySetupCommand, INSTALLABLE, installHarness, setupCommand, setupDocs, setupTip, setupTitle } from './setup.js';

// One popover for all three choices: harnesses on the left, the focused harness's models on the
// right, and its thinking levels underneath. Clicking (or arrowing to) a harness previews its
// models; picking a model commits harness + model, picking a thinking level commits it in place.
// places: the "Run on" picks, so the list is what's installed there rather than only on this computer.
export function runnerPicker(anchor, { agent, model, effort, savedModel, savedEffort, places, auto = false }, pick) {
  const open = $('.picker');
  if (open) return open.close();
  const agents = places ? harnessesAt(places, { auto }) : auto ? [AUTO, ...S.agents] : S.agents;
  const remote = places?.length > 1 || !!places?.[0];
  const sub = (a) => {
    if (a.id === 'auto') return 'Picks harness and model for you';
    if (!a.available) return remote ? 'Not installed there' : 'Not installed';
    const models = (a.models || []).length > 1 ? `${a.models.length - 1} models` : 'Default model';
    return a.missing?.length ? `Not on ${a.missing.map(placeName).join(', ')}` : models;
  };
  let focusAgent = agents.find((a) => a.id === agent && a.available) ? agent : agents.find((a) => a.available)?.id;

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
            (a) => `<button class="pk-h${a.available ? '' : ' off'}" role="option" data-id="${esc(a.id)}" ${a.available ? '' : `aria-disabled="true" title="${esc(setupTitle(a))}"`}>
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
      </div>
    </div>`);
  const input = $('.pk-search input', node);
  const list = $('.pk-list', node);
  const sideRows = $$('.pk-h', node);
  const seg = $('.pk-effort', node);
  const modelOf = (id) => (id === agent ? model : savedModel(id));
  const effortOf = (id) => (id === agent ? effort : savedEffort(id, modelOf(id)));

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
    if (focusAgent !== agent) markInUse(focusAgent);
    agent = focusAgent;
    model = m;
    effort = e;
    pick(agent, model, effort);
    paintEffort();
    $(`button[data-e="${CSS.escape(e)}"]`, seg)?.focus();
  };

  const paintModels = () => {
    const a = agents.find((x) => x.id === focusAgent);
    sideRows.forEach((b) => b.classList.toggle('on', b.dataset.id === focusAgent));
    const models = a?.models || [{ id: '', label: 'Default' }];
    const current = focusAgent === agent ? model : savedModel(focusAgent);
    input.placeholder = `Search ${a?.name || ''} models`;
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
  };
  // A harness that isn't installed: how to get it, in place of its models.
  const paintSetup = (a) => {
    $('.pk-search', node).hidden = true;
    seg.hidden = true;
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
    pick(agent, model, effort);
  };

  const choose = (m) => {
    close();
    anchor.focus();
    // Carry the thinking level over when the new model accepts it, else fall back to the saved one.
    const cur = effortOf(focusAgent);
    const e = effortsFor(focusAgent, m).includes(cur) ? cur : savedEffort(focusAgent, m);
    if (focusAgent !== agent || m !== model || e !== effort) pick(focusAgent, m, e);
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
    const inSide = sideRows.includes(document.activeElement);
    const segBtns = $$('button', seg);
    const inSeg = segBtns.includes(document.activeElement);
    // Tab hops from the model list to the thinking levels and back; anywhere else it leaves.
    if (e.key === 'Tab' && !seg.hidden && (inSeg ? e.shiftKey : !e.shiftKey && !inSide)) {
      e.preventDefault();
      return inSeg ? focusModels() : (segBtns.find((b) => b.classList.contains('on')) || segBtns[0]).focus();
    }
    if (e.key === 'Tab') return close();
    if (inSeg && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      e.stopPropagation();
      return step(segBtns, e.key === 'ArrowRight' ? 1 : -1);
    }
    if (inSeg && e.key === 'ArrowUp') return e.preventDefault(), focusModels();
    if (inSeg && (e.key === 'Enter' || e.key === ' ')) return e.preventDefault(), chooseEffort(document.activeElement.dataset.e);
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
  };
  input.oninput = filter;
  seg.onclick = (e) => {
    const b = e.target.closest('button[data-e]');
    if (b) chooseEffort(b.dataset.e);
  };

  paintModels();
  const close = popover(node, {
    anchor,
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
