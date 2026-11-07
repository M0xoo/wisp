// What you'd type in the launcher, in a message: @ada in api on laptop with opus high plan: fix it.
// Options are read only from the front, and end at `:` or the first word that isn't one, so a
// sentence that happens to hold "with" or "in" is never eaten. Pure: ctx holds everything it may
// look at, and it imports nothing of wisp's, so wisp Grid reads the same grammar (parseRoute below).
//
// ctx: { projects, machines: [{ id, name, kind, computer, usable, agents | null }], agents (here),
//        adapters (every harness wisp knows), crew, goals, defaultProject, defaultAgent, sandbox,
//        thread: { agent, machine } in a task's thread }
//
// Two steps. Reading finds where the options end, and asks only what's known anywhere: a thing that
// exists somewhere is an option even if it can't run here, so `with gpt-5 fix it` is refused and not
// sent as a sentence. Resolving then checks them in order, machine, project, model, because the
// chosen machine decides which models are valid.

import { crewMentions } from './mentions.js';

// /new @name: exact name, then name prefix, then anywhere in the name or path.
export function findProject(projects, q) {
  const n = String(q || '').toLowerCase();
  if (!n) return null;
  const name = (p) => String(p.name || '').toLowerCase();
  return projects.find((p) => name(p) === n) || projects.find((p) => name(p).startsWith(n)) || projects.find((p) => name(p).includes(n) || String(p.path || '').toLowerCase().includes(n)) || null;
}

const LISTS = new Set(['help', 'projects', 'models', 'crew', 'machines', 'status']);
const SLASH = new Set([...LISTS, 'new', 'start', 'stop', 'done', 'btw']);
const COLON = /^\s*[:：]/;
const MARKS = /^[*_~`]+|[*_~`]+$/g;
// "with gpt-9": shaped like a model, so not a sentence, even if nothing here has heard of it.
const MODEL_SHAPE = /^[a-z]+-\d/i;
// Words a bare in/on can't take as the start of a name: "in the login page", "on my laptop".
const NOT_A_NAME = new Set(['a', 'an', 'the', 'my', 'our', 'your', 'this', 'that', 'these', 'those', 'all', 'it', 'its', 'one', 'some', 'any', 'each', 'every']);
const HERE = /^(here|local|this computer)$/i;

// A channel's own markup, gone before the grammar reads it. Text stays as written: an agent should
// see what you sent, and __init__.py isn't bold. kind: 'telegram', 'slack' (its <…> and &amp;; bot: its user id) or 'discord'.
export function stripFormatting(text, kind = '', { bot = '' } = {}) {
  let t = String(text ?? '').replace(/\r\n/g, '\n').replace(/[\u200b-\u200d\u2060\ufeff]/g, '').replace(/\u00a0/g, ' ').trim();
  if (kind === 'telegram') {
    t = t.replace(/^\/(\w+)@\w+/, '/$1'); // /new@wispbot
    if (bot) t = t.replace(new RegExp(`^@${bot.replace(/\W/g, '')}\\b[\\s,:]*`, 'i'), '').trim(); // @wispbot in a group
  }
  if (kind === 'slack') {
    if (bot) t = t.replace(new RegExp(`<@${bot.replace(/\W/g, '')}(?:\\|[^>]*)?>[\\s,:]*`, 'g'), '').trim();
    t = t
      .replace(/<((?:https?:\/\/|mailto:)[^>|]+)(?:\|([^>]*))?>/g, (_, url, label) => slackLink(url, label))
      .replace(/<#(\w+)(?:\|([^>]*))?>/g, (_, id, name) => `#${name || id}`)
      .replace(/<!(\w+)(?:[^>|]*)(?:\|([^>]*))?>/g, (_, what, label) => label || `@${what}`)
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }
  if (kind === 'discord') {
    if (bot) t = t.replace(new RegExp(`<@!?${bot.replace(/\D/g, '')}>[\\s,:]*`, 'g'), '').trim();
    t = t.replace(/<(https?:\/\/[^>\s]+)>/g, '$1'); // the brackets only turn its preview off
  }
  return t;
}

// Slack writes a bare example.com as a link labelled example.com. A label that says something else
// keeps its URL, so nothing is hidden from the agent.
function slackLink(url, label) {
  const bare = url.replace(/^mailto:/, '');
  if (!label || label === url || label === bare || label === url.replace(/^https?:\/\//, '')) return label || bare;
  return `${label} (${url})`;
}

// The next word, its own marks and punctuation apart from it.
function token(s) {
  const raw = /^\S+/.exec(s)?.[0] || '';
  let w = raw.replace(MARKS, '');
  const colon = /[:：]$/.test(w);
  const comma = /,$/.test(w);
  if (colon || comma) w = w.slice(0, -1).replace(MARKS, '');
  return { raw, word: w, low: w.toLowerCase(), colon, comma, after: s.slice(raw.length).trimStart() };
}

const lower = (x) => String(x || '').toLowerCase();
const namesOf = (list) => list.map((x) => x.name).filter(Boolean);
const harnesses = (ctx) => (ctx.adapters || []).filter((a) => a.id !== 'wisp');
const placeList = (ctx) => [...(ctx.machines || []).flatMap((m) => m.agents || []), ...(ctx.agents || []), ...harnesses(ctx)];
const modelIds = (a) => (a.models || []).filter((m) => m.id);

const findHarness = (ctx, w) => harnesses(ctx).find((a) => a.id === w || lower(a.name) === w || lower(a.name).split(' ')[0] === w || (w.length >= 3 && a.id.startsWith(w))) || null;

// Id, label, then prefix (of the id, or the part after a provider's "/").
function matchModels(a, w) {
  const list = modelIds(a);
  const exact = list.filter((m) => lower(m.id) === w);
  if (exact.length) return { tier: 0, hits: exact };
  const label = list.filter((m) => lower(m.label) === w);
  if (label.length) return { tier: 1, hits: label };
  if (w.length < 3) return { tier: 2, hits: [] }; // "with a test" isn't a model
  return { tier: 2, hits: list.filter((m) => lower(m.id).startsWith(w) || lower(m.id).split('/').pop().startsWith(w) || lower(m.label).startsWith(w)) };
}
const modelKnown = (ctx, w) => placeList(ctx).some((a) => a.id !== 'wisp' && matchModels(a, w).hits.length);
const effortKnown = (ctx, w) => placeList(ctx).some((a) => (a.efforts || []).includes(w) || modelIds(a).some((m) => m.efforts?.includes(w)));

// A bare in/on: a whole name (longest first, names may have spaces), else the unique name a word
// starts. A comma says it's a sentence ("in app, the button…"), so no prefix then. exact: whole names
// only, and one that fits two is ambiguous (a router: "on mac" isn't enough to send work somewhere).
function pickName(list, s, exact = false) {
  const text = s.toLowerCase();
  for (const x of [...list].sort((a, b) => b.name.length - a.name.length)) {
    const n = x.name.toLowerCase();
    if (text.startsWith(n) && (text.length === n.length || /^[\s:：,*_~`]/.test(text.slice(n.length)))) {
      const twins = exact ? list.filter((y) => y.name.toLowerCase() === n) : [];
      if (twins.length > 1) return { ambiguous: twins, word: x.name, rest: s.slice(x.name.length).trimStart() };
      const t = token(s.slice(x.name.length));
      const tail = s.slice(x.name.length);
      if (t.word === '' && t.raw) return { item: x, rest: t.after, colon: t.colon || COLON.test(tail) };
      return { item: x, rest: tail.trimStart(), colon: false };
    }
  }
  const t = token(s);
  const whole = list.filter((x) => x.name.toLowerCase() === t.low); // **api**: marks hid it above
  if (whole.length === 1) return { item: whole[0], rest: t.after, colon: t.colon };
  if (exact) return whole.length ? { ambiguous: whole, word: t.word, rest: t.after } : null;
  if (!t.word || t.comma || t.word.length < 2 || NOT_A_NAME.has(t.low)) return null;
  const hits = list.filter((x) => x.name.toLowerCase().startsWith(t.low));
  if (hits.length === 1) return { item: hits[0], rest: t.after, colon: t.colon };
  return hits.length ? { ambiguous: hits, word: t.word, rest: t.after } : null;
}

const fresh = () => ({ crew: null, tagged: [], project: null, machine: undefined, withs: null, mode: null, problems: [], notes: [] });
const problem = (o, kind, text, choices = []) => o.problems.push({ kind, text, choices });

// Past an in/on that matched nothing: would what follows be options up to a `:`? Then that's what
// the writer meant, and running somewhere else would be wrong.
function optionsToColon(s, o, ctx) {
  if (COLON.test(s)) return true;
  const probe = { ...o, ...fresh(), crew: o.crew, project: o.project, machine: o.machine, withs: o.withs, mode: o.mode };
  for (let rest = s; rest; ) {
    const step = readOption(token(rest), rest, probe, ctx, 1);
    if (!step) return false;
    if (step.colon) return true;
    rest = step.rest;
  }
  return false;
}

function readPlace(t, o, ctx, { list, kind, word, special }) {
  const s = t.after;
  if (!s) return null;
  const own = special?.(s);
  const hit = own || pickName(list, s, !!ctx.blind);
  if (hit?.ambiguous) {
    problem(o, 'ambiguous', `“${hit.word}” could be ${hit.ambiguous.length} ${kind}s.`, namesOf(hit.ambiguous));
    return { rest: hit.rest, stop: true };
  }
  if (hit) return hit;
  const v = token(s);
  if (!v.word) return null;
  if (v.colon || optionsToColon(v.after, o, ctx)) {
    problem(o, 'no-match', `No ${kind} “${v.word}”.`, namesOf(list));
    return { rest: v.after, stop: true };
  }
  o.notes.push(`“${word} ${v.word}” isn’t one of your ${kind}s, so I read it as part of the task.`);
  return null;
}

// on: cloud is your cloud computer, sandbox a fresh box, here this computer.
function machineWords(ctx) {
  return (s) => {
    const t = token(s);
    if (HERE.test(t.word)) return { item: { id: '', name: 'this computer' }, rest: t.after, colon: t.colon };
    if (t.low === 'this' && /^computer\b/i.test(t.after)) return { item: { id: '', name: 'this computer' }, ...(({ after, colon }) => ({ rest: after, colon }))(token(t.after)) };
    if (t.low === 'sandbox') return { item: { id: 'sandbox', name: 'sandbox' }, rest: t.after, colon: t.colon };
    if (t.low === 'cloud' && !(ctx.machines || []).some((m) => lower(m.name) === 'cloud')) {
      const clouds = (ctx.machines || []).filter((m) => m.kind === 'grid' && !m.computer);
      if (clouds.length === 1) return { item: clouds[0], rest: t.after, colon: t.colon };
    }
    return null;
  };
}

// with X [Y] [Z]: harness, model, effort, or Auto's goal. A word known nowhere ends the options.
function readWith(t, o, ctx) {
  let cur = token(t.after);
  if (!cur.word) return null;
  const w = { raw: t.raw, agent: '', model: '', effort: '' };
  const done = (c) => ({ rest: c.after, colon: c.colon });
  if (cur.low === 'auto') {
    w.agent = 'auto';
    o.withs = w;
    if (cur.colon) return done(cur);
    const next = token(cur.after);
    if ((ctx.goals || []).includes(next.low)) return (w.model = next.low), done(next);
    if (effortKnown(ctx, next.low)) return (w.effort = next.low), done(next);
    return done(cur);
  }
  const harness = findHarness(ctx, cur.low);
  if (harness) {
    w.agent = harness.id;
    o.withs = w;
    if (cur.colon) return done(cur);
    const next = token(cur.after);
    const own = placeList(ctx).filter((a) => a.id === harness.id);
    if (next.word && (own.some((a) => matchModels(a, next.low).hits.length) || MODEL_SHAPE.test(next.word))) {
      w.model = next.low;
      cur = next;
      if (cur.colon) return done(cur);
    }
  } else if (modelKnown(ctx, cur.low) || MODEL_SHAPE.test(cur.word)) {
    w.model = cur.low;
    o.withs = w;
    if (cur.colon) return done(cur);
  } else if (effortKnown(ctx, cur.low) && cur.colon) {
    // On its own only right before `:`: "with high priority, fix…" is a sentence.
    w.effort = cur.low;
    o.withs = w;
    return done(cur);
  } else return null;
  const next = token(cur.after);
  if (next.word && effortKnown(ctx, next.low)) return (w.effort = next.low), done(next);
  return done(cur);
}

function readMode(t, o, count) {
  if (o.mode) return null;
  let mode = t.low === 'plan' || t.low === 'edits' ? t.low : '';
  let last = t;
  if (t.low === 'full-auto') mode = 'auto';
  if (t.low === 'full' && !t.colon) {
    const next = token(t.after);
    if (next.low === 'auto') (mode = 'auto'), (last = next);
  }
  if (!mode) return null;
  // First, it's only a mode right before `:`. "plan the migration" is a task.
  if (!count && !last.colon && !COLON.test(last.after)) return null;
  o.mode = mode;
  return { rest: last.after, colon: last.colon };
}

// parseRoute's `with`: no models to check against, so one to three words, up to the next option.
const OPTION_WORD = /^(?:on|in|with|plan|edits|full|full-auto)$|^[@#]/i;
function skipWith(t) {
  let cur = token(t.after);
  if (!cur.word || OPTION_WORD.test(cur.word)) return null;
  for (let n = 1; n < 3 && !cur.colon; n++) {
    const next = token(cur.after);
    if (!next.word || OPTION_WORD.test(next.word)) break;
    if (!MODEL_SHAPE.test(next.word) && !/^(?:low|medium|high|xhigh|max|opus|sonnet|haiku)$/i.test(next.word)) break;
    cur = next;
  }
  return { rest: cur.after, colon: cur.colon };
}

// One option at the front of s. → { rest, colon?, stop? }, or null when this isn't one.
function readOption(t, s, o, ctx, count) {
  const thread = !!ctx.thread;
  if (ctx.blind) {
    // Only machines are known here: what's the machine's to judge is stepped over, one word each.
    if (t.word[0] === '@' && t.word.length > 1 && !t.word.includes('/')) return { rest: t.after, colon: t.colon };
    if (t.word[0] === '#' && t.word.length > 1) return /^\d+$/.test(t.word.slice(1)) ? null : { rest: t.after, colon: t.colon };
    if (t.low === 'with' && !t.colon) return skipWith(t);
    if (t.low === 'in' && !t.colon) {
      const v = token(t.after);
      return !v.word || NOT_A_NAME.has(v.low) || OPTION_WORD.test(v.word) ? null : { rest: v.after, colon: v.colon };
    }
  }
  if (t.word[0] === '@' && !t.word.includes('/')) {
    // crewMentions reads the whole text, so it gets it without this word's marks.
    const src = `${t.word}${t.colon ? ':' : t.comma ? ',' : ''}${s.slice(t.raw.length)}`;
    const m = crewMentions(src, ctx.crew || []);
    if (m.lead.length && (!thread || !o.crew)) {
      const used = src.trimEnd().slice(0, src.trimEnd().length - m.rest.length);
      const [first, ...more] = m.lead;
      if (o.crew) o.tagged.push(first);
      else o.crew = first;
      o.tagged.push(...more);
      return { rest: m.rest, colon: /[:：]\s*$/.test(used) };
    }
    if (thread) return null;
    const name = t.word.slice(1);
    if (!o.project) {
      const p = name && findProject(ctx.projects || [], name);
      if (p) return (o.project = p), { rest: t.after, colon: t.colon };
    }
    problem(o, 'no-match', `No crew member or project matches “${name}”.`, [...(ctx.crew || []).map((m) => `@${m.name}`), ...namesOf(ctx.projects || [])]);
    return { rest: t.after, stop: true };
  }
  if (t.word[0] === '#' && t.word.length > 1 && !thread && !o.project) {
    const name = t.word.slice(1);
    if (/^\d+$/.test(name) && !(ctx.projects || []).some((p) => p.name === name)) return null; // #123 is an issue
    const p = findProject(ctx.projects || [], name);
    if (p) return (o.project = p), { rest: t.after, colon: t.colon };
    problem(o, 'no-match', `No project matches “${name}”.`, namesOf(ctx.projects || []));
    return { rest: t.after, stop: true };
  }
  if (t.low === 'in' && !t.colon && !thread && !o.project) {
    const hit = readPlace(t, o, ctx, { list: ctx.projects || [], kind: 'project', word: 'in' });
    if (!hit) return null;
    if (hit.stop) return hit;
    o.project = hit.item;
    return hit;
  }
  if (t.low === 'on' && !t.colon && !thread && o.machine === undefined) {
    const hit = readPlace(t, o, ctx, { list: ctx.machines || [], kind: 'machine', word: 'on', special: machineWords(ctx) });
    if (!hit) return null;
    if (hit.stop) return hit;
    o.machine = hit.item.id;
    return hit;
  }
  if (t.low === 'with' && !t.colon && !o.withs) return readWith(t, o, ctx);
  return readMode(t, o, count);
}

// --- resolving: machine, project, model ------------------------------------------------------------

const machineOf = (ctx, id) => (ctx.machines || []).find((m) => m.id === id) || null;
const placeName = (ctx, id) => (id ? machineOf(ctx, id)?.name || id : 'this computer');

// What can run at a place: its harnesses, or null when that can't be known (offline, a sandbox).
function agentsAt(ctx, id) {
  if (!id) return ctx.agents || [];
  if (id === 'sandbox') return null;
  return machineOf(ctx, id)?.agents || null;
}

// null agents don't always mean offline: a cloud computer asleep wakes when it gets work.
function resolveMachine(o, ctx, mid) {
  if (mid === 'sandbox' && !ctx.sandbox) problem(o, 'not-installed', 'Sandboxes need a wisp Grid: sign in to one in Settings → Cloud.');
  if (!mid || mid === 'sandbox') return;
  const m = machineOf(ctx, mid);
  if (m && !m.usable) problem(o, 'offline', `${m.name} is offline.`, namesOf((ctx.machines || []).filter((x) => x.usable)));
}

// A member's job: model, effort and mode can change for this one job. Its harness can't (its kit and
// memory are compiled for it), Auto picks for itself, and it works where it works.
function resolveMember(o, ctx) {
  const m = o.crew;
  const w = o.withs;
  const name = m.name;
  if (o.project && o.project.path !== m.cwd) problem(o, 'refused', `${name} works in ${m.cwd ? (ctx.projects || []).find((p) => p.path === m.cwd)?.name || m.cwd : 'a folder of their own'}: a job can’t move them to ${o.project.name}.`);
  const own = m.sandbox ? 'sandbox' : m.machine || '';
  if (o.machine !== undefined && o.machine !== own) problem(o, 'refused', `${name} works on ${placeName(ctx, own)}: a job can’t move them to ${placeName(ctx, o.machine)}.`);
  if (!w) return;
  if (m.agent === 'auto') return problem(o, 'refused', `${name} is on Auto, which picks the harness and model itself. Change that in their settings, or start a task of your own.`);
  if (w.agent && w.agent !== m.agent) return problem(o, 'refused', `${name} runs on ${(findHarness(ctx, m.agent) || { name: m.agent }).name}: their kit and memory are made for it, so a job can’t change harness.`);
  if (m.sandbox) {
    if (w.model) o.model = w.model;
    if (w.effort) o.effort = w.effort;
    return;
  }
  const at = agentsAt(ctx, m.machine || '');
  if (!at) return problem(o, 'offline', `${placeName(ctx, m.machine)} is offline, so I can’t check that model for ${name}.`);
  resolveModel(o, ctx, at.filter((a) => a.id === m.agent), m.machine || '', m.agent);
  o.agent = null; // the member's, as it always is
}

// One harness on a place (agents), or every harness there, for the model and effort asked for.
function resolveModel(o, ctx, agents, mid, prefer = '') {
  const w = o.withs;
  const place = placeName(ctx, mid);
  const usable = agents.filter((a) => a.available && a.id !== 'wisp');
  const nameOf = (id) => (findHarness(ctx, id) || { name: id }).name;
  if (w.agent) {
    const a = agents.find((x) => x.id === w.agent);
    if (!a?.available) return problem(o, 'not-installed', `${nameOf(w.agent)} isn’t ${a?.signedIn === false ? 'signed in' : 'installed'} on ${place}.`, namesOf(usable));
    o.agent = a.id;
    if (w.model) {
      const { hits } = matchModels(a, w.model);
      if (hits.length !== 1) return problem(o, hits.length ? 'ambiguous' : 'not-installed', hits.length ? `“${w.model}” could be ${hits.length} models.` : `${a.name} on ${place} has no model “${w.model}”.`, (hits.length ? hits : modelIds(a)).map((m) => m.id));
      o.model = hits[0].id;
    }
    return effortFor(o, a, hits0(a, o.model), place);
  }
  if (w.model) {
    const found = usable.map((a) => ({ a, ...matchModels(a, w.model) })).filter((x) => x.hits.length);
    if (!found.length) return problem(o, 'not-installed', `No model “${w.model}” on ${place}.`, usable.flatMap((a) => modelIds(a).map((m) => m.id)).slice(0, 12));
    const best = Math.min(...found.map((x) => x.tier));
    const top = found.filter((x) => x.tier === best);
    const pick = top.find((x) => x.a.id === prefer && x.hits.length === 1) || (top.length === 1 && top[0].hits.length === 1 ? top[0] : null);
    if (!pick) return problem(o, 'ambiguous', `“${w.model}” could be several models on ${place}.`, top.flatMap((x) => x.hits.map((m) => `${x.a.id} ${m.id}`)));
    o.agent = pick.a.id;
    o.model = pick.hits[0].id;
    return effortFor(o, pick.a, pick.hits[0], place);
  }
  const a = usable.find((x) => x.id === prefer) || null;
  if (!a) return problem(o, 'refused', `Auto picks the thinking level itself. Name a model too: with opus ${w.effort}.`);
  return effortFor(o, a, null, place);
}
const hits0 = (a, id) => modelIds(a).find((m) => m.id === id) || null;

function effortFor(o, a, model, place) {
  const effort = o.withs.effort;
  if (!effort) return;
  const list = model?.efforts || a.efforts || [];
  if (!list.includes(effort)) return problem(o, 'not-installed', `${model?.label || a.name} on ${place} has no thinking level “${effort}”.`, list);
  o.effort = effort;
}

function resolveWith(o, ctx, mid) {
  const w = o.withs;
  if (w.agent === 'auto') {
    if (ctx.thread) return problem(o, 'refused', 'Auto picks when a task starts: name a harness or a model for a follow-up.', namesOf((ctx.agents || []).filter((a) => a.available)));
    o.agent = 'auto';
    o.model = w.model || null;
    if (w.effort) problem(o, 'refused', 'Auto picks the thinking level itself.', ctx.goals || []);
    return;
  }
  const at = agentsAt(ctx, mid);
  if (at) return resolveModel(o, ctx, at, mid, ctx.thread?.agent || ctx.defaultAgent || '');
  // Offline or a sandbox: nothing to check against here, so what's known of the harness stands.
  const a = w.agent ? findHarness(ctx, w.agent) : harnesses(ctx).find((x) => matchModels(x, w.model).hits.length);
  if (a) o.agent = a.id;
  if (w.model) o.model = (a && matchModels(a, w.model).hits[0]?.id) || w.model;
  if (w.effort) o.effort = w.effort;
}

function resolve(o, ctx) {
  if (o.crew) return resolveMember(o, ctx);
  const project = o.project || ctx.defaultProject;
  const mid = ctx.thread ? ctx.thread.machine || '' : o.machine ?? (project?.machine || '');
  if (!ctx.thread) resolveMachine(o, ctx, mid);
  if (!o.problems.length && o.withs) resolveWith(o, ctx, mid);
}

const nothing = (o, command = null, arg = '') => ({ command, arg, crew: null, tagged: [], project: null, machine: null, agent: null, model: null, effort: null, mode: null, prompt: '', problems: [], notes: [], ...o });

// A word or a slash command that isn't a task. /new goes on to the options; the rest are whole.
function readCommand(text, ctx) {
  const slash = /^\/(\w+)\s*([\s\S]*)$/.exec(text);
  if (slash) {
    const name = slash[1].toLowerCase();
    if (!SLASH.has(name)) return { unknown: slash[1] };
    return { name: name === 'start' ? 'help' : name, arg: slash[2].trim() };
  }
  const w = /^([a-z]+)[?.!]?(?:\s+(?:on\s+)?(.+))?$/i.exec(text);
  const name = w?.[1].toLowerCase();
  if (!name) return null;
  if ((LISTS.has(name) || name === 'stop' || name === 'done') && !w[2]) return { name, arg: '' };
  // "models laptop": a list for a place, if that's a place; else it's a sentence.
  if (name === 'models' && w[2] && (ctx.machines || []).some((m) => lower(m.name).startsWith(lower(w[2])))) return { name, arg: w[2].trim() };
  return null;
}

// What a router needs of a message, for one that knows computers and nothing else (wisp Grid, which
// holds no projects, models or crew: those are the computer's to read). → { machine, text }, with the
// message as it should reach that computer, `on <name>` gone; { problems } when the name fits several;
// null for anything else, which isn't this router's. Read from the front like parseMessage, so
// "fix it on laptop" is a sentence, and whole names only, so "on mac" isn't Mac Studio. "cloud" and
// "here" aren't computers: they stay the box's.
export function parseRoute(text, computers = []) {
  const whole = String(text ?? '').trim();
  if (COLON.test(whole)) return null;
  const ctx = { blind: true, machines: computers.some((m) => lower(m.name) === 'cloud') ? computers : [...computers, { id: '', name: 'cloud' }] };
  const cmd = readCommand(whole, ctx);
  if (cmd && cmd.name !== 'new') return null;
  const src = cmd ? cmd.arg : whole;
  const o = fresh();
  let rest = src;
  for (let count = 0; rest; count++) {
    const t = token(rest);
    if (!t.word) return null;
    const step = readOption(t, rest, o, ctx, count);
    if (o.problems.length) return o.problems[0].kind === 'ambiguous' ? { problems: o.problems } : null;
    if (!step || step.stop) return null;
    if (o.machine !== undefined) {
      if (!computers.some((m) => m.id === o.machine)) return null;
      const said = `${src.slice(0, src.length - rest.length)}${step.colon ? ': ' : ''}${step.rest}`.trim();
      if (!said.replace(COLON, '').trim()) return null; // nothing to do there: not a task, and the box can say so
      return { machine: o.machine, text: cmd ? `/new ${said}` : said };
    }
    rest = step.rest;
    if (step.colon) return null;
  }
  return null;
}

// text (already through stripFormatting) → what it asks for. problems: why it can't start, each
// { kind, text, choices }; notes: what the first reply should mention. prompt is the words left.
export function parseMessage(text, ctx = {}) {
  let src = String(text ?? '').trim();
  // A leading `:`: the message exactly as written.
  if (COLON.test(src)) return nothing({ prompt: src.replace(COLON, '').trim() });
  const cmd = readCommand(src, ctx);
  if (cmd?.unknown && ctx.thread) return nothing({ prompt: src }); // /goal, /side: words for the agent's task, as a follow-up
  if (cmd?.unknown) return nothing({ problems: [{ kind: 'unknown', text: `There’s no /${cmd.unknown} here. Send /help, or start with “:” to send it as written.`, choices: [] }] });
  if (cmd && cmd.name !== 'new') return nothing({ prompt: cmd.name === 'btw' ? cmd.arg : '' }, cmd.name, cmd.arg);
  if (cmd) src = cmd.arg;

  const o = fresh();
  let rest = src;
  for (let count = 0; rest; count++) {
    const t = token(rest);
    if (!t.word && t.colon) {
      rest = t.after;
      break;
    }
    const step = readOption(t, rest, o, ctx, count);
    if (!step) break;
    rest = step.rest;
    if (step.stop) break;
    const colon = step.colon || COLON.test(rest);
    if (colon) rest = rest.replace(COLON, '').trim();
    if (colon) break;
  }
  if (!o.problems.length) resolve(o, ctx);
  const prompt = rest.trim();
  // A member named further in joins as a delegate, as in the launcher.
  const further = crewMentions(prompt, ctx.crew || []).all.filter((m) => m !== o.crew && !o.tagged.includes(m));
  return {
    command: cmd?.name || null,
    arg: '',
    crew: o.crew,
    tagged: [...o.tagged, ...further],
    project: o.project,
    machine: o.machine ?? null,
    agent: o.agent ?? null,
    model: o.model ?? null,
    effort: o.effort ?? null,
    mode: o.mode,
    prompt,
    problems: o.problems,
    notes: o.notes,
  };
}
