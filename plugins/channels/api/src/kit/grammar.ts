// What you'd type in the launcher, in a message: @ada in api on laptop with opus high plan: fix it.
// Options are read only from the front, and end at `:` or the first word that isn't one, so a
// sentence that happens to hold "with" or "in" is never eaten. Pure: ctx holds everything it may
// look at, and it imports nothing of wisp's, so wisp Grid reads the same grammar (parseRoute below).
// The port of v1 server/channels/grammar.js.
//
// Two steps. Reading finds where the options end, and asks only what's known anywhere: a thing that
// exists somewhere is an option even if it can't run here, so `with gpt-5 fix it` is refused and not
// sent as a sentence. Resolving then checks them in order, machine, project, model, because the
// chosen machine decides which models are valid.

import type { MachineView, Mode, Parsed, Problem } from '../index.ts';
import { COLON, type Ctx, type Opts, type Step, type Token, type With, effortKnown, findHarness, fresh, lower, matchModels, modelKnown, namesOf, placeList, problem, token } from './grammar-words.ts';
import { resolve } from './grammar-resolve.ts';
import { crewMentions } from './mentions.ts';

export type { Ctx };
export { stripFormatting } from './grammar-format.ts';

/** /new @name: exact name, then name prefix, then anywhere in the name or path. */
export function findProject<P extends { name?: string; path?: string }>(projects: readonly P[], q: unknown): P | null {
  const n = String(q || '').toLowerCase();
  if (!n) return null;
  const name = (p: P): string => String(p.name || '').toLowerCase();
  return projects.find((p) => name(p) === n) || projects.find((p) => name(p).startsWith(n)) || projects.find((p) => name(p).includes(n) || String(p.path || '').toLowerCase().includes(n)) || null;
}

const LISTS = new Set(['help', 'projects', 'models', 'crew', 'machines', 'status']);
const SLASH = new Set([...LISTS, 'new', 'start', 'stop', 'done', 'btw']);
// "with gpt-9": shaped like a model, so not a sentence, even if nothing here has heard of it.
const MODEL_SHAPE = /^[a-z]+-\d/i;
// Words a bare in/on can't take as the start of a name: "in the login page", "on my laptop".
const NOT_A_NAME = new Set(['a', 'an', 'the', 'my', 'our', 'your', 'this', 'that', 'these', 'those', 'all', 'it', 'its', 'one', 'some', 'any', 'each', 'every']);
const HERE = /^(here|local|this computer)$/i;



type NamePick<T> = { item: T; rest: string; colon: boolean } | { ambiguous: T[]; word: string; rest: string };

// A whole name at the front of s, longest first (names may have spaces).
function wholeName<T extends { name: string }>(list: readonly T[], s: string, exact: boolean): NamePick<T> | null {
  const text = s.toLowerCase();
  for (const x of [...list].sort((a, b) => b.name.length - a.name.length)) {
    const n = x.name.toLowerCase();
    if (!(text.startsWith(n) && (text.length === n.length || /^[\s:：,*_~`]/.test(text.slice(n.length))))) continue;
    const twins = exact ? list.filter((y) => y.name.toLowerCase() === n) : [];
    if (twins.length > 1) return { ambiguous: twins, word: x.name, rest: s.slice(x.name.length).trimStart() };
    const tail = s.slice(x.name.length);
    const t = token(tail);
    if (t.word === '' && t.raw) return { item: x, rest: t.after, colon: t.colon || COLON.test(tail) };
    return { item: x, rest: tail.trimStart(), colon: false };
  }
  return null;
}

// A bare in/on: a whole name, else the unique name a word starts. A comma says it's a sentence ("in
// app, the button…"), so no prefix then. exact: whole names only, and one that fits two is ambiguous
// (a router: "on mac" isn't enough to send work somewhere).
function pickName<T extends { name: string }>(list: readonly T[], s: string, exact = false): NamePick<T> | null {
  const named = wholeName(list, s, exact);
  if (named) return named;
  const t = token(s);
  const whole = list.filter((x) => x.name.toLowerCase() === t.low); // **api**: marks hid it above
  const [only] = whole;
  if (only && whole.length === 1) return { item: only, rest: t.after, colon: t.colon };
  if (exact) return whole.length ? { ambiguous: whole, word: t.word, rest: t.after } : null;
  if (!t.word || t.comma || t.word.length < 2 || NOT_A_NAME.has(t.low)) return null;
  const hits = list.filter((x) => x.name.toLowerCase().startsWith(t.low));
  const [one] = hits;
  if (one && hits.length === 1) return { item: one, rest: t.after, colon: t.colon };
  return hits.length ? { ambiguous: hits, word: t.word, rest: t.after } : null;
}

// the writer meant, and running somewhere else would be wrong.
function optionsToColon(s: string, o: Opts, ctx: Ctx): boolean {
  if (COLON.test(s)) return true;
  const probe: Opts = { ...fresh(), crew: o.crew, project: o.project, machine: o.machine, withs: o.withs, mode: o.mode };
  for (let rest = s; rest; ) {
    const step = readOption(token(rest), rest, probe, ctx, 1);
    if (!step) return false;
    if (step.colon) return true;
    rest = step.rest;
  }
  return false;
}

interface PlaceSpec<T> {
  list: readonly T[];
  kind: string;
  word: string;
  special?: (s: string) => { item: T; rest: string; colon: boolean } | null;
}

function readPlace<T extends { name: string }>(t: Token, o: Opts, ctx: Ctx, { list, kind, word, special }: PlaceSpec<T>): ({ item: T; rest: string; colon: boolean } & { stop?: undefined }) | (Step & { stop: true }) | null {
  const s = t.after;
  if (!s) return null;
  const hit = special?.(s) || pickName(list, s, !!ctx.exact);
  if (hit && 'ambiguous' in hit) {
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

const THIS_COMPUTER: MachineView = { id: '', name: 'this computer' };

// on: cloud is your cloud computer, sandbox a fresh box, here this computer.
function machineWords(ctx: Ctx): (s: string) => { item: MachineView; rest: string; colon: boolean } | null {
  return (s) => {
    const t = token(s);
    if (HERE.test(t.word)) return { item: THIS_COMPUTER, rest: t.after, colon: t.colon };
    if (t.low === 'this' && /^computer\b/i.test(t.after)) {
      const c = token(t.after);
      return { item: THIS_COMPUTER, rest: c.after, colon: c.colon };
    }
    if (t.low === 'sandbox') return { item: { id: 'sandbox', name: 'sandbox' }, rest: t.after, colon: t.colon };
    if (t.low === 'cloud' && !(ctx.machines || []).some((m) => lower(m.name) === 'cloud')) {
      const clouds = (ctx.machines || []).filter((m) => m.kind === 'grid' && !m.computer);
      const [cloud] = clouds;
      if (cloud && clouds.length === 1) return { item: cloud, rest: t.after, colon: t.colon };
    }
    return null;
  };
}

const done = (c: Token): Step => ({ rest: c.after, colon: c.colon });

// with auto [goal | effort]
function readAuto(cur: Token, w: With, o: Opts, ctx: Ctx): Step {
  w.agent = 'auto';
  o.withs = w;
  if (cur.colon) return done(cur);
  const next = token(cur.after);
  if ((ctx.goals || []).includes(next.low)) {
    w.model = next.low;
    return done(next);
  }
  if (effortKnown(ctx, next.low)) {
    w.effort = next.low;
    return done(next);
  }
  return done(cur);
}

// with X [Y] [Z]: harness, model, effort, or Auto's goal. A word known nowhere ends the options.
function readWith(t: Token, o: Opts, ctx: Ctx): Step | null {
  let cur = token(t.after);
  if (!cur.word) return null;
  const w: With = { raw: t.raw, agent: '', model: '', effort: '' };
  if (cur.low === 'auto') return readAuto(cur, w, o, ctx);
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
  if (next.word && effortKnown(ctx, next.low)) {
    w.effort = next.low;
    return done(next);
  }
  return done(cur);
}

function readMode(t: Token, o: Opts, count: number): Step | null {
  if (o.mode) return null;
  let mode: Mode | '' = t.low === 'plan' || t.low === 'edits' ? t.low : '';
  let last = t;
  if (t.low === 'full-auto') mode = 'auto';
  if (t.low === 'full' && !t.colon) {
    const next = token(t.after);
    if (next.low === 'auto') {
      mode = 'auto';
      last = next;
    }
  }
  if (!mode) return null;
  // First, it's only a mode right before `:`. "plan the migration" is a task.
  if (!count && !last.colon && !COLON.test(last.after)) return null;
  o.mode = mode;
  return { rest: last.after, colon: last.colon };
}

// @name: a crew member (or several), else a project.
function readAt(t: Token, s: string, o: Opts, ctx: Ctx): Step | null {
  const thread = !!ctx.thread;
  // crewMentions reads the whole text, so it gets it without this word's marks.
  const src = `${t.word}${t.colon ? ':' : t.comma ? ',' : ''}${s.slice(t.raw.length)}`;
  const m = crewMentions(src, ctx.crew || []);
  const [first, ...more] = m.lead;
  if (first && (!thread || !o.crew)) {
    const used = src.trimEnd().slice(0, src.trimEnd().length - m.rest.length);
    if (o.crew) o.tagged.push(first);
    else o.crew = first;
    o.tagged.push(...more);
    return { rest: m.rest, colon: /[:：]\s*$/.test(used) };
  }
  if (thread) return null;
  const name = t.word.slice(1);
  if (!o.project) {
    const p = name ? findProject(ctx.projects || [], name) : null;
    if (p) {
      o.project = p;
      return { rest: t.after, colon: t.colon };
    }
  }
  problem(o, 'no-match', `No crew member or project matches “${name}”.`, [...(ctx.crew || []).map((x) => `@${x.name}`), ...namesOf(ctx.projects || [])]);
  return { rest: t.after, stop: true };
}

// #project (#123 is an issue)
function readHash(t: Token, o: Opts, ctx: Ctx): Step | null {
  const name = t.word.slice(1);
  if (/^\d+$/.test(name) && !(ctx.projects || []).some((p) => p.name === name)) return null;
  const p = findProject(ctx.projects || [], name);
  if (p) {
    o.project = p;
    return { rest: t.after, colon: t.colon };
  }
  problem(o, 'no-match', `No project matches “${name}”.`, namesOf(ctx.projects || []));
  return { rest: t.after, stop: true };
}

// One option at the front of s. → { rest, colon?, stop? }, or null when this isn't one.
function readOption(t: Token, s: string, o: Opts, ctx: Ctx, count: number): Step | null {
  const thread = !!ctx.thread;
  if (t.word[0] === '@' && !t.word.includes('/')) return readAt(t, s, o, ctx);
  if (t.word[0] === '#' && t.word.length > 1 && !thread && !o.project) return readHash(t, o, ctx);
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


const nothing = (o: Partial<Parsed>, command: string | null = null, arg = ''): Parsed => ({
  command,
  arg,
  crew: null,
  tagged: [],
  project: null,
  machine: null,
  agent: null,
  model: null,
  effort: null,
  mode: null,
  prompt: '',
  problems: [],
  notes: [],
  ...o,
});

type Command = { unknown: string } | { name: string; arg: string };

// A word or a slash command that isn't a task. /new goes on to the options; the rest are whole.
function readCommand(text: string, ctx: Ctx): Command | null {
  const slash = /^\/(\w+)\s*([\s\S]*)$/.exec(text);
  if (slash) {
    const name = (slash[1] ?? '').toLowerCase();
    if (!SLASH.has(name)) return { unknown: slash[1] ?? '' };
    return { name: name === 'start' ? 'help' : name, arg: (slash[2] ?? '').trim() };
  }
  const w = /^([a-z]+)[?.!]?(?:\s+(?:on\s+)?(.+))?$/i.exec(text);
  const name = w?.[1]?.toLowerCase();
  if (!w || !name) return null;
  const arg = w[2];
  if ((LISTS.has(name) || name === 'stop' || name === 'done') && !arg) return { name, arg: '' };
  // "models laptop": a list for a place, if that's a place; else it's a sentence.
  if (name === 'models' && arg && (ctx.machines || []).some((m) => lower(m.name).startsWith(lower(arg)))) return { name, arg: arg.trim() };
  return null;
}

/**
 * What a router needs of a message, for one that knows computers and nothing else (wisp Grid, which
 * holds no projects, models or crew: those are the computer's to read). → { machine, text }, with the
 * message as it should reach that computer, `on <name>` gone; { problems } when the name fits several;
 * null for anything else, which isn't this router's. `on <name>` comes first, after an optional /new:
 * a router can't tell an option from a word, so "in production on build drop the table" is a sentence,
 * and so is "fix it on laptop". Whole names only, so "on mac" isn't Mac Studio. "cloud" and "here"
 * aren't computers: they stay the box's.
 */
export function parseRoute(text: unknown, computers: readonly MachineView[] = []): { machine: string; text: string } | { problems: Problem[] } | null {
  const whole = String(text ?? '').trim();
  if (COLON.test(whole)) return null;
  const ctx: Ctx = { exact: true, machines: computers.some((m) => lower(m.name) === 'cloud') ? [...computers] : [...computers, { id: '', name: 'cloud' }] };
  const cmd = readCommand(whole, ctx);
  if (cmd && ('unknown' in cmd || cmd.name !== 'new')) return null;
  const src = cmd ? cmd.arg : whole;
  const t = token(src);
  if (t.low !== 'on') return null;
  const o = fresh();
  const step = readOption(t, src, o, ctx, 0);
  if (o.problems.length) return o.problems[0]?.kind === 'ambiguous' ? { problems: o.problems } : null;
  const machine = o.machine;
  if (!step || step.stop || machine === undefined || !computers.some((m) => m.id === machine)) return null;
  const said = `${step.colon ? ': ' : ''}${step.rest}`.trim();
  if (!said.replace(COLON, '').trim()) return null; // nothing to do there: not a task, and the box can say so
  return { machine, text: cmd ? `/new ${said}` : said };
}

// The options at the front of src, read into o; → the words left.
function readOptions(src: string, o: Opts, ctx: Ctx): string {
  let rest = src;
  for (let count = 0; rest; count++) {
    const t = token(rest);
    if (!t.word && t.colon) return t.after;
    const step = readOption(t, rest, o, ctx, count);
    if (!step) break;
    rest = step.rest;
    if (step.stop) break;
    if (step.colon || COLON.test(rest)) return rest.replace(COLON, '').trim();
  }
  return rest;
}

/**
 * text (already through stripFormatting) → what it asks for. problems: why it can't start, each
 * { kind, text, choices }; notes: what the first reply should mention. prompt is the words left.
 */
export function parseMessage(text: unknown, ctx: Ctx = {}): Parsed {
  let src = String(text ?? '').trim();
  // A leading `:`: the message exactly as written.
  if (COLON.test(src)) return nothing({ prompt: src.replace(COLON, '').trim() });
  const cmd = readCommand(src, ctx);
  if (cmd && 'unknown' in cmd) {
    if (ctx.thread) return nothing({ prompt: src }); // /goal, /side: words for the agent's task, as a follow-up
    return nothing({ problems: [{ kind: 'unknown', text: `There’s no /${cmd.unknown} here. Send /help, or start with “:” to send it as written.`, choices: [] }] });
  }
  if (cmd && cmd.name !== 'new') return nothing({ prompt: cmd.name === 'btw' ? cmd.arg : '' }, cmd.name, cmd.arg);
  if (cmd) src = cmd.arg;

  const o = fresh();
  const rest = readOptions(src, o, ctx);
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
