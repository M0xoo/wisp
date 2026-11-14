// The open task as v1 shows it (web/js/features/split.js, feed.js openBody, transcript.js): its head,
// its turns (the ask, the answer's brief, the trail), the details column with the task's actions,
// the overlap note and the reply box. It renders at once from the list's row (design/feedback.md);
// the turns fill in as the task's own topic arrives. Every control answers at once (design/feedback.md):
// Mark done, a follow-up, Rerun and Fork show their result before the peer answers; Ship it and a
// restore show their control working; the panes and menus open in the same frame.

import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup, untrack, type JSX } from 'solid-js';
import { entityKey, ownerOf, uuidv7, type EntityKey, type Json } from '@wisp/client';
import {
  Answer,
  BtwList,
  Button,
  Dialog,
  Inline,
  OverlapNote,
  RateButtons,
  ReplyBox,
  TaskBody,
  TaskDetails,
  TaskHead,
  TurnView,
  WhyForm,
  WorkingPanel,
  useSignal,
  type IconName,
  type MenuEntry,
  type TaskAction,
  type ReplyCap,
  type TaskPlaceChip,
} from '@wisp/ui';
import { useShell } from '../context.tsx';
import { SESSION, type SessionRow } from '../rows.ts';
import { Slot, useClients, usePluginClient } from '../slot.tsx';
import { TaskHeadSlot } from './slots.tsx';
import { useProjects } from './projects.ts';
import { taskPlaces } from './project-pick.ts';
import { switchTo } from './project-switch.ts';
import { changeFigures, duration, foldedFrom, longTime, nextNeedsYou, overlapLine, overlapsOf, statusOf } from './rows-view.ts';
import { coldHint, compactItem } from './cold.ts';
import { replyPlaceholderKey } from './reply-hint.ts';
import { goalGate } from './goal-gate.ts';
import { feedbackCommand, isFeedback } from './feedback.ts';
import { readComments } from './comment-text.ts';
import { useNow } from '../clock.ts';
import { stopQuestion, type StopQuestion } from './stop-question.ts';
import { noOutputLine } from './no-output.ts';
import { promptKeys, remember, sentStore } from './prompt-keys.ts';
import { draftValue, replyDraft } from './drafts.ts';
import { keep, placeOf, placesStore, scrollFor, type Place } from './place.ts';
import { dismiss, dismissedStore, shownOverlaps, type Dismissed } from './overlap-dismiss.ts';
import { menuEntryOf, taskMenu, type TaskMenuEntry } from '../task-menu.ts';
import {
  rateTurn,
  ratingOf,
  btw,
  btwDrop,
  btwOf,
  btwQuestion,
  setSetting,
  archive,
  stopRun,
  coldOf,
  compactNow,
  followUp,
  forLater,
  setLean,
  type Attachment,
  fork,
  remove,
  rename,
  rerun,
  restore,
  setGoal,
  setMode,
  setState,
} from './commands.ts';
import { answerContext } from './answer-ctx.ts';
import { answerComments } from './answer-comments.ts';
import { blockedOf } from './answer-of.ts';
import { TASK_KEY, type TaskKey } from './task-keys.ts';
import { usePromptMenu } from './prompt-menu.ts';
import { useAttachments } from './attach.ts';
import { attachAct } from './capture.ts';
import { useMic } from './dictate.ts';
import type { PickOptions } from '../platform/types.ts';
import { harnessOf } from './harness.ts';
import { RunnerPicker } from './RunnerPicker.tsx';
import { TurnTranscript } from './TurnTranscript.tsx';
import { isStub, turnOpener } from './turn-window.ts';
import { envReveal } from './env-reveal.ts';
import { runPick, type Runner } from './runner.ts';
import { rowUsage, taskUsage, type TurnStatsLike } from './task-usage.ts';
import { MODE_ICON, agentMenu, modeMenu, teamMenu, whenMenu, type Mode, type When } from './pickers.ts';
import { capOf } from './cap.ts';

interface TurnBody {
  readonly prompt?: string;
  readonly startedAt?: number;
  readonly endedAt?: number | null;
  readonly checkpoint?: { readonly commit?: string; readonly branch?: string };
  readonly presentation?: { readonly blocks?: readonly { readonly type: string; readonly title?: string; readonly summary?: string }[] };
  readonly stats?: { readonly costUsd?: number; readonly durationMs?: number; readonly inputTokens?: number; readonly outputTokens?: number };
  readonly activity?: readonly { readonly kind: string; readonly label?: string }[];
  readonly raw?: string;
  readonly presentationNotes?: string;
  readonly changes?: readonly { readonly file: string; readonly edits?: readonly unknown[] }[];
  /** where runtime keeps a turn's changes today */
  readonly ext?: { readonly 'wisp.runtime'?: { readonly changes?: readonly { readonly file: string; readonly edits?: readonly unknown[] }[] } };
}

/** A step of a turn, as the task's topic sends it (runtime's event log: `kind`, and a tool's `tool` and `label`). */
/** A tool's output carried by its own `tool_output` event, as a step's `out` and the event that carried it. */
const outputOf = (o: { readonly text: string; readonly seq: number } | undefined): { out?: string; seq?: number } => (o?.text ? { out: o.text, seq: o.seq } : {});

interface EventRow {
  readonly seq: number;
  readonly turn_id: string;
  /** when it happened (ms) */
  readonly t?: number;
  readonly kind?: string;
  readonly body?: {
    readonly kind?: string;
    readonly tool?: string;
    readonly label?: string;
    /** its whole title when the label was cut (v1 #780) */
    readonly title?: string;
    readonly text?: string;
    readonly detail?: string;
    readonly file?: string;
    readonly output?: string;
    readonly callId?: string;
    /** when a call's result came in */
    readonly outAt?: number;
    readonly name?: string;
  };
}

interface TurnRow {
  readonly id: string;
  readonly session_id: string;
  readonly idx: number;
  readonly prompt: string;
  readonly started_at: number;
  readonly status?: string;
  readonly body: TurnBody;
}

const ACT_ICON: Readonly<Record<string, IconName>> = { read: 'read', edit: 'pen', run: 'terminal', error: 'warn', text: 'text', tool: 'tool' };

const clock = (at: number): string => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(at);

export default function TaskView(props: { readonly id: string; readonly onBack?: () => void }): JSX.Element {
  const shell = useShell();
  const t = shell.t;
  const key = props.id as EntityKey;
  const scope = shell.client.scope.child(`task:${key}`);
  onCleanup(() => scope.dispose());
  // the topic names the session by its own id, the part after `<peer>:`
  const bare = key.slice(key.indexOf(':') + 1);
  shell.client.peers.watch(ownerOf(key), `session:${bare}`, scope);
  const row = useSignal(shell.client.entities.row<SessionRow>(SESSION, key));
  const allTurns = useSignal(shell.client.entities.list<TurnRow>('turn'));
  const allEvents = useSignal(shell.client.entities.list<EventRow>('event'));
  /** a turn's steps, oldest first: its tool calls and its messages */
  const stepsOf = (turnId: string): EventRow[] =>
    allEvents()
      .filter((e) => e.turn_id === turnId)
      .sort((a, b) => a.seq - b.seq);
  const sessions = useSignal(shell.client.entities.list<SessionRow>(SESSION));
  // a turn names its session by the bare id the server gave it, or by the key (an optimistic one)
  const turns = createMemo(() =>
    allTurns()
      .filter((x) => x.session_id === key || x.session_id === bare)
      .sort((a, b) => a.idx - b.idx),
  );
  // the reply being written is a draft (kind 5): kept across reloads and updates, per task (v1 F-task-32)
  // each task keeps its place (v1 split.js keepPlace/backToPlace, F-task-17): written when it closes or the page hides,
  // read once on opening it, after its turns are there
  let bodyEl: HTMLElement | undefined;
  const places = placesStore(shell.client);
  const turnTops = (el: HTMLElement): { id: string; top: number }[] => {
    const at = el.getBoundingClientRect().top - el.scrollTop;
    return [...el.querySelectorAll<HTMLElement>('[data-turn]')].map((t) => ({ id: t.dataset['turn'] ?? '', top: t.getBoundingClientRect().top - at }));
  };
  const keepPlace = (): void => {
    const el = bodyEl;
    if (!el?.isConnected || !el.querySelector('[data-turn]')) return;
    const p = placeOf(el, turnTops(el));
    places.set((cur) => keep(cur as unknown as Record<string, Place>, key, p) as unknown as Json);
  };
  onCleanup(keepPlace);
  const onHide = (): void => {
    if (document.visibilityState === 'hidden') keepPlace();
  };
  addEventListener('pagehide', keepPlace);
  document.addEventListener('visibilitychange', onHide);
  onCleanup(() => {
    removeEventListener('pagehide', keepPlace);
    document.removeEventListener('visibilitychange', onHide);
  });
  let placed = false;
  createEffect(() => {
    if (placed || turns().length === 0) return;
    placed = true;
    // after a reload the kept places are still loading from disk
    void places.ready.then(() => {
      const p = (places.value() as unknown as Readonly<Record<string, Place>> | undefined)?.[key];
      requestAnimationFrame(() => {
        const el = bodyEl;
        if (el && p) el.scrollTop = scrollFor(p, el, turnTops(el));
        // placed away from the end (its kept place, or its top): what shows stays as turns land (F-page-44)
        if (el) keepShown(el);
      });
    });
  });
  const [rKey, rField] = replyDraft(key);
  const reply$ = useSignal(shell.client.drafts.get<string>(rKey, rField));
  const text = (): string => reply$() ?? '';
  const setText = (v: string): void => shell.client.drafts.set(rKey, rField, draftValue(v));
  let input: HTMLTextAreaElement | undefined;
  queueMicrotask(() => shell.nav().layout === 'split' && input?.focus());
  const titleOf = (id: string): string => sessions().find((s) => s.id === id)?.title ?? '';
  // the overlap note's × (v1 #787): closed for this task until what it says changes; kept in this browser as v1 did
  const closedNotes = dismissedStore(shell.client);
  const closed = useSignal(closedNotes.value);
  // until the kept ones load (a reload), a closed note would flash up and go: it waits for them
  const [closedReady, setClosedReady] = createSignal(false);
  void closedNotes.ready.catch(() => undefined).finally(() => setClosedReady(true)); // a failed load shows them all
  const closeNote = (id: string, all: ReturnType<typeof overlapsOf>): void => {
    closedNotes.set((cur) => dismiss(cur as unknown as Dismissed, id, all));
  };
  const peer = ownerOf(key);
  const run = shell.client.commands.run;
  // the cold-cache line and Compact now (v1 cold-cache.js): asked again whenever the task settles or changes
  const now = useNow(shell.client);
  // Stop asks first (v1 #781): what else stops (its running subagents, a subagent's report), and that queued follow-ups stay
  const [stopAsk, setStopAsk] = createSignal<StopQuestion | undefined>();
  const [stopping, setStopping] = createSignal(false);
  const allRows = useSignal(shell.client.entities.list<SessionRow>(SESSION));
  const askStop = (): void => {
    const r = row();
    if (!r) return;
    const live = allRows().filter((x) => x.parent_id === key && x.state === 'running').length;
    setStopAsk(stopQuestion({ sub: !!r.parent_id, name: harnessOf(harnesses(), r.agent).name, live, queued: Number(r.summary.queued ?? 0) }, t));
  };
  const doStop = (): void => {
    setStopAsk(undefined);
    // checked again after the answer: a run that ended while the question was open isn't stopped by an old Yes
    const st = row()?.state;
    if (st !== 'running' && st !== 'waiting') return;
    setStopping(true);
    void run(stopRun, { id: key })
      .catch(() => undefined)
      .finally(() => setStopping(false));
  };
  const [cold] = createResource(
    () => {
      const r = row();
      return r && r.state !== 'running' ? `${r.state}:${r.updated_at}` : undefined;
    },
    () => run(coldOf, { id: key }).catch(() => undefined),
  );
  const hint = (): ReturnType<typeof coldHint> => (row()?.state === 'running' ? undefined : coldHint(cold(), now(), t));
  const compactOffer = (): ReturnType<typeof compactItem> => (row()?.state === 'running' ? undefined : compactItem(cold(), now(), t));
  // what's open in the page: the steps, the notes, a command in flight, the reply's extras
  const [stepsOpen, setStepsOpen] = createSignal(false);
  const [notesOpen, setNotesOpen] = createSignal(false);
  // 👍 / 👎 on a turn (v1 feedback.js): after 👎, one optional line under that turn's trail
  const [whyFor, setWhyFor] = createSignal<string | undefined>();
  const rate = (turnId: string, rating: 'up' | 'down' | null, text?: string): void => {
    setWhyFor(rating === 'down' && !text ? turnId : undefined);
    if (text) shell.toast.success(t('shell.rate.thanks'));
    void run(rateTurn, { id: key, turnKey: entityKey(peer, turnId), rating, at: Date.now(), ...(text && { text }) }).catch(() => undefined);
  };
  const [restoring, setRestoring] = createSignal(false);
  const [picking, setPicking] = createSignal(false);
  // older turns fold away (v1 transcript.js): Show earlier opens them for this view
  const [unfolded, setUnfolded] = createSignal(false);
  // once the reader has left the end, the first turn shown stays shown as turns land (F-page-44): the window grows
  // instead of sliding, for as long as the task is open (v1's showAll, set the same way, stayed too)
  const [keepFrom, setKeepFrom] = createSignal<string | undefined>(undefined);
  const fold = createMemo(() => foldedFrom(turns(), unfolded(), keepFrom()));
  const keepShown = (el: HTMLElement): void => {
    if (keepFrom() === undefined && el.scrollHeight - el.scrollTop - el.clientHeight >= 2) setKeepFrom(fold().shown[0]?.id);
  };
  const onBodyScroll = (e: Event): void => keepShown(e.currentTarget as HTMLElement);
  // the older turns came as stubs (v1 #788): opening one asks for only that turn
  const opener = turnOpener({
    scope,
    bare,
    watch: (topic, s) => shell.client.peers.watch(ownerOf(key), topic, s),
    stubOf: (id) => ((x) => (x ? isStub(x.body) : undefined))(turns().find((x) => x.id === id)),
    failed: () => shell.toast.show(t('shell.task.openTurnFailed')),
  });
  // files with the reply: picked, pasted or dropped, each uploading at once to the task's computer
  const att = useAttachments(shell, () => ownerOf(key));
  const files = att.files;
  const [team, setTeam] = createSignal<ReadonlySet<string>>(new Set());
  const [goal, setGoalText] = createSignal<string | undefined>(undefined);
  const [when, setWhen] = createSignal<When | undefined>(undefined);
  const nav = useSignal(shell.nav);
  const harnesses = useSignal(shell.harnesses());
  // the @ and / menus (plugins' prompt sources: shell-composer's tasks, crew, My Stuff and commands)
  const menu = usePromptMenu({ shell, where: 'reply', task: key, text, setText, input: () => input, id: `reply-suggest-${bare}` });
  // a plugin may fill this reply box (the file view's ✦: "@src/a.ts:12-20 "): set it, the caret at its end
  const replyBox = { text: () => text(), set: (v: string) => (setText(v), menu.typed(v)), focus: () => (input?.focus(), input?.setSelectionRange(input.value.length, input.value.length)) };
  if (shell.prompts) onCleanup(shell.prompts.provide('reply', replyBox));
  // the phone app's mic (v1 dictate.js): none elsewhere
  const mic = useMic(shell, { text, set: replyBox.set, el: () => input });
  // the reply box's harness · model (v1 S.replyRunners): the next follow-ups run on it, the task keeps its own
  const [replyRun, setReplyRun] = createSignal<Runner | undefined>(undefined);
  const [runnerOpen, setPickingRunner] = createSignal(false);
  const runOf = (): ReturnType<typeof runPick> => runPick(replyRun());
  let goalInput: HTMLInputElement | undefined;
  // each prompt source with its own plugin's client, the one its extensions get
  // (a page without the shell's clients, a test's, uses the shell's own)
  const clients = ((): { client(plugin: string): ReturnType<typeof shell.client.plugin> } => {
    try {
      return useClients();
    } catch {
      return { client: (pl) => shell.client.plugin(pl) };
    }
  })();
  const sent = sentStore(shell.client);
  const sentList = useSignal(sent.value);
  const replyMode = (): string => String(row()?.summary['mode'] ?? 'auto');
  // ↑ brings back what you sent, Shift+Tab cycles the task's mode (v1 prompt-history.js, F-task-31, F-comp-4)
  const replyKeys = promptKeys({
    sent: () => sentList() as readonly string[],
    value: text,
    set: (v) => (setText(v), menu.typed(v)),
    mode: { get: replyMode, set: (m) => void run(setMode, { id: key, mode: m }).catch(() => undefined) },
  });
  // while it works, a follow-up waits behind the run when Settings → Follow-ups says Queue (v1 queued.js; else it steers)
  const followSetting = useSignal(shell.client.entities.row<{ value?: unknown }>('setting', entityKey(peer, 'runtime.followUp')));
  const queueOn = (): boolean => followSetting()?.value === 'queue';
  const working = (): boolean => row()?.state === 'running' || row()?.state === 'waiting';
  const queues = (): boolean => working() && queueOn();
  const shellHome = usePluginClient('shell').home;
  // every folder it works in, its own first (F-task-27): a chip opens that project, the list showing only it
  const projects = useProjects(shell, shellHome).list;
  const placeChips = (s: SessionRow): TaskPlaceChip[] =>
    taskPlaces(
      {
        name: String(s.summary['project'] ?? ''),
        color: String(s.summary['color'] ?? ''),
        cwd: String(s.summary['cwd'] ?? ''),
        ...(typeof s.summary['projectId'] === 'string' && { projectId: s.summary['projectId'] }),
      },
      s.body?.['dirs'],
      projects(),
    ).map((p) => {
      const id = p.id;
      const title = t(p.own ? 'shell.task.placeOwn' : 'shell.task.placeAlso', { path: p.path });
      const chip = { name: p.name, color: p.color, title, ...(!p.own && { also: true as const }) };
      if (id === undefined) return chip;
      return { ...chip, onOpen: () => (switchTo(shell, id), shell.nav().layout === 'stack' && shell.navigate({ t: 'home' })) };
    });
  const send = (): void => {
    // /feedback … or /bug …: to the wisp team about this task's run, never a follow-up (v1 composer.js)
    if (isFeedback(text())) {
      const typed = text();
      setText('');
      return feedbackCommand(shell, typed, { home: shellHome, sessionId: key, restore: () => text() === '' && setText(typed) });
    }
    // /btw: a side question, answered beside the run (v1 btw.js), never a follow-up
    const q = btwQuestion(text());
    if (q) {
      setText('');
      void run(btw, { id: key, question: q, tmp: uuidv7(), at: Date.now() }).catch(() => setText(`/btw ${q}`));
      return;
    }
    const v = menu.encode(text().trim());
    if (v) sent.set((cur) => remember(cur as readonly string[], v));
    // the Done when line open and empty: nothing goes, the line takes the focus (v1 #769 replyGoalEmpty)
    const gate = goalGate(v, goal());
    if (gate === 'askGoal') {
      goalInput?.focus();
      shell.toast.show(t('shell.goal.empty'), { action: { label: t('shell.goal.sendWithout'), onClick: () => (setGoalText(undefined), send()) } });
      return;
    }
    menu.reset();
    // what plugins send with it, at its top (comments on lines): the reply goes even with nothing typed
    const extra = shell
      .promptSources()()
      .filter((p) => (p.where ?? ['reply']).includes('reply') && p.pending)
      .map((p) => p.pending?.(v, { client: clients.client((p as { plugin?: string }).plugin ?? 'shell'), task: key }))
      .find((x) => x !== undefined);
    if (!v && !extra) return;
    // a plugin's prompt source may take it (@a crew member: their job, their answer under this turn)
    const pc = shell.client.plugin('shell');
    if (
      !extra &&
      files().length === 0 &&
      shell
        .promptSources()()
        .some((p) => (p.where ?? ['reply']).includes('reply') && p.send?.(v, { client: pc, task: key, restore: (back) => !text().trim() && setText(back) }) === true)
    ) {
      setText('');
      return;
    }
    setText('');
    const g = goal();
    if (g) void run(setGoal, { id: key, text: g }).catch(() => undefined);
    setGoalText(undefined);
    const turnId = entityKey(peer, uuidv7());
    const at = Date.now();
    const idx = turns().length;
    // the box clears at once; with files, the turn starts once they're up (usually already)
    extra?.taken();
    const go = (attachments: readonly Attachment[]): void => {
      run(followUp, {
        id: key,
        text: extra ? extra.text : v,
        turnId,
        idx,
        at,
        ...(attachments.length > 0 && { attachments }),
        ...(runOf() ? { run: runOf() as NonNullable<ReturnType<typeof runOf>> } : {}),
        ...(queues() && { queue: true }),
      }).catch(() => {
        extra?.back();
        setText(v);
      });
    };
    if (files().length === 0) go([]);
    else void att.take().then(go);
  };
  /** an answer's `next` chip, `question` option, `actions` reply: sent as a follow-up */
  const reply = (v: string): void => {
    run(followUp, { id: key, text: v, turnId: entityKey(peer, uuidv7()), idx: turns().length, at: Date.now() }).catch(() => undefined);
  };
  /** an answer's chip without ⌘: into the reply box, to read first */
  const draft = (v: string): void => {
    setText(v);
    input?.focus();
  };
  const side = (kind: 'changes' | 'shell'): void => shell.navigate({ t: 'toggleSide', side: { kind, id: key as never } });
  // Take over (T, Open in <harness>): the task's conversation in its harness's own CLI, in shell-task's Terminal tab
  const takeOver = (): void => shell.navigate({ t: 'openSide', side: { kind: 'view', id: 'shell-task.term' as never } });
  /** a new task from this one (Rerun, Fork): its row and page show at once */
  // Rerun… (v1 rerunDialog): the task's prompt, mode, harness and computer, editable, then a new task (F-task-43/44)
  const openRerun = (agent?: string): void => shell.navigate({ t: 'openOverlay', overlay: { kind: 'dialog', id: 'shell.rerun' as never, params: { id: key, ...(agent && { agent }) } } });
  const copy = (cmd: typeof rerun, agent?: string): void => {
    const newId = entityKey(peer, uuidv7());
    void run(cmd, { id: key, newId, at: Date.now(), ...(agent && { agent }) }).catch(() => undefined);
    shell.navigate({ t: 'openTask', id: newId as never });
  };
  // Ship it is wisp.ship's dialog (an overlay view, `ship.dialog`); without that plugin, navigation drops it
  const ship = (): void => shell.navigate({ t: 'openOverlay', overlay: { kind: 'dialog', id: 'ship.dialog' as never, params: { key } } });
  // v1: leaving a task (done, archived, deleted) opens the next that needs you, else New task
  const next = (): void => {
    const id = nextNeedsYou(untrack(sessions), key);
    if (id) shell.navigate({ t: 'openTask', id: (id.includes(':') ? id : entityKey(peer, id)) as never });
  };
  const markDone = (): void => {
    void run(setState, { id: key, state: 'done' }).catch(() => undefined);
    shell.navigate({ t: 'markDone', id: key as never });
    next();
  };
  // "Open in Claude Code" (v1's Take over; owner, 2026-11-10)
  const harnessName = (): string => harnessOf(harnesses(), row()?.agent ?? '').name;
  // v1 moreMenu: what a task's right-click menu offers is here too: the entries other plugins attach to
  // `shell.row:menu` (Side discussion, Share, Ship it, Run app, Save as recipe, Add to crew, Set goal, Keep worktree);
  // the shell's own (Rerun, Fork, Changes, Shell) are on this page already
  const rowMenu = useSignal(shell.extensions('shell.row:menu'));
  const camel = (k: string): string => k.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
  const menuRow = (): Record<string, unknown> => {
    const r = (row() ?? {}) as unknown as Record<string, unknown>;
    const top = Object.fromEntries(
      Object.entries(r)
        .filter(([k]) => k !== 'body' && k !== 'summary')
        .map(([k, v]) => [camel(k), v]),
    );
    return { ...((r['body'] as object | undefined) ?? {}), ...top, ...((r['summary'] as object | undefined) ?? {}), id: key };
  };
  const extProps = (x: typeof rowMenu extends () => readonly (infer E)[] ? E : never) => ({
    client: clients.client(x.plugin),
    config: x.config,
    session: () => menuRow() as { id: string; agent: string },
  });
  // v1 actions.js moreMenu, in its order: on a phone (its bar folded) Transcript, Rerun, Open in first; then Rename,
  // Copy task ID, Copy resume command, Open project in editor, Fork…, Compact, Lean runs, what plugins attach to a
  // task's menu (Side discussion, Share, Changes and Shell where the bar doesn't have them, Run app, Save as recipe,
  // Add to crew, Set goal), Save for later, Keep worktree, Restore to before latest turn, Archive, Delete task
  const barFolded = (): boolean => nav().layout === 'stack';
  const busyNow = (): boolean => row()?.state === 'running' || row()?.state === 'waiting';
  const lastTurn = (): (TurnBody & { id: string }) | undefined => {
    const x = turns().at(-1);
    return x ? ({ ...(x.body as TurnBody), id: x.id } as TurnBody & { id: string }) : undefined;
  };
  const canRollback = (): boolean => {
    const l = lastTurn();
    return row()?.agent !== 'wisp' && !busyNow() && !!l && (!!(l.changes ?? l.ext?.['wisp.runtime']?.changes)?.length || !!l.checkpoint?.commit);
  };
  const forLaterNow = (): boolean => row()?.summary['forLater'] === true;
  const canSaveForLater = (): boolean => !row()?.archived && (row()?.state === 'review' || row()?.state === 'done');
  // the shell's Rerun is above (folded) or on the page; its Changes and Shell only where the bar doesn't have them
  const moreExts = (): ReturnType<typeof rowMenu> =>
    rowMenu().filter(
      (x) =>
        x.def.bar && !x.def.bar.rowOnly && x.id !== 'shell.row.rerun' && !(barFolded() && (x.id === 'shell.row.changes' || x.id === 'shell.row.shell')) && (x.def.if?.(extProps(x) as never) ?? true),
    );
  // v1 #786 taskMenuHtml: the row's menu's sections and submenus (task-menu.ts), with what only More has: on a phone
  // the bar's folded Transcript, Rerun and Open in first; Compact and Lean runs with the task itself; Copy resume
  // command under Copy ›, Open project in editor and Restore under Files ›
  const more = (): MenuEntry[] => {
    const own: TaskMenuEntry[] = [];
    if (barFolded()) {
      own.push({ section: 'open', order: -30, entry: { value: 'transcript', label: t('shell.task.transcript'), icon: 'transcript', keys: 'V', checked: stepsOpen() } });
      if (!row()?.summary['sideOf'])
        own.push(
          { section: 'open', order: -20, entry: { value: 'rerun', label: t('shell.task.rerun'), icon: 'rerun', keys: '⇧R' } },
          { section: 'open', order: -10, entry: { value: 'openIn', label: t('shell.task.openIn', { harness: harnessName() }), icon: 'terminal', keys: 'T' } },
        );
    }
    own.push({ section: 'task', order: -10, entry: { value: 'rename', label: t('shell.more.rename'), icon: 'pen', keys: 'M' } });
    if (compactOffer()) own.push({ section: 'task', order: 45, entry: { value: 'compact', label: t('shell.cold.compact'), icon: 'minus', hint: compactOffer()?.note ?? '' } });
    // v1's task menu: Lean runs for this task, or as Settings says (Claude Code only)
    if (row()?.agent === 'claude')
      own.push({
        section: 'task',
        order: 46,
        entry: {
          kind: 'group',
          id: 'lean',
          label: t('shell.task.lean'),
          items: (['follow', 'on', 'off'] as const).map((v) => ({
            value: `lean:${v}`,
            label: t(`shell.task.lean.${v}`),
            checked: ((row()?.body as { lean?: string } | undefined)?.lean ?? 'follow') === v,
          })),
        },
      });
    own.push({ sub: 'copy', order: -20, entry: { value: 'copy-id', label: t('shell.more.copyId'), icon: 'copy' } });
    // Copy resume command and Open project in editor are the shell's row entries (row-menu.ts), here as on the row
    if (canRollback()) own.push({ sub: 'files', order: 130, entry: { value: 'rollback', label: t('shell.more.rollback'), icon: 'replay' } });
    if (forLaterNow()) own.push({ section: 'place', order: -20, entry: { value: 'later', label: t('shell.more.unlater'), icon: 'bookmark', keys: 'L' } });
    else if (canSaveForLater()) own.push({ section: 'place', order: -20, entry: { value: 'later', label: t('shell.more.later'), icon: 'bookmark', keys: 'L' } });
    if (row()?.archived) own.push({ section: 'place', order: -10, entry: { value: 'unarchive', label: t('shell.more.unarchive'), icon: 'archive', keys: 'A' } });
    else if (!busyNow()) own.push({ section: 'place', order: -10, entry: { value: 'archive', label: t('shell.task.archive'), icon: 'archive', keys: 'A' } });
    return taskMenu({
      entries: [...own, ...moreExts().map((x) => menuEntryOf(x, extProps(x) as never, t))],
      danger: [{ value: 'delete', label: t('shell.more.delete'), icon: 'trash', danger: true, keys: '⌫' }],
      t,
    });
  };
  const onMore = (v: string): void => {
    if (v === 'transcript') setStepsOpen(!stepsOpen());
    else if (v === 'rerun') openRerun();
    else if (v === 'openIn') takeOver();
    else if (v === 'shell') side('shell');
    else if (v === 'fork') copy(fork);
    else if (v === 'compact') void run(compactNow, { id: key }).catch(() => undefined);
    else if (v.startsWith('lean:')) {
      const lean = v.slice(5);
      void run(setLean, { id: key, ...(lean !== 'follow' && { lean: lean as 'on' | 'off' }) }).catch(() => undefined);
    } else if (v === 'copy') void shell.platform.copy(location.href).then((ok) => shell.toast.show(t(ok ? 'shell.task.copied' : 'shell.task.copyFailed')));
    else if (v === 'archive') {
      void run(archive, { id: key, archived: true }).catch(() => undefined);
      shell.navigate({ t: 'archive', id: key as never });
      next();
    } else if (v === 'delete') {
      void run(remove, { id: key }).catch(() => undefined);
      shell.navigate({ t: 'delete', id: key as never });
      next();
    } else if (v === 'rename') document.querySelector<HTMLElement>('[data-part="split.title"]')?.click();
    else if (v === 'copy-id') void shell.platform.copy(bare).then((ok) => ok && shell.toast.show(t('shell.more.copiedId')));
    else if (v === 'later') void run(forLater, { id: key, forLater: !forLaterNow() }).catch(() => undefined);
    else if (v === 'unarchive') void run(archive, { id: key, archived: false }).catch(() => undefined);
    else if (v === 'rollback') {
      const l = lastTurn();
      if (l)
        void run(restore, { id: key, turn: l.id }).then(
          () => shell.toast.success(t('shell.task.restored')),
          () => undefined,
        );
    } else if (v.startsWith('x:')) {
      const x = rowMenu().find((e) => `x:${e.id}` === v);
      if (x) x.def.bar?.select?.(extProps(x) as never);
    }
  };
  const actions = (s: SessionRow): TaskAction[] => [
    {
      id: 'transcript',
      deskOnly: true,
      key: 'V',
      icon: 'transcript',
      label: t('shell.task.transcript'),
      title: t('shell.task.transcriptTitle'),
      on: stepsOpen(),
      act: { onClick: () => setStepsOpen(!stepsOpen()) },
    },
    {
      id: 'rerun',
      deskOnly: true,
      key: '⇧R',
      icon: 'rerun',
      label: t('shell.task.rerun'),
      title: t('shell.task.rerunTitle'),
      act: { menu: { items: agentMenu(t, harnesses(), s.agent, false), onSelect: (a) => openRerun(a) } },
    },
    {
      id: 'openIn',
      // the owner's rename of v1's Take over (ADR-0033); parity knows it by this part (allowed.md §5)
      part: 'details.openIn',
      deskOnly: true,
      key: 'T',
      icon: 'terminal',
      label: t('shell.task.openIn', { harness: harnessOf(harnesses(), s.agent).name }),
      title: t('shell.task.openInTitle', { harness: harnessOf(harnesses(), s.agent).name }),
      act: { onClick: () => side('shell') },
    },
    {
      id: 'changes',
      key: 'D',
      icon: 'file',
      label: t('shell.task.changes'),
      title: t('shell.task.changesTitle'),
      part: 'split.changes',
      on: nav().side.kind === 'changes',
      act: { onClick: () => side('changes') },
    },
    {
      id: 'shell',
      key: '⌃`',
      icon: 'shell',
      label: t('shell.task.shell'),
      title: t('shell.task.shellTitle'),
      part: 'split.shell',
      on: nav().side.kind === 'shell',
      act: { onClick: () => side('shell') },
    },
    { id: 'ship', key: 'S', icon: 'send', label: t('shell.task.ship'), title: t('shell.task.shipTitle'), act: { onClick: ship } },
    { id: 'done', key: 'E', icon: 'done', label: t('shell.task.done'), title: t('shell.card.done'), tone: 'good', act: { onClick: markDone } },
    { id: 'more', icon: 'dots', label: t('shell.task.more'), title: t('shell.task.more'), act: { menu: { items: more(), onSelect: onMore } } },
  ];
  // the shell's task keys (v1 kbd.js, builtins.tsx): what this page's buttons and More menu do
  const onKey = (e: Event): void => {
    const act = (e as CustomEvent<TaskKey>).detail;
    const did = ((): boolean => {
      if (act === 'transcript') setStepsOpen(!stepsOpen());
      else if (act === 'rerun' || act === 'fork' || act === 'archive' || act === 'delete') onMore(act);
      else if (act === 'openIn') takeOver();
      else if (act === 'shell') side('shell');
      else if (act === 'changes' || act === 'panel') {
        if (act === 'panel' && nav().side.kind !== 'none') shell.navigate({ t: 'closeSide' });
        else side('changes');
      } else if (act === 'pr') shell.navigate({ t: 'toggleSide', side: { kind: 'pr', id: key as never } });
      else if (act === 'ship') ship();
      else if (act === 'done') markDone();
      else if (act === 'later') void run(forLater, { id: key, forLater: !(row()?.summary['forLater'] === true) }).catch(() => undefined);
      else if (act === 'reply') input?.focus();
      else if (act === 'rename') document.querySelector<HTMLElement>('[data-part="split.title"]')?.click();
      else if (act === 'collapse') {
        setStepsOpen(false);
        setUnfolded(false);
      } else if (act === 'top') document.querySelector('[data-kit="turns"]')?.firstElementChild?.scrollIntoView({ block: 'start' });
      else if (act.startsWith('answer:')) {
        // the question waiting over the reply box, else the latest answer's question block: its Nth choice
        const n = Number(act.slice(7)) - 1;
        const opts = document.querySelectorAll<HTMLButtonElement>('[data-part="task.ask"] button, [data-part="block.question.option"]:not(:disabled)');
        const b = opts[n];
        if (!b) return false;
        b.click();
      } else return false;
      return true;
    })();
    if (did) e.preventDefault();
  };
  document.addEventListener(TASK_KEY, onKey);
  onCleanup(() => document.removeEventListener(TASK_KEY, onKey));
  const attach = (o: PickOptions): void => {
    setPicking(true);
    void shell.platform.pickFiles(o).then((picked) => {
      setPicking(false);
      if (picked.length) att.add(picked);
    });
  };
  return (
    <Show when={row()}>
      {(s) => {
        const h = (): { name: string; logo?: string } => harnessOf(harnesses(), replyRun()?.agent ?? s().agent);
        const branch = (): string => String(s().summary['branch'] ?? '');
        const color = (): string => String(s().summary['color'] ?? 'slate');
        const ov = createMemo(() => (!closedReady() ? [] : shownOverlaps(overlapsOf(s()), closed() as unknown as Dismissed | undefined, s().id)));
        const mode = (): Mode => (['plan', 'edits', 'auto'].includes(String(s().summary['mode'])) ? (s().summary['mode'] as Mode) : 'auto');
        // a channel's cap (F-chan-10): the pill after the mode; Lift is the user's switch above it, to Full auto
        const capView = (): ReplyCap | undefined => {
          const c = capOf(s().summary);
          if (!c) return undefined;
          const m = t(`shell.mode.${c}`);
          return {
            label: t('shell.cap.label', { mode: m }),
            title: t('shell.cap.title', { mode: m }),
            lift: { label: t('shell.cap.lift'), title: t('shell.cap.liftTitle'), act: { onClick: () => void run(setMode, { id: key, mode: 'auto' }).catch(() => undefined) } },
          };
        };
        // its usage, its subagents' in, and how full its context is (v1 #785): the server sums them on the row
        const usage = createMemo(() =>
          taskUsage(
            rowUsage(s().summary as unknown as Readonly<Record<string, unknown>>),
            () => turns().map((x) => x.body.stats as TurnStatsLike | undefined),
            t,
            (id) => shell.navigate({ t: 'openTask', id: id as never }),
            () => shell.navigate({ t: 'openOverlay', overlay: { kind: 'viewer', id: 'shell-settings.sheet' as never, params: { pane: 'usage' } } }),
          ),
        );
        return (
          <>
            <TaskBody
              bodyRef={(el) => {
                bodyEl = el;
                el.addEventListener('scroll', onBodyScroll, { passive: true });
                onCleanup(() => el.removeEventListener('scroll', onBodyScroll));
              }}
              details={
                <TaskDetails
                  harness={t('shell.task.harness', { name: h().name })}
                  {...(h().logo && { logo: h().logo })}
                  project={String(s().summary['project'] ?? '')}
                  color={color()}
                  places={placeChips(s())}
                  status={statusOf(s(), t)}
                  {...(branch() && { branch: { head: branch().replace(/-[0-9a-f]{6}$/, ''), tail: branch().match(/-[0-9a-f]{6}$/)?.[0] ?? '', title: branch() } })}
                  {...((u) => (u ? { usage: u } : {}))(usage())}
                  actions={actions(s())}
                />
              }
              turns={
                <>
                  {/* the band over the turns (wisp.goal's): `shell.task:band`, the task's row as its session */}
                  <Slot input="shell.task:band" layout="stack" id={key} session={() => s() as never} />
                  <Show when={fold().hidden > 0}>
                    <Button size="sm" variant="ghost" icon="chevron" part="turn.fold" onClick={() => setUnfolded(true)}>
                      {t('shell.task.earlier', { n: fold().hidden })}
                    </Button>
                  </Show>
                  <For each={fold().shown}>
                    {(turn) => {
                      const b = turn.body;
                      const hero = b.presentation?.blocks?.find((x) => x.type === 'hero');
                      // the steps come as the turn's events (the task's topic); a turn row that carries its own still reads
                      const steps = createMemo((): { kind: string; label?: string; title?: string; detail?: string; out?: string; bad?: boolean; seq?: number }[] => {
                        const all = stepsOf(turn.id);
                        const kindOf = (e: EventRow): string => e.kind ?? e.body?.kind ?? '';
                        // a tool's output: on the step itself, or the tool_output that names its call
                        const outputs = new Map(all.filter((e) => kindOf(e) === 'tool_output' && e.body?.callId).map((e) => [e.body?.callId ?? '', { text: e.body?.text ?? '', seq: e.seq }]));
                        const ev = all.filter((e) => kindOf(e) === 'tool' || kindOf(e) === 'tool_error');
                        if (!ev.length) return [...(b.activity ?? [])];
                        return ev.map((e) =>
                          kindOf(e) === 'tool_error'
                            ? { kind: 'error', label: e.body?.text ?? e.body?.name ?? '', bad: true }
                            : {
                                kind: e.body?.tool ?? 'tool',
                                label: e.body?.label ?? '',
                                ...(e.body?.title && { title: e.body.title }),
                                ...(e.body?.detail && { detail: e.body.detail }),
                                ...(e.body?.file && { file: e.body.file }),
                                // the event that carried the output names it to Reveal (ADR-0050)
                                ...(e.body?.output ? { out: e.body.output, seq: e.seq } : outputOf(outputs.get(e.body?.callId ?? ''))),
                              },
                        );
                      });
                      const cwd = String((s() as { body?: { cwd?: string } }).body?.cwd ?? s().summary['cwd'] ?? '');
                      const here = (text: string): string => (cwd ? text.replace(new RegExp(`(/private)?${cwd.replace(/^\/private/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?`, 'g'), '') : text);
                      const count = (k: string): number => steps().filter((a) => a.kind === k).length;
                      const blocks = b.presentation?.blocks ?? [];
                      const stubbed = isStub(b);
                      const changes = b.ext?.['wisp.runtime']?.changes ?? b.changes ?? [];
                      const figures = changeFigures(changes);
                      const tokens = (b.stats?.inputTokens ?? 0) + (b.stats?.outputTokens ?? 0);
                      // a follow-up with comments on lines: the cards over the words typed with them (v1 sentComments)
                      const sent = readComments(turn.prompt);
                      // comments on this answer (v1 comments.js): words or a whole block, for the next follow-up
                      const comment = answerComments({ shell, client: (pl) => clients.client(pl), task: key, turn: turn.id, of: () => (turn.id === turns().at(-1)?.id ? undefined : sent.rest) });
                      // what a step printed of a .env file: masked, revealed per task (env-reveal.ts)
                      const env = envReveal(shell, key, `${turn.id}:`);
                      return (
                        <>
                          <TurnView
                            id={turn.id}
                            rate={<RateButtons rating={ratingOf(b)} labels={{ up: t('shell.rate.up'), down: t('shell.rate.down') }} onRate={(next) => rate(turn.id, next)} />}
                            {...(whyFor() === turn.id && {
                              trailBody: (
                                <WhyForm
                                  labels={{ placeholder: t('shell.rate.why'), note: t('shell.rate.whyNote'), skip: t('shell.rate.skip'), send: t('shell.rate.send') }}
                                  onSend={(text) => rate(turn.id, 'down', text)}
                                  onSkip={() => {
                                    setWhyFor(undefined);
                                    shell.toast.success(t('shell.rate.thanks'));
                                  }}
                                  onClose={() => setWhyFor(undefined)}
                                />
                              ),
                            })}
                            prompt={sent.rest}
                            askNotes={sent.notes.map((c) => ({
                              n: c.n,
                              on: c.kind === 'text' && c.quote ? `“${c.quote.replace(/\s+/g, ' ')}”` : c.label,
                              removed: c.removed,
                              removedLabel: t('shell.task.commentRemoved'),
                              say: c.note,
                            }))}
                            harness={h().name}
                            {...(h().logo && { logo: h().logo })}
                            time={clock(turn.started_at)}
                            timeTitle={longTime(turn.started_at)}
                            {...(b.checkpoint?.commit && {
                              sha: { short: b.checkpoint.commit.slice(0, 7), title: t('shell.task.checkpoint', { branch: b.checkpoint.branch ?? '', sha: b.checkpoint.commit }) },
                            })}
                            {...(hero?.title && { hero: { title: hero.title, summary: hero.summary ?? '' } })}
                            {...(stubbed && {
                              answer: (
                                <Button size="sm" variant="ghost" icon="chevron" part="turn.open" loading={opener.opening(turn.id)} onClick={() => opener.open(turn.id)}>
                                  {t('shell.task.openTurn')}
                                </Button>
                              ),
                            })}
                            {...(!stubbed && blocks.length > 0 && {
                              answer: (
                                <>
                                  {/* v1 transcript.js renderTranscript: with Transcript on, the turn's timeline comes before its answer */}
                                  <Show when={stepsOpen()}>
                                    <TurnTranscript
                                      steps={[
                                        ...steps(),
                                        ...((b as { presentation?: { notes?: string } }).presentation?.notes
                                          ? [{ kind: 'text', label: String((b as { presentation?: { notes?: string } }).presentation?.notes) }]
                                          : []),
                                      ]}
                                      changes={changes}
                                      env={env}
                                      here={here}
                                      status={turn.status ?? ''}
                                      t={t}
                                    />
                                  </Show>
                                  <Answer
                                    blocks={blocks}
                                    ctx={Object.assign(answerContext({
                                      shell,
                                      key,
                                      turnId: turn.id,
                                      env,
                                      blocked: () => blockedOf(b),
                                      latest: () => turn.id === turns().at(-1)?.id,
                                      title: () => s().title,
                                      transcript: stepsOpen,
                                      meta: () => [
                                        ...(b.endedAt && b.endedAt > turn.started_at ? [duration(b.endedAt - turn.started_at)] : []),
                                        ...(b.stats?.costUsd ? [`$${b.stats.costUsd.toFixed(2)}`] : []),
                                        ...(changes.length ? [t(changes.length === 1 ? 'shell.task.touched.one' : 'shell.task.touched.other', { n: changes.length })] : []),
                                      ],
                                      reply,
                                      draft,
                                      openChanges: () => side('changes'),
                                      apps: () => ((b as { ext?: Record<string, unknown> }).ext?.['wisp.apps'] ?? {}) as Record<string, unknown>,
                                      tour: s().agent === 'wisp',
                                    }), { comment })}
                                  />
                                </>
                              ),
                            })}
                            {...(turn.status === 'running' && { live: s().summary.live || t('shell.task.starting') })}
                            {...(turn.status === 'running' &&
                              turn.id === turns().at(-1)?.id &&
                              (s().state === 'running' || s().state === 'waiting') && {
                                working: (
                                  <WorkingPanel
                                    part="task.working"
                                    waiting={s().state === 'waiting'}
                                    status={
                                      (b as { by?: string }).by === 'compact'
                                        ? t('shell.work.compacting')
                                        : t(s().state === 'waiting' ? 'shell.work.waiting' : 'shell.work.working', { name: harnessName() })
                                    }
                                    elapsed={duration(now() - turn.started_at)}
                                    count={t('shell.work.actions', { count: steps().filter((a) => a.kind !== 'text').length })}
                                    note={noOutputLine(
                                      {
                                        running: turn.status === 'running',
                                        waiting: s().state === 'waiting',
                                        startedAt: turn.started_at,
                                        steps: stepsOf(turn.id).map((e) => ({ kind: e.kind ?? e.body?.kind, t: e.t, outAt: e.body?.outAt, call: e.body?.callId, output: e.body?.output })),
                                        // a delegate of this task still works: its row says so
                                        delegating: allRows().some((x) => x.parent_id === key && x.state === 'running'),
                                      },
                                      now(),
                                      t,
                                    )}
                                    ticker={steps()
                                      .filter((a) => a.kind !== 'text')
                                      .slice(-5)
                                      .reverse()
                                      .map((a) => ({ icon: ACT_ICON[a.kind] ?? 'tool', text: here(a.label ?? a.kind) }))}
                                    actions={
                                      <>
                                        <Show when={Number(s().summary.queued ?? 0) > 0}>
                                          <span data-kit="working-queued">{t('shell.work.queued', { count: Number(s().summary.queued ?? 0) })}</span>
                                        </Show>
                                        <span data-kit="working-grow" />
                                        <Button size="sm" variant="ghost" tone="bad" icon="stop" part="task.stop" loading={stopping()} onClick={askStop}>
                                          {stopping() ? t('shell.stop.stopping') : t('shell.stop.ok')}
                                        </Button>
                                      </>
                                    }
                                  />
                                ),
                              })}
                            actsTitle={t('shell.task.activity')}
                            acts={
                              stepsOpen()
                                ? []
                                : [
                                    { icon: 'read', text: String(count('read')), title: t('shell.task.read', { n: count('read') }) },
                                    { icon: 'pen', text: String(count('edit')), title: t('shell.task.edited', { n: count('edit') }) },
                                    { icon: 'terminal', text: String(count('run')), title: t('shell.task.ran', { n: count('run') }) },
                                  ]
                            }
                            stats={[
                              { text: duration((b.endedAt ?? (turn.status === 'running' ? Date.now() : turn.started_at)) - turn.started_at) },
                              ...(b.stats?.costUsd !== undefined ? [{ text: `$${b.stats.costUsd.toFixed(2)}` }] : []),
                            ]}
                            receipt={{ text: t('shell.task.tokens', { n: tokens }), title: t('shell.task.tokensTitle', { n: tokens }) }}
                            {...(changes.length > 0 && {
                              files: { label: t('shell.task.files', { n: figures.files }), plus: `+${figures.plus}`, minus: `−${figures.minus}`, act: { onClick: () => side('changes') } },
                            })}
                            activity={{
                              open: false,
                              onToggle: () => setStepsOpen(!stepsOpen()),
                              items: steps().map((a) => ({
                                icon: ACT_ICON[a.kind] ?? 'tool',
                                text: here(a.label ?? a.kind),
                                ...(a.detail && { detail: here(a.detail) }),
                                ...(a.out && { out: here(a.out) }),
                                ...(a.bad && { bad: true }),
                              })),
                            }}
                            {...(notesOpen() && { notes: String((b as { presentation?: { notes?: string } }).presentation?.notes ?? t('shell.task.noNotes')) })}
                            tools={[
                              { id: 'notes', icon: 'text', label: t('shell.task.notes'), on: notesOpen(), act: { onClick: () => setNotesOpen(!notesOpen()) } },
                              {
                                id: 'rollback',
                                icon: 'replay',
                                label: t('shell.task.rollback'),
                                act: {
                                  pending: restoring(),
                                  onClick: () => {
                                    setRestoring(true);
                                    run(restore, { id: key, turn: turn.id })
                                      .then(
                                        () => shell.toast.success(t('shell.task.restored')),
                                        () => undefined,
                                      )
                                      .finally(() => setRestoring(false));
                                  },
                                },
                              },
                              { id: 'fork', icon: 'fork', label: t('shell.task.fork'), part: 'turn.fork', act: { onClick: () => copy(fork) } },
                            ]}
                          />
                          {/* under each turn, what plugins say of it (shell-task's cards: why it stopped, held, what changed, the receipt): `shell.turn:foot`, the turn's key as its id */}
                          <Slot input="shell.turn:foot" layout="stack" id={entityKey(peer, turn.id)} session={() => s() as never} />
                        </>
                      );
                    }}
                  </For>
                  {/* the /btw side questions asked on it (v1 btw.js), after its turns: answered on the side, the run carries on */}
                  <BtwList
                    items={btwOf(row()).map((b) => ({
                      id: b.id,
                      question: b.question,
                      ...(b.answer !== undefined && { answer: b.answer }),
                      ...(b.pending && { pending: true }),
                      error: b.error,
                      tip: t('shell.btw.tip', { at: clock(b.at) }),
                    }))}
                    waiting={t('shell.btw.waiting', { name: harnessOf(harnesses(), s().agent).name })}
                    dismiss={(pending) => t(pending ? 'shell.btw.cancel' : 'shell.btw.dismiss')}
                    onDismiss={(btwId) => void run(btwDrop, { id: key, btwId }).catch(() => undefined)}
                  />
                </>
              }
              dock={
                <>
                  <Show when={ov()[0]}>
                    {(o) => (
                      <OverlapNote
                        head={t('shell.overlap.with', { title: titleOf(o().id) })}
                        files={overlapLine(o(), t)}
                        {...(ov().length > 1 && { more: t('shell.overlap.more', { n: ov().length - 1 }) })}
                        moreTitle={t('shell.overlap.moreTitle')}
                        open={t('shell.overlap.open')}
                        openTitle={t('shell.overlap.openTitle')}
                        onOpen={() => shell.navigate({ t: 'openTask', id: o().id as never })}
                        dismiss={{ label: t('shell.overlap.dismiss'), title: t('shell.overlap.dismissTitle'), onDismiss: () => closeNote(s().id, overlapsOf(s())) }}
                        moreAct={{
                          menu: {
                            items: ov()
                              .slice(1)
                              .map((x) => ({ value: x.id, label: titleOf(x.id), hint: overlapLine(x, t) })),
                            onSelect: (id) => shell.navigate({ t: 'openTask', id: id as never }),
                          },
                        }}
                      />
                    )}
                  </Show>
                  {/* what waits on you, over the reply box (shell-task's question and queue): `shell.task:foot` */}
                  <Slot input="shell.task:foot" layout="stack" id={key} session={() => s() as never} />
                  <ReplyBox
                    placeholder={t(replyPlaceholderKey(row()), { name: h().name })}
                    value={text()}
                    onInput={(v) => {
                      setText(v);
                      menu.typed(v);
                    }}
                    onSend={send}
                    onKey={replyKeys}
                    {...(working() && {
                      queue: {
                        label: t('shell.reply.queue'),
                        title: queueOn() ? t('shell.reply.queueOn', { name: h().name }) : t('shell.reply.queueOff', { name: h().name }),
                        on: queueOn(),
                        act: { onClick: () => void run(setSetting, { peer, key: 'runtime.followUp', value: queueOn() ? 'interrupt' : 'queue' }).catch(() => undefined) },
                      },
                    })}
                    suggest={menu.suggest()}
                    onPaste={(e) => menu.paste(e) || att.paste(e)}
                    onFiles={att.add}
                    inputRef={(el) => (input = el)}
                    attach={t('shell.home.attach')}
                    attachAct={attachAct(shell, attach, picking())}
                    mic={mic ? { label: mic.label(), on: mic.on(), act: { onClick: mic.toggle } } : undefined}
                    mode={{
                      label: t(`shell.mode.${mode()}`),
                      title: t('shell.home.fullAutoTitle'),
                      icon: MODE_ICON[mode()],
                      act: { menu: { items: modeMenu(t, mode()), onSelect: (m) => void run(setMode, { id: key, mode: m }).catch(() => undefined) } },
                      cap: capView(),
                    }}
                    runner={{
                      title: t('shell.task.runner', { name: [h().name, replyRun()?.model ?? '', replyRun()?.effort ?? ''].filter(Boolean).join(' · ') }),
                      ...(h().logo && { logo: h().logo }),
                      act: { onClick: () => setPickingRunner(true) },
                    }}
                    team={t('shell.home.delegateTitle')}
                    teamAct={{
                      menu: {
                        items: teamMenu(t, harnesses(), team()),
                        onSelect: (v) => {
                          const next = new Set(team());
                          if (next.has(v)) next.delete(v);
                          else next.add(v);
                          setTeam(next);
                        },
                      },
                    }}
                    goal={t('shell.task.goal')}
                    goalOn={goal() !== undefined}
                    goalAct={{ onClick: () => setGoalText(goal() === undefined ? '' : undefined) }}
                    {...(goal() !== undefined && {
                      goalLine: {
                        label: t('shell.home.goal'),
                        placeholder: t('shell.home.goalPlaceholder'),
                        value: goal() ?? '',
                        onInput: setGoalText,
                        ref: (el: HTMLInputElement) => (goalInput = el),
                      },
                    })}
                    later={t('shell.home.later')}
                    laterAct={{ menu: { items: whenMenu(t), onSelect: (w) => setWhen(w as When) } }}
                    send={t('shell.home.send')}
                    hint={hint()}
                    extras={[
                      ...files().map((f, i) => ({
                        id: `file:${i}:${f.name}`,
                        icon: 'clip' as const,
                        label: f.name,
                        removeLabel: t('shell.home.remove', { name: f.name }),
                        onRemove: () => att.remove(f),
                      })),
                      ...(when()
                        ? [
                            {
                              id: 'when',
                              icon: 'clock' as const,
                              label: t('shell.when.chip', { when: t(`shell.when.${when()}`) }),
                              removeLabel: t('shell.when.clear'),
                              onRemove: () => setWhen(undefined),
                            },
                          ]
                        : []),
                    ]}
                  />
                  <RunnerPicker
                    open={runnerOpen()}
                    onOpenChange={setPickingRunner}
                    peer={peer}
                    value={replyRun() ?? { agent: s().agent, model: String(s().summary.model ?? ''), effort: '' }}
                    onChange={setReplyRun}
                  />
                </>
              }
            />
            <TaskHead
              actions={<TaskHeadSlot id={key} session={() => s() as never} />}
              title={s().title}
              color={color()}
              renameLabel={t('shell.task.rename')}
              panelLabel={t('shell.task.panel')}
              closeLabel={t('shell.task.close')}
              {...(props.onBack && { onBack: props.onBack, backLabel: t('shell.home.back') })}
              onClose={() => shell.navigate({ t: 'home' })}
              onRename={(title) => void run(rename, { id: key, title }).catch(() => undefined)}
              onPanel={() => side('changes')}
              panelOn={nav().side.kind !== 'none'}
            />
            <Show when={stopAsk()}>
              {(q) => (
                <Dialog
                  open
                  role="alertdialog"
                  size="sm"
                  title={q().title}
                  description={q().body}
                  onOpenChange={(open) => !open && setStopAsk(undefined)}
                  part="task.stopAsk"
                  footer={
                    <Inline gap="4" justify="end">
                      <Button variant="ghost" onClick={() => setStopAsk(undefined)}>
                        {t('shell.stop.cancel')}
                      </Button>
                      <Button variant="danger" part="task.stopAsk.ok" onClick={doStop}>
                        {q().ok}
                      </Button>
                    </Inline>
                  }
                />
              )}
            </Show>
          </>
        );
      }}
    </Show>
  );
}
