// Spells: changes to wisp you ask for (or get from a colleague) that wisp layers over itself at
// runtime. A spell is one JSON file in ~/.wisp/spells/<id>.json; ~/.wisp/spells.json says which are
// on. Nothing a spell adds is written into config.json: wisp merges spells in when it reads, so
// turning one off puts wisp back exactly where it was, and the file is all there is to share.
//
// What a spell may contain is checked here (normalizeSpell) against web/js/spell-schema.js, the
// table the page uses to apply them. describeSpell() says in plain words what one does, for the
// review dialog and the Cast a spell agent.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  ACTIONS, BUILTIN_BLOCKS, CARD_HEAD_ORDER, EVENTS, HOOK_ACTIONS, HOOK_IF, ICONS, PART_PROPS, PARTS, PROP_RANGE, SETTINGS, SLOTS, SPELL_VERSION, TOKENS,
  ghProblem, kebab, scriptBody, scriptExports, styleProblem, wispPathProblem,
} from '../web/js/spell-schema.js';
import { normalizeRecipe } from './recipes.js';
import { normalizeBlueprints, SPELL_CREW_MAX } from './crew-share.js';
import { bad, clip, truncate, writeJsonAtomic } from './util.js';

const ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
const MAX_SCRIPT = 64 * 1024;
const MAX_ITEMS = 40; // per list in a spell
const MAX_PROMPT = 600; // characters per prompt rule
const MAX_DOC = 400; // characters per agent block doc

const str = (v, n = 200) => (v === undefined || v === null ? '' : clip(String(v), n));
const arr = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);

// One problem list per spell: every check pushes a message, and a spell with any is refused.
class Problems extends Array {
  at_(where, msg) {
    this.push(`${where}: ${msg}`);
  }
}

function checkAction(a, where, p, { hook = false, panels = new Set(), data = new Set(), fns = new Set() } = {}) {
  const o = obj(a);
  if (!o) return p.at_(where, 'do must be an object like { "open": "https://…" }'), null;
  const keys = Object.keys(o).filter((k) => k in ACTIONS);
  if (keys.length !== 1) return p.at_(where, `do needs exactly one of ${Object.keys(ACTIONS).join(', ')}`), null;
  const k = keys[0];
  const v = o[k];
  if (hook && !HOOK_ACTIONS.has(k)) return p.at_(where, `a hook can only ${[...HOOK_ACTIONS].join(', ')}`), null;
  const text = (x) => typeof x === 'string' && x.trim();
  switch (k) {
    case 'open':
    case 'webhook':
      // A link, or a template that becomes one ({pr.url}); the page checks the filled-in link again.
      if (!text(v) || !(/^https?:\/\//i.test(v.trim()) || (k === 'open' && /^\{[\w.]+\}/.test(v.trim())))) p.at_(where, `${k} needs an http(s) URL`);
      return { [k]: str(v, 500) };
    case 'openAll': {
      const x = obj(v);
      // { fn, with } (or `data`, as stored): links a script function returns from those sources.
      if (x?.fn) {
        if (!fns.has(x.fn)) p.at_(where, `openAll: the script exports no function ${x.fn}`);
        return { openAll: { fn: str(x.fn, 60), data: arr(x.with ?? x.data).map((d) => str(d, 40)) } };
      }
      if (x?.data) {
        if (!data.has(x.data)) p.at_(where, `openAll: no data source named ${x.data}`);
        return { openAll: { data: str(x.data, 40), field: str(x.field || 'url', 60) } };
      }
      p.at_(where, 'openAll needs { "data": "<source>", "field": "url" } or { "fn": "<script function>" }');
      return null;
    }
    case 'panel':
      if (!panels.has(v)) p.at_(where, `no panel named ${v}`);
      return { panel: str(v, 40) };
    case 'insert':
    case 'copy':
    case 'toast':
    case 'send':
    case 'reply':
    case 'notify':
    case 'exec':
    case 'recipe':
      if (!text(v)) p.at_(where, `${k} needs text`);
      // Kept as written (line breaks, a trailing space after "Explain why "), only capped.
      return { [k]: k === 'exec' ? str(v, 1000) : truncate(String(v), 4000) };
    case 'ship':
    case 'done':
    case 'archive':
      return { [k]: true };
    case 'setLaunch':
    case 'launchWith':
    case 'rerun':
    case 'launch': {
      const x = obj(v) || {};
      const out = {};
      for (const f of ['agent', 'model', 'effort', 'mode', 'text', 'prompt', 'cwd']) if (x[f] !== undefined) out[f] = f === 'prompt' || f === 'text' ? truncate(String(x[f]), 4000) : str(x[f], 200);
      if (out.mode && !['plan', 'edits', 'auto'].includes(out.mode)) p.at_(where, 'mode must be plan, edits or auto');
      if (k === 'launch' && !out.prompt) p.at_(where, 'launch needs a prompt');
      return { [k]: out };
    }
  }
  return null;
}

// The kind a spell's riskiest part makes it: safe < acts < reads < runs.
const RANK = { safe: 0, acts: 1, reads: 2, runs: 3 };

// Validate and normalize a spell. Throws a 400 listing every problem.
export function normalizeSpell(raw) {
  const p = new Problems();
  const j = obj(raw);
  if (!j) throw bad('A spell is a JSON object.');
  if (j.wispSpell !== SPELL_VERSION) p.at_('wispSpell', `must be ${SPELL_VERSION}`);
  const id = String(j.id || '').trim();
  if (!ID.test(id)) p.at_('id', 'lowercase letters, digits and dashes, starting with a letter or digit (at most 41)');
  const name = str(j.name, 60).trim();
  if (!name) p.at_('name', 'required');
  const known = new Set(['wispSpell', 'id', 'name', 'version', 'description', 'author', 'wisp', 'harnesses', 'when', 'data', 'buttons', 'chips', 'panels', 'blocks', 'parts', 'ui', 'prompt', 'settings', 'slash', 'commands', 'hooks', 'recipes', 'crew', 'script']);
  const warnings = Object.keys(j).filter((k) => !known.has(k)).map((k) => `${k}: not something spells know about yet, ignored`);

  // script: plain JS whose exported functions render panels, chips and blocks in the sandbox.
  const script = typeof j.script === 'string' ? j.script : '';
  if (script.length > MAX_SCRIPT) p.at_('script', `at most ${MAX_SCRIPT / 1024} KB`);
  const fns = new Set(scriptExports(script));
  if (script) {
    try {
      new Function(scriptBody(script)); // compiles; never called here
    } catch (err) {
      p.at_('script', `doesn't compile: ${err.message}`);
    }
  }
  const needFn = (fn, where) => fn && !fns.has(fn) && p.at_(where, `the script exports no function ${fn}`);

  // data: what wisp fetches for the spell. Mod code never fetches anything itself.
  const data = {};
  for (const [k, v] of Object.entries(obj(j.data) || {})) {
    const where = `data.${k}`;
    const x = obj(v);
    if (!/^[A-Za-z_][\w]{0,30}$/.test(k) || !x) {
      p.at_(where, 'a source is { "wisp": "/sessions" } or { "gh": ["pr", "list", …] }');
      continue;
    }
    const refresh = Math.min(Math.max(Number(x.refresh) || 60, 10), 3600);
    if (x.wisp !== undefined) {
      const e = wispPathProblem(x.wisp);
      if (e) p.at_(where, e);
      data[k] = { wisp: String(x.wisp), refresh };
    } else if (x.gh !== undefined) {
      const e = ghProblem(x.gh);
      if (e) p.at_(where, e);
      data[k] = { gh: x.gh.map(String), refresh, ...(x.cwd === 'task' && { cwd: 'task' }) };
    } else p.at_(where, 'a source is { "wisp": "/path" } or { "gh": [args] }');
  }
  const dataNames = new Set(Object.keys(data));

  const panelIds = new Set(arr(j.panels).map((x) => x?.id).filter(Boolean));
  const ctx = { panels: panelIds, data: dataNames, fns };

  const icon = (v, where) => {
    if (v === undefined || v === '') return '';
    if (!ICONS.includes(v)) p.at_(where, `icon must be one of ${ICONS.join(', ')}`);
    return String(v);
  };
  const when = (v) => (obj(v) ? Object.fromEntries(Object.entries(v).filter(([k]) => ['hasPr', 'prState', 'state', 'status', 'agent', 'project', 'unread', 'hasBranch'].includes(k))) : undefined);
  const slotOk = (slot, where, allowed) => {
    if (!(slot in SLOTS)) p.at_(where, `slot must be one of ${Object.keys(SLOTS).join(', ')}`);
    else if (allowed && !allowed.includes(slot)) p.at_(where, `this goes in ${allowed.join(', ')}`);
  };

  const BUTTON_SLOTS = ['topbar', 'float', 'palette', 'launcher.bar', 'launcher.chips', 'composer.bar', 'composer.chips', 'card.hover', 'card.menu', 'sidebar.top', 'split.head', 'split.details', 'term.head', 'crew.page'];
  const buttons = arr(j.buttons).slice(0, MAX_ITEMS).map((b, i) => {
    const where = `buttons[${i}]`;
    const x = obj(b) || {};
    slotOk(x.slot, where, BUTTON_SLOTS);
    const label = str(x.label, 40);
    if (!label && !x.icon) p.at_(where, 'needs a label or an icon');
    const badge = obj(x.badge);
    if (badge?.count && !dataNames.has(badge.count)) p.at_(where, `badge counts ${badge.count}, which isn't a data source`);
    if (badge?.fn) needFn(badge.fn, where);
    return {
      id: str(x.id || `b${i}`, 40),
      slot: x.slot,
      label,
      icon: icon(x.icon, where),
      title: str(x.title, 120),
      ...(badge && { badge: badge.count ? { count: str(badge.count, 40) } : badge.fn ? { fn: str(badge.fn, 60), data: arr(badge.with ?? badge.data).map((d) => str(d, 40)) } : { text: str(badge.text, 40) } }),
      ...(x.group && { group: str(x.group, 30) }),
      ...(x.corner && { corner: x.corner === 'bottom-left' ? 'bottom-left' : 'bottom-right' }),
      ...(x.key && { key: str(x.key, 20) }),
      ...(when(x.when) && { when: when(x.when) }),
      ...(x.primary && { primary: true }),
      do: checkAction(x.do, where, p, ctx),
    };
  });

  const chips = arr(j.chips).slice(0, MAX_ITEMS).map((c, i) => {
    const where = `chips[${i}]`;
    const x = obj(c) || {};
    slotOk(x.slot, where, ['card.head', 'launcher.chips', 'composer.chips']);
    if (!x.text && !x.fn) p.at_(where, 'needs text (a {field} template) or fn');
    needFn(x.fn, where);
    return {
      id: str(x.id || `c${i}`, 40),
      slot: x.slot,
      text: str(x.text, 120),
      ...(x.fn && { fn: str(x.fn, 60), data: arr(x.with ?? x.data).map((d) => str(d, 40)) }),
      tone: ['good', 'bad', 'warn', 'info', 'neutral'].includes(x.tone) ? x.tone : 'neutral',
      icon: icon(x.icon, where),
      title: str(x.title, 160),
      ...(when(x.when) && { when: when(x.when) }),
      ...(x.do && { do: checkAction(x.do, where, p, ctx) }),
    };
  });

  const panels = arr(j.panels).slice(0, MAX_ITEMS).map((x0, i) => {
    const x = obj(x0) || {};
    const where = `panels[${i}]`;
    if (!x.id) p.at_(where, 'needs an id');
    const as = ['dialog', 'drawer', 'feed', 'card'].includes(x.as) ? x.as : 'dialog';
    if (as === 'card' && !['card.top', 'card.bottom'].includes(x.slot)) p.at_(where, 'a card panel needs slot card.top or card.bottom');
    if (!x.render) p.at_(where, 'needs render: the script function that returns its blocks');
    needFn(x.render, where);
    for (const d of arr(x.data)) if (!dataNames.has(d)) p.at_(where, `no data source named ${d}`);
    const refresh = obj(x.refresh) || {};
    return {
      id: str(x.id, 40),
      title: str(x.title, 80),
      icon: icon(x.icon, where),
      as,
      ...(as === 'card' && { slot: x.slot }),
      data: arr(x.data).map((d) => str(d, 40)),
      render: str(x.render, 60),
      ...(when(x.when) && { when: when(x.when) }),
      refresh: { ...(refresh.every && { every: Math.min(Math.max(Number(refresh.every) || 60, 10), 3600) }), on: arr(refresh.on).filter((e) => ['summary', 'finished', 'config'].includes(e)) },
    };
  });

  const blocks = arr(j.blocks).slice(0, MAX_ITEMS).map((x0, i) => {
    const x = obj(x0) || {};
    const where = `blocks[${i}]`;
    const type = String(x.type || '');
    if (!/^[a-z][a-z0-9-]{1,30}$/.test(type)) p.at_(where, 'type: lowercase letters, digits and dashes');
    if (BUILTIN_BLOCKS.includes(type)) p.at_(where, `${type} is a built-in block`);
    if (!x.doc) p.at_(where, 'needs doc: a JSON example and when an agent should use it');
    if (!x.render) p.at_(where, 'needs render: the script function that turns it into wisp blocks');
    needFn(x.render, where);
    return { type, doc: str(x.doc, MAX_DOC), summary: str(x.summary, 200), render: str(x.render, 60) };
  });

  // parts: restyle, props and order; ui: tokens and hide.
  const parts = {};
  for (const [name, v] of Object.entries(obj(j.parts) || {})) {
    const where = `parts.${name}`;
    if (!(name in PARTS)) {
      p.at_(where, `not a part (see the part list)`);
      continue;
    }
    const x = obj(v) || {};
    const out = {};
    if (x.style) {
      out.style = {};
      for (const [k, val] of Object.entries(obj(x.style) || {})) {
        const e = styleProblem(k, val);
        if (e) p.at_(where, e);
        else out.style[kebab(k)] = String(val).trim();
      }
    }
    if (x.props) {
      out.props = {};
      const allowed = PART_PROPS[name] || {};
      for (const [k, val] of Object.entries(obj(x.props) || {})) {
        const t = allowed[k];
        if (!t) p.at_(where, `${k} isn't a prop of ${name}${Object.keys(allowed).length ? ` (${Object.keys(allowed).join(', ')})` : ''}`);
        else if (Array.isArray(t) ? !t.includes(val) : PROP_RANGE[t] ? !Number.isInteger(val) || val < PROP_RANGE[t][0] || val > PROP_RANGE[t][1] : t === 'bool' ? typeof val !== 'boolean' : typeof val !== 'string') p.at_(where, `${k}: ${Array.isArray(t) ? t.join(' | ') : PROP_RANGE[t] ? `${t} from ${PROP_RANGE[t][0]} to ${PROP_RANGE[t][1]}` : t}`);
        else out.props[k] = typeof val === 'string' ? str(val, 160) : val;
      }
    }
    if (x.order) {
      if (name !== 'card.head') p.at_(where, 'order is only for card.head');
      const order = arr(x.order).filter((k) => k in CARD_HEAD_ORDER);
      if (order.length !== arr(x.order).length) p.at_(where, `order takes ${Object.keys(CARD_HEAD_ORDER).join(', ')}`);
      out.order = order;
    }
    parts[name] = out;
  }
  const ui = obj(j.ui) || {};
  const hide = arr(ui.hide).filter((h) => {
    if (h in PARTS) return true;
    p.at_('ui.hide', `${h} isn't a part`);
    return false;
  });
  const tokens = (o, where) =>
    Object.fromEntries(
      Object.entries(obj(o) || {}).filter(([k, v]) => {
        if (!TOKENS.includes(k)) return p.at_(where, `${k} isn't a token (${TOKENS.join(', ')})`), false;
        const e = styleProblem('color', v);
        return e ? (p.at_(where, `${k}: value not allowed`), false) : true;
      }),
    );

  const tokensOut = ui.tokens ? tokens(ui.tokens, 'ui.tokens') : null;
  const darkOut = ui.dark ? tokens(ui.dark, 'ui.dark') : null;

  // prompt rules: text added to agents' system prompts, where `when` matches.
  const prompt = arr(j.prompt).slice(0, MAX_ITEMS).map((r, i) => {
    const x = typeof r === 'string' ? { text: r } : obj(r) || {};
    if (!String(x.text || '').trim()) p.at_(`prompt[${i}]`, 'needs text');
    return { text: truncate(String(x.text || '').trim(), MAX_PROMPT), ...(scopeOf(x.when) && { when: scopeOf(x.when) }) };
  });

  const settings = {};
  for (const [k, v] of Object.entries(obj(j.settings) || {})) {
    const t = SETTINGS[k];
    if (!t) p.at_(`settings.${k}`, `not a setting spells can change (${Object.keys(SETTINGS).join(', ')})`);
    else if (Array.isArray(t) ? !t.includes(v) : typeof v !== 'string') p.at_(`settings.${k}`, Array.isArray(t) ? t.join(' | ') : 'a string');
    else settings[k] = v;
  }

  const slash = arr(j.slash).slice(0, MAX_ITEMS).map((x0, i) => {
    const x = obj(x0) || {};
    const where = `slash[${i}]`;
    const name = String(x.name || '').replace(/^\//, '').toLowerCase();
    if (!/^[a-z][a-z0-9-]{1,20}$/.test(name)) p.at_(where, 'name: lowercase letters, digits and dashes');
    if (['btw', 'feedback', 'spell'].includes(name)) p.at_(where, `/${name} is built in`);
    return { name, args: str(x.args, 40), hint: str(x.hint, 80), do: checkAction(x.do, where, p, ctx) };
  });

  const commands = arr(j.commands).slice(0, MAX_ITEMS).map((x0, i) => {
    const x = obj(x0) || {};
    const where = `commands[${i}]`;
    if (!x.label) p.at_(where, 'needs a label');
    return { id: str(x.id || `k${i}`, 40), label: str(x.label, 60), keywords: str(x.keywords, 120), icon: icon(x.icon, where), ...(x.key && { key: str(x.key, 20) }), do: checkAction(x.do, where, p, ctx) };
  });

  const hooks = arr(j.hooks).slice(0, MAX_ITEMS).map((x0, i) => {
    const x = obj(x0) || {};
    const where = `hooks[${i}]`;
    if (!(x.on in EVENTS)) p.at_(where, `on must be one of ${Object.keys(EVENTS).join(', ')}`);
    const cond = obj(x.if) || {};
    for (const k of Object.keys(cond)) if (!HOOK_IF.includes(k)) p.at_(where, `if.${k}: one of ${HOOK_IF.join(', ')}`);
    return { id: str(x.id || `h${i}`, 40), on: x.on, if: cond, max: Math.min(Math.max(Number(x.max) || 1, 1), 10), do: checkAction(x.do, where, p, { ...ctx, hook: true }) };
  });

  const recipes = arr(j.recipes).slice(0, MAX_ITEMS).map((r, i) => {
    try {
      const { name: rn, prompt: rp, cwd, agent, model, effort, mode } = normalizeRecipe(obj(r) || {});
      const rid = String(r.id ?? i).replace(/[^\w-]/g, '');
      return { id: rid.startsWith(`spell-${id}-`) ? rid : `spell-${id}-${rid}`, name: rn, prompt: rp, cwd, agent, model, effort, mode, spell: id };
    } catch (err) {
      p.at_(`recipes[${i}]`, err.message);
      return null;
    }
  });

  // crew: members the spell brings (server/crew-share.js), each a blueprint. They join paused.
  let crew = [];
  if (arr(j.crew).length > SPELL_CREW_MAX) p.at_('crew', `at most ${SPELL_CREW_MAX} members`);
  try {
    crew = normalizeBlueprints(arr(j.crew).slice(0, SPELL_CREW_MAX), 'crew');
  } catch (err) {
    p.push(err.message);
  }

  if (p.length) throw Object.assign(bad(`This spell has ${p.length} problem${p.length > 1 ? 's' : ''}:\n- ${p.join('\n- ')}`), { problems: [...p] });

  return {
    spell: {
      wispSpell: SPELL_VERSION,
      id,
      name,
      version: str(j.version || '1.0.0', 20),
      description: str(j.description, 400),
      author: str(j.author, 60),
      ...(j.wisp && { wisp: str(j.wisp, 30) }),
      harnesses: arr(j.harnesses).length ? arr(j.harnesses).map((h) => str(h, 20)) : ['*'],
      ...(scopeOf(j.when) && { when: scopeOf(j.when) }),
      ...(Object.keys(data).length && { data }),
      ...(buttons.length && { buttons }),
      ...(chips.length && { chips }),
      ...(panels.length && { panels }),
      ...(blocks.length && { blocks }),
      ...(Object.keys(parts).length && { parts }),
      ...((hide.length || tokensOut || darkOut) && { ui: { ...(hide.length && { hide }), ...(tokensOut && { tokens: tokensOut }), ...(darkOut && { dark: darkOut }) } }),
      ...(prompt.length && { prompt }),
      ...(Object.keys(settings).length && { settings }),
      ...(slash.length && { slash }),
      ...(commands.length && { commands }),
      ...(hooks.length && { hooks }),
      ...(recipes.length && { recipes: recipes.map(({ spell, ...r }) => r) }),
      ...(crew.length && { crew }),
      ...(script && { script }),
    },
    warnings,
  };
}

// Where a prompt rule, block or hook applies: { project: [names|ids|paths], agent: [...], mode: [...] }.
function scopeOf(v) {
  const o = obj(v);
  if (!o) return undefined;
  const out = {};
  for (const k of ['project', 'agent', 'mode']) if (o[k] !== undefined) out[k] = arr(o[k]).map((x) => str(x, 200));
  return Object.keys(out).length ? out : undefined;
}

export function scopeMatches(scope, { project, agent, mode, cwd } = {}) {
  if (!scope) return true;
  if (scope.agent && !scope.agent.includes(agent) && !scope.agent.includes('*')) return false;
  if (scope.mode && !scope.mode.includes(mode)) return false;
  if (scope.project && !scope.project.some((x) => x === project?.name || x === project?.id || (x.startsWith('/') && String(cwd || '').startsWith(x)))) return false;
  return true;
}

const CRON_WORDS = { '*/30 * * * *': 'every 30 min', '0 * * * *': 'hourly', '0 9 * * 1-5': 'weekday mornings', '0 9 * * *': 'every morning', '0 9 * * 1': 'on Mondays' };
const ON_WORDS = { finished: 'when a task finishes', done: 'when a task is marked done', ci: 'when CI fails' };
const MODE_WORDS = { plan: 'Plan', edits: 'Edits', auto: 'Full auto' };

// What a spell does, in plain words, with the riskiest kind it reaches (for the review badges).
export function describeSpell(s) {
  const lines = [];
  let kind = 'safe';
  const bump = (k) => RANK[k] > RANK[kind] && (kind = k);
  const act = (a) => {
    if (!a) return '';
    const [k, v] = Object.entries(a)[0];
    bump(ACTIONS[k]?.kind || 'safe');
    const what = {
      open: () => `opens ${v}`,
      openAll: () => (v.data ? `opens every link in ${v.data}` : `opens the links ${v.fn}() returns`),
      panel: () => `opens the “${(s.panels || []).find((x) => x.id === v)?.title || v}” panel`,
      insert: () => `types “${clip(v, 50)}” into the box`,
      copy: () => `copies “${clip(v, 40)}”`,
      toast: () => 'shows a message',
      setLaunch: () => `sets the prompt box to ${Object.values(v).filter(Boolean).join(' · ')}`,
      send: () => `sends “${clip(v, 50)}” to the task`,
      reply: () => `replies “${clip(v, 50)}” to the task`,
      launchWith: () => `launches with ${Object.entries(v).filter(([k2, x]) => x && k2 !== 'text').map(([, x]) => x).join(' · ')}`,
      launch: () => `starts a task: “${clip(v.prompt, 50)}”`,
      rerun: () => `reruns the task on ${[v.agent, v.model, v.mode].filter(Boolean).join(' · ') || 'another harness'}`,
      recipe: () => `runs the recipe ${v}`,
      ship: () => 'opens Ship it',
      done: () => 'marks the task done',
      archive: () => 'archives the task',
      notify: () => 'notifies you',
      webhook: () => `POSTs the task to ${v}`,
      exec: () => `runs \`${clip(v, 60)}\``,
    }[k];
    return what ? what() : k;
  };
  const WHERE = { topbar: 'A top bar button', float: 'A floating button', palette: 'A ⌘K item', 'launcher.bar': 'A prompt box button', 'launcher.chips': 'A chip under the prompt box', 'composer.bar': 'A follow-up box button', 'composer.chips': 'A quick reply above the follow-up box', 'card.head': "A chip in each card's head", 'card.hover': 'A card button (on hover)', 'card.menu': "An item in each card's menu", 'term.head': "A button in a task's terminal", 'crew.page': "A button on each crew member's page" };
  const cards = (w) => (w ? ` (cards ${Object.entries(w).map(([k, v]) => `${k}: ${v}`).join(', ')})` : '');
  for (const b of s.buttons || []) lines.push(`${WHERE[b.slot] || b.slot} “${b.label || b.icon}”${cards(b.when)} that ${act(b.do)}`);
  for (const c of s.chips || []) lines.push(`${WHERE[c.slot] || c.slot}${c.text ? ` showing “${c.text}”` : ''}${cards(c.when)}${c.do ? ` that ${act(c.do)}` : ''}`);
  for (const x of s.panels || []) lines.push(`A ${x.as === 'card' ? `panel in each card (${x.slot})` : x.as === 'feed' ? 'panel pinned above the feed' : `${x.as}`} “${x.title || x.id}”`);
  for (const b of s.blocks || []) lines.push(`A “${b.type}” block agents can use in their reports`);
  for (const [name, v] of Object.entries(s.parts || {})) lines.push(`Changes ${name}${v.style ? ` (${Object.keys(v.style).join(', ')})` : ''}${v.props ? ` (${Object.entries(v.props).map(([k, x]) => `${k}: ${x}`).join(', ')})` : ''}${v.order ? ` (order: ${v.order.join(', ')})` : ''}`);
  if (s.ui?.hide?.length) lines.push(`Hides ${s.ui.hide.join(', ')}`);
  if (s.ui?.tokens || s.ui?.dark) lines.push(`Recolours wisp (${Object.keys({ ...s.ui.tokens, ...s.ui.dark }).join(', ')})`);
  for (const r of s.prompt || []) lines.push(`Tells ${r.when?.agent ? r.when.agent.join('/') : 'every'} agent${r.when?.project ? ` in ${r.when.project.join(', ')}` : ''}: “${clip(r.text, 90)}”`);
  if (s.settings) lines.push(`Sets ${Object.entries(s.settings).map(([k, v]) => `${k} = ${v}`).join(', ')} while it's on`);
  for (const x of s.slash || []) lines.push(`/${x.name} ${x.args ? `<${x.args}> ` : ''}that ${act(x.do)}`);
  for (const x of s.commands || []) lines.push(`⌘K “${x.label}” that ${act(x.do)}`);
  for (const h of s.hooks || []) {
    bump('acts');
    lines.push(`On its own, when ${h.on.replace('.', ' ')}${Object.keys(h.if).length ? ` (${Object.entries(h.if).map(([k, v]) => `${k}: ${v}`).join(', ')})` : ''}: ${act(h.do)}, at most ${h.max}× per task`);
  }
  for (const r of s.recipes || []) lines.push(`A recipe “${r.name}”`);
  // A member that starts jobs on its own (a schedule, events) or works in Full auto can run commands.
  for (const b of s.crew || []) {
    bump(b.cron || b.on.length || b.mode === 'auto' ? 'runs' : 'acts');
    const when = [b.cron ? CRON_WORDS[b.cron] || `on \`${b.cron}\`` : '', ...b.on.map((k) => ON_WORDS[k])].filter(Boolean).join(', ') || 'only when asked';
    lines.push(`A crew member, ${b.name}${b.role ? ` · ${b.role}` : ''}: works ${when}, in ${MODE_WORDS[b.mode]} mode${b.kit.length ? `, with ${b.kit.length} skill${b.kit.length > 1 ? 's and instructions files' : ' or instructions file'}` : ''}. Joins paused`);
  }
  for (const [k, d] of Object.entries(s.data || {})) {
    if (d.gh) bump('reads');
    lines.push(d.gh ? `Reads GitHub: \`gh ${d.gh.join(' ')}\`` : `Reads wisp's ${d.wisp}`);
  }
  return { lines, kind };
}

export const spellHash = (s) => createHash('sha256').update(JSON.stringify(s)).digest('hex').slice(0, 16);

// The store: ~/.wisp/spells/<id>.json files plus ~/.wisp/spells.json (on/off and where each came from).
export class Spells {
  constructor(home, { safe = process.env.WISP_SAFE === '1' } = {}) {
    this.dir = path.join(home, 'spells');
    this.stateFile = path.join(home, 'spells.json');
    this.safe = safe;
    fs.mkdirSync(this.dir, { recursive: true });
    this.state = { enabled: [], sources: {}, hooks: {} };
    try {
      const raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      this.state = { enabled: Array.isArray(raw.enabled) ? raw.enabled : [], sources: raw.sources || {}, hooks: raw.hooks || {} };
    } catch {}
    this.spells = new Map();
    this.broken = new Map(); // id -> why the file couldn't be loaded
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const { spell } = normalizeSpell(JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')));
        this.spells.set(spell.id, spell);
      } catch (err) {
        this.broken.set(f.replace(/\.json$/, ''), clip(err.message, 400));
      }
    }
    this.onChange = () => {};
  }

  #saveState() {
    writeJsonAtomic(this.stateFile, this.state, 2);
  }

  enabled() {
    if (this.safe) return [];
    return this.state.enabled.map((id) => this.spells.get(id)).filter(Boolean);
  }

  get(id) {
    return this.spells.get(id) || null;
  }

  isOn(id) {
    return !this.safe && this.state.enabled.includes(id);
  }

  view(s) {
    const d = describeSpell(s);
    return { ...s, enabled: this.isOn(s.id), source: this.state.sources[s.id] || null, hash: spellHash(s), summary: d.lines, kind: d.kind };
  }

  list() {
    return {
      safe: this.safe,
      spells: [...this.spells.values()].map((s) => this.view(s)).sort((a, b) => a.name.localeCompare(b.name)),
      broken: [...this.broken].map(([id, error]) => ({ id, error })),
    };
  }

  // Check another spell would fit: its block types and slash names mustn't clash with one that's on.
  #clashes(s) {
    const out = [];
    for (const o of this.enabled()) {
      if (o.id === s.id) continue;
      for (const b of s.blocks || []) if ((o.blocks || []).some((x) => x.type === b.type)) out.push(`block type ${b.type} is already ${o.name}'s`);
      for (const x of s.slash || []) if ((o.slash || []).some((y) => y.name === x.name)) out.push(`/${x.name} is already ${o.name}'s`);
    }
    return out;
  }

  // Save (new or a new version). It stays off unless `enable` (and a new version of one that was on stays on).
  install(raw, { source = null, enable = false } = {}) {
    const { spell, warnings } = normalizeSpell(raw);
    const was = this.spells.get(spell.id);
    writeJsonAtomic(path.join(this.dir, `${spell.id}.json`), spell, 2);
    this.spells.set(spell.id, spell);
    this.broken.delete(spell.id);
    if (source) this.state.sources[spell.id] = { ...source, at: Date.now() };
    else if (!was) this.state.sources[spell.id] = { kind: 'local', at: Date.now() };
    if (enable) this.setEnabled(spell.id, true, { quiet: true });
    this.#saveState();
    this.onChange();
    return { spell: this.view(spell), warnings, updated: !!was };
  }

  setEnabled(id, on, { quiet = false } = {}) {
    const s = this.spells.get(id);
    if (!s) throw bad('no such spell', 404);
    if (on) {
      const c = this.#clashes(s);
      if (c.length) throw bad(`Can't turn ${s.name} on: ${c.join('; ')}.`, 409);
      if (!this.state.enabled.includes(id)) this.state.enabled.push(id);
    } else this.state.enabled = this.state.enabled.filter((x) => x !== id);
    this.#saveState();
    if (!quiet) this.onChange();
    return this.view(s);
  }

  remove(id) {
    if (!this.spells.has(id) && !this.broken.has(id)) throw bad('no such spell', 404);
    fs.rmSync(path.join(this.dir, `${id}.json`), { force: true });
    this.spells.delete(id);
    this.broken.delete(id);
    this.state.enabled = this.state.enabled.filter((x) => x !== id);
    delete this.state.sources[id];
    delete this.state.hooks[id];
    this.#saveState();
    this.onChange();
  }

  // The file to share: the spell as written, nothing about this machine.
  exported(id) {
    const s = this.spells.get(id);
    if (!s) throw bad('no such spell', 404);
    return { ...s };
  }

  // --- what the rest of wisp reads ---

  // Settings spells set, and which spell set each (the last one turned on wins).
  settings() {
    const values = {};
    const lockedBy = {};
    for (const s of this.enabled()) for (const [k, v] of Object.entries(s.settings || {})) (values[k] = v), (lockedBy[k] = { id: s.id, name: s.name });
    return { values, lockedBy };
  }

  recipes() {
    return this.enabled().flatMap((s) => (s.recipes || []).map((r) => ({ ...r, runs: 0, lastRunAt: null, spell: { id: s.id, name: s.name } })));
  }

  #applies(s, session, project) {
    if (s.harnesses && !s.harnesses.includes('*') && !s.harnesses.includes(session.agent)) return false;
    return scopeMatches(s.when, { project, agent: session.agent, mode: session.mode, cwd: session.cwd });
  }

  // Prompt rules for this session, as one section of its system prompt ('' when none).
  promptFor(session, project) {
    const rules = this.enabled()
      .filter((s) => this.#applies(s, session, project))
      .flatMap((s) => (s.prompt || []).filter((r) => scopeMatches(r.when, { project, agent: session.agent, mode: session.mode, cwd: session.cwd })).map((r) => `- ${r.text} _(spell: ${s.name})_`));
    if (!rules.length) return '';
    return `\n\n## Spells the user cast\n\nThe user turned these on in wisp. Follow them unless the current request says otherwise.\n\n${rules.join('\n')}\n`;
  }

  // Extra block types agents may use in this session's report.
  blocksFor(session, project) {
    return this.enabled()
      .filter((s) => this.#applies(s, session, project))
      .flatMap((s) => (s.blocks || []).map((b) => ({ type: b.type, doc: b.doc, spell: s.name })));
  }

  hooks(event) {
    return this.enabled().flatMap((s) => (s.hooks || []).filter((h) => h.on === event).map((h) => ({ spell: s, hook: h })));
  }

  // A hook's run count for one session (hooks fire at most `max` times per task).
  hookCount(spellId, hookId, sessionId) {
    return this.state.hooks[spellId]?.[hookId]?.[sessionId] || 0;
  }

  countHook(spellId, hookId, sessionId) {
    const h = ((this.state.hooks[spellId] ||= {})[hookId] ||= {});
    h[sessionId] = (h[sessionId] || 0) + 1;
    // Keep the newest 200 sessions per hook.
    const keys = Object.keys(h);
    if (keys.length > 200) for (const k of keys.slice(0, keys.length - 200)) delete h[k];
    this.#saveState();
  }

  // What the page needs to apply every spell that's on.
  forPage() {
    return this.enabled().map((s) => ({ ...s, kind: describeSpell(s).kind }));
  }
}

// The overlay: store.config.defaults reads spell settings first while they're on, writes go to
// the user's own values, and saving config.json saves only the user's (toJSON).
export function overlayDefaults(target, settings) {
  return new Proxy(target, {
    get(t, k) {
      if (k === 'toJSON') return () => t;
      const v = settings().values;
      return Object.hasOwn(v, k) ? v[k] : t[k];
    },
    ownKeys: (t) => [...new Set([...Reflect.ownKeys(t), ...Object.keys(settings().values)])],
    getOwnPropertyDescriptor(t, k) {
      const v = settings().values;
      if (Object.hasOwn(v, k)) return { value: v[k], writable: true, enumerable: true, configurable: true };
      return Reflect.getOwnPropertyDescriptor(t, k);
    },
    has: (t, k) => Object.hasOwn(settings().values, k) || k in t,
  });
}
