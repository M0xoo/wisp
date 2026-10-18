// Subagents: a team the lead can delegate to, any harness, model and thinking level per member, plus
// the user's "use it for" note. Picked in the launcher, saved as presets, shown on cards and turns.

import { fmtDuration, renderPresentation } from '../blocks.js';
import { esc } from '../md.js';
import { api } from '../core/api.js';
import { $, $$, el, icon } from '../core/dom.js';
import { STATUS_LABEL } from '../core/format.js';
import { S } from '../core/state.js';
import { popover } from '../ui/popover.js';
import { toast, toastError, tryApi } from '../ui/toast.js';
import { draftInto } from './composer.js';
import { scheduleRefetch } from './feed.js';
import { runnerPicker } from './runner-picker.js';
import { agentById, agentName, effortLabel, harnessesAt, harnessLogo, paintRunnerBtn, savedEffort, savedModel } from './runners.js';
import { ctxFor } from './turns.js';

const MAX_TEAM = 6; // rows
const MAX_COPIES = 5; // parallel copies of one row
const MAX_INSTANCES = 12; // copies across the team
export const copiesOf = (m) => Math.max(1, m.count || 1);
export const teamSize = (team) => team.reduce((n, m) => n + copiesOf(m), 0);
export const canLead = (id) => agentById(id)?.delegates !== false;
export const memberLabel = (m) => {
  const a = agentById(m.agent);
  const model = (m.model && a?.models?.find((x) => x.id === m.model)?.label) || m.model || 'Default model';
  return `${a?.name || agentName(m.agent)} · ${model}${m.effort ? ` · ${effortLabel(m.effort)}` : ''}`;
};
const slugName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);

// Same rule as the server: blank names become the harness id, repeats get -2, -3…
function uniqueNames(members) {
  const taken = new Set();
  return members.map((m) => {
    const base = slugName(m.name) || m.agent;
    let name = base;
    for (let i = 2; taken.has(name); i++) name = `${base}-${i}`;
    taken.add(name);
    return { ...m, name };
  });
}

// The lead's logo with its subagents' tucked behind it; they fan out on hover. A member that
// is working pulses; one the lead never used is dimmed.
export function teamStack(lead, team) {
  const shown = team.slice(0, 4);
  const tip = `${agentName(lead)} with ${team.map((m) => `${m.name}${m.busy ? ' (working)' : m.used === false ? ' (unused)' : ''}`).join(', ')}`;
  return `<span class="team-stack" data-tip="${esc(tip)}" aria-label="${esc(tip)}" tabindex="0">
    <span class="ts-l">${harnessLogo(lead)}</span>
    ${shown.map((m, i) => `<span class="ts-m${m.used === false ? ' idle' : ''}${m.busy ? ' busy' : ''}" style="--i:${i}">${harnessLogo(m.agent)}</span>`).join('')}
    ${team.length > shown.length ? `<span class="ts-m ts-more" style="--i:${shown.length}">+${team.length - shown.length}</span>` : ''}
  </span>`;
}

// Launcher button: a stack of the members' logos and the preset's name, or just "Subagents".
export function paintTeamBtn(btn, team, presetId, lead) {
  const ok = canLead(lead);
  const flat = team.flatMap((m) => Array(copiesOf(m)).fill(m));
  const n = flat.length;
  const p = (S.config.teams || []).find((x) => x.id === presetId);
  btn.classList.toggle('on', team.length > 0 && ok);
  btn.classList.toggle('off', team.length > 0 && !ok);
  btn.innerHTML = team.length
    ? `<span class="tb-stack">${flat.slice(0, 5).map((m, i) => `<span class="ts-m" style="--i:${i}">${harnessLogo(m.agent)}</span>`).join('')}${n > 5 ? `<span class="ts-m ts-more" style="--i:5">+${n - 5}</span>` : ''}</span><span class="tb-label">${esc(p?.name || `${n} subagent${n > 1 ? 's' : ''}`)}</span>`
    : `${icon('agent')}<span class="tb-label">Subagents</span>`;
  btn.title = !team.length
    ? 'Subagents: give the lead a team on other harnesses to delegate to'
    : ok
      ? `Subagents the lead can delegate to:\n${team.map((m) => `• ${m.name}${copiesOf(m) > 1 ? ` ×${copiesOf(m)}` : ''}: ${memberLabel(m)}${m.use ? ` — ${m.use}` : ''}`).join('\n')}`
      : `${agentName(lead)} can't delegate (wisp can't give it tools), so this launch runs without subagents`;
}

export function teamEditor(anchor, { lead, team, presetId, places }, onChange) {
  const open = $('.team-pop');
  if (open) return open.close();
  let members = team.map((m) => ({ ...m }));
  let preset = presetId;
  const r = anchor.getBoundingClientRect();
  const width = Math.min(540, innerWidth - 24);
  const left = Math.max(12, Math.min(r.left, innerWidth - 12 - width));
  const below = r.bottom + 440 < innerHeight;
  const node = el(`
    <div class="team-pop" role="dialog" aria-label="Subagents" style="left:${left}px;width:${width}px;${below ? `top:${r.bottom + 6}px` : `bottom:${innerHeight - r.top + 6}px`}">
      <header class="tp-head">
        <div class="tp-title"><b>Subagents</b><small>The lead hands tasks to these, each on its own harness. Tell it what each one is for.</small></div>
        <button class="ghost xs tp-presets" aria-haspopup="menu">${icon('agent')}<span>Presets</span>${icon('chevron', 'chev')}</button>
      </header>
      <div class="tp-warn" hidden></div>
      <div class="tp-list"></div>
      <footer class="tp-foot"></footer>
    </div>`);
  const list = $('.tp-list', node);
  const foot = $('.tp-foot', node);
  const commit = () => onChange(uniqueNames(members), preset);
  let typing;
  const commitSoon = () => (clearTimeout(typing), (typing = setTimeout(commit, 300)));

  const paintWarn = () => {
    const w = $('.tp-warn', node);
    w.hidden = canLead(lead);
    w.innerHTML = `${icon('warn')}<span>${esc(agentName(lead))} can't delegate: wisp can't give it tools. Pick Claude Code, Codex or opencode as the lead to use these.</span>`;
  };
  const paintFoot = () => {
    foot.innerHTML = `
      <button class="ghost sm tp-add" ${members.length >= MAX_TEAM || teamSize(members) >= MAX_INSTANCES ? 'disabled' : ''}>${icon('plus')}Add subagent</button>
      <span class="tp-count" title="Agents in all, counting copies (max ${MAX_INSTANCES})">${teamSize(members)} agent${teamSize(members) === 1 ? '' : 's'}</span>
      <span class="grow"></span>
      ${members.length ? `<button class="link xs tp-clear">Clear</button><button class="ghost sm tp-save">${icon('check')}Save as preset</button>` : ''}`;
  };
  const paintList = () => {
    const named = uniqueNames(members);
    list.innerHTML = members.length
      ? members
          .map(
            (m, i) => `<div class="tp-row" data-i="${i}">
              <div class="tp-top">
                <button class="runner-btn tp-runner" title="Harness, model and thinking level" aria-haspopup="dialog"></button>
                <span class="tp-copies${copiesOf(m) > 1 ? ' on' : ''}" title="Copies: identical agents that take tasks in parallel">
                  <button class="tp-dec" aria-label="One copy fewer" ${copiesOf(m) <= 1 ? 'disabled' : ''}>${icon('minus')}</button>
                  <b>×${copiesOf(m)}</b>
                  <button class="tp-inc" aria-label="One copy more" ${copiesOf(m) >= MAX_COPIES || teamSize(members) >= MAX_INSTANCES ? 'disabled' : ''}>${icon('plus')}</button>
                </span>
                <label class="field sm mono tp-name" title="What the lead calls it"><span>@</span><input value="${esc(m.name || '')}" placeholder="${esc(named[i].name)}" maxlength="24" spellcheck="false" autocomplete="off"></label>
                <button class="icon-btn tp-del" title="Remove">${icon('x')}</button>
              </div>
              <label class="field sm tp-use"><span>Use for</span><input value="${esc(m.use || '')}" placeholder="e.g. image and UI work · research · writing tests" maxlength="300" spellcheck="false" autocomplete="off"></label>
            </div>`,
          )
          .join('')
      : `<div class="tp-empty">${icon('agent')}<p>No subagents yet. Add one per harness you want the lead to use, like Codex for tests or opencode for research.</p></div>`;
    $$('.tp-row', list).forEach((row, i) => paintRunnerBtn($('.tp-runner', row), members[i].agent, members[i].model, members[i].effort));
    paintFoot();
  };
  const add = () => {
    if (members.length >= MAX_TEAM || teamSize(members) >= MAX_INSTANCES) return;
    const used = new Set([lead, ...members.map((m) => m.agent)]);
    const pool = places ? harnessesAt(places) : S.agents;
    const a = pool.find((x) => x.available && !used.has(x.id)) || pool.find((x) => x.available && x.id !== lead) || pool.find((x) => x.available);
    if (!a) return toast('No harness is installed.', { tone: 'bad' });
    const model = savedModel(a.id);
    members.push({ name: '', agent: a.id, model, effort: savedEffort(a.id, model), use: '', count: 1 });
    paintList();
    commit();
    $(`.tp-row[data-i="${members.length - 1}"] .tp-use input`, list)?.focus();
  };

  // Save: name it; an existing preset's name updates that preset.
  const askName = () => {
    const cur = (S.config.teams || []).find((x) => x.id === preset);
    foot.innerHTML = `<form class="tp-saveform"><input class="input sm" placeholder="Preset name, e.g. Review crew" value="${esc(cur?.name || '')}" maxlength="60"><button class="primary sm">Save</button><button type="button" class="link xs tp-cancel">Cancel</button></form>`;
    const input = $('input', foot);
    input.focus();
    input.select();
    $('.tp-cancel', foot).onclick = paintFoot;
    $('form', foot).onsubmit = async (e) => {
      e.preventDefault();
      const name = input.value.trim();
      if (!name) return input.focus();
      const same = (S.config.teams || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
      try {
        const p = await api(same ? `/teams/${same.id}` : '/teams', { method: same ? 'PATCH' : 'POST', body: { name, members: uniqueNames(members) } });
        S.config.teams = [...(S.config.teams || []).filter((x) => x.id !== p.id), p];
        preset = p.id;
        commit();
        paintFoot();
        toast(`${same ? 'Updated' : 'Saved'} preset <b>${esc(p.name)}</b>`);
      } catch (err) {
        toastError(err);
      }
    };
  };

  const presetMenu = (btn) => {
    const prev = $('.menu.tp-menu');
    if (prev) return prev.close();
    const teams = S.config.teams || [];
    const b = btn.getBoundingClientRect();
    const menu = el(`
      <div class="menu tp-menu" role="menu" style="top:${b.bottom + 4}px;right:${innerWidth - b.right}px">
        ${teams.length
          ? teams
              .map(
                (t) => `<button role="menuitem" data-id="${esc(t.id)}" class="${t.id === preset ? 'on' : ''}">
                  <span class="tb-stack">${t.members.slice(0, 4).map((m, i) => `<span class="ts-m" style="--i:${i}">${harnessLogo(m.agent)}</span>`).join('')}</span>
                  <span class="mm-text"><b>${esc(t.name)}</b><small>${esc(t.members.map((m) => m.name).join(', '))}</small></span>
                  <span class="tp-mdel" data-del="${esc(t.id)}" title="Delete preset">${icon('trash')}</span>
                </button>`,
              )
              .join('')
          : `<div class="tp-mempty">No presets yet. Set up a team, then <b>Save as preset</b>.</div>`}
      </div>`);
    menu.onclick = async (ev) => {
      const del = ev.target.closest('[data-del]');
      if (del) {
        ev.stopPropagation();
        const t = teams.find((x) => x.id === del.dataset.del);
        if (!(await tryApi(() => api(`/teams/${t.id}`, { method: 'DELETE' })))) return close();
        S.config.teams = (S.config.teams || []).filter((x) => x.id !== t.id);
        if (preset === t.id) (preset = ''), commit();
        close();
        return toast(`Deleted preset <b>${esc(t.name)}</b>`);
      }
      const item = ev.target.closest('button[data-id]');
      if (!item) return;
      const t = teams.find((x) => x.id === item.dataset.id);
      members = t.members.map((m) => ({ ...m }));
      preset = t.id;
      close();
      paintList();
      commit();
    };
    const close = popover(menu, { anchor: btn, capture: true });
  };

  list.addEventListener('click', (e) => {
    const row = e.target.closest('.tp-row');
    if (!row) return;
    const i = Number(row.dataset.i);
    if (e.target.closest('.tp-del')) {
      members.splice(i, 1);
      paintList();
      return commit();
    }
    const step = e.target.closest('.tp-inc') ? 1 : e.target.closest('.tp-dec') ? -1 : 0;
    if (step) {
      const m = members[i];
      const next = copiesOf(m) + step;
      if (next < 1 || next > MAX_COPIES || (step > 0 && teamSize(members) >= MAX_INSTANCES)) return;
      m.count = next;
      paintList();
      $(`.tp-row[data-i="${i}"] ${step > 0 ? '.tp-inc' : '.tp-dec'}`, list)?.focus();
      return commit();
    }
    const rb = e.target.closest('.tp-runner');
    if (rb) {
      const m = members[i];
      runnerPicker(rb, { agent: m.agent, model: m.model, effort: m.effort, savedModel, savedEffort, places, auto: true }, (agent, model, effort) => {
        Object.assign(m, { agent, model, effort });
        paintList();
        commit();
      });
    }
  });
  list.addEventListener('input', (e) => {
    const row = e.target.closest('.tp-row');
    if (!row) return;
    const m = members[Number(row.dataset.i)];
    if (e.target.closest('.tp-name')) m.name = e.target.value;
    else m.use = e.target.value;
    commitSoon();
  });
  foot.addEventListener('click', (e) => {
    if (e.target.closest('.tp-add')) add();
    if (e.target.closest('.tp-save')) askName();
    if (e.target.closest('.tp-clear')) {
      members = [];
      preset = '';
      paintList();
      commit();
    }
  });
  $('.tp-presets', node).onclick = (e) => presetMenu(e.currentTarget);

  paintWarn();
  paintList();
  // The harness picker and preset menu float outside the popover; clicks there keep it open.
  const close = popover(node, {
    anchor,
    keep: '.picker, .tp-menu',
    onClose: () => {
      clearTimeout(typing);
      commit();
      $('.menu.tp-menu')?.close();
      anchor.classList.remove('open');
    },
  });
  anchor.classList.add('open');
  if (!members.length) $('.tp-add', node)?.focus();
}

// One delegation with the child session and turn it ran as (from the lead's childSessions).
function delegationsOf(s, t) {
  return (t.delegations || []).map((d) => {
    const child = s.childSessions?.[d.sessionId];
    return { d, child, ct: child?.turns.find((x) => x.id === d.turnId) };
  });
}
export const subKey = (s, t) => delegationsOf(s, t).map(({ ct }) => ct?.status || '?').join(',');
const subStatus = (ct) => {
  if (!ct || ct.status === 'running') return { cls: 'waiting', label: 'Working' };
  if (ct.status === 'stopped') return { cls: 'partial', label: 'Stopped' };
  if (ct.status === 'error') return { cls: 'blocked', label: 'Failed' };
  const st = ct.presentation?.blocks?.find((b) => b.type === 'hero')?.status || 'done';
  return { cls: st, label: STATUS_LABEL[st] || 'Done' };
};

// While the lead works: one live line per subagent it's waiting on.
export function teamLiveHtml(s, t) {
  const list = delegationsOf(s, t);
  if (!list.length) return '';
  return `<div class="team-live">${list
    .map(({ d, ct }) => {
      const running = !ct || ct.status === 'running';
      const hero = ct?.presentation?.blocks?.find((b) => b.type === 'hero');
      const last = ct?.activity?.findLast((a) => a.kind !== 'text')?.label;
      const st = subStatus(ct);
      return `<div class="tl-row ${running ? 'live' : `st-${st.cls}`}" data-sub="${esc(d.sessionId)}">
        <span class="tl-logo">${harnessLogo(d.agent)}</span>
        <b class="tl-name">@${esc(d.name)}</b>
        <span class="tl-live">${esc(running ? last || 'Starting up' : hero?.title || st.label)}</span>
        ${running ? `<span class="elapsed" data-start="${ct?.startedAt || d.startedAt}">${fmtDuration(Date.now() - (ct?.startedAt || d.startedAt))}</span>` : `<span class="pill st-${st.cls}"><i></i>${st.label}</span>`}
      </div>`;
    })
    .join('')}</div>`;
}

// After the run: the team's reports, one card each, opening into the subagent's own presentation.
const subOpen = new Set(); // delegation ids the user unfolded
export function renderSubs(s, t) {
  const list = delegationsOf(s, t);
  if (!list.length) return null;
  const names = [...new Set(list.map(({ d }) => `@${d.name}`))];
  const node = el(`
    <section class="subs">
      <div class="subs-head">
        ${teamStack(s.agent, list.map(({ d, ct }) => ({ name: d.name, agent: d.agent, busy: ct?.status === 'running' })))}
        <b>${list.length} delegated task${list.length > 1 ? 's' : ''}</b>
        <span class="subs-to">${esc(names.join(', '))}</span>
      </div>
      <div class="subs-list"></div>
    </section>`);
  const box = $('.subs-list', node);
  for (const { d, child, ct } of list) {
    const st = subStatus(ct);
    const hero = ct?.presentation?.blocks?.find((b) => b.type === 'hero');
    const files = ct?.changes?.length || 0;
    const card = el(`
      <article class="sub st-${st.cls} ${subOpen.has(d.id) ? 'open' : ''}">
        <button class="sub-head" aria-expanded="${subOpen.has(d.id)}">
          <span class="sub-logo">${harnessLogo(d.agent)}</span>
          <span class="sub-main">
            <span class="sub-top"><b>@${esc(d.name)}</b><span class="sub-model">${esc(memberLabel(d))}</span></span>
            <span class="sub-title">${esc(hero?.title || (ct?.status === 'running' ? ct.activity?.findLast((a) => a.kind !== 'text')?.label || 'Working' : d.prompt))}</span>
          </span>
          <span class="sub-side">
            ${files ? `<span class="sub-files">${files} file${files > 1 ? 's' : ''}</span>` : ''}
            ${ct?.endedAt ? `<span class="sub-dur">${fmtDuration(ct.endedAt - ct.startedAt)}</span>` : ''}
            <span class="pill st-${st.cls}"><i></i>${st.label}</span>
            ${icon('chevron', 'chev')}
          </span>
        </button>
        <div class="sub-body" ${subOpen.has(d.id) ? '' : 'hidden'}></div>
      </article>`);
    const body = $('.sub-body', card);
    const fill = () => {
      body.innerHTML = `<div class="sub-task"><span>Task from ${esc(agentName(s.agent))}</span><p>${esc(d.prompt)}</p></div>`;
      if (ct?.presentation && child) {
        // Its "next" and question blocks draft into the lead's composer: the lead stays in charge.
        const ctx = { ...ctxFor(child, ct, false), reply: (text) => draftInto(s.id, `Ask @${d.name} to: ${text}`), draft: (text) => draftInto(s.id, `Ask @${d.name} to: ${text}`) };
        body.append(renderPresentation(ct.presentation, ctx));
      } else if (ct?.status === 'running') body.append(el(`<p class="muted sub-wait">Still working…</p>`));
    };
    if (subOpen.has(d.id)) fill();
    $('.sub-head', card).onclick = () => {
      const opening = body.hidden;
      opening ? subOpen.add(d.id) : subOpen.delete(d.id);
      card.classList.toggle('open', opening);
      $('.sub-head', card).setAttribute('aria-expanded', String(opening));
      if (opening) fill();
      body.hidden = !opening;
    };
    box.append(card);
  }
  return node;
}

// A subagent's summary: its lead's card shows it, so update the live line or re-fetch the lead.
const childState = new Map();
export function onChildSummary(c) {
  const row = $(`.tl-row[data-sub="${CSS.escape(c.id)}"] .tl-live`);
  if (row && c.state === 'running' && c.live) row.textContent = c.live;
  if (childState.get(c.id) !== c.state) {
    childState.set(c.id, c.state);
    scheduleRefetch(c.parentId);
  }
}
