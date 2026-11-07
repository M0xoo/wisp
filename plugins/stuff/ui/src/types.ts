// Every row and argument shape My Stuff's UI reads or sends, in one file (docs/v2-ui-brief.md): when
// packages/protocol/src/generated/ exports the Rust types (crate wisp-stuff-api, ts-rs), this file
// re-exports them and nothing else changes. Until then the truth is plugins/stuff/api/src/lib.rs
// (`StuffView`, what a page sees of an item) and v1's server/services/stuff.js `view()`.

/** The plugin's sync topic and the entity its rows are (`stuff.item`, keyed `<peer>:<id>`). */
export const TOPIC = 'stuff';
export const ITEM = 'stuff.item';

export type StuffKind = 'image' | 'video' | 'doc' | 'code' | 'file' | 'link' | 'app';

export interface StuffFrom {
  session?: string;
  title?: string;
  turn?: string;
  key?: string;
}

export interface Published {
  url: string;
  account?: string;
  host?: string;
  handle?: string;
  rev?: number;
  at?: number;
}

export interface PrevView {
  at: number;
  size?: number;
  by?: string;
}

/** What a page sees of an item (Rust `StuffView`): no paths or hashes, the grant as it holds now. */
export interface StuffView {
  id: string;
  kind: StuffKind;
  name: string;
  title: string;
  mime?: string;
  size: number;
  at: number;
  by: 'you' | 'agent' | 'wisp' | string;
  lang?: string;
  excerpt?: string;
  url?: string;
  entry?: string;
  files?: number;
  uses?: string[];
  from?: StuffFrom;
  note?: string;
  tags?: string[];
  starred?: boolean;
  rev?: number;
  updatedAt?: number;
  published?: Published;
  allowed?: string[];
  changed?: boolean;
  risky?: string[];
  prev?: PrevView;
  cover?: boolean;
  db?: boolean;
  data?: boolean;
  running?: { port: number };
  /** page-only: a save on its way (the optimistic row a command adds before the peer answers) */
  pending?: boolean;
  /** page-only: Publish pressed, the grid hasn't answered */
  publishing?: boolean;
}

/** A row as the entity store hands it out. */
export type Item = Readonly<StuffView>;

/** A pane pin: `<app>@task` or `<app>@home` in the `panes` setting. */
export type PaneWhere = 'task' | 'home';
export interface PanePin {
  app: string;
  where: PaneWhere;
}

/** `stuff.grant`: what a pane may use now. */
export interface Grant {
  allowed: string[];
  changed: boolean;
}

/** `stuff.launch`: where wisp serves the app (127.0.0.1, its own port). */
export interface Launched {
  port: number;
  url: string;
}

/** A starter pane wisp ships (v1 GET /stuff/starters). */
export interface Starter {
  id: string;
  name: string;
  description: string;
}

/** What the page knows of a task, for the pane bridge (the runtime's `session` rows). */
export interface TaskRow {
  id: string;
  title?: string;
  state?: string;
  status?: string;
  project?: string;
  agent?: string;
  account?: string;
  machine?: { name?: string } | null;
  model?: string;
  mode?: string;
  branch?: string;
  preview?: string;
  live?: string;
  unread?: boolean;
  archived?: boolean;
  asks?: boolean;
  pending?: boolean;
  kind?: string;
  crew?: { id: string; name: string } | null;
  pr?: PrRow | null;
  prs?: { repo?: string; pr: PrRow }[];
  turns?: { status?: string }[];
  createdAt?: number;
  updatedAt?: number;
}

export interface PrRow {
  number?: number;
  url: string;
  state?: string;
  draft?: boolean;
  checks?: unknown;
  review?: unknown;
  conflict?: boolean;
}

export interface CrewRow {
  id: string;
  name: string;
  role?: string;
  running?: boolean;
  busy?: boolean;
  nextAt?: number | null;
}
