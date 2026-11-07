// A v1 spell after checkSpell: every field cleaned, capped and typed. This is what ~/.wisp/spells
// holds, what GET /api/spells answers and what the converter turns into a manifest.

/** `{ "open": "https://…" }`: exactly one action, by name. */
export type Action = Readonly<Record<string, unknown>>;

/** Where a prompt rule, block or hook applies. */
export interface Scope {
  project?: string[];
  agent?: string[];
  mode?: string[];
}

export type DataSource = { wisp: string; refresh: number } | { gh: string[]; refresh: number; cwd?: 'task' };

export interface Button {
  id: string;
  slot: string;
  label: string;
  icon: string;
  title: string;
  badge?: { count: string } | { fn: string; data: string[] } | { text: string };
  group?: string;
  corner?: 'bottom-left' | 'bottom-right';
  key?: string;
  when?: Record<string, unknown>;
  primary?: true;
  do: Action | null;
}

export interface Chip {
  id: string;
  slot: string;
  text: string;
  fn?: string;
  data?: string[];
  tone: string;
  icon: string;
  title: string;
  when?: Record<string, unknown>;
  do?: Action | null;
}

export interface Panel {
  id: string;
  title: string;
  icon: string;
  as: 'dialog' | 'drawer' | 'feed' | 'card';
  slot?: string;
  data: string[];
  render: string;
  when?: Record<string, unknown>;
  refresh: { every?: number; on: string[] };
}

export interface BlockDef {
  type: string;
  doc: string;
  summary: string;
  render: string;
}

export interface PartOut {
  style?: Record<string, string>;
  props?: Record<string, unknown>;
  order?: string[];
}

export interface PromptRule {
  text: string;
  when?: Scope;
}

export interface Slash {
  name: string;
  args: string;
  hint: string;
  do: Action | null;
}

export interface Command {
  id: string;
  label: string;
  keywords: string;
  icon: string;
  key?: string;
  do: Action | null;
}

export interface Hook {
  id: string;
  on: string;
  if: Record<string, unknown>;
  max: number;
  do: Action | null;
}

export interface Recipe {
  id: string;
  name: string;
  prompt: string;
  cwd: string;
  agent: string;
  model: string;
  effort: string;
  mode: string;
}

/** A crew blueprint (checked by wisp.crew through `plugins.section` when it is on). */
export type Blueprint = Readonly<Record<string, unknown>>;

export interface Spell {
  wispSpell: 1;
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  wisp?: string;
  harnesses: string[];
  when?: Scope;
  data?: Record<string, DataSource>;
  buttons?: Button[];
  chips?: Chip[];
  panels?: Panel[];
  blocks?: BlockDef[];
  parts?: Record<string, PartOut>;
  ui?: { hide?: string[]; tokens?: Record<string, unknown>; dark?: Record<string, unknown> };
  prompt?: PromptRule[];
  settings?: Record<string, unknown>;
  slash?: Slash[];
  commands?: Command[];
  hooks?: Hook[];
  recipes?: Recipe[];
  crew?: Blueprint[];
  script?: string;
}
