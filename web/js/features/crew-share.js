// Sharing crew members (server/crew-share.js, design/crew-sharing.md). Here: Share (a member as a
// .crew.json file, its JSON, a secret gist, or a spell), Import (a file, JSON or a link, then a
// review of who joins, as what, in which project), the review a spell's member needs before it
// resumes (new from the spell, or the spell changed what it does), and asking what happens to a
// spell's members when the spell is removed.
//
// Spells reach Share and Import as the crew.share and crew.import parts; never the review a spell's
// member needs before it resumes (a spell mustn't hide what gates its own members).

import { esc, md } from '../md.js';
import { api } from '../core/api.js';
import { $, $$, el, icon } from '../core/dom.js';
import { launch, MOBILE, S } from '../core/state.js';
import { overlay } from '../ui/overlay.js';
import { ask } from '../ui/confirm.js';
import { toast, toastError } from '../ui/toast.js';
import { MODES, agentName, harnessLogo, harnessesAt } from './runners.js';
import { projectList } from './project-list.js';
import { pathAt } from './places.js';
import { renderFeed } from './feed.js';
import { avatarHtml, cadenceLabel, cadenceText, crewList, eventsLabel, memberById, openCrew, paintCrew } from './crew.js';

const modeOf = (id) => MODES.find((x) => x.id === id) || MODES.find((x) => x.id === 'auto');
const modeLabel = (id) => modeOf(id).label;
const here = (agent) => agent === 'auto' || harnessesAt(['']).some((a) => a.id === agent && a.available);
const projectName = (cwd) => (cwd ? S.config.projects?.find((p) => pathAt(p, '') === cwd)?.name || cwd.split(/[\\/]/).pop() : '');
const launcherProject = () => S.config.projects?.find((p) => p.id === launch.project)?.path || '';
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function download(name, json) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([`${JSON.stringify(json, null, 2)}\n`], { type: 'application/json' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// A project picker on a button: the launcher's list, plus No project unless one is required.
function pickProject(anchor, current, { required = false } = {}, onPick) {
  projectList(anchor, {
    projects: (S.config.projects || []).filter((p) => pathAt(p, '')),
    current: S.config.projects?.find((p) => pathAt(p, '') === current)?.id,
    extras: required ? [] : [{ id: '', icon: 'x', label: 'No project' }],
    label: 'Works in',
    onPick: (pid) => onPick(pathAt(S.config.projects?.find((x) => x.id === pid) || {}, '') || ''),
  });
}

// --- Share -------------------------------------------------------------------------------------------

// What goes and what stays, a check of it right away (notes, and secrets that block it), then Copy,
// Download, As a spell or a secret gist. ids: one member, or the whole crew (Share your crew…).
export function shareMember(ids, { anchor = null } = {}) {
  const members = [].concat(ids).map(memberById).filter(Boolean);
  if (!members.length) return;
  const one = members.length === 1 ? members[0] : null;
  const kits = members.reduce((n, m) => n + (m.kit?.length || 0), 0);
  const noted = members.some((m) => m.notebook?.trim());
  const mates = one ? (one.team || []).map((t) => t.crew && memberById(t.crew)).filter(Boolean) : [];
  const o = { kit: kits > 0, notebook: false, team: false };
  const title = one ? one.name : 'your crew';
  const node = el(`<div class="modal crew-share" role="dialog" aria-label="Share ${esc(title)}">
      <header><h2>Share ${esc(title)}</h2><button class="icon-btn close" title="Close" aria-label="Close">${icon('x')}</button></header>
      <div class="cs-who">${members.map((m) => `<span class="cs-face" title="${esc(m.name)}">${avatarHtml(m, { size: one ? 40 : 30, dot: false, state: 'idle' })}</span>`).join('')}
        ${one ? `<div class="cs-name"><b>${esc(one.name)}</b><small>${esc([one.role, cadenceText(one)].filter(Boolean).join(' · '))}</small></div>` : `<div class="cs-name"><b>${plural(members.length, 'member', 'members')}</b><small>${esc(members.map((m) => m.name).join(', '))}</small></div>`}</div>
      <p class="hint">Their name, brief, schedule, mode and harness go along. Their project, computer, log and jobs stay here: whoever adds them picks a project, and they start paused.</p>
      <div class="cs-opts">
        <label class="check"><input type="checkbox" name="kit" ${o.kit ? 'checked' : 'disabled'}><span>Skills and instructions <small>${kits ? plural(kits, 'file', 'files') : 'none yet'}</small></span></label>
        <label class="check"><input type="checkbox" name="notebook" ${noted ? '' : 'disabled'}><span>Notebook <small>${noted ? 'what they learned about your code: read it first' : 'empty'}</small></span></label>
        ${mates.length ? `<label class="check"><input type="checkbox" name="team"><span>Who they delegate to <small>${esc(mates.map((m) => m.name).join(', '))}: ${mates.length > 1 ? 'they stay' : 'stays'} here unless ticked</small></span></label>` : ''}
      </div>
      <div class="cs-out" aria-live="polite"></div>
      <footer class="ce-foot">
        ${MOBILE ? '' : `<button type="button" class="ghost sm" data-a="spell" title="A spell that brings them: for people who'd rather it kept them up to date">${icon('wizard')}As a spell</button><button type="button" class="ghost sm" data-a="download">${icon('download')}Download</button>`}
        <span class="grow"></span>
        <button type="button" class="ghost sm" data-a="gist" title="A secret gist on your GitHub account: share its link">${icon('github')}Create a gist</button>
        <button type="button" class="primary sm" data-a="copy">${icon('copy')}Copy</button>
      </footer>
    </div>`);
  const close = overlay(node);
  const out = $('.cs-out', node);
  const acts = $$('[data-a]:not(.close)', node).filter((b) => b.dataset.a !== 'close');
  let checked = null; // { bundle, notes, file } for the options as they are
  let failed = '';
  let seq = 0;
  const paintOut = (extra = '') => {
    // The delegates option already names who stays here.
    const notes = (checked?.notes || []).filter((n) => !(mates.length && / delegates to .*, who stays here/.test(n)));
    out.innerHTML = failed ? `<p class="cs-bad">${icon('lock')}<span>${esc(failed)}</span></p>` : `${notes.map((n) => `<p class="cs-note">${icon('info')}<span>${esc(n)}</span></p>`).join('')}${extra}`;
    for (const b of acts) b.disabled = !!failed;
  };
  // The file for these options, checked by the server (the secret scan runs here).
  const check = async () => {
    const n = ++seq;
    try {
      const r = await api('/crew/export', { method: 'POST', body: { ids: members.map((m) => m.id), ...o } });
      if (n !== seq) return;
      (checked = r), (failed = '');
    } catch (err) {
      if (n !== seq) return;
      (checked = null), (failed = err.message);
    }
    paintOut();
  };
  check();
  node.addEventListener('change', (e) => {
    const k = e.target.name;
    if (!(k in o)) return;
    o[k] = e.target.checked;
    check();
  });
  const ready = async () => checked || (await check(), checked);
  node.addEventListener('click', async (e) => {
    if (e.target.closest('.close')) return close();
    const b = e.target.closest('[data-a]');
    const a = b?.dataset.a;
    if (!a || b.disabled) return;
    if (a === 'copy-ref') {
      await navigator.clipboard.writeText(b.dataset.ref);
      return toast(`Copied <code>${esc(b.dataset.ref)}</code>`);
    }
    const r = await ready();
    if (!r) return;
    if (a === 'copy') {
      await navigator.clipboard.writeText(JSON.stringify(r.bundle, null, 2));
      close();
      return toast(`Copied ${esc(title)}. They paste it in <b>Import crew members…</b> (⌘K)`);
    }
    if (a === 'download') {
      download(r.file, r.bundle);
      return close();
    }
    if (a === 'spell') {
      const key = r.bundle.members[0].key;
      download(`${key}.spell.json`, { wispSpell: 1, id: one ? `${key}-crew` : 'my-crew', name: one ? `${one.name}${one.role ? `, ${one.role}` : ''}` : 'My crew', version: '1.0.0', description: `Brings ${r.bundle.members.map((x) => x.name).join(', ')} to your crew.`, crew: r.bundle.members });
      return close();
    }
    if (a === 'gist') {
      if (!(await ask(`Post ${title} to a secret gist on your GitHub account?\n\nIt isn't listed on your profile, but anyone with its link can read it.`, { ok: 'Create the gist', anchor: b }))) return;
      for (const x of acts) x.disabled = true;
      b.innerHTML = `${icon('github')}Posting the gist…`;
      try {
        const g = await api('/crew/export', { method: 'POST', body: { ids: members.map((m) => m.id), ...o, gist: true } });
        paintOut(`<div class="cs-gist">${icon('check')}<span>Secret gist ready: <code>${esc(g.gist.ref)}</code>. They paste it in <b>Import crew members…</b> (⌘K), or run <code>wisp crew import ${esc(g.gist.ref)}</code>.</span><button class="ghost xs" data-a="copy-ref" data-ref="${esc(g.gist.ref)}">${icon('copy')}Copy</button></div>`);
        b.innerHTML = `${icon('github')}Create a gist`;
        for (const x of acts) x.disabled = false;
      } catch (err) {
        b.innerHTML = `${icon('github')}Create a gist`;
        for (const x of acts) x.disabled = false;
        toastError(err);
      }
    }
  });
  requestAnimationFrame(() => $('[data-a="copy"]', node)?.focus());
}

// --- Import -------------------------------------------------------------------------------------------

// A file, its JSON or a link: the box with it in, checking it at once, then the review in its
// place. Without one, the box to paste it in. It stays up (saying what it's doing) until the review
// replaces it, and keeps what you pasted when the server refuses.
export function importCrew(src = null, { state = null } = {}) {
  const node = el(`<div class="modal crew-import" role="dialog" aria-label="Import crew members">
      <header><h2>Import crew members</h2><button class="icon-btn close" title="Close" aria-label="Close">${icon('x')}</button></header>
      <form class="ce-form">
        <label class="ce-stack"><span>A shared member <small>a <code>.crew.json</code> file’s JSON, or a link (https or <code>gist:&lt;id&gt;</code>)</small></span>
          <textarea class="textarea mono" name="src" rows="5" spellcheck="false" placeholder="gist:3f2a… or { &quot;wispCrew&quot;: 1, &quot;members&quot;: [ … ] }"></textarea></label>
        <p class="cs-bad" hidden></p>
        <footer class="ce-foot">
          <button type="button" class="ghost sm" data-a="file">${icon('file')}File…</button><input type="file" accept=".json,application/json" hidden>
          <span class="grow"></span>
          <button type="button" class="ghost sm" data-a="cancel">Cancel</button>
          <button class="primary sm" data-a="review">Review</button>
        </footer>
      </form>
    </div>`);
  const close = overlay(node);
  const ta = $('textarea', node);
  const go = $('[data-a="review"]', node);
  const bad = $('.cs-bad', node);
  const file = $('input[type=file]', node);
  ta.value = src?.text || src?.url || '';
  const review = async (body) => {
    go.disabled = ta.disabled = true;
    go.textContent = body.url ? 'Fetching it…' : 'Checking it…';
    bad.hidden = true;
    let r;
    try {
      r = await api('/crew/import', { method: 'POST', body: { ...body, dryRun: true } });
    } catch (err) {
      go.disabled = ta.disabled = false;
      go.textContent = 'Review';
      bad.innerHTML = `${icon('warn')}<span>${esc(err.message)}</span>`;
      bad.hidden = false;
      return ta.focus();
    }
    if (!node.isConnected) return; // closed meanwhile
    // A spell: its own review.
    if (r.spell) return close(), (await import('./spell-ui.js')).reviewImport({ spell: r.spell });
    reviewImportCrew(body, r, state);
  };
  node.addEventListener('click', (e) => {
    if (e.target.closest('.close, [data-a="cancel"]')) return close();
    if (e.target.closest('[data-a="file"]')) file.click();
  });
  file.onchange = async () => {
    const f = file.files[0];
    if (!f) return;
    ta.value = await f.text();
    review({ text: ta.value });
  };
  $('form', node).onsubmit = (e) => {
    e.preventDefault();
    const v = ta.value.trim();
    if (!v) return ta.focus();
    review(/^(https:\/\/|gist:)/i.test(v) ? { url: v } : { text: v });
  };
  if (src) review(src);
  else requestAnimationFrame(() => ta.focus());
}

// Who joins: a card each (ticked), the name they get (editable), what starts them, their mode and
// harness, the brief and kit, notes on what changed on the way in, and their project (required for
// one that starts when CI fails). Add puts them on the crew at once, paused; refused, it comes back.
function reviewImportCrew(src, r, state) {
  const def = launcherProject();
  const picks = state || Object.fromEntries(r.members.map((p) => [p.key, { name: p.name, cwd: def, skip: false }]));
  const node = el(`<div class="modal crew-import crew-review-list" role="dialog" aria-label="Review crew members">
      <header><h2>${r.members.length === 1 ? `Add ${esc(r.members[0].name)} to your crew` : `Add ${r.members.length} members to your crew`}</h2><button class="icon-btn close" title="Close" aria-label="Close">${icon('x')}</button></header>
      ${src.url ? `<p class="hint ci-src">From <code>${esc(src.url)}</code>${r.source?.owner ? ` by ${esc(r.source.owner)}` : ''}</p>` : ''}
      <div class="ci-list">${r.members.map((p) => memberCard(p, picks[p.key])).join('')}</div>
      <footer class="ce-foot">
        <small class="ci-paused">${icon('pause')}They start paused: resume each when you’re ready.</small>
        <span class="grow"></span>
        <button type="button" class="ghost sm" data-a="cancel">Cancel</button>
        <button type="button" class="primary sm" data-a="add"></button>
      </footer>
    </div>`);
  const close = overlay(node);
  const paint = () => {
    const n = Object.values(picks).filter((x) => !x.skip).length;
    const add = $('[data-a="add"]', node);
    add.textContent = n === 1 ? `Add ${Object.entries(picks).find(([, x]) => !x.skip)[1].name || 'them'}` : `Add ${n}`;
    add.disabled = !n || n > r.room;
    add.title = n > r.room ? `Your crew has room for ${r.room} more` : '';
    for (const card of $$('.ci-card', node)) {
      const p = r.members.find((x) => x.key === card.dataset.key);
      const c = picks[p.key];
      card.classList.toggle('skip', c.skip);
      $('.ci-proj span', card).textContent = projectName(c.cwd) || (p.needsProject ? 'Pick a project' : 'No project');
      $('.ci-proj', card).classList.toggle('need', p.needsProject && !c.cwd && !c.skip);
    }
  };
  paint();
  node.addEventListener('input', (e) => {
    const key = e.target.closest('.ci-card')?.dataset.key;
    if (key && e.target.name === 'name') (picks[key].name = e.target.value), paint();
  });
  node.addEventListener('change', (e) => {
    const key = e.target.closest('.ci-card')?.dataset.key;
    if (key && e.target.name === 'pick') (picks[key].skip = !e.target.checked), paint();
  });
  node.addEventListener('click', async (e) => {
    if (e.target.closest('.close, [data-a="cancel"]')) return close();
    const card = e.target.closest('.ci-card');
    if (e.target.closest('.ci-proj') && card) {
      const p = r.members.find((x) => x.key === card.dataset.key);
      return pickProject(e.target.closest('.ci-proj'), picks[p.key].cwd, { required: p.needsProject }, (cwd) => {
        picks[p.key].cwd = cwd;
        paint();
      });
    }
    if (!e.target.closest('[data-a="add"]')) return;
    const missing = r.members.find((p) => p.needsProject && !picks[p.key].skip && !picks[p.key].cwd);
    if (missing) {
      toast(`${esc(picks[missing.key].name)} starts when CI fails: pick the project whose GitHub repo they watch`, { tone: 'bad' });
      return $(`.ci-card[data-key="${missing.key}"] .ci-proj`, node)?.focus();
    }
    close();
    // At once, paused; gone again (and the review back) if the server refuses.
    const temps = r.members.filter((p) => !picks[p.key].skip).map((p) => ({ ...p, name: picks[p.key].name.trim() || p.name, cwd: picks[p.key].cwd, id: `new-${p.key}-${Date.now()}`, paused: true, log: [], queue: [], notebook: p.notebook || '' }));
    S.config.crew = [...crewList(), ...temps];
    paintCrew();
    try {
      const out = await api('/crew/import', { method: 'POST', body: { ...src, choices: picks } });
      S.config.crew = [...crewList().filter((x) => !temps.includes(x)), ...out.members];
      renderFeed();
      const names = out.members.map((m) => m.name);
      toast(`${esc(names.length > 2 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names.join(' and '))} joined your crew, paused`, { action: { label: 'Open', run: () => openCrew(out.members[0].id) } });
    } catch (err) {
      S.config.crew = crewList().filter((x) => !temps.includes(x));
      paintCrew();
      toastError(err);
      reviewImportCrew(src, r, picks);
    }
  });
}

function memberCard(p, c) {
  const facts = [
    ['clock', p.cron ? cadenceLabel(p.cron) : 'On call'],
    ...(p.on.length ? [['bolt', eventsLabel(p)]] : []),
    [`logo:${p.agent}`, `${agentName(p.agent)}${p.model ? ` · ${p.model}` : ''} · ${modeLabel(p.mode)}`],
  ];
  const kit = p.kit || [];
  return `<div class="ci-card" data-key="${esc(p.key)}">
      <label class="ci-pick" title="Add them"><input type="checkbox" name="pick" ${c.skip ? '' : 'checked'} aria-label="Add ${esc(p.name)}"></label>
      <span class="ci-face">${avatarHtml({ ...p, id: '' }, { size: 36, dot: false, state: 'idle' })}</span>
      <div class="ci-main">
        <div class="ci-top"><input class="input sm ci-name" name="name" maxlength="24" value="${esc(c.name)}" spellcheck="false" autocomplete="off" aria-label="Name">${p.role ? `<span class="ci-role">${esc(p.role)}</span>` : ''}</div>
        <div class="ci-facts">${facts.map(([ic, t]) => `<span>${ic.startsWith('logo:') ? `<span class="cv-logo">${harnessLogo(ic.slice(5))}</span>` : icon(ic)}${esc(t)}</span>`).join('')}</div>
        ${p.notes.map((n) => `<p class="ci-note">${icon('info')}<span>${esc(n)}</span></p>`).join('')}
        <details class="ci-more"><summary>Brief${kit.length ? ` · ${plural(kit.length, 'skill or instructions file', 'skills and instructions files')}` : ''}${p.notebook ? ' · notebook' : ''}</summary>
          <div class="prose">${p.brief ? md(p.brief) : '<p class="cv-none">No brief: they do what each job asks.</p>'}</div>
          ${kit.length ? `<div class="ci-kit">${kit.map((k) => `<span title="${esc(k.kind === 'skill' ? k.description : 'Instructions, in every job')}">${icon(k.kind === 'skill' ? 'spark' : 'file')}${esc(k.name)}</span>`).join('')}</div>` : ''}
        </details>
        <button type="button" class="tog-btn ci-proj" title="The project their jobs run in">${icon('folder')}<span></span>${icon('chevron', 'chev')}</button>
      </div>
    </div>`;
}

// A .crew.json dropped anywhere on the window: review it.
document.addEventListener('drop', async (e) => {
  const f = [...(e.dataTransfer?.files || [])].find((x) => /\.crew\.json$/i.test(x.name));
  if (!f || e.defaultPrevented) return;
  e.preventDefault();
  importCrew({ text: await f.text() });
});

// #/crew?src=gist:… (a share link opened in wisp): review it.
export function routeCrew() {
  const m = location.hash.match(/^#\/crew\?src=(.+)$/);
  if (!m) return false;
  history.replaceState(history.state, '', '#/'); // the phone's Back entries keep their state
  importCrew({ url: decodeURIComponent(m[1]) });
  return true;
}

// --- a spell's member: the review before it resumes ----------------------------------------------------

// New from the spell (everything it does, and a project), or what the spell changed (each field, old
// and new). Resume sends accept: the server won't resume them without it.
export function reviewChange(m) {
  const fresh = !m.changed?.from;
  const def = m.spell?.def || { ...m, on: m.on || [] };
  const on = def.on || [];
  const needs = on.includes('ci');
  let cwd = m.cwd || (fresh ? launcherProject() : '');
  const agentOk = here(m.agent);
  const from = m.changed?.from || {};
  const rows = fresh
    ? `<div class="cr-facts">
        <span>${icon('clock')}${esc(def.cron ? cadenceLabel(def.cron) : 'On call')}</span>
        ${on.length ? `<span>${icon('bolt')}${esc(eventsLabel({ on }))}</span>` : ''}
        <span>${icon(modeOf(def.mode).icon)}${esc(modeLabel(def.mode))}</span>
      </div>
      <div class="cv-sec"><h5>Brief</h5><div class="prose">${def.brief ? md(def.brief) : '<p class="cv-none">No brief: they do what each job asks.</p>'}</div></div>
      ${(def.kit || []).length ? `<div class="cv-sec"><h5>Skills and instructions</h5><div class="ci-kit">${def.kit.map((k) => `<span>${icon(k.kind === 'skill' ? 'spark' : 'file')}${esc(k.name)}</span>`).join('')}</div></div>` : ''}`
    : changeRows(from, def);
  const node = el(`<div class="modal crew-review" role="dialog" aria-label="Review ${esc(m.name)}">
      <header><h2>${fresh ? `Meet ${esc(m.name)}` : `${esc(m.name)} changed`}</h2><button class="icon-btn close" title="Close" aria-label="Close">${icon('x')}</button></header>
      <div class="cs-who"><span class="cs-face">${avatarHtml(m, { size: 40, dot: false })}</span><div class="cs-name"><b>${esc(m.name)}${m.role ? ` · ${esc(m.role)}` : ''}</b><small>${m.spell ? `From the “${esc(m.spell.name)}” spell` : 'Their spell was removed; they’re yours now'}</small></div></div>
      <p class="hint">${fresh ? 'The spell brought them, paused. Here is what they’ll do once they start.' : 'Their spell was updated, so wisp paused them. This is what changed.'}</p>
      <div class="cr-body">${rows}</div>
      ${agentOk ? '' : `<p class="ci-note">${icon('info')}<span>Prefers ${esc(agentName(m.agent))}, which isn’t installed here: Auto picks a harness for them.</span></p>`}
      <div class="cr-proj"><span>Works in</span><button type="button" class="tog-btn ci-proj" title="The project their jobs run in">${icon('folder')}<span></span>${icon('chevron', 'chev')}</button>${needs ? '<small>Starts when CI fails: they watch this project’s GitHub repo</small>' : ''}</div>
      <footer class="ce-foot">
        <span class="grow"></span>
        <button type="button" class="ghost sm" data-a="cancel">Keep paused</button>
        <button type="button" class="primary sm" data-a="resume">${icon('play')}Resume ${esc(m.name)}</button>
      </footer>
    </div>`);
  const close = overlay(node);
  const paint = () => {
    $('.ci-proj span', node).textContent = projectName(cwd) || (needs ? 'Pick a project' : 'No project');
    $('.ci-proj', node).classList.toggle('need', needs && !cwd);
  };
  paint();
  node.addEventListener('click', async (e) => {
    if (e.target.closest('.close, [data-a="cancel"]')) return close();
    const pb = e.target.closest('.ci-proj');
    if (pb) {
      return pickProject(pb, cwd, { required: needs }, (v) => {
        cwd = v;
        paint();
      });
    }
    if (!e.target.closest('[data-a="resume"]')) return;
    if (needs && !cwd) {
      toast(`${esc(m.name)} starts when CI fails: pick the project whose GitHub repo they watch`, { tone: 'bad' });
      return $('.ci-proj', node).focus();
    }
    close();
    const body = { paused: false, accept: true, on, ...(cwd !== m.cwd && { cwd }), ...(!agentOk && { agent: 'auto', model: '', effort: '' }) };
    const before = { ...m };
    Object.assign(m, { paused: false, changed: undefined, cwd });
    renderFeed();
    try {
      Object.assign(m, await api(`/crew/${m.id}`, { method: 'PATCH', body }));
      renderFeed();
      toast(`${esc(m.name)} is on`);
    } catch (err) {
      for (const k of Object.keys(m)) if (!(k in before)) delete m[k];
      Object.assign(m, before);
      renderFeed();
      toastError(err);
    }
  });
  requestAnimationFrame(() => $('[data-a="resume"]', node)?.focus());
}

// What a spell update changed, field by field.
function changeRows(from, def) {
  const out = [];
  const same = (a, b) => JSON.stringify(a ?? '') === JSON.stringify(b ?? '');
  if (!same(from.brief, def.brief)) out.push(['Brief', `<div class="cr-diff"><small>Was</small><del class="prose">${md(from.brief || '(none)')}</del><small>Now</small><ins class="prose">${md(def.brief || '(none)')}</ins></div>`]);
  if (!same(from.cron, def.cron)) out.push(['Checks in', `<p class="cr-change"><span class="cr-was">${esc(from.cron ? cadenceLabel(from.cron) : 'On call')}</span>${icon('arrow')}<b>${esc(def.cron ? cadenceLabel(def.cron) : 'On call')}</b></p>`]);
  if (!same(from.on, def.on)) out.push(['Also starts when', `<p class="cr-change"><span class="cr-was">${esc(eventsLabel(from) || 'Nothing else')}</span>${icon('arrow')}<b>${esc(eventsLabel(def) || 'Nothing else')}</b></p>`]);
  if (!same(from.mode, def.mode)) out.push(['May do without asking', `<p class="cr-change"><span class="cr-was">${esc(modeLabel(from.mode))}</span>${icon('arrow')}<b>${esc(modeLabel(def.mode))}</b></p>`]);
  if (!same(from.kit, def.kit)) {
    const names = (l) => new Map((l || []).map((k) => [k.name, JSON.stringify(k)]));
    const a = names(from.kit);
    const b = names(def.kit);
    const lines = [...[...b.keys()].filter((n) => !a.has(n)).map((n) => `<span class="cr-plus">${icon('plus')}${esc(n)}</span>`), ...[...a.keys()].filter((n) => !b.has(n)).map((n) => `<span class="cr-minus">${icon('minus')}${esc(n)}</span>`), ...[...b.keys()].filter((n) => a.has(n) && a.get(n) !== b.get(n)).map((n) => `<span>${icon('pen')}${esc(n)}</span>`)];
    out.push(['Skills and instructions', `<div class="ci-kit">${lines.join('')}</div>`]);
  }
  return out.map(([h, body]) => `<div class="cv-sec"><h5>${h}</h5>${body}</div>`).join('');
}

// --- a spell being removed ----------------------------------------------------------------------------

// The members a spell brought: keep them as yours, or remove them with it. 'keep' | 'remove' | null.
export async function crewWithSpell(spell, anchor) {
  const names = (spell.crew || []).map((b) => b.name);
  if (!names.length) return 'keep';
  const who = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
  return ask(`Keep ${who} on your crew?\n\n${spell.name} brought ${names.length > 1 ? 'them' : 'this member'}. Kept, they’re yours to change; otherwise they leave with the spell.`, { ok: `Keep ${names.length > 1 ? 'them' : names[0]}`, altDanger: true, alt: `Remove ${names.length > 1 ? 'them' : names[0]} too`, anchor }).then((a) => (a === 'alt' ? 'remove' : a ? 'keep' : null));
}
