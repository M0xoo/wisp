// Automations: recipes (saved prompts) and triggers (schedules, GitHub watchers, task watchers).

import { esc } from '../md.js';
import { api } from '../core/api.js';
import * as bus from '../core/bus.js';
import { $, $$, el, icon } from '../core/dom.js';
import { ago, whenLabel } from '../core/format.js';
import { launch, S } from '../core/state.js';
import { overlay, present } from '../ui/overlay.js';
import { toast, toastError } from '../ui/toast.js';
import { renderFeed, reveal, setFocus } from './feed.js';
import { launchBehind } from './launcher.js';
import { projectById } from './places.js';
import { runnerPicker } from './runner-picker.js';
import { agentName, MODES, paintRunnerBtn, savedEffort, savedModel } from './runners.js';
import { ask } from '../ui/confirm.js';
import { crewList } from './crew.js';

// Top bar: always one click to recipes and triggers. The badge counts triggers that are on;
// the tooltip says what fires next.
export async function paintAutoBtn() {
  const btn = $('#autoBtn');
  const on = (S.config.triggers || []).filter((t) => t.enabled);
  const n = $('.ab-n', btn);
  n.hidden = !on.length;
  n.textContent = on.length;
  btn.classList.toggle('live', !!on.length);
  const r = S.config.recipes?.length || 0;
  let title = `Automations: ${r} recipe${r === 1 ? '' : 's'} · ${on.length} trigger${on.length === 1 ? '' : 's'} on`;
  if (on.length) {
    const next = (await api('/triggers').catch(() => [])).filter((t) => t.enabled && t.nextAt).sort((a, b) => a.nextAt - b.nextAt)[0];
    if (next) title += `\nNext: ${next.name} · ${whenLabel(next.nextAt)}`;
  }
  btn.title = title;
}

const TRIGGER_KINDS = [
  { kind: 'schedule', label: 'Schedule', icon: 'clock', hint: 'On a cron schedule, local time' },
  { kind: 'ci', label: 'CI failed', icon: 'warn', hint: 'A GitHub Actions run fails (polled with gh)' },
  { kind: 'issues', label: 'Issue labelled', icon: 'ask', hint: 'An open issue gets a label (polled with gh)' },
  { kind: 'finished', label: 'Task finished', icon: 'bolt', hint: 'One of your tasks finishes' },
  { kind: 'done', label: 'Task marked done', icon: 'done', hint: 'You mark a task done, or ship it' },
];
const TASK_KINDS = new Set(['finished', 'done']);
const CRON_PRESETS = [
  ['Weekdays 9:00', '0 9 * * 1-5'],
  ['Every hour', '0 * * * *'],
  ['Daily 18:00', '0 18 * * *'],
  ['Mondays 8:00', '0 8 * * 1'],
];
export const recipeParams = (prompt) => [...new Set([...String(prompt || '').matchAll(/\{([a-zA-Z][\w-]{0,30})\}/g)].map((m) => m[1]))];

const projectOptions = (selected, { any } = {}) =>
  (any ? `<option value="">${esc(any)}</option>` : '') +
  S.config.projects.map((p) => `<option value="${esc(p.path)}" ${p.path === selected ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
const modeOptions = (selected, { inherit } = {}) =>
  (inherit ? `<option value="">${esc(inherit)}</option>` : '') + MODES.map((m) => `<option value="${m.id}" ${m.id === selected ? 'selected' : ''}>${m.label}</option>`).join('');

export function openAutomations({ tab = 'recipes', edit = null, host } = {}) {
  const node = el(`<div class="modal auto-modal">
      <header><h2>Automations</h2><button class="icon-btn close">${icon('x')}</button></header>
      <p class="mem-lede">Recipes are prompts you send again and again; <code>{name}</code> in one becomes a field to fill in. Triggers start tasks on their own.</p>
      <div class="mem-tabs" role="tablist"></div>
      <div class="auto-body"></div>
    </div>`);
  const close = present(node, host);
  let recipes = [];
  let triggers = [];
  let editing = edit; // { type: 'recipe' | 'trigger', draft }

  const render = async () => {
    [recipes, triggers] = await Promise.all([api('/recipes').catch(() => recipes), api('/triggers').catch(() => triggers)]);
    if (!node.isConnected) return;
    $('.mem-tabs', node).innerHTML = [
      ['recipes', 'Recipes', recipes.length],
      ['triggers', 'Triggers', triggers.length],
    ].map(([k, l, n]) => `<button role="tab" data-tab="${k}" class="${tab === k ? 'on' : ''}">${l}<span>${n}</span></button>`).join('');
    const body = $('.auto-body', node);
    body.innerHTML = '';
    if (editing?.type === 'recipe') body.append(recipeForm(editing.draft));
    else if (editing?.type === 'trigger') body.append(triggerForm(editing.draft));
    else body.innerHTML = tab === 'recipes' ? recipesView() : triggersView();
  };

  const recipesView = () =>
    `<div class="au-list">${
      recipes
        .map((r) => {
          const proj = S.config.projects.find((p) => p.path === r.cwd);
          const tags = [r.params.length ? r.params.map((p) => `{${p}}`).join(' ') : '', proj ? proj.name : 'Any project', r.agent ? agentName(r.agent) : '', r.runs ? `${r.runs} run${r.runs > 1 ? 's' : ''}` : ''].filter(Boolean);
          return `<div class="au-item" data-id="${r.id}">
            <span class="mem-ico">${icon('bolt')}</span>
            <div class="au-main"><b>${esc(r.name)}</b><p>${esc(r.prompt.replace(/\s+/g, ' ').slice(0, 140))}</p><span class="au-tags">${tags.map((t) => `<i>${esc(t)}</i>`).join('')}</span></div>
            <span class="au-acts"><button class="primary sm" data-act="run">Run</button><button class="icon-btn" data-act="schedule" title="Run it on a schedule">${icon('clock')}</button><button class="icon-btn" data-act="edit" title="Edit">${icon('pen')}</button><button class="icon-btn" data-act="delete" title="Delete">${icon('trash')}</button></span>
          </div>`;
        })
        .join('') || '<p class="mem-empty">No recipes yet. Save a task you repeat, like a release checklist, a PR from a commit, or a dependency bump.</p>'
    }</div><button class="mem-add" data-act="new">${icon('plus')}New recipe</button>
    <p class="hint">Also from the terminal: <code>wisp recipes</code>, <code>wisp run &lt;name&gt; [values…]</code>.</p>`;

  const describe = (t) => {
    const member = t.crew && crewList().find((m) => m.id === t.crew);
    if (TASK_KINDS.has(t.kind)) {
      const where = t.cwd ? S.config.projects.find((p) => p.path === t.cwd)?.name || t.cwd.split(/[\\/]/).pop() : member?.cwd ? `${member.name}’s project` : 'any project';
      return `When a task in ${esc(where)} ${t.kind === 'done' ? 'is marked done' : 'finishes'}${member ? ` → ${esc(member.name)}` : ', a new task in its folder'}`;
    }
    const proj = (member && !t.cwd ? `${member.name}’s folder` : S.config.projects.find((p) => p.path === t.cwd)?.name || t.cwd.split(/[\\/]/).pop()) + (member ? ` → ${member.name}` : '');
    if (t.kind === 'schedule') return `<code>${esc(t.cron)}</code> in ${esc(proj)}${t.nextAt ? ` · next ${esc(whenLabel(t.nextAt))}` : ''}`;
    const what = t.kind === 'ci' ? `failed CI${t.branch ? ` on <code>${esc(t.branch)}</code>` : ''}` : `issues labelled <code>${esc(t.label)}</code>`;
    return `Watches ${what} in ${esc(proj)} every ${t.every} min${t.seeded ? '' : ' · first check records what is already there'}`;
  };
  const triggersView = () =>
    `<div class="au-list">${
      triggers
        .map((t) => {
          const k = TRIGGER_KINDS.find((x) => x.kind === t.kind);
          const last = t.lastSessionId && S.sessions.has(t.lastSessionId) ? `<a href="#" data-session="${esc(t.lastSessionId)}">last run ${ago(t.lastRunAt)} ago</a>` : t.lastRunAt ? `last run ${ago(t.lastRunAt)} ago` : 'not run yet';
          return `<div class="au-item ${t.enabled ? '' : 'off'}" data-id="${t.id}">
            <span class="mem-ico">${icon(k.icon)}</span>
            <div class="au-main"><b>${esc(t.name)}</b><p>${describe(t)}</p><span class="au-tags"><i>${esc(MODES.find((m) => m.id === t.mode)?.label || t.mode)}</i>${t.agent ? `<i>${esc(agentName(t.agent))}</i>` : ''}<i>${last}</i></span>${t.lastError ? `<p class="au-err">${icon('warn')}${esc(t.lastError)}</p>` : ''}</div>
            <span class="au-acts">${TASK_KINDS.has(t.kind) ? '' : `<button class="ghost xs" data-act="fire" title="${t.kind === 'schedule' ? 'Run it now' : 'Check GitHub now'}">${icon('replay')}${t.kind === 'schedule' ? 'Run now' : 'Check now'}</button>`}<button class="switch" data-act="toggle" role="switch" aria-checked="${t.enabled}" title="On / off"></button><button class="icon-btn" data-act="edit" title="Edit">${icon('pen')}</button><button class="icon-btn" data-act="delete" title="Delete">${icon('trash')}</button></span>
          </div>`;
        })
        .join('') || '<p class="mem-empty">No triggers yet. Run a recipe every weekday morning, or send an agent after every red CI run.</p>'
    }</div><button class="mem-add" data-act="new">${icon('plus')}New trigger</button>
    <p class="hint">Triggers run while wisp is open. GitHub watchers use your <code>gh</code> login and poll, so nothing has to reach this machine.</p>`;

  // Harness · model button for a form, with "Launcher default" when no agent is set.
  const runnerField = (draft) => {
    const wrap = el(`<div class="au-runner"><button type="button" class="runner-btn" aria-haspopup="dialog"></button><button type="button" class="link xs" ${draft.agent ? '' : 'hidden'}>Use launcher default</button></div>`);
    const [btn, reset] = wrap.children;
    const paint = () => (paintRunnerBtn(btn, draft.agent, draft.model, draft.effort), (reset.hidden = !draft.agent));
    btn.onclick = () =>
      runnerPicker(btn, { agent: draft.agent || S.config.defaults.agent, model: draft.model, effort: draft.effort, savedModel, savedEffort, auto: true }, (a, m, e) => {
        Object.assign(draft, { agent: a, model: m, effort: e });
        paint();
      });
    reset.onclick = () => (Object.assign(draft, { agent: '', model: '', effort: '' }), paint());
    paint();
    return wrap;
  };

  const recipeForm = (d) => {
    const f = el(`<form class="au-form">
        <label><span>Name</span><input class="input" name="name" maxlength="60" placeholder="Release" spellcheck="false"></label>
        <label class="stack"><span>Prompt <small class="muted">· <code>{version}</code> becomes a field</small></span><textarea class="textarea mono" name="prompt" rows="7" spellcheck="false" placeholder="Prepare release {version}: update CHANGELOG, README and docs/, bump package.json, tag v{version}…"></textarea></label>
        <p class="au-params muted xs"></p>
        <label><span>Project</span><select name="cwd">${projectOptions(d.cwd, { any: 'Any project (picked when run)' })}</select></label>
        <label><span>Mode</span><select name="mode">${modeOptions(d.mode, { inherit: 'Launcher default' })}</select></label>
        <div class="au-row"><span>Harness</span></div>
        <div class="au-foot"><button type="button" class="ghost sm" data-act="cancel">Cancel</button><button class="primary sm">${d.id ? 'Save' : 'Create recipe'}</button></div>
      </form>`);
    $('[name="name"]', f).value = d.name || '';
    $('[name="prompt"]', f).value = d.prompt || '';
    $('.au-row', f).append(runnerField(d));
    const params = () => {
      const p = recipeParams($('[name="prompt"]', f).value);
      $('.au-params', f).innerHTML = p.length ? `Fields when run: ${p.map((x) => `<code>{${esc(x)}}</code>`).join(' ')}` : 'No fields: it runs as written.';
    };
    $('[name="prompt"]', f).oninput = params;
    params();
    f.onsubmit = async (e) => {
      e.preventDefault();
      const body = { name: $('[name="name"]', f).value, prompt: $('[name="prompt"]', f).value, cwd: $('[name="cwd"]', f).value, mode: $('[name="mode"]', f).value, agent: d.agent || '', model: d.model || '', effort: d.effort || '' };
      try {
        await api(d.id ? `/recipes/${d.id}` : '/recipes', { method: d.id ? 'PATCH' : 'POST', body });
        editing = null;
        tab = 'recipes';
        render();
      } catch (err) {
        toastError(err);
      }
    };
    requestAnimationFrame(() => $(d.name ? '[name="prompt"]' : '[name="name"]', f)?.focus());
    return f;
  };

  const triggerForm = (d) => {
    d.kind ||= 'schedule';
    const f = el(`<form class="au-form">
        <div class="au-kinds">${TRIGGER_KINDS.map((k) => `<button type="button" data-kind="${k.kind}" class="${k.kind === d.kind ? 'on' : ''}">${icon(k.icon)}<b>${k.label}</b><small>${k.hint}</small></button>`).join('')}</div>
        <label><span>Name</span><input class="input" name="name" maxlength="60" spellcheck="false"></label>
        ${crewList().length ? `<label class="k-to"><span>Send to</span><select name="crew"><option value="">A new task</option>${crewList().map((m) => `<option value="${m.id}" ${m.id === d.crew ? 'selected' : ''}>${esc(m.name)}${m.role ? ` · ${esc(m.role)}` : ''} (crew)</option>`).join('')}</select></label>` : ''}
        <label class="k-cwd"><span>Project</span><select name="cwd">${projectOptions(d.id ? d.cwd : d.cwd || projectById(launch.project)?.path, { any: 'Their own folder (crew only)' })}</select></label>
        <div class="k-schedule"><label><span>When</span><input class="input mono" name="cron" spellcheck="false" placeholder="0 9 * * 1-5"></label>
          <p class="au-presets">${CRON_PRESETS.map(([l, c]) => `<button type="button" class="lp-chip" data-cron="${c}">${l}</button>`).join('')}<span class="muted xs">minute hour day month weekday</span></p></div>
        <div class="k-ci"><label><span>Branch</span><input class="input mono" name="branch" spellcheck="false" placeholder="Any branch (e.g. main)"></label></div>
        <div class="k-issues"><label><span>Label</span><input class="input" name="label" spellcheck="false" placeholder="wisp"></label></div>
        <div class="k-gh"><label><span>Check every</span><select name="every">${[2, 5, 15, 60].map((m) => `<option value="${m}" ${Number(d.every || 5) === m ? 'selected' : ''}>${m} min</option>`).join('')}</select></label></div>
        <label><span>Run</span><select name="recipeId"><option value="">This prompt</option>${recipes.map((r) => `<option value="${r.id}" ${r.id === d.recipeId ? 'selected' : ''}>Recipe: ${esc(r.name)}</option>`).join('')}</select></label>
        <label class="stack k-prompt"><span>Prompt <small class="muted k-vars"></small></span><textarea class="textarea mono" name="prompt" rows="6" spellcheck="false"></textarea></label>
        <label class="k-run"><span>Mode</span><select name="mode">${modeOptions(d.mode || (d.kind === 'issues' ? 'plan' : 'auto'))}</select></label>
        <div class="au-row k-run"><span>Harness</span></div>
        <p class="au-crew muted xs" hidden>${icon('crew')}<span>Their job runs in their folder, on their harness, with what they remember. A schedule needs no project; a GitHub watcher still watches the project you pick.</span></p>
        <p class="au-warn" hidden>${icon('warn')}<span>Issue text comes from GitHub: anyone who can open and label issues can steer this agent. Plan mode only reads; Full auto runs shell commands without asking.</span></p>
        <div class="au-foot"><button type="button" class="ghost sm" data-act="cancel">Cancel</button><button class="primary sm">${d.id ? 'Save' : 'Create trigger'}</button></div>
      </form>`);
    for (const k of ['name', 'cron', 'branch', 'label']) $(`[name="${k}"]`, f).value = d[k] || '';
    $('[name="prompt"]', f).value = d.prompt || '';
    $('.au-row', f).append(runnerField(d));
    const sync = () => {
      for (const k of ['schedule', 'ci', 'issues']) $(`.k-${k}`, f).hidden = d.kind !== k;
      $('.k-gh', f).hidden = d.kind === 'schedule' || TASK_KINDS.has(d.kind);
      $('.k-prompt', f).hidden = !!$('[name="recipeId"]', f).value;
      $('.k-vars', f).innerHTML = d.kind === 'ci' ? '· <code>{name} {branch} {url} {id} {sha}</code> · empty = built-in CI prompt' : d.kind === 'issues' ? '· <code>{number} {title} {body} {url} {author}</code> · empty = built-in issue prompt' : TASK_KINDS.has(d.kind) ? '· <code>{id} {title} {summary} {branch}</code> · empty = built-in prompt' : '';
      $('.au-warn', f).hidden = !(d.kind === 'issues' && $('[name="mode"]', f).value !== 'plan');
      // Sent to a crew member: they run it their way, so mode and harness are theirs.
      const crew = $('[name="crew"]', f)?.value || '';
      // The empty project: a task watcher watches every project (or the member's); otherwise it's the member's folder.
      const any = $('[name="cwd"] option[value=""]', f);
      any.textContent = TASK_KINDS.has(d.kind) ? (crew ? 'Their project (any, if they have none)' : 'Any project') : 'Their own folder (crew only)';
      any.hidden = !TASK_KINDS.has(d.kind) && !crewList().length;
      if (any.hidden && any.selected && any.nextElementSibling) any.nextElementSibling.selected = true;
      $$('.k-run', f).forEach((x) => (x.hidden = !!crew));
      $('.au-crew', f).hidden = !crew;
      $$('.au-kinds button', f).forEach((b) => b.classList.toggle('on', b.dataset.kind === d.kind));
    };
    f.addEventListener('click', (e) => {
      const k = e.target.closest('[data-kind]')?.dataset.kind;
      if (k) {
        if (k === 'issues' && !d.id) $('[name="mode"]', f).value = 'plan';
        d.kind = k;
        sync();
      }
      const c = e.target.closest('[data-cron]')?.dataset.cron;
      if (c) $('[name="cron"]', f).value = c;
    });
    f.addEventListener('change', sync);
    sync();
    f.onsubmit = async (e) => {
      e.preventDefault();
      const v = (k) => $(`[name="${k}"]`, f).value;
      const body = { kind: d.kind, name: v('name'), crew: $('[name="crew"]', f)?.value || '', cwd: v('cwd'), cron: v('cron'), branch: v('branch'), label: v('label') || 'wisp', every: Number(v('every')), recipeId: v('recipeId'), prompt: v('recipeId') ? '' : v('prompt'), mode: v('mode'), agent: d.agent || '', model: d.model || '', effort: d.effort || '' };
      try {
        await api(d.id ? `/triggers/${d.id}` : '/triggers', { method: d.id ? 'PATCH' : 'POST', body });
        editing = null;
        tab = 'triggers';
        render();
      } catch (err) {
        toastError(err);
      }
    };
    return f;
  };

  node.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-tab],[data-act],[data-session]');
    if (!t || t.closest('.au-form') && !t.dataset.act) return;
    if (t.dataset.tab) return e.preventDefault(), (tab = t.dataset.tab), (editing = null), render();
    if (t.dataset.session) return e.preventDefault(), close(), reveal(t.dataset.session);
    const act = t.dataset.act;
    if (act === 'cancel') return (editing = null), render();
    const itemId = t.closest('.au-item')?.dataset.id;
    if (tab === 'recipes') {
      const r = recipes.find((x) => x.id === itemId);
      if (act === 'new') return (editing = { type: 'recipe', draft: { cwd: projectById(launch.project)?.path || '' } }), render();
      if (act === 'edit') return (editing = { type: 'recipe', draft: { ...r } }), render();
      if (act === 'run') return close(), runRecipe(r);
      if (act === 'schedule') return (tab = 'triggers'), (editing = { type: 'trigger', draft: { kind: 'schedule', name: r.name, recipeId: r.id, cwd: r.cwd || projectById(launch.project)?.path, mode: r.mode || undefined } }), render();
      if (act === 'delete' && (await ask(`Delete the recipe “${r.name}”?`, { ok: 'Delete recipe', danger: true, anchor: t }))) return api(`/recipes/${r.id}`, { method: 'DELETE' }).then(render).catch(toastError);
    } else {
      const tr = triggers.find((x) => x.id === itemId);
      if (act === 'new') return (editing = { type: 'trigger', draft: {} }), render();
      if (act === 'edit') return (editing = { type: 'trigger', draft: { ...tr } }), render();
      if (act === 'toggle') return api(`/triggers/${tr.id}`, { method: 'PATCH', body: { enabled: !tr.enabled } }).then(render).catch(toastError);
      if (act === 'delete' && (await ask(`Delete the trigger “${tr.name}”?`, { ok: 'Delete trigger', danger: true, anchor: t }))) return api(`/triggers/${tr.id}`, { method: 'DELETE' }).then(render).catch(toastError);
      if (act === 'fire') {
        t.disabled = true;
        try {
          const r = await api(`/triggers/${tr.id}/run`, { method: 'POST', body: {} });
          for (const { followUp, ...x } of r.started) S.sessions.set(x.id, x);
          renderFeed();
          // A CI failure on a branch that already has a task goes to it as a follow-up.
          const sent = r.started.filter((x) => x.followUp).length;
          const fresh = r.started.length - sent;
          const parts = [fresh && `Started ${fresh} session${fresh > 1 ? 's' : ''}`, sent && `Sent ${sent} follow-up${sent > 1 ? 's' : ''} to tasks already on it`].filter(Boolean);
          toast(parts.length ? parts.join(' · ') : 'Nothing new to act on.');
        } catch (err) {
          toastError(err);
        }
        render();
      }
    }
  });
  bus.on('config', () => !editing && render(), { node });
  render();
}

// Run a recipe: show it, ask for its fields (and a project, if it isn't tied to one), launch on Run.
export function runRecipe(r) {
  if (!r) return;
  const needsProject = !r.cwd;
  const node = el(`
    <form class="modal run-modal">
      <header><h2>${esc(r.name)}</h2><button type="button" class="icon-btn close">${icon('x')}</button></header>
      <p class="cmp-prompt">${esc(r.prompt)}</p>
      ${r.params.map((p) => `<label class="ship-field"><span>${esc(p)}</span><input class="input" name="p:${esc(p)}" spellcheck="false" required></label>`).join('')}
      ${needsProject ? `<label class="ship-field"><span>Project</span><select name="cwd">${projectOptions(projectById(launch.project)?.path)}</select></label>` : ''}
      <div class="ship-foot"><span class="muted xs">${r.agent ? `${esc(agentName(r.agent))}${r.model ? ` · ${esc(r.model)}` : ''}` : 'Launcher harness'} · ${esc(MODES.find((m) => m.id === r.mode)?.label || 'launcher mode')}</span><button class="primary sm">${icon('enter')}Run</button></div>
    </form>`);
  const close = overlay(node);
  $('.close', node).onclick = close;
  node.onsubmit = async (e) => {
    e.preventDefault();
    const params = Object.fromEntries($$('input[name^="p:"]', node).map((i) => [i.name.slice(2), i.value]));
    const d = S.config.defaults;
    const agent = r.agent || d.agent;
    const cwd = needsProject ? $('[name="cwd"]', node).value : r.cwd;
    const model = r.agent ? r.model : savedModel(agent);
    const effort = r.agent ? r.effort : savedEffort(agent, model);
    const body = { params, cwd: needsProject ? cwd : undefined, agent, model: r.agent ? undefined : model, effort: r.agent ? undefined : effort, mode: r.mode || d.mode };
    close();
    try {
      const prompt = r.prompt.replace(/\{([a-zA-Z][\w-]{0,30})\}/g, (_, k) => params[k] || ''); // as the server fills it
      const s = await launchBehind({ prompt, cwd, runner: { agent, model, effort } }, () => api(`/recipes/${r.id}/run`, { method: 'POST', body }));
      setFocus(s.id);
    } catch (err) {
      toast(`“${esc(r.name)}” didn’t start: ${esc(err.message)}`, { tone: 'bad', action: { label: 'Try again', run: () => runRecipe(r) } });
    }
  };
  // Always wait for Run, even with nothing to fill in, so a click on a recipe never launches it outright.
  requestAnimationFrame(() => ($('input, select', node) || $('button.primary', node))?.focus());
}

// A task worth repeating becomes a recipe, starting from its first prompt.
export async function saveAsRecipe(id) {
  const s = S.full.get(id) || (await api(`/sessions/${id}`).catch(() => null));
  if (!s?.turns?.[0]) return;
  openAutomations({ tab: 'recipes', edit: { type: 'recipe', draft: { name: s.title, prompt: s.turns[0].prompt, cwd: '', mode: s.mode, agent: s.agent, model: s.model, effort: s.effort } } });
}
