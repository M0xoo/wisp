// A member's editor (v1 crew.js crewEditor; ADR-0043 §5 `wakes:`), DOM-free: the form's draft from a member (or a
// new one), what Save sends (only what changed, for crew.update; everything, for crew.create), and the Wakes list:
// each a trigger spec targeting this member (`{ on, match? }`; a hand-off is `crew.reported` matching who reports).
import type { Member } from './types.ts';
import type { MemberPatch } from './commands.ts';

export interface Wake {
  readonly on: string;
  readonly match?: Readonly<Record<string, unknown>>;
}

export interface Draft {
  readonly name: string;
  readonly role: string;
  /** a spirit code or an emoji (a new member rolls one) */
  readonly avatar: string;
  /** what else starts their jobs (v1 EVENTS: finished, done, ci) */
  readonly on: readonly string[];
  readonly brief: string;
  readonly cron: string;
  readonly parallel: number;
  readonly agent: string;
  readonly mode: 'plan' | 'edits' | 'auto';
  readonly cwd: string;
  readonly wakes: readonly Wake[];
}

const wakesOf = (m: Partial<Member> & { wakes?: unknown }): Wake[] =>
  Array.isArray(m.wakes)
    ? (m.wakes as unknown[]).filter((w): w is Wake => !!w && typeof w === 'object' && typeof (w as Wake).on === 'string').map((w) => ({ on: w.on, ...(w.match && { match: w.match }) }))
    : [];

/** What else can start their jobs, in v1's order (automations.syncMember kinds). */
export const EVENTS: readonly string[] = ['finished', 'done', 'ci'];

/** The form's start: the member as it is, or a new one (on call, two jobs at once as v1, Full auto). */
export function draftOf(m: (Partial<Member> & { wakes?: unknown }) | undefined): Draft {
  return {
    name: m?.name ?? '',
    role: m?.role ?? '',
    avatar: m?.avatar ?? '',
    on: Array.isArray(m?.on) ? m.on.filter((k) => EVENTS.includes(k)) : [],
    brief: m?.brief ?? '',
    cron: m?.cron ?? '',
    parallel: Math.min(5, Math.max(1, m?.parallel || 2)),
    agent: m?.agent ?? '',
    mode: m?.mode === 'plan' || m?.mode === 'edits' ? m.mode : 'auto',
    cwd: m?.cwd ?? '',
    wakes: m ? wakesOf(m) : [],
  };
}

/** What's wrong with the draft, as an i18n key, or undefined. A name is 1 to 24 letters, digits, spaces, `._-`. */
export function problemOf(d: Draft, taken: readonly string[]): string | undefined {
  const n = d.name.trim();
  if (!n) return 'wisp.crew.editor.need.name';
  if (!/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,23}$/u.test(n)) return 'wisp.crew.editor.bad.name';
  if (taken.some((x) => x.toLowerCase() === n.toLowerCase())) return 'wisp.crew.editor.taken';
  return undefined;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Save on an existing member: only the fields that changed (crew.update merges). */
export function patchOf(d: Draft, before: Draft): MemberPatch & { wakes?: readonly Wake[] } {
  const out: Record<string, unknown> = {};
  for (const k of ['name', 'role', 'avatar', 'on', 'brief', 'cron', 'parallel', 'agent', 'mode', 'cwd', 'wakes'] as const) {
    const v = typeof d[k] === 'string' ? (d[k] as string).trim() : d[k];
    if (!same(v, before[k])) out[k] = v;
  }
  return out as MemberPatch & { wakes?: readonly Wake[] };
}

/** A wake as its row says it: the source's title, and for a hand-off who it follows. */
export function wakeLabel(w: Wake, titleOf: (on: string) => string, t: (k: string, v?: Readonly<Record<string, string | number>>) => string): string {
  const who = typeof w.match?.['member'] === 'string' ? (w.match['member'] as string) : '';
  return w.on === 'crew.reported' && who ? t('wisp.crew.editor.wake.after', { name: who }) : titleOf(w.on);
}

/** Add a wake (the same one twice is one); `member` for a hand-off. */
export function addWake(list: readonly Wake[], on: string, member?: string): Wake[] {
  const w: Wake = on === 'crew.reported' && member ? { on, match: { member } } : { on };
  return list.some((x) => same(x, w)) ? [...list] : [...list, w];
}

/** The editor's params: `{ id }` to edit a member, nothing to add one. */
export const parseEditor = (p: unknown): { id?: string } => {
  const id = (p as { id?: unknown } | null)?.id;
  return typeof id === 'string' && id ? { id } : {};
};

/** v1 crew-templates.js: ready-made members (a spirit, a schedule, and a name, role and brief from the catalogue:
 * `wisp.crew.tpl.<key>.name|role|brief`) that already work. */
export interface Template {
  readonly key: string;
  readonly avatar: string;
  readonly cron: string;
  readonly on?: readonly string[];
}

export const TEMPLATES: readonly Template[] = [
  { key: 'verify', avatar: 'bean.teal.visor.smile.halo', cron: '', on: ['finished'] },
  { key: 'ci', avatar: 'ghost.sky.visor.flat.antenna', cron: '*/30 * * * *' },
  { key: 'review', avatar: 'blob.violet.wide.flat.headphones', cron: '0 * * * *' },
  { key: 'triage', avatar: 'bean.amber.happy.smile.leaf', cron: '0 9 * * 1-5' },
  { key: 'deps', avatar: 'star.lime.dots.grin.beanie', cron: '0 9 * * 1' },
  { key: 'notes', avatar: 'drop.rose.happy.cat.halo', cron: '0 17 * * 5' },
];

/** A template's words, as the catalogue has them. */
export interface TemplateText {
  readonly name: string;
  readonly role: string;
  readonly brief: string;
}

/** A template picked (v1): a name you typed stays (a template's own is a suggestion); the rest is the template's. */
export function fromTemplate(d: Draft, tp: Template, text: TemplateText, names: readonly string[]): Draft {
  const typed = d.name.trim();
  const keep = typed !== '' && !names.includes(typed);
  return { ...d, name: keep ? d.name : text.name, role: text.role, brief: text.brief, cron: tp.cron, on: [...(tp.on ?? [])], avatar: tp.avatar };
}

/** One event chip pressed: on or off. */
export const toggleOn = (on: readonly string[], k: string): string[] => (on.includes(k) ? on.filter((x) => x !== k) : [...on, k]);
