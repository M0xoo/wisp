// What This Mac reads (design/machine.md, `GET /api/machine` and `GET /api/load` in v1). The Rust
// wisp.machine plugin publishes them as rows on two topics, so the UI subscribes instead of polling:
//   plugin:wisp.machine:snapshot  entity `machine.snapshot`, id `this`: the whole reading (10 s while watched)
//   plugin:wisp.machine:load      entity `machine.load`, id `this`: the cheap one the chip reads (15 s)
// Watching `snapshot` is what makes the peer measure (v1: "only while GET /machine was read in the
// last 30 s"). Shapes follow v1 field for field; one file, so switching to the generated types
// (packages/protocol/src/generated/machine/) is one edit.

export const SNAPSHOT_TOPIC = 'plugin:wisp.machine:snapshot' as const;
export const LOAD_TOPIC = 'plugin:wisp.machine:load' as const;
export const SNAPSHOT = 'machine.snapshot';
export const LOAD = 'machine.load';
export const THIS = 'this';

export type Held = 'paused' | 'battery' | 'memory' | 'cpu' | 'runs';

export interface Guard {
  readonly held: Held | null;
  readonly why: string | null;
  readonly floor: number | null;
  readonly ceiling: number | null;
  readonly maxRuns: number | null;
  readonly runs: number;
  readonly pausedUntil: number;
  readonly battery: { readonly pct: number; readonly charging: boolean; readonly hold: number | null } | null;
}

export interface TaskUse {
  readonly id: string;
  readonly title: string;
  readonly crew: string | null;
  readonly rss: number;
  readonly cpu: number;
  readonly procs: number;
  readonly worktreeBytes: number | null;
}

export interface CrewUse {
  readonly id: string;
  readonly name: string;
  readonly rss: number;
  readonly cpu: number;
  readonly jobs: number | readonly string[];
}

export interface Leftover {
  readonly pid: number;
  readonly command: string;
  readonly rss: number;
  readonly cpu: number;
  readonly task: string | null;
  readonly since: number;
}

export interface LeftoverGroup {
  readonly id: string;
  readonly command: string;
  readonly task: string | null;
  readonly count: number;
  readonly rss: number;
  readonly cpu: number;
  readonly pids: readonly number[];
  readonly commands: readonly string[];
  readonly since: number;
}

export interface HistoryPoint {
  readonly at: number;
  readonly freePct: number | null;
  readonly cpu: number | null;
  readonly runs: number;
  readonly held: boolean;
  readonly worktreeBytes: number | null;
}

export type ReclaimKind = 'merged' | 'done' | 'crew' | 'leftover';

export interface ReclaimGroup {
  readonly kind: ReclaimKind | 'harness';
  readonly count: number;
  readonly bytes: number;
  readonly ids: readonly string[];
}

export interface HarnessDisk {
  readonly id: string;
  readonly name: string;
  readonly bytes: number;
  readonly parts: readonly { readonly label: string; readonly path: string; readonly bytes: number }[];
  readonly removable: { readonly count: number; readonly bytes: number };
  readonly how: string;
}

export interface HarnessGroup extends ReclaimGroup {
  readonly kind: 'harness';
  readonly total: number;
  readonly measuredAt: number;
  readonly harnesses: readonly HarnessDisk[];
}

export interface MachineSnapshot {
  readonly at: number;
  /** 'darwin' | 'win32' | 'linux': names the pane (This Mac, This PC, This computer) */
  readonly platform?: string;
  readonly mem: { readonly total: number; readonly freePct: number | null; readonly pressure: number | null; readonly per: 'footprint' | 'rss' };
  readonly cpu: { readonly pct: number | null; readonly cores: number };
  readonly disk: { readonly free: number; readonly total: number; readonly worktrees: number | null; readonly reclaimable: number };
  readonly wisp: { readonly rss: number; readonly cpu: number };
  readonly guard: Guard;
  readonly tasks: readonly TaskUse[];
  readonly crew: readonly CrewUse[];
  readonly leftovers: readonly Leftover[];
  /** the store's column names: snake case where two words */
  readonly leftover_groups: readonly LeftoverGroup[];
  readonly history: readonly HistoryPoint[];
  readonly reclaim: readonly (ReclaimGroup | HarnessGroup)[];
  /** Settings → Worktrees' automatic cleanup, in idle days, or 'off' */
  readonly cleanup?: string;
}

/** The chip's cheap reading (v1 GET /load). */
export interface MachineLoad {
  readonly at: number;
  readonly platform?: string;
  readonly mem_free_pct: number | null;
  /** the CPU in use, as a share of all cores (v1 load.cpu); absent on rows written before it was kept */
  readonly cpu?: number | null;
  readonly runs: number;
  readonly held: { readonly kind: Held; readonly why: string } | null;
  readonly limits: { readonly floor: number | null; readonly maxRuns?: number | null };
  readonly paused_until: number;
  /** processes left behind, from the last snapshot */
  readonly left_behind: number;
}

/** The task row's RAM column reads `res` off the list summary (set over 500 MB or 50% CPU). */
export interface RowRes {
  readonly state?: string;
  readonly res?: { readonly rss: number; readonly cpu: number };
}
