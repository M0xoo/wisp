// A crew member's kit (server/crew.js, web/js/skill-md.js): instructions files it follows on every
// job (an AGENTS.md) and skills it reads when a job fits one. Here: the Skills and instructions
// section in its details, the Add menu, the editor, the picker for the ones already on this
// computer (~/.claude/skills, ~/.codex/AGENTS.md, …), .md files dropped on the section, and
// Generate: a job where the member studies its job and project and proposes its own files, which
// come back as an offer (m.offers) that its thread shows under that job for you to pick from.
//
// Every change is the member's whole kit, PATCHed optimistically by crew.js (patch): the row
// changes at once and goes back with a toast if the server refuses.

import { esc } from '../md.js';
import { api } from '../core/api.js';
import { $, $$, el, icon } from '../core/dom.js';
import { overlay } from '../ui/overlay.js';
import { popover } from '../ui/popover.js';
import { toast, toastError } from '../ui/toast.js';
import { KIT_BODY_MAX, KIT_MAX, parseSkillMd, skillName } from '../skill-md.js';

const newKitId = () => Math.random().toString(36).slice(2, 12).padEnd(10, '0');
const size = (n) => (n < 1000 ? `${n} characters` : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k characters`);
const same = (a, b) => a.kind === b.kind && a.name.toLowerCase() === b.name.toLowerCase();

// The section: one row a file (what it is, its switch), or what it's for while empty.
// A spell's member: its spell owns the kit, so the rows read but don't change (Make it mine first).
export function kitHtml(m) {
  const kit = m.kit || [];
  const locked = !!m.spell;
  const rows = kit
    .map(
      (k) => `<div class="ck-row${k.on === false ? ' off' : ''}" data-kit-row="${esc(k.id)}">
        <button class="ck-open" data-kit="${esc(k.id)}" title="${locked ? `From the “${esc(m.spell.name)}” spell` : k.kind === 'skill' ? 'Edit this skill' : 'Edit these instructions'}" ${locked ? 'disabled' : ''}>${icon(k.kind === 'skill' ? 'spark' : 'file')}<span class="ck-text one"><b>${esc(k.name)}</b><small title="${esc(k.kind === 'skill' ? k.description : `Every job · ${size(k.body.length)}`)}">${esc(k.kind === 'skill' ? k.description : `Every job · ${size(k.body.length)}`)}</small></span></button>
        <button class="switch" role="switch" aria-checked="${k.on !== false}" data-kit-on="${esc(k.id)}" title="${k.on === false ? 'Off: kept, not used' : 'On: in their jobs'}" aria-label="Use ${esc(k.name)}" ${locked ? 'disabled' : ''}></button>
      </div>`,
    )
    .join('');
  return `<div class="cv-sec cv-kit"><h5>Skills and instructions ${kit.length ? `<small>${kit.length}</small>` : ''}${locked ? '' : `<button class="link xs" data-kit-add aria-haspopup="menu">${icon('plus')}Add</button>`}</h5>
    ${rows || `<p class="cv-none">${locked ? 'None: their spell gave them no skills or instructions.' : 'An AGENTS.md they follow on every job, or skills they read when a job needs one. Drop .md files here too.'}</p>`}</div>`;
}

// A click in the section. patch(m, body) saves (crew.js patchMember, optimistic); send(m, prompt,
// { kit }) hands it a job (crew.js sendJob).
export function kitClick(e, m, patch, send) {
  if (m.spell) return;
  const add = e.target.closest('[data-kit-add]');
  if (add) return addMenu(add, m, patch, send);
  const on = e.target.closest('[data-kit-on]')?.dataset.kitOn;
  if (on) return patch(m, { kit: (m.kit || []).map((k) => (k.id === on ? { ...k, on: k.on === false } : k)) });
  const id = e.target.closest('[data-kit]')?.dataset.kit;
  const k = id && (m.kit || []).find((x) => x.id === id);
  if (k) return kitEditor(m, patch, { item: k });
}

function addMenu(anchor, m, patch, send) {
  $('.menu.ck-menu')?.close();
  const menu = el(`<div class="menu ck-menu" role="menu">
      <button data-k="generate">${icon('wizard')}<span>Generate with ${esc(m.name)}…<small>They study the job and propose their own; you pick</small></span></button>
      <button data-k="rules">${icon('file')}<span>Instructions file<small>An AGENTS.md they follow on every job</small></span></button>
      <button data-k="skill">${icon('spark')}<span>Skill<small>A how-to they read when a job needs it</small></span></button>
      <button data-k="local">${icon('laptop')}<span>From this computer…<small>Your harnesses’ skills and AGENTS.md files</small></span></button>
      <button data-k="upload">${icon('clip')}<span>Upload .md files…<small>A SKILL.md becomes a skill, the rest instructions</small></span></button>
    </div>`);
  menu.onclick = (e) => {
    const k = e.target.closest('button')?.dataset.k;
    if (!k) return;
    close();
    if (k === 'generate') return generateDialog(m, send);
    if ((m.kit || []).length >= KIT_MAX) return toast(`${esc(m.name)} has ${KIT_MAX} files already. Remove one first.`, { tone: 'bad' });
    if (k === 'rules' || k === 'skill') kitEditor(m, patch, { kind: k });
    if (k === 'local') importDialog(m, patch);
    if (k === 'upload') pickFiles(m, patch);
  };
  const close = popover(menu, { anchor });
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`;
  menu.style.top = `${Math.max(8, r.bottom + 6 + h > innerHeight ? r.top - h - 6 : r.bottom + 6)}px`;
  $('button', menu).focus();
}

// The kit with files added (one with the same kind and name is replaced, keeping its switch).
function mergeKit(m, items) {
  const kit = [...(m.kit || [])];
  for (const it of items) {
    const at = kit.findIndex((k) => same(k, it));
    if (at >= 0) kit[at] = { ...kit[at], ...it, id: kit[at].id };
    else kit.push({ id: newKitId(), on: true, ...it });
  }
  return kit;
}

// Adds files to the kit. Resolves with whether it saved.
const addToKit = (m, patch, items) => patch(m, { kit: mergeKit(m, items) });

// --- the editor --------------------------------------------------------------------------------

// item: edit it; kind: a new one. draft: what was typed, back after the server refused it (or a
// proposed file to look over). onSaved(file): after the server took it.
export function kitEditor(m, patch, { item = null, kind = item?.kind || 'rules', draft = null, onSaved = null } = {}) {
  const skill = kind === 'skill';
  const d = draft || { name: item?.name ?? (skill ? '' : 'AGENTS.md'), description: item?.description || '', body: item?.body || '' };
  const node = el(`<div class="modal kit-edit" role="dialog" aria-label="${skill ? 'Skill' : 'Instructions file'}">
      <header><h2>${item ? `Edit ${esc(item.name)}` : skill ? `New skill for ${esc(m.name)}` : `Instructions for ${esc(m.name)}`}</h2><button class="icon-btn close" title="Close" aria-label="Close">${icon('x')}</button></header>
      <form class="ce-form">
        <label class="ce-stack"><span>Name <small>${skill ? 'lowercase, with dashes: release-notes' : 'like AGENTS.md or style.md'}</small></span>
          <input class="input mono" name="name" maxlength="64" spellcheck="false" autocomplete="off" required placeholder="${skill ? 'release-notes' : 'AGENTS.md'}"></label>
        ${skill ? `<label class="ce-stack"><span>When to use it <small>in every job’s prompt: how they know to read it</small></span><textarea class="textarea" name="description" rows="2" maxlength="1024" required placeholder="Writing release notes or a CHANGELOG entry for a release."></textarea></label>` : ''}
        <label class="ce-stack"><span>${skill ? 'The skill' : 'Instructions'} <small>${skill ? 'markdown; read when a job fits. Paste a whole SKILL.md and the name and When fill in' : 'markdown; in every job’s prompt'}</small></span>
          <textarea class="textarea mono ke-body" name="body" rows="14" maxlength="${KIT_BODY_MAX}" spellcheck="false" required placeholder="${skill ? '1. Read the commits since the last tag…' : '- Run the tests before you report.\n- Never push to main.'}"></textarea></label>
        <footer class="ce-foot">
          ${item ? `<button type="button" class="ghost sm danger" data-a="drop">${icon('trash')}Remove</button>` : ''}
          <span class="grow"></span><small class="ke-count"></small>
          <button type="button" class="ghost sm" data-a="cancel">Cancel</button>
          <button class="primary sm">${item ? 'Save' : 'Add'}</button>
        </footer>
      </form>
    </div>`);
  const close = overlay(node);
  const f = $('form', node);
  const $f = (n) => $(`[name="${n}"]`, f);
  $f('name').value = d.name;
  if (skill) $f('description').value = d.description;
  $f('body').value = d.body;
  const count = () => ($('.ke-count', node).textContent = $f('body').value.length > 2000 ? size($f('body').value.length) : '');
  count();
  $('.close', node).onclick = () => {
    close();
  };
  $('[data-a="cancel"]', node).onclick = () => {
    close();
  };
  const drop = $('[data-a="drop"]', node);
  if (drop)
    drop.onclick = () => {
      close();
      patch(m, { kit: (m.kit || []).filter((k) => k.id !== item.id) });
    };
  // A pasted SKILL.md: its front matter fills the name and When; the rest is the skill.
  $f('body').addEventListener('input', () => {
    count();
    const v = $f('body').value;
    if (!skill || !v.startsWith('---\n')) return;
    const sk = parseSkillMd(v);
    if (sk.body === v.trim()) return;
    if (sk.name && !$f('name').value) $f('name').value = skillName(sk.name);
    if (sk.description && !$f('description').value) $f('description').value = sk.description;
    $f('body').value = sk.body;
    count();
  });
  if (skill) $f('name').addEventListener('blur', () => ($f('name').value = skillName($f('name').value)));
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    const next = { kind, name: skill ? skillName($f('name').value) : $f('name').value.trim(), ...(skill && { description: $f('description').value.trim() }), body: $f('body').value.trim() };
    const missing = ['name', ...(skill ? ['description'] : []), 'body'].find((k) => !next[k]);
    if (missing) {
      $f(missing).setAttribute('aria-invalid', 'true');
      return $f(missing).focus();
    }
    const clash = (m.kit || []).find((k) => k.id !== item?.id && same(k, next));
    if (clash) {
      $f('name').setAttribute('aria-invalid', 'true');
      $f('name').focus();
      return toast(`${esc(m.name)} already has ${skill ? 'a skill' : 'a file'} named ${esc(next.name)}.`, { tone: 'bad' });
    }
    close();
    const kit = item ? (m.kit || []).map((k) => (k.id === item.id ? { ...k, ...next } : k)) : [...(m.kit || []), { id: newKitId(), on: true, ...next }];
    // Refused: the editor comes back with what you typed.
    patch(m, { kit }).then((ok) => (ok ? onSaved?.(next) : kitEditor(m, patch, { item, kind, draft: next, onSaved })));
  });
  for (const x of $$('input, textarea', f)) x.addEventListener('input', () => x.removeAttribute('aria-invalid'));
  setTimeout(() => (item || !skill ? $f('body') : $f('name')).focus());
}

// --- from this computer ------------------------------------------------------------------------------

let lastLocal = null; // the last list, shown at once while a fresh one loads

function importDialog(m, patch) {
  const node = el(`<div class="modal kit-import" role="dialog" aria-label="Add from this computer">
      <header><h2>Add to ${esc(m.name)} from this computer</h2><button class="icon-btn close" title="Close" aria-label="Close">${icon('x')}</button></header>
      <p class="hint">A copy goes in their kit; a skill with scripts or references beside its SKILL.md keeps reading them from its folder.</p>
      <div class="ki-list"></div>
      <footer class="ce-foot"><span class="grow"></span><button type="button" class="ghost sm" data-a="cancel">Cancel</button><button class="primary sm" data-a="add" disabled>Add</button></footer>
    </div>`);
  const close = overlay(node);
  const list = $('.ki-list', node);
  const picked = new Set();
  let data = lastLocal;
  // Added: the same file is in the kit already (one with only the same name isn't).
  const have = (it) => (m.kit || []).some((k) => same(k, it) && k.body === it.body);
  const rowHtml = (it, i) => `<label class="ki-row${have(it) ? ' added' : ''}"><input type="checkbox" data-i="${i}" ${have(it) ? 'disabled' : picked.has(i) ? 'checked' : ''}>${icon(it.kind === 'skill' ? 'spark' : 'file')}<span class="ki-text"><b>${esc(it.name)}</b>${it.description ? `<small>${esc(it.description)}</small>` : ''}<code>${esc(it.from)}${it.files ? ` · ${it.files} more file${it.files > 1 ? 's' : ''}` : ''}</code></span>${have(it) ? '<span class="ki-pill">Added</span>' : ''}</label>`;
  const all = () => (data ? [...data.skills.map((x) => ({ ...x, kind: 'skill' })), ...data.rules.map((x) => ({ ...x, kind: 'rules' }))] : []);
  const paint = () => {
    if (!data) {
      // Loading: rows the shape of the real ones.
      list.innerHTML = `<h5>Skills</h5>${'<div class="ki-row ph"><i></i><span class="ki-text"><b></b><small></small></span></div>'.repeat(3)}`;
      return;
    }
    const items = all();
    const sec = (title, kind) => {
      const rows = items.map((it, i) => (it.kind === kind ? rowHtml(it, i) : '')).join('');
      return `<h5>${title}</h5>${rows || `<p class="cv-none">${kind === 'skill' ? 'No skills in ~/.claude/skills, ~/.agents/skills, ~/.codex/skills or ~/.gemini/skills.' : 'No CLAUDE.md, AGENTS.md or GEMINI.md in your harnesses’ folders or this project.'}</p>`}`;
    };
    list.innerHTML = sec('Skills', 'skill') + sec('Instructions', 'rules');
    const add = $('[data-a="add"]', node);
    add.disabled = !picked.size;
    add.textContent = picked.size ? `Add ${picked.size}` : 'Add';
  };
  paint();
  api(`/crew-kit${m.cwd && !m.machine ? `?cwd=${encodeURIComponent(m.cwd)}` : ''}`)
    .then((x) => {
      data = lastLocal = x;
      picked.clear();
      paint();
    })
    .catch((err) => {
      if (!data) list.innerHTML = `<p class="cv-none">Couldn’t look: ${esc(err.message)}</p>`;
    });
  list.addEventListener('change', (e) => {
    const i = Number(e.target.dataset.i);
    if (e.target.checked) picked.add(i);
    else picked.delete(i);
    paint();
  });
  $('.close', node).onclick = () => {
    close();
  };
  $('[data-a="cancel"]', node).onclick = () => {
    close();
  };
  $('[data-a="add"]', node).onclick = () => {
    const items = all().filter((_, i) => picked.has(i));
    if ((m.kit || []).length + items.length > KIT_MAX) return toast(`That’s more than ${KIT_MAX} files. Pick fewer.`, { tone: 'bad' });
    close();
    addToKit(
      m,
      patch,
      // A skill with the same name is its newer copy and replaces it; instructions with the same
      // name (two AGENTS.md) are different files, named after where they came from.
      items.map(({ kind, name, description, body, path, from }, i) => ({
        kind,
        name: kind === 'rules' && [...(m.kit || []), ...items.slice(0, i)].some((k) => same(k, { kind, name })) ? from.replace(/[^\w .-]+/g, ' ').replace(/^[^\w]+/, '').trim().slice(-60) : name,
        ...(kind === 'skill' && { description: description || `Use for ${name.replace(/-/g, ' ')}.` }),
        body,
        ...(path && { path }),
      })),
    );
  };
}

// --- .md files: picked or dropped ----------------------------------------------------------------

function pickFiles(m, patch) {
  const input = el('<input type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" multiple hidden>');
  input.onchange = () => {
    addFiles(m, patch, [...input.files]);
    input.remove();
  };
  document.body.append(input);
  input.click();
}

// A SKILL.md (or any file with a name and description up top) is a skill; anything else is an
// instructions file under its own name.
export async function addFiles(m, patch, files) {
  const md = files.filter((f) => /\.(md|markdown|txt)$/i.test(f.name) && f.size <= KIT_BODY_MAX * 2);
  if (!md.length) return toast('Drop .md files: a SKILL.md, an AGENTS.md…', { tone: 'bad' });
  try {
    const items = await Promise.all(
      md.map(async (f) => {
        const text = await f.text();
        const sk = parseSkillMd(text);
        if (/^skill\.md$/i.test(f.name) || (sk.name && sk.description)) return { kind: 'skill', name: skillName(sk.name || f.name.replace(/\.\w+$/, '')), description: sk.description || `Use for ${skillName(sk.name || f.name).replace(/-/g, ' ')}.`, body: sk.body.slice(0, KIT_BODY_MAX) };
        return { kind: 'rules', name: f.name.replace(/[^\w .-]/g, '').slice(0, 60) || 'AGENTS.md', body: text.trim().slice(0, KIT_BODY_MAX) };
      }),
    );
    if ((m.kit || []).length + items.length > KIT_MAX) return toast(`That’s more than ${KIT_MAX} files for ${esc(m.name)}.`, { tone: 'bad' });
    addToKit(m, patch, items);
  } catch (err) {
    toastError(err);
  }
}

// --- generate: the member builds its own kit ----------------------------------------------------------

const ideas = (m) => [
  m.role ? `Make yourself the best ${m.role} for this project` : 'Make yourself the best engineer for this project',
  'Learn our conventions and write them down as your rules',
  'A skill for each kind of job you get most',
  ...((m.kit || []).length ? ['Improve the skills you have'] : []),
];

function generateDialog(m, send) {
  const node = el(`<div class="modal kit-gen" role="dialog" aria-label="Generate a kit">
      <header><h2>Have ${esc(m.name)} build their kit</h2><button class="icon-btn close" title="Close" aria-label="Close">${icon('x')}</button></header>
      <form class="ce-form">
        <label class="ce-stack"><span>What should they get great at?</span>
          <textarea class="textarea" name="goal" rows="3" maxlength="2000" placeholder="${esc(ideas(m)[0])}."></textarea></label>
        <div class="ce-cadence">${ideas(m).map((t) => `<button type="button" class="lp-chip" data-idea="${esc(t)}">${esc(t)}</button>`).join('')}</div>
        <p class="hint">${esc(m.name)} reads their brief, notebook and kit${m.cwd ? ', and the project’s docs and code' : ''}, then proposes an AGENTS.md and a few skills under the job in their thread. Nothing joins their kit until you pick it.</p>
        <footer class="ce-foot"><span class="grow"></span><button type="button" class="ghost sm" data-a="cancel">Cancel</button><button class="primary sm">${icon('wizard')}Start</button></footer>
      </form>
    </div>`);
  const close = overlay(node);
  const ta = $('textarea', node);
  $('.close', node).onclick = () => {
    close();
  };
  $('[data-a="cancel"]', node).onclick = () => {
    close();
  };
  $('.ce-cadence', node).onclick = (e) => {
    const t = e.target.closest('[data-idea]')?.dataset.idea;
    if (!t) return;
    ta.value = `${t}.`;
    ta.focus();
  };
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('form', node).requestSubmit();
  });
  $('form', node).addEventListener('submit', (e) => {
    e.preventDefault();
    const goal = ta.value.trim() || `${ideas(m)[0]}.`;
    close();
    send(m, goal, { kit: true, restore: () => generateDialog(m, send) });
  });
  setTimeout(() => ta.focus());
}

// --- an offer: files a job proposed, under that job in the thread -----------------------------------------

const unpicked = new Map(); // offer id -> indexes you unticked
const edited = new Map(); // offer id -> names you already added through the editor

export function offerHtml(m, o) {
  if (!o) return '';
  if (o.state !== 'open')
    return `<div class="cv-offer settled" data-offer="${esc(o.id)}">${icon(o.state === 'taken' ? 'check' : 'x')}<span>${o.state === 'taken' && o.names?.length ? `Added to their kit: ${o.names.map((n) => `<code>${esc(n)}</code>`).join(', ')}` : `Dismissed ${o.files.length} proposed file${o.files.length > 1 ? 's' : ''}`}</span></div>`;
  const off = unpicked.get(o.id) || new Set();
  const done = edited.get(o.id) || new Set();
  const n = o.files.filter((f, i) => !off.has(i) && !done.has(f.name)).length;
  const rows = o.files
    .map((f, i) => {
      const was = (m.kit || []).find((k) => same(k, f));
      const tag = done.has(f.name) ? '<span class="ki-pill">Added</span>' : was ? `<span class="ki-pill">${was.body === f.body ? 'Same as yours' : 'Replaces yours'}</span>` : '';
      return `<div class="co-row${done.has(f.name) ? ' added' : ''}">
        <input type="checkbox" data-offer-pick="${i}" ${done.has(f.name) ? 'checked disabled' : off.has(i) ? '' : 'checked'} aria-label="Add ${esc(f.name)}">
        <button class="ck-open" data-offer-edit="${i}" title="Read and edit it before adding">${icon(f.kind === 'skill' ? 'spark' : 'file')}<span class="ck-text"><b>${esc(f.name)}</b><small>${esc(f.kind === 'skill' ? f.description : `Every job · ${size(f.body.length)}`)}</small></span></button>
        ${tag}
      </div>`;
    })
    .join('');
  return `<div class="cv-offer" data-offer="${esc(o.id)}">
      <p class="co-head">${icon('wizard')}<b>Proposed for ${esc(m.name)}’s kit</b><small>${o.files.length} file${o.files.length > 1 ? 's' : ''} · click one to read it</small></p>
      ${rows}
      <div class="co-acts"><button class="primary sm" data-offer-add ${n ? '' : 'disabled'}>${n ? `Add ${n} to their kit` : 'Add to their kit'}</button><button class="ghost sm" data-offer-drop>${done.size ? 'Done' : 'Dismiss'}</button></div>
    </div>`;
}

// A click in an offer. repaint(): the thread again (a tick changes the button's count).
export function offerClick(e, m, patch, repaint) {
  const o = (m.offers || []).find((x) => x.id === e.target.closest('[data-offer]')?.dataset.offer);
  if (!o || o.state !== 'open') return;
  const settle = (state, names) => (m.offers || []).map((x) => (x.id === o.id ? { ...x, state, names } : x));
  const pick = e.target.closest('[data-offer-pick]');
  if (pick) {
    const off = unpicked.get(o.id) || new Set();
    const i = Number(pick.dataset.offerPick);
    if (pick.checked) off.delete(i);
    else off.add(i);
    unpicked.set(o.id, off);
    return repaint();
  }
  const ed = e.target.closest('[data-offer-edit]');
  if (ed) {
    const f = o.files[Number(ed.dataset.offerEdit)];
    const done = edited.get(o.id) || new Set();
    if (done.has(f.name)) return kitEditor(m, patch, { item: (m.kit || []).find((k) => same(k, f)) });
    // Its own copy, or yours with it written over (same name): saving adds it.
    return kitEditor(m, patch, {
      item: (m.kit || []).find((k) => same(k, f)) || null,
      kind: f.kind,
      draft: f,
      onSaved: (saved) => {
        edited.set(o.id, new Set([...done, saved.name, f.name]));
        repaint();
      },
    });
  }
  const done = [...(edited.get(o.id) || [])];
  if (e.target.closest('[data-offer-drop]')) return patch(m, { offers: settle(done.length ? 'taken' : 'dismissed', done) });
  if (e.target.closest('[data-offer-add]')) {
    const off = unpicked.get(o.id) || new Set();
    const files = o.files.filter((f, i) => !off.has(i) && !done.includes(f.name));
    const kit = mergeKit(m, files);
    if (kit.length > KIT_MAX) return toast(`That makes more than ${KIT_MAX} files for ${esc(m.name)}. Untick some, or remove one from their kit.`, { tone: 'bad' });
    return patch(m, { kit, offers: settle('taken', [...done, ...files.map((f) => f.name)]) });
  }
}
