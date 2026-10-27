// Auto: what the router (server/router.js) learned about which harness, model and thinking level work for you.

import { esc } from '../md.js';
import { api } from '../core/api.js';
import * as bus from '../core/bus.js';
import { $, $$, el, icon } from '../core/dom.js';
import { S } from '../core/state.js';
import { fmtDate, SHORT_TIME } from '../core/format.js';
import { present } from '../ui/overlay.js';
import { toast, toastError } from '../ui/toast.js';
import { AUTO_GOALS, harnessLogo } from './runners.js';
import { ask } from '../ui/confirm.js';
import { typeWord } from './auto-preview.js';

const ARM_STATE = { ready: ['Ready', 'ok'], new: ['Trying out', 'warn'], untried: ['No data yet', ''], cooling: ['At its limit', 'warn'], gone: ['Not installed', 'bad'] };
const TIER = { 1: 'small', 2: 'everyday', 3: 'frontier' };
const untilLabel = (t) => fmtDate(t, SHORT_TIME);
// Never / Prefer act on a model at every level: 'claude:opus'. A rule with '@kind' is for one kind
// of task (Never pick … for UI tasks, from the launcher's preview) and is listed under the table.
const modelRule = (a) => `${a.agent}:${a.model || ''}`; // 'codex:' is its default model
const coversModel = (rule, a) => !rule.includes('@') && (rule === modelRule(a) || rule.startsWith(`${modelRule(a)}:`));
// The model's name without its level: "Claude Code · Opus 5.5 · High" → "Opus 5.5".
const modelName = (a) => (a.model ? a.label.split(' · ')[1] || a.model : `${a.label.split(' · ')[0]}’s default model`);
export async function openRouter({ host } = {}) {
  const node = el(`<div class="modal router-modal">
      <header><h2>Auto</h2><button class="icon-btn close">${icon('x')}</button></header>
      <div class="ro-body"><div class="it-loading"><span class="orb tiny"></span>Loading…</div></div>
    </div>`);
  const close = present(node, host);
  const pctOf = (x) => `${Math.round(x * 100)}%`;
  const outcome = (r) => (r === null ? '<span class="dim">waiting</span>' : r >= 0.9 ? '<span class="ok">worked</span>' : r >= 0.5 ? '<span>finished</span>' : r >= 0.25 ? '<span class="warn">partly</span>' : '<span class="bad">didn’t work</span>');
  const render = async () => {
    const r = await api('/router').catch((err) => (toastError(err), null));
    if (!r || !node.isConnected) return;
    const arms = r.arms.filter((a) => a.state !== 'gone' || a.n);
    const set = { blocked: [...(r.settings.blocked || [])], prefer: [...(r.settings.prefer || [])] };
    const sources = Object.entries(r.priors.sources || {});
    const srcNames = (ids) => ids.map((id) => r.priors.sources?.[id]?.name).filter(Boolean).join('\n');
    // Where a row's number comes from: your own runs once there are a few, else the benchmarks.
    const srcMark = (a) =>
      a.n >= 3 ? '<i class="ro-src mine">your tasks</i>' : a.prior ? `<i class="ro-src" title="${esc(srcNames(a.from))}">public benchmarks</i>` : a.inherited ? `<i class="ro-src" title="${esc(srcNames(a.from))}">its family’s benchmarks</i>` : '';
    const ruleBtns = (a) => {
      const never = set.blocked.some((x) => coversModel(x, a));
      const pref = set.prefer.some((x) => coversModel(x, a));
      const name = esc(modelName(a));
      return `<span class="ro-rule"><button class="chip-tog${never ? ' on' : ''}" data-rule="blocked" data-key="${esc(a.key)}" aria-pressed="${never}" title="Never pick ${name}, at any level">Never</button><button class="chip-tog${pref ? ' on' : ''}" data-rule="prefer" data-key="${esc(a.key)}" aria-pressed="${pref}" title="Prefer ${name} when it’s close, at any level">Prefer</button></span>`;
    };
    const paintRules = () => {
      for (const b of $$('.ro-rule button', node)) {
        const a = arms.find((x) => x.key === b.dataset.key);
        const on = set[b.dataset.rule].some((x) => coversModel(x, a));
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', on);
      }
      const kinds = set.blocked.filter((x) => x.includes('@'));
      const box = $('.ro-kinds', node);
      box.hidden = !kinds.length;
      box.innerHTML = kinds
        .map((x) => {
          const [what, kind] = x.split('@');
          const a = arms.find((y) => modelRule(y) === what || y.agent === what);
          return `<span class="ro-kind">Never ${esc(a ? (what.includes(':') ? modelName(a) : a.label.split(' · ')[0]) : what)} for ${esc(typeWord(kind))} tasks<button class="att-x" data-drop="${esc(x)}" aria-label="Allow it again" title="Allow it again">${icon('x')}</button></span>`;
        })
        .join('');
    };
    $('.ro-body', node).innerHTML = `
      <p class="hint">For each task Auto weighs every harness · model · thinking level. It starts from public benchmarks, then learns from what you pick yourself and how your runs go: merged PRs, thumbs up or down, rollbacks, follow-ups. Balanced runs each model at its makers’ default level or one step up, Best thinks high, Cheap thinks low. A better model that isn’t your habit shows up as a suggestion in the launcher; Auto doesn’t run it on its own.</p>
      ${sources.length ? `<h5 class="ro-sub">Where the starting numbers come from</h5><ul class="ro-sources">${sources.map(([, x]) => `<li><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.name)}</a><small>${esc(fmtDate(new Date(x.date).getTime(), { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }))}</small></li>`).join('')}</ul>` : ''}
      <h4>Harness · model · thinking</h4>
      <div class="ro-scroll"><table class="us-table ro-table"><thead><tr><th></th><th>Works</th><th title="Tasks you launched on it yourself">Your picks</th><th title="Auto’s runs of it that it learned from">Your tasks</th><th>~Cost</th><th class="ro-time">~Time</th><th></th><th></th></tr></thead><tbody>${arms
        .map((a) => {
          const [state, tone] = ARM_STATE[a.state] || ARM_STATE.ready;
          const types = Object.entries(a.byType).map(([t, x]) => `${typeWord(t)} ${pctOf(x.chance)} (${x.n})`).join(' · ');
          const sub = [srcMark(a), types && esc(types)].filter(Boolean).join(' · ');
          return `<tr><td><span class="us-runner"><span class="model-logo">${harnessLogo(a.agent)}</span>${esc(a.label)}<i class="ro-tier t${a.tier}" title="${TIER[a.tier]} tier">${TIER[a.tier]}</i></span>${sub ? `<small class="ro-types">${sub}</small>` : ''}</td>${a.state === 'untried' ? `<td>—</td><td>${a.picks || '—'}</td><td>—</td><td>—</td><td class="ro-time">—</td>` : `<td><b>${pctOf(a.chance)}</b></td><td>${a.picks || '—'}</td><td>${a.n || '—'}</td><td>${a.usd ? `$${a.usd.toFixed(2)}` : '$0'}</td><td class="ro-time">${a.minutes}m</td>`}<td><span class="sx-state ${tone}" ${a.coolingUntil ? `title="${esc(`${a.coolingWhy || 'At its limit'} · back around ${untilLabel(a.coolingUntil)}`)}"` : ''}><i class="dot ${tone}"></i>${state}${a.coolingUntil ? ` until ${untilLabel(a.coolingUntil)}` : ''}</span></td><td>${ruleBtns(a)}</td></tr>`;
        })
        .join('')}</tbody></table></div>
      <div class="ro-kinds" hidden></div>
      <h4>Tests per project</h4>
      <p class="hint">What wisp runs to check an Auto task. Leave it empty to use what wisp found, or type <code>off</code> to skip the check in that project.</p>
      ${r.projects?.length
        ? `<div class="ro-tests">${r.projects
            .map((p) => `<label class="ro-test"><span class="us-proj c-${esc(p.color || 'slate')}"><i class="p-dot"></i>${esc(p.name)}</span><input class="input mono" data-id="${esc(p.id)}" value="${esc(p.testCommand)}" placeholder="${esc(p.detected?.command || (p.detected?.skip ? `none: ${p.detected.skip}` : 'none found'))}" spellcheck="false"></label>`)
            .join('')}</div>`
        : '<p class="mem-empty">Add a project to set its test command.</p>'}
      <h4>Recent picks</h4>
      ${r.recent.length
        ? `<ul class="ro-recent">${r.recent
            .map((x) => {
              const s = S.sessions.get(x.id);
              return `<li><span class="model-logo">${harnessLogo(x.key.split(':')[0])}</span><span class="ro-title">${esc(s?.title || 'Task')}</span><small>${esc(x.label)} · ${esc(x.type)}${x.trying ? ' · trying' : x.explored ? ' · exploring' : ''}</small>${outcome(x.r)}</li>`;
            })
            .join('')}</ul>`
        : '<p class="mem-empty">Nothing yet. Launch with Auto and its picks show up here.</p>'}
      <div class="ro-foot"><button class="ghost sm danger" id="roReset">Forget what Auto learned</button><span class="hint">The benchmark starting point stays.</span></div>`;
    paintRules();
    // Never / Prefer: on at once, both lists sent whole, put back with a toast if the server refuses.
    // The two exclude each other for a model.
    const save = async (before) => {
      try {
        await api('/router', { method: 'PATCH', body: { blocked: set.blocked, prefer: set.prefer } });
        Object.assign((S.config.defaults.router ||= {}), { blocked: [...set.blocked], prefer: [...set.prefer] });
      } catch (err) {
        Object.assign(set, before);
        paintRules();
        toastError(err);
      }
    };
    $('.ro-table', node).onclick = (e) => {
      const b = e.target.closest('.ro-rule button');
      if (!b) return;
      const a = arms.find((x) => x.key === b.dataset.key);
      const before = { blocked: [...set.blocked], prefer: [...set.prefer] };
      const k = b.dataset.rule;
      const other = k === 'blocked' ? 'prefer' : 'blocked';
      const on = !set[k].some((x) => coversModel(x, a));
      set[k] = set[k].filter((x) => !coversModel(x, a));
      if (on) {
        set[k].push(modelRule(a));
        set[other] = set[other].filter((x) => !coversModel(x, a));
      }
      paintRules();
      save(before);
    };
    $('.ro-kinds', node).onclick = (e) => {
      const x = e.target.closest('[data-drop]')?.dataset.drop;
      if (!x) return;
      const before = { blocked: [...set.blocked], prefer: [...set.prefer] };
      set.blocked = set.blocked.filter((y) => y !== x);
      paintRules();
      save(before);
    };
    for (const input of $$('.ro-test input', node)) {
      let saved = input.value;
      const save = async () => {
        const v = input.value.trim();
        if (v === saved) return;
        const prev = saved;
        saved = v;
        try {
          await api(`/projects/${input.dataset.id}`, { method: 'PATCH', body: { testCommand: v } });
          toast(v ? `Auto will check with <code>${esc(v)}</code>` : 'Back to the test command wisp finds');
        } catch (err) {
          saved = input.value = prev;
          toastError(err);
        }
      };
      input.onblur = () => {
        save();
      };
      input.onkeydown = (e) => {
        if (e.key === 'Enter') input.blur();
      };
    }
    $('#roReset', node).onclick = async () => {
      if (!(await ask('Forget what Auto learned from your tasks?', { ok: 'Forget it all', danger: true, anchor: $('#roReset', node) }))) return;
      await api('/router/reset', { method: 'POST', body: {} }).catch(toastError);
      render();
    };
  };
  bus.on('router', render, { node });
  render();
  return close;
}
