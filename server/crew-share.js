// Sharing crew members (design/crew-sharing.md). A blueprint is who a member is: name, role, face,
// brief, schedule, what else starts them, mode, harness, kit and delegates. Never where they run
// (cwd, machine) or what they've done (log, queue, offers; the notebook only when the sharer adds
// it). A .crew.json file is { wispCrew: 1, members: [blueprint, …] }; a spell's `crew` key is a list
// of them, checked by the same normalizeBlueprint.
//
// Imported members are yours from the start. A spell's members stay the spell's while it's on
// (m.spell, Crew.update's lock); switched off, they wait in config.crewDormant (keyed
// `<spell id>:<key>`) so the crew list and everything reading it never sees them.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adapters } from './adapters/index.js';
import { BRIEF_MAX, CREW_COLORS, DEFINITION, MAX_CREW, MAX_PARALLEL, NAME, REVIEWED, avatarOf, clampNotebook, handleOf, normalizeKit } from './crew.js';
import { MEMBER_KINDS, parseCron } from './triggers.js';
import { MAX_SUBAGENTS, normalizeTeam } from './subagents.js';
import { scanAll } from './secret-scan.js';
import { gh } from './git.js';
import { bad, MODES, truncate } from './util.js';

export const CREW_FILE = 1; // wispCrew
export const SPELL_CREW_MAX = 10;
const KEY = /^[a-z0-9][a-z0-9-]{0,40}$/;
const HARNESS = /^[\w-]{1,30}$/;

const arr = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const agentName = (id) => adapters[id]?.name || id;
// A field's problem, with the field in front ("cron: Bad hour field: 25").
const at = (field, fn) => {
  try {
    return fn();
  } catch (err) {
    throw bad(`${field}: ${err.message}`);
  }
};

// --- the blueprint ----------------------------------------------------------------------------------

// Anything → a clean blueprint, or a 400 saying what's wrong. Paths are refused: a shared member
// never brings a folder or a machine from someone else's computer.
export function normalizeBlueprint(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('A crew member is a JSON object with at least a name.');
  for (const k of ['cwd', 'machine']) if (raw[k]) throw bad(`${k}: a shared member has no ${k === 'cwd' ? 'folder' : 'machine'}; whoever adds them picks one.`);
  const name = String(raw.name || '').replace(/\s+/g, ' ').trim();
  if (!name) throw bad('name: required');
  if (!NAME.test(name)) throw bad(`name: up to 24 letters, digits, spaces, dots, dashes or underscores, not “${truncate(name, 40)}”`);
  const key = raw.key === undefined || raw.key === '' ? handleOf(name) || 'member' : String(raw.key);
  if (!KEY.test(key)) throw bad('key: lowercase letters, digits and dashes (at most 41)');
  const brief = String(raw.brief || '').replace(/\r\n/g, '\n').trim();
  if (brief.length > BRIEF_MAX) throw bad(`brief: at most ${BRIEF_MAX.toLocaleString('en')} characters`);
  const cron = String(raw.cron || '').trim();
  if (cron) at('cron', () => parseCron(cron));
  const on = [...new Set(arr(raw.on).map(String))].sort();
  for (const k of on) if (!MEMBER_KINDS.has(k)) throw bad(`on: ${k} isn't one of ${[...MEMBER_KINDS].join(', ')}`);
  const mode = String(raw.mode || 'auto');
  if (!MODES.has(mode)) throw bad('mode: plan, edits or auto');
  const agent = String(raw.agent || 'auto');
  if (!HARNESS.test(agent)) throw bad('agent: a harness id, like claude or codex (or auto)');
  const effort = String(raw.effort || '');
  if (!/^[\w-]{0,20}$/.test(effort)) throw bad('effort: a thinking level, like high');
  const parallel = raw.parallel === undefined ? 2 : Math.floor(Number(raw.parallel));
  if (!(parallel >= 1 && parallel <= MAX_PARALLEL)) throw bad(`parallel: 1 to ${MAX_PARALLEL}`);
  const kit = at('kit', () => normalizeKit(arr(raw.kit).map((k) => (k && typeof k === 'object' ? { ...k, path: undefined } : k)), () => false)).map(({ id, path: _, on: use, ...k }) => ({ ...k, ...(use === false && { on: false }) }));
  const team = arr(raw.team).map((t, i) => {
    if (!t || typeof t !== 'object') throw bad(`team[${i}]: { "crew": "<key>" } or { "agent": "codex" }`);
    if (t.crew !== undefined) {
      if (!KEY.test(String(t.crew))) throw bad(`team[${i}]: crew is the key of another member in the same file`);
      return { crew: String(t.crew) };
    }
    if (!HARNESS.test(String(t.agent || ''))) throw bad(`team[${i}]: agent is a harness id, like codex`);
    const text = (k, n) => String(t[k] || '').replace(/\s+/g, ' ').trim().slice(0, n);
    return { agent: String(t.agent), ...(text('name', 40) && { name: text('name', 40) }), ...(text('model', 120) && { model: text('model', 120) }), ...(text('effort', 20) && { effort: text('effort', 20) }), ...(text('use', 300) && { use: text('use', 300) }), ...(Number(t.count) > 1 && { count: Math.min(4, Math.floor(Number(t.count))) }) };
  });
  if (team.length > MAX_SUBAGENTS) throw bad(`team: at most ${MAX_SUBAGENTS} delegates`);
  if (team.some((t) => t.crew === key)) throw bad("team: a member can't delegate to themselves");
  const notebook = typeof raw.notebook === 'string' ? clampNotebook(raw.notebook.trim()) : '';
  return {
    key,
    name,
    role: String(raw.role || '').replace(/\s+/g, ' ').trim().slice(0, 60),
    avatar: avatarOf(raw.avatar),
    ...(CREW_COLORS.includes(raw.color) && { color: raw.color }),
    brief,
    cron,
    on,
    mode,
    agent,
    model: String(raw.model || '').slice(0, 120),
    effort,
    parallel,
    kit,
    team,
    ...(notebook && { notebook }),
  };
}

// A list of blueprints, checked together: each on its own, then unique keys and names.
export function normalizeBlueprints(list, where = 'members') {
  const out = arr(list).map((x, i) => {
    try {
      return normalizeBlueprint(x);
    } catch (err) {
      throw bad(`${where}[${i}]${x?.name ? ` (${truncate(String(x.name), 24)})` : ''}: ${err.message}`);
    }
  });
  const seen = new Map();
  out.forEach((b, i) => {
    const h = handleOf(b.name);
    if (seen.has(b.key) || [...seen.values()].includes(h)) throw bad(`${where}[${i}] (${b.name}): two members share the key ${b.key} or the name ${b.name}`);
    seen.set(b.key, h);
  });
  for (const b of out) for (const t of b.team) if (t.crew && !seen.has(t.crew)) throw bad(`${where} (${b.name}): delegates to ${t.crew}, who isn't in this file`);
  return out;
}

// What a spell owns of a member's blueprint (compared to see what an update changed).
export const definitionOf = (bp) => Object.fromEntries(DEFINITION.map((k) => [k, bp[k] ?? (k === 'on' || k === 'kit' || k === 'team' ? [] : '')]));

// A shared file, parsed: { members } — or { spell } when it's a spell (that goes to the spell review).
export function parseCrewFile(j) {
  if (j && typeof j === 'object' && j.wispSpell !== undefined) return { spell: j };
  const list = Array.isArray(j) ? j : Array.isArray(j?.members) ? j.members : j && typeof j === 'object' && j.name ? [j] : null;
  if (!list) throw bad('A crew file is { "wispCrew": 1, "members": [ … ] }.');
  if (j.wispCrew !== undefined && j.wispCrew !== CREW_FILE) throw bad(`wispCrew: this wisp reads version ${CREW_FILE}; update wisp to read this file.`);
  if (!list.length) throw bad('That file has no crew members in it.');
  if (list.length > MAX_CREW) throw bad(`At most ${MAX_CREW} members in one file.`);
  return { members: normalizeBlueprints(list) };
}

// --- sharing ----------------------------------------------------------------------------------------

// A member → its blueprint. keyOf(id): the key of a delegate shared in the same file, else null
// (that delegate stays here). on: the kinds of the triggers that send it work (Crew.on).
export function toBlueprint(m, { on = [], kit = true, notebook = false, key = handleOf(m.name) || 'member', keyOf = () => null, nameOf = () => '' } = {}) {
  const notes = [];
  const team = [];
  for (const t of m.team || []) {
    if (!t.crew) team.push({ agent: t.agent, ...(t.name && t.name !== t.agent && { name: t.name }), ...(t.model && { model: t.model }), ...(t.effort && { effort: t.effort }), ...(t.use && { use: t.use }), ...(t.count > 1 && { count: t.count }) });
    else if (keyOf(t.crew)) team.push({ crew: keyOf(t.crew) });
    else notes.push(`${m.name} delegates to ${nameOf(t.crew) || t.label || 'another member'}, who stays here (tick Who they delegate to)`);
  }
  const files = kit ? (m.kit || []).map(({ id, path: dir, on: use, ...k }) => (dir && notes.push(`${k.name} has files beside its SKILL.md that stay here; only the SKILL.md goes`), { ...k, ...(use === false && { on: false }) })) : [];
  const bp = normalizeBlueprint({ key, name: m.name, role: m.role, avatar: m.avatar, color: m.color, brief: m.brief, cron: m.cron, on, mode: m.mode, agent: m.agent, model: m.model, effort: m.effort, parallel: m.parallel, kit: files, team, ...(notebook && m.notebook && { notebook: m.notebook }) });
  return { bp, notes };
}

// Members to share (ids, names or handles) → { bundle, notes, hits, file }. team: their crew
// delegates come too (and theirs). hits: secrets the scan found; nothing may leave while there are any.
export function exportCrew(crew, ids, { kit = true, notebook = false, team = false } = {}) {
  const list = [];
  for (const id of arr(ids)) {
    const m = crew.find(id);
    if (!m) throw bad(`No one called “${id}” on your crew.`, 404);
    if (!list.includes(m)) list.push(m);
  }
  if (!list.length) throw bad('Pick who to share.');
  if (team) for (let i = 0; i < list.length; i++) for (const t of list[i].team || []) if (t.crew && crew.get(t.crew) && !list.includes(crew.get(t.crew))) list.push(crew.get(t.crew));
  const keys = new Map();
  for (const m of list) {
    const base = handleOf(m.name) || 'member';
    let k = base;
    for (let i = 2; [...keys.values()].includes(k); i++) k = `${base}-${i}`;
    keys.set(m.id, k);
  }
  const notes = [];
  const members = list.map((m) => {
    const out = toBlueprint(m, { on: crew.on(m), kit, notebook, key: keys.get(m.id), keyOf: (id) => keys.get(id) || null, nameOf: (id) => crew.get(id)?.name || '' });
    notes.push(...out.notes);
    return out.bp;
  });
  const hits = scanAll(
    Object.fromEntries(members.flatMap((b) => [[`${b.name} · role`, b.role], [`${b.name} · brief`, b.brief], [`${b.name} · notebook`, b.notebook || ''], ...b.kit.map((k) => [`${b.name} · ${k.name}`, `${k.description || ''}\n${k.body}`])])),
  );
  return { bundle: { wispCrew: CREW_FILE, members }, notes, hits, file: `${members.length === 1 ? members[0].key : 'crew'}.crew.json` };
}

// A secret gist (gh's default; never --public) holding the file. → { url, ref: 'gist:<id>' }.
export async function createGist(bundle, file, { description = 'A wisp crew member' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wisp-gist-'));
  try {
    const f = path.join(dir, file);
    fs.writeFileSync(f, `${JSON.stringify(bundle, null, 2)}\n`);
    let out;
    try {
      out = await gh(dir, ['gist', 'create', f, '--desc', description]);
    } catch (err) {
      throw bad(`Couldn't create the gist: ${err.code === 'ENOENT' ? 'the GitHub CLI (gh) isn’t installed' : err.message}. Copy it instead, or sign in to GitHub in Settings → Agents.`, 502);
    }
    const url = String(out).split(/\s+/).find((u) => /^https:\/\/gist\.github\.com\/\S+/.test(u));
    const id = /([a-f0-9]{6,64})\/?$/i.exec(url || '')?.[1];
    if (!id) throw bad(`gh didn't answer with a gist link: ${truncate(String(out), 200)}`, 502);
    return { url, ref: `gist:${id}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- importing --------------------------------------------------------------------------------------

// A name nobody on the crew has: Scout, then Scout 2, Scout 3…
export function uniqueName(name, taken) {
  const has = (n) => taken.includes(handleOf(n));
  if (!has(name)) return name;
  for (let i = 2; ; i++) {
    const n = `${name.slice(0, 23 - String(i).length).trim()} ${i}`;
    if (!has(n)) return n;
  }
}

// What importing would do, for the review and then for real: each member with the name it gets
// here, the harness it runs on, its project, and notes on what changed on the way in.
// choices: { [key]: { name, cwd, skip } }; agents: this computer's harnesses ({ id, available }).
export function planImport(members, { crew, agents = [], choices = {} }) {
  const taken = crew.list.map((m) => handleOf(m.name));
  const keys = new Set(members.filter((b) => !choices[b.key]?.skip).map((b) => b.key));
  return members.map((bp) => {
    const c = choices[bp.key] || {};
    const asked = String(c.name || bp.name).replace(/\s+/g, ' ').trim();
    if (!NAME.test(asked)) throw bad(`${asked || 'A name'}: up to 24 letters, digits, spaces, dots, dashes or underscores.`);
    const name = c.skip ? asked : uniqueName(asked, taken);
    if (!c.skip) taken.push(handleOf(name));
    const notes = [];
    if (name !== asked) notes.push(`${asked} is already on your crew: they join as ${name}`);
    const here = bp.agent === 'auto' || (adapters[bp.agent] && bp.agent !== 'wisp' && agents.some((a) => a.id === bp.agent && a.available));
    if (!here) notes.push(`Prefers ${agentName(bp.agent)}, which isn't installed here: Auto picks a harness`);
    const team = bp.team.filter((t) => {
      if (t.crew) return keys.has(t.crew) || (notes.push(`Delegates to ${members.find((b) => b.key === t.crew)?.name || t.crew}, who you left out`), false);
      return (adapters[t.agent] && t.agent !== 'wisp') || t.agent === 'auto' || (notes.push(`Delegates to ${t.agent}, a harness this wisp doesn't know`), false);
    });
    return { ...bp, name, agent: here ? bp.agent : 'auto', model: here ? bp.model : '', effort: here ? bp.effort : '', team, cwd: String(c.cwd || ''), skip: !!c.skip, needsProject: bp.on.includes('ci'), notes };
  });
}

// Adds the planned members, paused, with the triggers that send them work: all of them or none.
export function applyImport(plan, { crew, triggers }) {
  const list = plan.filter((p) => !p.skip);
  if (!list.length) throw bad('Pick at least one member to add.');
  if (crew.list.length + list.length > MAX_CREW) throw bad(`Your crew has room for ${MAX_CREW - crew.list.length} more (at most ${MAX_CREW}). Leave some out, or remove someone first.`);
  for (const p of list) if (p.needsProject && !p.cwd) throw bad(`${p.name} starts when CI fails: pick the project whose GitHub repo they watch.`);
  const made = [];
  try {
    for (const p of list) made.push([crew.create({ name: p.name, role: p.role, avatar: p.avatar, ...(p.color && { color: p.color }), brief: p.brief, cron: p.cron, mode: p.mode, agent: p.agent, model: p.model, effort: p.effort, parallel: p.parallel, kit: p.kit, notebook: p.notebook || '', cwd: p.cwd, paused: true }), p]);
    const idOf = new Map(made.map(([m, p]) => [p.key, m]));
    for (const [m, p] of made) {
      if (p.on.length) triggers.syncMember(m, p.on);
      if (p.team.length) crew.update(m, { team: p.team.map((t) => (t.crew ? { crew: idOf.get(t.crew).id, name: idOf.get(t.crew).name, role: idOf.get(t.crew).role, agent: idOf.get(t.crew).agent } : t)) });
    }
  } catch (err) {
    for (const [m] of made) forget(crew, m);
    throw err;
  }
  return made.map(([m]) => m);
}

// Gone for good: the member and the triggers that sent it work (not left behind switched off).
function forget(crew, m) {
  crew.store.config.triggers = (crew.store.config.triggers || []).filter((t) => t.crew !== m.id);
  crew.remove(m);
}

// --- a spell's members ------------------------------------------------------------------------------

const dormantKey = (m) => `${m.spell.id}:${m.spell.key}`;

// Brings the crew in line with the spells that are on (after any spell change, and at start):
// a new member for each blueprint without one, back from config.crewDormant for one switched off
// before, out to it for a spell switched off; an update applied, pausing the member when it
// changes what they do. Their triggers move with them; a new member gets its triggers when
// you resume it (the review picks its project), so nothing queues work for it before then.
export function syncSpellCrew({ crew, triggers, spells }) {
  const store = crew.store;
  const dormant = (store.config.crewDormant ||= {});
  const want = new Map();
  for (const s of spells.enabled()) for (const bp of s.crew || []) want.set(`${s.id}:${bp.key}`, { s, bp });
  let dirty = false;
  for (const m of crew.list.filter((x) => x.spell && !want.has(dormantKey(x)))) {
    const mine = (store.config.triggers || []).filter((t) => t.crew === m.id);
    store.config.triggers = (store.config.triggers || []).filter((t) => t.crew !== m.id);
    store.config.crew = crew.list.filter((x) => x !== m);
    dormant[dormantKey(m)] = { ...m, triggers: mine };
    dirty = true;
  }
  for (const [k, { s, bp }] of want) {
    let m = crew.list.find((x) => x.spell && dormantKey(x) === k);
    if (!m && dormant[k]) {
      if (crew.list.length >= MAX_CREW) {
        console.warn(`wisp: no room on the crew for ${dormant[k].name} (${s.name})`);
        continue;
      }
      const { triggers: mine = [], ...back } = dormant[k];
      delete dormant[k];
      back.name = uniqueName(back.name, crew.list.map((x) => handleOf(x.name)));
      crew.list.push(back);
      (store.config.triggers ||= []).push(...mine);
      m = back;
      dirty = true;
    }
    const def = definitionOf(bp);
    if (!m) {
      if (crew.list.length >= MAX_CREW) {
        console.warn(`wisp: no room on the crew for ${bp.name} (${s.name})`);
        continue;
      }
      try {
        m = crew.create({ ...def, team: [], name: uniqueName(bp.name, crew.list.map((x) => handleOf(x.name))), agent: adapters[bp.agent] && bp.agent !== 'wisp' ? bp.agent : 'auto', model: bp.model, effort: bp.effort, parallel: bp.parallel, notebook: bp.notebook || '', paused: true });
      } catch (err) {
        console.warn(`wisp: ${s.name} couldn't add ${bp.name}: ${err.message}`);
        continue;
      }
      Object.assign(m, { spell: { id: s.id, key: bp.key, name: s.name, def }, changed: { from: null, at: Date.now() } });
      dirty = true;
      continue;
    }
    if (m.spell.name !== s.name) (m.spell.name = s.name), (dirty = true);
    if (same(m.spell.def, def)) continue;
    const old = m.spell.def;
    const taken = crew.list.filter((x) => x !== m).map((x) => handleOf(x.name));
    try {
      crew.update(m, { role: def.role, avatar: def.avatar, ...(def.color && { color: def.color }), brief: def.brief, cron: def.cron, mode: def.mode, kit: def.kit, ...(!taken.includes(handleOf(def.name)) && { name: def.name }) }, { bySpell: true });
    } catch (err) {
      console.warn(`wisp: ${s.name} couldn't update ${m.name}: ${err.message}`);
      continue;
    }
    m.spell.def = def;
    if (REVIEWED.some((f) => !same(old?.[f], def[f]))) {
      m.paused = true;
      m.changed ||= { from: old, at: Date.now() }; // the oldest change you haven't seen
    }
    dirty = true;
  }
  // Delegates, once every member of the spell is here: { crew: key } is another of its members.
  for (const m of crew.list.filter((x) => x.spell && want.has(dormantKey(x)))) {
    const ofSpell = (key) => crew.list.find((x) => x.spell?.id === m.spell.id && x.spell.key === key);
    const team = (m.spell.def.team || []).filter((t) => (t.crew ? ofSpell(t.crew) : (adapters[t.agent] && t.agent !== 'wisp') || t.agent === 'auto')).map((t) => (t.crew ? { crew: ofSpell(t.crew).id, name: ofSpell(t.crew).name, role: ofSpell(t.crew).role, agent: ofSpell(t.crew).agent } : t));
    if (same(normalizeTeam(team, adapters), m.team || [])) continue;
    try {
      crew.update(m, { team }, { bySpell: true });
      dirty = true;
    } catch {}
  }
  if (dirty) crew.changed();
  return dirty;
}

// A spell is being removed: its members stay as yours (keep), or go with it. Dormant ones too.
export function releaseSpellCrew({ crew }, spellId, { keep = true } = {}) {
  const store = crew.store;
  const dormant = store.config.crewDormant || {};
  for (const m of crew.list.filter((x) => x.spell?.id === spellId)) {
    if (keep) delete m.spell;
    else forget(crew, m);
  }
  for (const [k, entry] of Object.entries(dormant)) {
    if (entry.spell?.id !== spellId) continue;
    delete dormant[k];
    const { triggers: mine = [], spell: _, ...m } = entry;
    if (keep && crew.list.length < MAX_CREW) {
      m.name = uniqueName(m.name, crew.list.map((x) => handleOf(x.name)));
      m.paused = true;
      crew.list.push(m);
      (store.config.triggers ||= []).push(...mine);
    } else if (store.home) fs.rmSync(path.join(store.home, 'crew', m.id), { recursive: true, force: true });
  }
  crew.changed();
}

// The members a spell has here (on or switched off), for the remove dialog.
export const spellMembers = ({ crew }, spellId) => [...crew.list, ...Object.values(crew.store.config.crewDormant || {})].filter((m) => m.spell?.id === spellId).map((m) => m.name);
