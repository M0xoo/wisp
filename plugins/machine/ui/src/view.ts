// This Mac's words and sums (design/machine-page.md), DOM-free: v1 web/js/machine-view.js, with the
// copy moved to the catalogue. Everything takes `now` and a `t`, so tests pin both.

import type { HistoryPoint, MachineLoad, MachineSnapshot, ReclaimGroup, ReclaimKind } from './types.ts';

export type T = (key: string, vars?: Readonly<Record<string, string | number>>) => string;

const KB = 1024;
const MB = KB ** 2;
const GB = KB ** 3;
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
/** the chip shows once free memory is under the floor plus this */
export const TIGHT = 10;
/** wisp's default memory floor (v1 server/load.js LOAD_DEFAULTS) */
export const FLOOR_DEFAULT = 15;

/** The pane's name, by the OS wisp runs on (a phone looks at the computer, not itself). */
export function machineLabelKey(platform: string | undefined): string {
  return platform === 'darwin' ? 'machine.name.mac' : platform === 'win32' ? 'machine.name.pc' : 'machine.name.computer';
}

export function size(n: number | null | undefined): string {
  if (n === null || n === undefined || !(n >= 0)) return '';
  if (n < MB) return `${Math.max(1, Math.round(n / KB))} KB`;
  if (n < GB) return `${Math.round(n / MB)} MB`;
  return `${(n / GB).toFixed(n < 10 * GB ? 1 : 0)} GB`;
}

export const pctText = (v: number | null | undefined): string => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${Math.round(v)}%`);

/** 2 h 10 min, 25 min, under a minute */
export function span(ms: number, t: T): string {
  const m = Math.round(ms / MINUTE);
  if (m < 1) return t('machine.span.under');
  if (m < 60) return t('machine.span.min', { m });
  const h = Math.floor(m / 60);
  return m % 60 ? t('machine.span.hmin', { h, m: m % 60 }) : t('machine.span.h', { h });
}

/** 20:00 today, Tue 8:00 another day */
export function clock(at: number, now: number): string {
  const d = new Date(at);
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  return new Date(now).toDateString() === d.toDateString() ? hm : `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${hm}`;
}

export interface Chip {
  /** the number that always shows (the short form in a bar, and the phone's only text) */
  readonly lead: string;
  /** the words after it in the long form */
  readonly rest: string;
  readonly tone: 'bad' | 'warn' | 'neutral';
  /** the tooltip's sentences */
  readonly why: string;
}

/**
 * The top-bar chip: only when it matters (memory tight, work held, automations paused, something
 * left behind), else null. `load` is the cheap reading; the snapshot fills in when there's no load.
 */
export function chipOf(o: { load: MachineLoad | undefined; pausedUntil: number; left: number; now: number; t: T }): Chip | null {
  const { load, now, t } = o;
  const free = load?.mem_free_pct ?? null;
  const runs = load?.runs ?? 0;
  const floor = load?.limits.floor ?? FLOOR_DEFAULT;
  const held = load?.held && load.held.kind !== 'paused' ? load.held : null;
  const until = Math.max(o.pausedUntil, load?.paused_until ?? 0);
  const tight = free !== null && free < floor + TIGHT;
  const paused = until > now;
  const left = o.left || load?.left_behind || 0;
  if (!tight && !held && !paused && !left) return null;
  const [lead, rest] =
    tight || held
      ? [pctText(free), runs ? t('machine.chip.memoryRuns', { runs }) : t('machine.chip.memory')]
      : paused
        ? [t('machine.chip.paused'), t('machine.chip.until', { at: clock(until, now) })]
        : [String(left), t('machine.chip.left')];
  const why = [held?.why, paused ? t('machine.auto.pausedUntil', { at: clock(until, now) }) : '', left ? t('machine.chip.leftWhy', { count: left }) : ''].filter(Boolean).join('. ');
  const tone = free !== null && free < floor ? 'bad' : tight || held ? 'warn' : 'neutral';
  return { lead, rest, tone, why };
}

/** The load the chip reads, from the snapshot when that's all there is. */
export function loadOf(m: MachineSnapshot): MachineLoad {
  const g = m.guard;
  return {
    at: m.at,
    ...(m.platform !== undefined && { platform: m.platform }),
    mem_free_pct: m.mem.freePct,
    runs: g.runs,
    held: g.held && g.held !== 'paused' ? { kind: g.held, why: g.why ?? '' } : null,
    limits: { floor: g.floor },
    paused_until: g.pausedUntil,
    left_behind: m.leftovers.length,
  };
}

/** The task row's RAM column: only a running task the peer marked heavy. */
export const resText = (s: { state?: string; res?: { rss: number } } | undefined): string => (s?.state === 'running' && s.res && s.res.rss > 0 ? size(s.res.rss) : '');

export interface UsingRow {
  readonly key: string;
  readonly kind: 'task' | 'crew' | 'wisp';
  readonly id: string;
  readonly title: string;
  readonly rss: number;
  readonly cpu: number;
  readonly procs: number;
  readonly bytes: number | null;
  /** the task ids Stop and Later act on */
  readonly ids: readonly string[];
}

/** What's using it: running tasks outside the crew, then crew members with their jobs summed, by RAM. */
export function usingRows(m: MachineSnapshot | undefined, t: T): UsingRow[] {
  if (!m) return [];
  const crewIds = new Set(m.crew.map((c) => c.id));
  const tasks: UsingRow[] = m.tasks
    .filter((x) => !x.crew || !crewIds.has(x.crew))
    .map((x) => ({ key: `t:${x.id}`, kind: 'task', id: x.id, title: x.title || t('machine.using.task'), rss: x.rss, cpu: x.cpu, procs: x.procs, bytes: x.worktreeBytes, ids: [x.id] }));
  const crew: UsingRow[] = m.crew.map((c) => {
    const ids = Array.isArray(c.jobs) ? (c.jobs as readonly string[]) : m.tasks.filter((x) => x.crew === c.id).map((x) => x.id);
    const bytes = m.tasks.filter((x) => ids.includes(x.id)).reduce((n, x) => n + (x.worktreeBytes ?? 0), 0);
    return { key: `c:${c.id}`, kind: 'crew', id: c.id, title: c.name || t('machine.using.member'), rss: c.rss, cpu: c.cpu, procs: ids.length, bytes: ids.length ? bytes : null, ids };
  });
  return [...tasks, ...crew].sort((a, b) => b.rss - a.rss || a.title.localeCompare(b.title));
}

/** wisp's own server: the last row, no actions. */
export const wispRow = (m: MachineSnapshot): UsingRow => ({ key: 'wisp', kind: 'wisp', id: 'wisp', title: 'wisp', rss: m.wisp.rss, cpu: m.wisp.cpu, procs: 1, bytes: null, ids: [] });

/** Free up space, safest first; `safe` ones go without asking. */
export const RECLAIM_ORDER: readonly ReclaimKind[] = ['merged', 'done', 'crew', 'leftover'];

export interface ReclaimRow extends ReclaimGroup {
  readonly kind: ReclaimKind;
  readonly key: string;
  readonly label: string;
  readonly safe: boolean;
}

export function reclaimRows(m: MachineSnapshot | undefined, t: T): ReclaimRow[] {
  if (!m) return [];
  const out: ReclaimRow[] = [];
  for (const kind of RECLAIM_ORDER) {
    const g = m.reclaim.find((x) => x.kind === kind);
    if (!g || g.count <= 0) continue;
    out.push({ ...g, kind, key: `r:${kind}`, label: t(`machine.free.${kind}`, { count: g.count }), safe: kind !== 'leftover' });
  }
  return out;
}

export interface DayStats {
  readonly lowFree: number | null;
  readonly peakRuns: number;
  readonly waited: number;
  readonly freed: number;
}

/** The last 24 h from the 1-min history: lowest free memory, most runs at once, minutes held, disk given back. */
export function dayStats(history: readonly HistoryPoint[], now: number): DayStats | null {
  const h = history.filter((p) => p.at > now - 24 * HOUR);
  if (!h.length) return null;
  const frees = h.map((p) => p.freePct).filter((v): v is number => v !== null);
  let freed = 0;
  let waited = 0;
  for (let i = 1; i < h.length; i++) {
    const a = h[i - 1];
    const b = h[i];
    if (!a || !b) continue;
    if (a.worktreeBytes !== null && b.worktreeBytes !== null && a.worktreeBytes > b.worktreeBytes) freed += a.worktreeBytes - b.worktreeBytes;
    if (b.held) waited += Math.min(b.at - a.at, 5 * MINUTE); // a gap in the history isn't an hour of waiting
  }
  return { lowFree: frees.length ? Math.min(...frees) : null, peakRuns: Math.max(0, ...h.map((p) => p.runs)), waited, freed };
}

/** A gauge's line over the last hour, 0..1 in both axes (the kit scales it); null with fewer than two points. */
export function sparkPoints(history: readonly HistoryPoint[], key: 'freePct' | 'cpu' | 'worktreeBytes', now: number, mark: number | null = null): { points: [number, number][]; mark: number | null } | null {
  const pts = history.filter((p) => p.at > now - HOUR && p[key] !== null);
  if (pts.length < 2) return null;
  const top = Math.max(1, mark ?? 0, ...pts.map((p) => p[key] ?? 0)) * 1.1;
  const y = (v: number): number => Math.min(1, Math.max(0, v / top));
  return { points: pts.map((p) => [(p.at - (now - HOUR)) / HOUR, y(p[key] ?? 0)]), mark: mark === null ? null : y(mark) };
}

export interface Choice {
  readonly id: string;
  readonly label: string;
  readonly at: number;
}

/** Pause automations ▾ */
export function pauseChoices(now: number, t: T): Choice[] {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  return [
    { id: 'hour', label: t('machine.pause.hour'), at: now + HOUR },
    { id: 'morning', label: t('machine.pause.morning'), at: d.getTime() },
  ];
}

/** Later ▾ on a running row: in an hour, tonight at 20:00 (while that's over an hour ahead), tomorrow 9:00. */
export function laterChoices(now: number, t: T): Choice[] {
  const tonight = new Date(now);
  tonight.setHours(20, 0, 0, 0);
  const morning = new Date(now);
  morning.setDate(morning.getDate() + 1);
  morning.setHours(9, 0, 0, 0);
  return [
    { id: 'hour', label: t('machine.later.hour'), at: now + HOUR },
    ...(tonight.getTime() - now > HOUR ? [{ id: 'tonight', label: t('machine.later.tonight'), at: tonight.getTime() }] : []),
    { id: 'morning', label: t('machine.later.morning'), at: morning.getTime() },
  ];
}

/** The automations line: paused, held and why, or running as usual. */
export function automationsLine(m: MachineSnapshot | undefined, pausedUntil: number, now: number, t: T): string {
  const g = m?.guard;
  const until = Math.max(pausedUntil, g?.pausedUntil ?? 0);
  if (until > now) return t('machine.auto.pausedUntil', { at: clock(until, now) });
  if (g?.held && g.held !== 'paused') return g.why || t('machine.auto.waiting');
  return t('machine.auto.usual');
}

/** "They wait under 15% free memory, over 200% CPU or at 8 runs going", or that they never wait. */
export function limitsLine(m: MachineSnapshot, t: T): string {
  const g = m.guard;
  const parts = [g.floor !== null ? t('machine.limits.floor', { n: g.floor }) : '', g.ceiling !== null ? t('machine.limits.ceiling', { n: g.ceiling }) : '', g.maxRuns ? t('machine.limits.runs', { n: g.maxRuns }) : ''].filter(Boolean);
  if (!parts.length) return t('machine.limits.off');
  const list = parts.length === 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} ${t('machine.limits.or')} ${parts.at(-1) ?? ''}`;
  return t('machine.limits.wait', { list });
}

/** The battery line under the automations' state, or '' off a Mac or without one. */
export function batteryLine(m: MachineSnapshot, t: T): string {
  const b = m.guard.battery;
  if (!b) return '';
  const base = t('machine.battery.pct', { pct: pctText(b.pct) });
  const on = b.charging ? '' : t('machine.battery.on');
  const hold = b.hold !== null ? t('machine.battery.hold', { n: b.hold }) : '';
  return [base, on, hold].filter(Boolean).join(' · ');
}

/** "Updated just now" / "Updated 2m ago" / "Reading…" */
export function updatedLine(at: number | undefined, now: number, failed: boolean, t: T): string {
  if (at === undefined) return failed ? t('machine.at.failed') : t('machine.at.reading');
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 10) return t('machine.at.now');
  if (s < 60) return t('machine.at.seconds', { n: s });
  return t('machine.at.minutes', { n: Math.round(s / 60) });
}

/** A gauge's tone: memory under the floor is bad, near it a warning. */
export function memTone(free: number | null, floor: number | null): 'bad' | 'warn' | 'neutral' {
  if (free === null || floor === null) return 'neutral';
  return free < floor ? 'bad' : free < floor + TIGHT ? 'warn' : 'neutral';
}
