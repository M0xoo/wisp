// Delegate (subagents in the API): a team the lead can hand work to, each member on any harness,
// model and thinking level, with the lead or on another machine, plus the user's "use it for" note.
// Picked in the launcher, saved as presets, shown on cards and turns.

import { fmtDuration, renderPresentation } from '../blocks.js';
import { esc } from '../md.js';
import { api } from '../core/api.js';
import * as bus from '../core/bus.js';
import { $, $$, el, icon } from '../core/dom.js';
import { STATUS_LABEL } from '../core/format.js';
import { HERE, here, S } from '../core/state.js';
import { popover } from '../ui/popover.js';
import { toast, toastError, tryApi } from '../ui/toast.js';
import { draftInto } from './composer.js';
import { reveal, scheduleRefetch } from './feed.js';
import { connectMachine, openMachines } from './machines.js';
import { placeMenu } from './place-menu.js';
import { MACHINE_STATE, machineById, placeName } from './places.js';
import { runnerPicker } from './runner-picker.js';
import { agentById, agentName, effortLabel, harnessesAt, harnessLogo, paintRunnerBtn, savedEffort, savedModel } from './runners.js';
import { ctxFor } from './turns.js';
import { avatarHtml, crewList, memberById } from './crew.js';

const MAX_TEAM = 6; // rows
const MAX_COPIES = 5; // parallel copies of one row
const MAX_INSTANCES = 12; // copies across the team
export const copiesOf = (m) => Math.max(1, m.count || 1);
export const teamSize = (team) => team.reduce((n, m) => n + copiesOf(m), 0);
export const canLead = (id) => agentById(id)?.delegates !== false;
export const memberLabel = (m) => {
  if (m.crew) return memberById(m.crew)?.role || m.role || 'Crew member'; // a crew member brings its own harness: name its role
  const a = agentById(m.agent);
  const model = (m.model && a?.models?.find((x) => x.id === m.model)?.label) || m.model || 'Default model';
  const where = m.machine || m.place ? ` · on ${memberPlaceName(m) || m.place}` : ''; // a delegation keeps only the place's name
  return `${a?.name || agentName(m.agent)} · ${model}${m.effort ? ` · ${effortLabel(m.effort)}` : ''}${where}`;
};
// A delegate's face: a crew member's avatar, anyone else's harness logo.
const faceOf = (m, size, opts = {}) => {
  const c = m.crew && memberById(m.crew);
  return c ? avatarHtml(c, { size, dot: false, ...opts }) : harnessLogo(m.agent);
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
  return `<span class="team-stack" role="img" data-tip="${esc(tip)}" aria-label="${esc(tip)}" tabindex="0">
    <span class="ts-l">${harnessLogo(lead)}</span>
    ${shown.map((m, i) => `<span class="ts-m${m.used === false ? ' idle' : ''}${m.busy ? ' busy' : ''}${m.crew ? ' crew' : ''}" style="--i:${i}">${faceOf(m, 18, { state: m.busy ? 'live' : 'idle', small: true })}</span>`).join('')}
    ${team.length > shown.length ? `<span class="ts-m ts-more" style="--i:${shown.length}">+${team.length - shown.length}</span>` : ''}
  </span>`;
}

// Launcher button: a stack of the members' logos and the preset's name, or just "Delegate".
export function paintTeamBtn(btn, team, presetId, lead) {
  const ok = canLead(lead);
  const flat = team.flatMap((m) => Array(copiesOf(m)).fill(m));
  const n = flat.length;
  const p = (S.config.teams || []).find((x) => x.id === presetId);
  btn.classList.toggle('on', team.length > 0 && ok);
  btn.classList.toggle('off', team.length > 0 && !ok);
  btn.innerHTML = team.length
    ? `<span class="tb-stack">${flat.slice(0, 5).map((m, i) => `<span class="ts-m${m.crew ? ' crew' : ''}" style="--i:${i}">${faceOf(m, 18)}</span>`).join('')}${n > 5 ? `<span class="ts-m ts-more" style="--i:5">+${n - 5}</span>` : ''}</span>${team.some((m) => m.machine) ? `<span class="tb-away" aria-hidden="true">${icon('server')}</span>` : ''}<span class="tb-label">${esc(p?.name || `${n} delegate${n > 1 ? 's' : ''}`)}</span>`
    : `${icon('agent')}<span class="tb-label">Delegate</span>`;
  btn.title = !team.length
    ? 'Delegate: agents the lead can hand parts of the task to, on other harnesses or other machines'
    : ok
      ? `The lead can delegate to:\n${team.map((m) => `• ${m.name}${copiesOf(m) > 1 ? ` ×${copiesOf(m)}` : ''}: ${memberLabel(m)}${m.use ? ` — ${m.use}` : ''}`).join('\n')}`
      : `${agentName(lead)} can't delegate (wisp can't give it tools), so this launch runs without delegates`;
}

// Where a member runs, as the page names places: '' with the lead, 'here' this computer, or a
// machine id. One away from the lead works on a copy of its work there (server/services/relay.js).
const HERE_KEY = 'here';
export const memberPlaceName = (m) => (!m.machine ? '' : m.machine === HERE_KEY ? here : machineById(m.machine)?.name || m.place || 'a machine');
// The places whose harnesses a member can use: the lead's, or its own.
const placesFor = (m, leadPlaces) => (m.machine ? [m.machine === HERE_KEY ? '' : m.machine] : leadPlaces);
const placeState = (k) => (k && k !== HERE_KEY ? machineById(k)?.state || 'off' : 'online');
const placeIcon = (k) => icon(k && k !== HERE_KEY ? 'server' : 'laptop');
const stateDot = (k) => (k && k !== HERE_KEY ? `<i class="dot ${placeState(k) === 'online' ? 'ok' : placeState(k) === 'error' ? 'bad' : ''}"></i>` : '');

// The delegate editor: who the lead can hand work to, where each one runs and on what, plus a
// name and a "use it for" note. lead / leadModel / leadEffort: the lead's run. places: where the
// lead runs ('' = this computer). pickLead(k): move the lead there (the launcher), else it's shown.
// exclude: a crew member id that can't be its own delegate (the crew editor, features/crew.js).
export function teamEditor(anchor, { lead, leadModel = '', leadEffort = '', team, presetId, places, pickLead, exclude = '' }, onChange) {
  const open = $('.team-pop');
  if (open) return open.close();
  let members = team.map((m) => ({ ...m }));
  let preset = presetId;
  const leadPlaces = () => (typeof places === 'function' ? places() : places) || [''];
  const r = anchor.getBoundingClientRect();
  const width = Math.min(560, innerWidth - 24);
  const left = Math.max(12, Math.min(r.left, innerWidth - 12 - width));
  const below = r.bottom + 460 < innerHeight;
  const node = el(`
    <div class="team-pop" role="dialog" aria-label="Delegate" style="left:${left}px;width:${width}px;${below ? `top:${r.bottom + 6}px` : `bottom:${innerHeight - r.top + 6}px`}">
      <header class="tp-head">
        <div class="tp-title"><b>Delegate</b><small>Agents the lead can hand parts of the task to, here or on your other machines. Tell it what each one is for.</small></div>
        <button class="ghost xs tp-presets" aria-haspopup="menu">${icon('agent')}<span>Presets</span>${icon('chevron', 'chev')}</button>
      </header>
      <div class="tp-lead"></div>
      <div class="tp-warn" hidden></div>
      <div class="tp-list"></div>
      <footer class="tp-foot"></footer>
    </div>`);
  const list = $('.tp-list', node);
  const foot = $('.tp-foot', node);
  const crewFree = () => crewList().filter((c) => c.id !== exclude && !members.some((m) => m.crew === c.id));
  const commit = () => onChange(uniqueNames(members), preset);
  let typing;
  const commitSoon = () => (clearTimeout(typing), (typing = setTimeout(commit, 300)));

  // The lead, and where it runs: the place every "with the lead" delegate shares.
  const paintLead = () => {
    const ks = leadPlaces();
    const where = ks.length > 1 ? `${ks.length} places` : placeName(ks[0]);
    const away = members.filter((m) => m.machine).map((m) => m.machine);
    const spots = [...new Set(away)].length;
    $('.tp-lead', node).innerHTML = `
      <span class="tp-tag">Lead</span>
      <span class="tp-lead-logo">${harnessLogo(lead)}</span>
      <span class="tp-lead-run">${esc(memberLabel({ agent: lead, model: leadModel, effort: leadEffort }))}</span>
      <span class="tp-on">on</span>
      ${pickLead
        ? `<button class="tp-place tp-lead-place" aria-haspopup="menu" title="Where the lead runs">${placeIcon(ks.length > 1 ? 'x' : ks[0])}<span>${esc(where)}</span>${ks.length === 1 ? stateDot(ks[0]) : ''}${icon('chevron', 'chev')}</button>`
        : `<span class="tp-place static" title="Where the lead runs">${placeIcon(ks[0])}<span>${esc(where)}</span></span>`}
      <span class="grow"></span>
      ${spots ? `<span class="tp-spread" title="Delegates on other places work on a copy of the lead's work there; their changes come back when they finish">${icon('server')}+${spots} place${spots > 1 ? 's' : ''}</span>` : ''}`;
  };
  const paintWarn = () => {
    const w = $('.tp-warn', node);
    w.hidden = canLead(lead);
    w.innerHTML = `${icon('warn')}<span>${esc(agentName(lead))} can't delegate: wisp can't give it tools. Pick Claude Code, Codex or opencode as the lead to use these.</span>`;
  };
  const paintFoot = () => {
    const full = members.length >= MAX_TEAM || teamSize(members) >= MAX_INSTANCES;
    foot.innerHTML = `
      <button class="ghost sm tp-add" ${full ? 'disabled' : ''} ${S.machines.length || crewFree().length ? 'aria-haspopup="menu"' : ''}>${icon('plus')}Add delegate${S.machines.length || crewFree().length ? icon('chevron', 'chev') : ''}</button>
      <span class="tp-count" title="Agents in all, counting copies (max ${MAX_INSTANCES})">${teamSize(members)} agent${teamSize(members) === 1 ? '' : 's'}</span>
      <span class="grow"></span>
      ${members.length ? `<button class="link xs tp-clear">Clear</button><button class="ghost sm tp-save">${icon('check')}Save as preset</button>` : ''}`;
  };
  const placeChip = (m) => {
    const k = m.machine || '';
    const st = placeState(k);
    const tip = !k ? 'Runs with the lead: same computer and folder, sees its edits as they happen' : `Runs on ${memberPlaceName(m)}, on a copy of the lead's work. Its changes come back when it finishes.${st === 'online' ? '' : ` ${MACHINE_STATE[st] || 'Not connected'}: wisp connects when you launch.`}`;
    return `<button class="tp-place${k ? ' away' : ''}${k && st !== 'online' ? ' off' : ''}" aria-haspopup="menu" title="${esc(tip)}">
      ${k ? placeIcon(k) : icon('agent')}<span>${esc(k ? memberPlaceName(m) : 'With the lead')}</span>${stateDot(k)}${icon('chevron', 'chev')}
    </button>`;
  };
  const paintList = () => {
    const named = uniqueNames(members);
    list.innerHTML = members.length
      ? members
          .map((m, i) =>
            m.crew
              ? crewRow(m, i)
              : `<div class="tp-row" data-i="${i}">
              <div class="tp-top">
                ${placeChip(m)}
                <button class="runner-btn tp-runner" title="Harness, model and thinking level${m.machine ? ` on ${esc(memberPlaceName(m))}` : ''}" aria-haspopup="dialog"></button>
                <span class="grow"></span>
                <span class="tp-copies${copiesOf(m) > 1 ? ' on' : ''}" title="Copies: identical agents that take tasks in parallel">
                  <button class="tp-dec" aria-label="One copy fewer" ${copiesOf(m) <= 1 ? 'disabled' : ''}>${icon('minus')}</button>
                  <b>×${copiesOf(m)}</b>
                  <button class="tp-inc" aria-label="One copy more" ${copiesOf(m) >= MAX_COPIES || teamSize(members) >= MAX_INSTANCES ? 'disabled' : ''}>${icon('plus')}</button>
                </span>
                <button class="icon-btn tp-del" title="Remove">${icon('x')}</button>
              </div>
              <div class="tp-bottom">
                <label class="field sm mono tp-name" title="What the lead calls it"><span>@</span><input value="${esc(m.name || '')}" placeholder="${esc(named[i].name)}" maxlength="24" spellcheck="false" autocomplete="off"></label>
                <label class="field sm tp-use"><span>Use for</span><input value="${esc(m.use || '')}" placeholder="e.g. tests · research · GPU work" maxlength="300" spellcheck="false" autocomplete="off"></label>
              </div>
            </div>`,
          )
          .join('')
      : `<div class="tp-empty">${icon('agent')}<p>No delegates yet. Add one per job: Codex for tests next to the lead, or a model on your GPU box for the heavy lifting.</p></div>`;
    $$('.tp-row', list).forEach((row, i) => !members[i].crew && paintRunnerBtn($('.tp-runner', row), members[i].agent, members[i].model, members[i].effort));
    paintFoot();
    paintLead();
  };

  // A crew member (features/crew.js): its face, name and role. It brings its own folder, harness
  // and memory, so there's nothing to pick but what the lead should use it for.
  const crewRow = (m, i) => {
    const c = memberById(m.crew);
    return `<div class="tp-row crew" data-i="${i}">
      <div class="tp-top">
        ${c ? avatarHtml(c, { size: 26, dot: false }) : `<span class="cr-av">${icon('crew')}</span>`}
        <span class="tp-crew"><b>${esc(c?.name || m.label || m.name)}</b><small>${esc(c ? [c.role, 'your crew · own folder and memory'].filter(Boolean).join(' · ') : 'no longer on your crew')}</small></span>
        <span class="grow"></span>
        <button class="icon-btn tp-del" title="Remove">${icon('x')}</button>
      </div>
      <div class="tp-bottom">
        <label class="field sm tp-use"><span>Use for</span><input value="${esc(m.use || '')}" placeholder="${esc(c?.role || 'what to hand them')}" maxlength="300" spellcheck="false" autocomplete="off"></label>
      </div>
    </div>`;
  };
  const addCrew = (id) => {
    const c = memberById(id);
    if (!c || members.length >= MAX_TEAM || teamSize(members) >= MAX_INSTANCES || members.some((m) => m.crew === id)) return;
    members.push({ crew: c.id, name: c.name, label: c.name, role: c.role, agent: c.agent, use: c.role || '', count: 1 });
    paintList();
    commit();
  };

  // A harness that's installed where the member runs, keeping its pick when that place has it.
  const fitRunner = (m) => {
    if (m.agent === 'auto' || m.crew) return;
    const pool = harnessesAt(placesFor(m, leadPlaces()));
    if (pool.find((a) => a.id === m.agent)?.available) return;
    const a = pool.find((x) => x.available && x.id === lead) || pool.find((x) => x.available);
    if (!a) return;
    const model = savedModel(a.id);
    Object.assign(m, { agent: a.id, model, effort: savedEffort(a.id, model) });
  };
  const add = (k = '') => {
    if (members.length >= MAX_TEAM || teamSize(members) >= MAX_INSTANCES) return;
    const used = new Set([lead, ...members.filter((m) => (m.machine || '') === k).map((m) => m.agent)]);
    const pool = harnessesAt(placesFor({ machine: k }, leadPlaces()));
    const a = pool.find((x) => x.available && !used.has(x.id)) || pool.find((x) => x.available && x.id !== lead) || pool.find((x) => x.available);
    if (!a) return toast(k ? `No harness is installed on ${esc(memberPlaceName({ machine: k }))} yet.` : 'No harness is installed.', { tone: 'bad' });
    const model = savedModel(a.id);
    members.push({ name: '', agent: a.id, model, effort: savedEffort(a.id, model), use: '', count: 1, ...(k && { machine: k }) });
    if (k && k !== HERE_KEY && machineById(k)?.state === 'off') connectMachine(k);
    paintList();
    commit();
    $(`.tp-row[data-i="${members.length - 1}"] .tp-use input`, list)?.focus();
  };

  // Where a delegate runs: with the lead, or any other place. Offline machines connect when picked.
  const whereMenu = (btn, { current, adding, onPick }) => {
    const prev = $('.menu.tp-where');
    if (prev) return prev.close();
    const ks = leadPlaces();
    const others = [...(ks.length === 1 && !ks[0] ? [] : [HERE_KEY]), ...S.machines.filter((m) => !(ks.length === 1 && ks[0] === m.id)).map((m) => m.id)];
    const row = (k) => {
      const m = k && k !== HERE_KEY ? machineById(k) : null;
      const st = placeState(k);
      const ready = m && st === 'online' ? (m.remote?.agents || []).filter((a) => a.available) : [];
      const on = !adding && k === current;
      const sub = !k ? 'Same computer and folder · sees edits live' : m ? (st === 'online' ? `${m.target} · works on a copy` : `${m.target} · ${MACHINE_STATE[st]}`) : 'Where wisp runs · works on a copy';
      return `<button class="wm-row ${on ? 'on' : ''}" data-k="${k}" role="menuitemradio" aria-checked="${on}">
        ${adding ? '' : `<span class="wm-check">${icon('check')}</span>`}
        <span class="wm-icon">${k ? placeIcon(k) : icon('agent')}${stateDot(k)}</span>
        <span class="wm-name"><b>${esc(k ? (k === HERE_KEY ? HERE : m?.name || 'machine') : 'With the lead')}</b><small>${esc(sub)}</small></span>
        ${ready.length ? `<span class="wm-agents">${ready.slice(0, 4).map((a) => `<span class="model-logo">${harnessLogo(a.id)}</span>`).join('')}</span>` : ''}
      </button>`;
    };
    const menu = el(`<div class="menu where-menu place-menu tp-where" role="menu">
      <div class="wm-h">${adding ? 'Add a delegate' : 'Runs on'} <small>${others.length ? 'away from the lead, its changes come back when done' : ''}</small></div>
      ${row('')}${others.map(row).join('')}
      ${adding && crewFree().length ? `<div class="wm-sep"></div><div class="wm-h">Your crew <small>they work in their own folder, with their memory</small></div>${crewFree().map((c) => `<button class="wm-row" data-crew="${c.id}">${avatarHtml(c, { size: 24, dot: false })}<span class="wm-name"><b>${esc(c.name)}</b><small>${esc(c.role || 'Crew member')}</small></span></button>`).join('')}` : ''}
      <div class="wm-sep"></div>
      <button data-a="add">${icon('plus')}${S.machines.length ? 'Add a machine…' : 'Add a machine to delegate to another computer…'}</button>
    </div>`);
    menu.onclick = (ev) => {
      if (ev.target.closest('[data-a="add"]')) {
        shut();
        return openMachines({ focusAdd: true });
      }
      const b = ev.target.closest('.wm-row');
      if (!b) return;
      shut();
      if (b.dataset.crew) return addCrew(b.dataset.crew);
      onPick(b.dataset.k);
    };
    const shut = popover(menu, { anchor: btn, capture: true, onClose: () => btn.setAttribute('aria-expanded', 'false') });
    btn.setAttribute('aria-expanded', 'true');
    const br = btn.getBoundingClientRect();
    const h = menu.offsetHeight;
    menu.style.left = `${Math.max(8, Math.min(br.left, innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${br.bottom + 6 + h > innerHeight - 8 ? Math.max(8, br.top - h - 6) : br.bottom + 6}px`;
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
                  <span class="tb-stack">${t.members.slice(0, 4).map((m, i) => `<span class="ts-m${m.crew ? ' crew' : ''}" style="--i:${i}">${faceOf(m, 18)}</span>`).join('')}</span>
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
    const pb = e.target.closest('.tp-place');
    if (pb) {
      const m = members[i];
      return whereMenu(pb, {
        current: m.machine || '',
        onPick: (k) => {
          if (k) m.machine = k;
          else delete m.machine;
          delete m.place;
          if (k && k !== HERE_KEY && machineById(k)?.state === 'off') connectMachine(k);
          fitRunner(m);
          paintList();
          commit();
        },
      });
    }
    const rb = e.target.closest('.tp-runner');
    if (rb) {
      const m = members[i];
      runnerPicker(rb, { agent: m.agent, model: m.model, effort: m.effort, savedModel, savedEffort, places: placesFor(m, leadPlaces()), auto: true }, (agent, model, effort) => {
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
    const addBtn = e.target.closest('.tp-add');
    // With machines around, Add asks where; without, it's one click.
    if (addBtn) S.machines.length || crewFree().length ? whereMenu(addBtn, { adding: true, onPick: add }) : add();
    if (e.target.closest('.tp-save')) askName();
    if (e.target.closest('.tp-clear')) {
      members = [];
      preset = '';
      paintList();
      commit();
    }
  });
  $('.tp-presets', node).onclick = (e) => presetMenu(e.currentTarget);
  $('.tp-lead', node).addEventListener('click', (e) => {
    const b = e.target.closest('.tp-lead-place');
    if (!b) return;
    placeMenu(b, { title: 'The lead runs on', current: leadPlaces().length === 1 ? leadPlaces()[0] : null }, (k) => {
      pickLead(k);
      for (const m of members) fitRunner(m);
      paintList();
      commit();
    });
  });

  paintWarn();
  paintList();
  // Machines connecting (or dropping) change the dots and what's installed where.
  bus.on('machines', () => node.isConnected && !node.contains(document.activeElement) && paintList(), { node });
  // The harness picker and preset menu float outside the popover; clicks there keep it open.
  const close = popover(node, {
    anchor,
    keep: '.picker, .tp-menu, .tp-where, .place-menu',
    onClose: () => {
      clearTimeout(typing);
      commit();
      $('.menu.tp-menu')?.close();
      $('.menu.tp-where')?.close();
      anchor.classList.remove('open');
    },
  });
  anchor.classList.add('open');
  if (!members.length) $('.tp-add', node)?.focus();
}

// Where a delegation ran: its own machine (on a copy of the lead's work), else where the lead runs.
function ranOn(s, d) {
  const away = !!d.place;
  const name = away ? d.place : s.machine?.name || placeName('');
  const tip = away ? `Ran on ${name}, on a copy of the lead's work` : `Ran on ${name}, with the lead in its folder`;
  return `<span class="tl-place${away ? ' away' : ''}" title="${esc(tip)}">${icon(away || s.machine ? 'server' : 'laptop')}${esc(name)}</span>`;
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
  return { cls: st, label: STATUS_LABEL[st] || STATUS_LABEL.done };
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
      // A crew member's job is a task of its own: the row opens it.
      const open = d.crew ? ` data-open="${esc(d.sessionId)}" role="link" tabindex="0" title="${esc(`Open @${d.name}’s task`)}"` : '';
      return `<div class="tl-row ${running ? 'live' : `st-${st.cls}`}${open ? ' opens' : ''}" data-sub="${esc(d.sessionId)}"${open}>
        <span class="tl-logo${d.crew ? ' crew' : ''}">${faceOf(d, 22, { state: running ? 'live' : 'idle' })}</span>
        <b class="tl-name">@${esc(d.name)}</b>
        ${ranOn(s, d)}
        <span class="tl-live">${esc(running ? last || 'Starting up' : hero?.title || st.label)}</span>
        ${running ? `<span class="elapsed" data-start="${ct?.startedAt || d.startedAt}">${fmtDuration(Date.now() - (ct?.startedAt || d.startedAt))}</span>` : `<span class="pill st-${st.cls}"><i></i>${st.label}</span>`}
      </div>`;
    })
    .join('')}</div>`;
}

// A crew delegation's live row and its report's link open the member's job.
const openJob = (e) => {
  const at = e.target.closest('.tl-row[data-open], .sub-open[data-open]');
  if (!at || (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ')) return;
  e.preventDefault();
  if (S.sessions.has(at.dataset.open)) reveal(at.dataset.open);
  else toast('That job isn’t here anymore.', { tone: 'bad' });
};
document.addEventListener('click', openJob);
document.addEventListener('keydown', (e) => {
  if (e.target.matches?.('.tl-row[data-open]')) openJob(e);
});

// After the run: the team's reports, one card each, opening into the subagent's own presentation.
const subOpen = new Set(); // delegation ids the user unfolded
export function renderSubs(s, t) {
  const list = delegationsOf(s, t);
  if (!list.length) return null;
  const names = [...new Set(list.map(({ d }) => `@${d.name}`))];
  const node = el(`
    <section class="subs">
      <div class="subs-head">
        ${teamStack(s.agent, list.map(({ d, ct }) => ({ name: d.name, agent: d.agent, crew: d.crew, busy: ct?.status === 'running' })))}
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
          <span class="sub-logo${d.crew ? ' crew' : ''}">${faceOf(d, 28)}</span>
          <span class="sub-main">
            <span class="sub-top"><b>@${esc(d.name)}</b>${ranOn(s, d)}<span class="sub-model">${esc(memberLabel({ ...d, place: '' }))}</span></span>
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
      body.innerHTML = `<div class="sub-task"><span>Task from ${esc(agentName(s.agent))}${d.crew ? `<button class="link xs sub-open" data-open="${esc(d.sessionId)}">Open @${esc(d.name)}’s job${icon('arrow')}</button>` : ''}</span><p>${esc(d.prompt)}</p></div>`;
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
