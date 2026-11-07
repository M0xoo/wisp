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

/** A file's text loaded for a `doc` block: loading, loaded, or why not. */
export type DocText = { readonly kind: 'loading' } | { readonly kind: 'ready'; readonly text: string } | { readonly kind: 'failed'; readonly reason: string };

/** An item of a `blocked` block (a tool call the sandbox or the mode refused). */
export interface BlockedItem {
  readonly tool: string;
  readonly detail: string;
  readonly why?: string;
}

/**
 * Everything a block may ask of its host. Every member is optional: a block whose action the host
 * doesn't offer renders without that control (a share page has no Reply), never a dead button.
 */
export interface BlockContext {
  /** sends a follow-up to the task: `next` items, `actions` replies, `question` answers */
  readonly reply?: (text: string) => void;
  /** runs a one-click shell command in the task's folder (`actions` items with `command`) */
  readonly run?: (command: string, label?: string) => void;
  readonly openTask?: (id: string) => void;
  readonly openStuff?: (id: string) => void;
  /** a file of the task (files/tree/diff/code): opens it in the side panel's editor or diff */
  readonly openFile?: (path: string, line?: number) => void;
  /** opens a link outside wisp (map, preview, image full size) */
  readonly openUrl?: (url: string) => void;
  /** Allow & retry on a `blocked` block (one item, or all of them when `item` is undefined) */
  readonly allow?: (item: BlockedItem | undefined) => void;
  /** a task by id, live: the `task` block's title and state */
  readonly task?: (id: string) => Accessor<TaskRef | undefined>;
  readonly stuff?: (id: string) => Accessor<StuffRef | undefined>;
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
  /** the block's own copy, translated; default English (./strings.ts) */
  readonly t?: (key: BlockString, vars?: Readonly<Record<string, string | number>>) => string;
}
