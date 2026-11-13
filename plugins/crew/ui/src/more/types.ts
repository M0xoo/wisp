// Shapes the crew's second half reads beyond ../types.ts. Truth: v1 server/crew.js (localKit),
// server/crew-share.js (export, import), server/usage.js crewStats (track record).

import type { KitFile, Member, MemberView, TeamRow } from '../types.ts';

export type { KitFile, Member, MemberView, TeamRow };

/** A kit file without its id and switch: what you write, paste or a job proposes. */
export type KitDraft = { kind: 'skill' | 'rules'; name: string; description?: string; body: string; path?: string };

/** crew.kit's answer: a file a kit can take (wisp's skills, the project's AGENTS.md). */
export interface LocalKitFile {
  name: string;
  description: string;
  path: string;
  /** `home` or `project` */
  from: string;
  /** its text, as the kit takes it; empty when it couldn't be read */
  body?: string;
}

/** Skills and instructions files on this computer, grouped (v1's shape). */
export interface LocalItem {
  name: string;
  description?: string;
  body: string;
  path?: string;
  /** where it was found: ~/.claude/skills/release-notes */
  from: string;
  /** files beside its SKILL.md */
  files?: number;
}
export interface LocalKitGroups {
  skills: LocalItem[];
  rules: LocalItem[];
}

/** crew.kit answers a flat list. */
export type LocalKit = readonly LocalKitFile[];

/** crew.export: the bundle for these options, checked (notes; secrets refuse it). */
export interface ExportAnswer {
  bundle: { wispCrew: 1; members: { key: string; name: string }[] } & Record<string, unknown>;
  notes: string[];
  file: string;
  gist?: { ref: string; url: string };
}

/** One member a bundle brings, as crew.import's dry run describes it. */
export interface ImportCandidate {
  key: string;
  name: string;
  role: string;
  avatar: string;
  color: string;
  brief: string;
  cron: string;
  on: string[];
  mode: string;
  agent: string;
  model: string;
  kit: KitDraft[];
  notebook?: string;
  /** starts when CI fails: it needs a project */
  needsProject: boolean;
  notes: string[];
}
export interface ImportPreview {
  members: ImportCandidate[];
  /** room left on the crew */
  room: number;
  source?: { owner?: string };
  /** a spell, not a crew bundle: it has its own review (the spells plugin) */
  spell?: Record<string, unknown>;
}
export interface ImportChoice {
  name: string;
  cwd: string;
  skip: boolean;
}

/** A project, as the list holds it (for Works in). */
export interface ProjectRow {
  id: string;
  name: string;
  path: string;
}

/** A harness the runtime offers (for a delegate on any harness). */
export interface HarnessRow {
  id: string;
  name: string;
  available?: boolean;
  models?: { id: string; label?: string }[];
}

// ---------- track record (server/usage.js crewStats) ----------

export type StatKind = 'checkin' | 'trigger' | 'task' | 'mention' | 'delegated';
export const STAT_KINDS: readonly StatKind[] = ['checkin', 'trigger', 'task', 'mention', 'delegated'];
export interface KindUsage {
  runs: number;
  tokens: number;
  cost: number;
  quiet: number;
}
export interface StatDay {
  date: string; // YYYY-MM-DD
  tokens: number;
  quiet?: number;
  kinds?: Partial<Record<StatKind, number>>;
}
export interface TopJob {
  id: string;
  title: string;
  kind: StatKind;
  at: number;
  tokens: number;
  cost: number;
  priced: boolean;
  quiet?: boolean;
}
export interface MemberStat {
  id: string;
  remote?: boolean;
  jobs: number;
  tokens: number;
  cost: number;
  priced: boolean;
  /** days the numbers cover */
  span: number;
  byKind: Record<StatKind, KindUsage>;
  kinds: Record<StatKind, number>;
  daily: StatDay[];
  top: TopJob[];
  counted: number;
  done: number;
  partial: number;
  blocked: number;
  failed: number;
  checkins: number;
  quiet: number;
  later: number;
  questions: number;
  approvals: number;
  followups: number;
  followedUp: number;
  prs: { merged: number };
}
export interface StatWindow {
  label: string;
  account?: string;
  /** 0..1 */
  used: number;
  since: number;
  resetsAt: number;
  tokens: number;
  members: Record<string, number>;
}
/** One range's numbers: an entity row `crew_stats` with id '7' | '30' | '90'. */
export interface CrewStats {
  days: number;
  members: MemberStat[];
  windows: StatWindow[];
  all: { tokens: number };
}
