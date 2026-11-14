// Answer blocks: the kit half of the wisp presentation (v1 web/js/blocks.js, plan §7.3.2). A block is
// whatever an agent wrote in its fenced `wisp` answer, so every field is untrusted: components read
// it through ./read.ts and never assume a shape. Blocks do no IO: whatever needs the outside world
// (open a task, send a reply, load a doc's text, a media URL) goes through the BlockContext the host
// gives, so the same blocks render in the task view, a share page or the gallery.
import type { Accessor, Component } from 'solid-js';
import type { BlockString } from './strings.ts';

/** One answer block as the agent wrote it: `type` plus anything. */
export type AnswerBlock = { readonly type: string } & { readonly [field: string]: unknown };

/** What a block's component receives. */
export interface BlockProps {
  readonly block: AnswerBlock;
  /** its index in the answer: entry delays, comment anchors */
  readonly index: number;
}

/** A renderer the host adds or overrides (`shell.block:renderer`, a plugin's own block type). */
export type BlockRenderer = Component<BlockProps>;

/** A task named by a `task` block, as the host knows it (undefined: not on this computer). */
export interface TaskRef {
  readonly id: string;
  readonly title: string;
  /** 'running' | 'review' | 'done' | 'error' | … */
  readonly state: string;
  readonly agent?: string;
  readonly updatedAt?: number;
}

/** Something in My Stuff named by a `stuff` block. */
export interface StuffRef {
  readonly id: string;
  readonly title: string;
  /** 'app' | 'doc' | 'image' | 'link' | … */
  readonly kind: string;
  readonly sub?: string;
}

/** What Save to My Stuff keeps from a block (v1 features/stuff.js `toggleSave`): a file the answer showed (`path`, by
 *  the task's own name for it), or its text (a code snippet, a doc). */
export interface KeepWhat {
  readonly kind: 'image' | 'video' | 'doc' | 'code';
  readonly path?: string;
  readonly text?: string;
  readonly name?: string;
  readonly lang?: string;
  readonly title?: string;
}

/** Save to My Stuff on a reply's picture, video, doc and code (v1 ctx.keep). `what` names the thing within its turn
 *  (`media:<path>`, `doc:<path>`, `code:<file>:<hash>`); the host adds the task and turn, so the same thing saved
 *  twice is one item and every button on it shows it's kept. Additive (2026-11-14). */
export interface KeepHost {
  /** false: only text can be kept from here (a task on another computer), so pictures and videos show no button */
  readonly files?: boolean;
  /** it's in My Stuff now (live) */
  readonly saved: (what: string) => Accessor<boolean>;
  /** saves it, or takes it out again when it's in */
  readonly toggle: (what: string, it: KeepWhat) => void;
}

/** A file's text loaded for a `doc` block: loading, loaded, or why not. */
export type DocText = { readonly kind: 'loading' } | { readonly kind: 'ready'; readonly text: string } | { readonly kind: 'failed'; readonly reason: string };

/** What a command run from an answer did (runtime.exec). */
export interface RunResult {
  readonly exitCode: number;
  readonly output: string;
  readonly durationMs?: number;
}

/** An item of a `blocked` block (a tool call the sandbox or the mode refused). */
export interface BlockedItem {
  readonly tool: string;
  readonly detail: string;
  readonly why?: string;
}

/** Which masked .env views show as they are (v1 env-mask.js `shown`): the host keeps them per task for the tab's
 *  life, so a refresh or a new turn doesn't hide them again. `id` names one view in this answer (`block:<index>`). */
export interface EnvReveal {
  /** masking is on (the `git.maskEnvFiles` setting); off, every view shows as it is */
  readonly on: () => boolean;
  readonly shown: (id: string) => boolean;
  readonly set: (id: string, shown: boolean) => void;
  /** the item as the server keeps it, once Reveal asked for it (ADR-0050: what reaches the page is masked by the
   *  server); undefined until it arrives, or with no server to ask (a share page never gets one) */
  readonly raw?: (id: string) => Readonly<Record<string, unknown>> | undefined;
}

/**
 * Everything a block may ask of its host. Every member is optional: a block whose action the host
 * doesn't offer renders without that control (a share page has no Reply), never a dead button.
 */
export interface BlockContext {
  /** sends a follow-up to the task: `next` items, `actions` replies, `question` answers */
  readonly reply?: (text: string) => void;
  /** runs a one-click shell command in the task's folder (`actions` items with `command`, `terminal` and `tests`
   *  Run). A result, when the host returns one, shows under the block (exit code, output); a refusal is the host's
   *  toast. */
  readonly run?: (command: string, label?: string) => void | Promise<RunResult | undefined>;
  /** puts text in the task's reply box without sending it (`next` chips, `question` "Answer in my own words") */
  readonly draft?: (text: string) => void;
  readonly openTask?: (id: string) => void;
  readonly openStuff?: (id: string) => void;
  /** Save to My Stuff on pictures, videos, docs and code (absent: no button, e.g. a share page or the tour) */
  readonly keep?: KeepHost;
  /** a file of the task (files/tree/diff/code): opens it in the side panel's editor or diff */
  readonly openFile?: (path: string, line?: number) => void;
  /** opens a link outside wisp (map, preview, image full size) */
  readonly openUrl?: (url: string) => void;
  /** Allow & retry on a `blocked` block (one item, or all of them when `item` is undefined); a rejection puts
   *  the card back */
  readonly allow?: ((item: BlockedItem | undefined) => void | Promise<unknown>) | undefined;
  /** Deny on a `blocked` block */
  readonly deny?: (() => void | Promise<unknown>) | undefined;
  /** the turn ran in Full auto and its harness still refused (its own safety check): nothing wisp can allow, so the
   *  `blocked` card says so and offers no retry (v1 #777). Additive (2026-11-12). */
  readonly unallowed?: boolean;
  /** a task by id, live: the `task` block's title and state */
  readonly task?: (id: string) => Accessor<TaskRef | undefined>;
  readonly stuff?: (id: string) => Accessor<StuffRef | undefined>;
  /** Show in folder for a file an answer names (`doc`): the computer's file manager opens on it */
  readonly revealFile?: (path: string) => void;
  /** a file's text for the `doc` block, live */
  readonly docText?: (path: string) => Accessor<DocText>;
  /** a path or URL an agent named (image, video, doc) → a URL the page can load; undefined: can't */
  readonly media?: (pathOrUrl: string) => string | undefined;
  /** a `preview` block's URL → a URL the frame may load (a proxied localhost, a grid preview) */
  readonly previewUrl?: (url: string) => string | undefined;
  /** an `app` block's saved state, and where it writes (v1 app-state) */
  readonly appState?: { readonly get: (key: string) => unknown; readonly set: (key: string, state: unknown) => void };
  /** extra and overriding renderers, by block type */
  readonly renderers?: Readonly<Record<string, BlockRenderer>>;
  /** false: the answer was shown before, so nothing rises or counts up (v1 firstShow) */
  readonly reveal?: boolean;
  /** this answer is the task's latest: `next`/`question`/`actions` are live only there */
  readonly latest?: boolean;
  /** shown in a task's own page (v1 ctx.trail): its head says the title, its bar the latest turn's state, so a hero
   *  doesn't say them twice. Additive (2026-11-12). */
  readonly inTask?: boolean;
  /** the task's title there (a hero's title that only repeats it is left out) */
  readonly taskTitle?: string;
  /** beside a hero's state (v1 R.hero meta: how long, what it cost, files touched), shown with the transcript */
  readonly heroMeta?: readonly string[];
  /** masked .env views shown (Reveal). Without it a block masks and keeps its Reveal to itself. Additive (2026-11-13). */
  readonly env?: EnvReveal;
  /** the block's own copy, translated; default English (./strings.ts) */
  readonly t?: (key: BlockString, vars?: Readonly<Record<string, string | number>>) => string;
}
