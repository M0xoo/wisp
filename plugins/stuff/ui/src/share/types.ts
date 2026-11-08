// The shapes sharing reads and sends (v1 server/routes/sessions.js share routes and
// web/js/features/share.js): the preview of what a share carries, the live link, the pasted link's
// card, and the import body. Field names are v1's JSON, so v1 grids answer them unchanged.

/** The task row fields Share… is offered on (the runtime plugin's session row). */
export interface ShareableTask {
  readonly id: string;
  readonly title?: string;
  readonly agent?: string;
  readonly parentId?: string;
  /** a card (a reminder, a draft), not a task */
  readonly kind?: string;
  readonly pending?: boolean;
  readonly delegated?: boolean;
  /** set when the task runs on another machine */
  readonly machine?: string;
  readonly turnCount?: number;
}

/** What goes with the work: its git branch (and remote), or its files. */
export type ShareWork = { readonly kind: 'git'; readonly branch?: string; readonly repo?: string } | { readonly kind: 'files' };

/** A live share link. `locked`: it needs a passkey. */
export interface Shared {
  readonly url: string;
  readonly locked?: boolean;
  readonly at?: number;
  /** what share.create adds to its answer: what was left out, and why */
  readonly notes?: readonly string[];
}

/** Where a share can go: a grid this wisp is signed in to. */
export interface ShareTarget {
  readonly host: string;
}

/** share.preview: what a share of the task would carry, and where it would go. */
export interface SharePreview {
  readonly shared: Shared | null;
  readonly work: ShareWork | null;
  readonly targets: readonly ShareTarget[];
  readonly delegates?: number;
  readonly crew?: readonly string[];
  readonly connectors?: readonly string[];
  readonly skills?: readonly string[];
}

/** The harness, model and effort the import runs with; `note` says why the card picked it. */
export interface RunHere {
  readonly agent: string;
  readonly model?: string;
  readonly effort?: string;
  readonly note?: string;
}

export interface ShareFrom {
  readonly name?: string;
  readonly handle?: string;
  readonly avatar?: string;
}

/** share.peek: the card for a pasted link. Locked and not unlocked: only `from` and `open: false`. */
export interface ShareCardInfo {
  readonly open: boolean;
  readonly locked?: boolean;
  /** the last passkey tried was wrong */
  readonly wrong?: boolean;
  readonly title?: string;
  readonly from?: ShareFrom;
  readonly agent?: string;
  readonly turns?: number;
  readonly delegates?: number;
  readonly work?: ShareWork | null;
  readonly connectors?: readonly string[];
  readonly skills?: readonly string[];
  /** connectors and crew members the import would add here */
  readonly newConnectors?: readonly string[];
  readonly newCrew?: readonly string[];
  /** the best harness here for it, or null when none can run it */
  readonly run: RunHere | null;
  /** the task's id here when this link was imported before */
  readonly imported?: string;
}

/** share.import's body (POST /shares/import). */
export interface ImportArgs {
  readonly url: string;
  readonly passkey?: string;
  readonly prompt: string;
  readonly agent: string;
  readonly model: string | undefined;
  readonly effort: string | undefined;
  readonly connectors: boolean;
  readonly crew: boolean;
  readonly title?: string;
  readonly from: ShareFrom | undefined;
}
