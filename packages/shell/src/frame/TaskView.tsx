// The open task as v1 shows it (web/js/features/split.js, feed.js openBody, transcript.js): its head,
// its turns (the ask, the answer's brief, the trail), the details column with the task's actions,
// the overlap note and the reply box. It renders at once from the list's row (design/feedback.md);
// the turns fill in as the task's own topic arrives. Every control answers at once (design/feedback.md):
// Mark done, a follow-up, Rerun and Fork show their result before the peer answers; Ship it and a
// restore show their control working; the panes and menus open in the same frame.

import { For, Show, createMemo, createSignal, onCleanup, type JSX } from 'solid-js';
import { entityKey, ownerOf, uuidv7, type EntityKey } from '@wisp/client';
import { Answer, Button, OverlapNote, ReplyBox, TaskBody, TaskDetails, TaskHead, TurnView, useSignal, type IconName, type MenuEntry, type TaskAction } from '@wisp/ui';
import { useShell } from '../context.tsx';
import { SESSION, type SessionRow } from '../rows.ts';
import { Slot } from '../slot.tsx';
import { TaskHeadSlot } from './slots.tsx';
import { changeFigures, duration, folded, longTime, overlapLine, overlapsOf, statusOf } from './rows-view.ts';
import { archive, followUp, forLater, type Attachment, fork, remove, rename, rerun, restore, setAgent, setGoal, setMode, setState } from './commands.ts';
import { answerContext } from './answer-ctx.ts';
import { TASK_KEY, type TaskKey } from './task-keys.ts';
import { usePromptMenu } from './prompt-menu.ts';
import { useAttachments } from './attach.ts';
import { harnessOf } from './harness.ts';
import { MODE_ICON, agentMenu, modeMenu, teamMenu, whenMenu, type Mode, type When } from './pickers.ts';

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
interface EventRow {
  readonly seq: number;
  readonly turn_id: string;
  readonly kind?: string;
  readonly body?: { readonly kind?: string; readonly tool?: string; readonly label?: string; readonly text?: string; readonly detail?: string; readonly output?: string; readonly callId?: string; readonly name?: string };
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
  const stepsOf = (turnId: string): EventRow[] => allEvents().filter((e) => e.turn_id === turnId).sort((a, b) => a.seq - b.seq);
  const sessions = useSignal(shell.client.entities.list<SessionRow>(SESSION));
  // a turn names its session by the bare id the server gave it, or by the key (an optimistic one)
  const turns = createMemo(() => allTurns().filter((x) => x.session_id === key || x.session_id === bare).sort((a, b) => a.idx - b.idx));
  const [text, setText] = createSignal('');
  let input: HTMLTextAreaElement | undefined;
  queueMicrotask(() => shell.nav().layout === 'split' && input?.focus());
  const titleOf = (id: string): string => sessions().find((s) => s.id === id)?.title ?? '';
  const peer = ownerOf(key);
  const run = shell.client.commands.run;
  // what's open in the page: the steps, the notes, a command in flight, the reply's extras
  const [stepsOpen, setStepsOpen] = createSignal(false);
  const [notesOpen, setNotesOpen] = createSignal(false);
  const [restoring, setRestoring] = createSignal(false);
  const [picking, setPicking] = createSignal(false);
  // older turns fold away (v1 transcript.js): Show earlier opens them for this view
  const [unfolded, setUnfolded] = createSignal(false);
  const fold = createMemo(() => folded(turns(), unfolded()));
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
  const send = (): void => {
    const v = menu.encode(text().trim());
    menu.reset();
    if (!v) return;
    setText('');
    const g = goal();
    if (g) void run(setGoal, { id: key, text: g }).catch(() => undefined);
    setGoalText(undefined);
    const turnId = entityKey(peer, uuidv7());
    const at = Date.now();
    const idx = turns().length;
    // the box clears at once; with files, the turn starts once they're up (usually already)
    const go = (attachments: readonly Attachment[]): void => {
      run(followUp, { id: key, text: v, turnId, idx, at, ...(attachments.length > 0 && { attachments }) }).catch(() => setText(v));
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
  /** a new task from this one (Rerun, Fork): its row and page show at once */
  const copy = (cmd: typeof rerun, agent?: string): void => {
    const newId = entityKey(peer, uuidv7());
    void run(cmd, { id: key, newId, at: Date.now(), ...(agent && { agent }) }).catch(() => undefined);
    shell.navigate({ t: 'openTask', id: newId as never });
  };
  // Ship it is wisp.ship's dialog (an overlay view, `ship.dialog`); without that plugin, navigation drops it
  const ship = (): void => shell.navigate({ t: 'openOverlay', overlay: { kind: 'dialog', id: 'ship.dialog' as never, params: { key } } });
  const markDone = (): void => {
    void run(setState, { id: key, state: 'done' }).catch(() => undefined);
    shell.navigate({ t: 'markDone', id: key as never });
  };
  // "Open in Claude Code" (v1's Take over; owner, 2026-11-10)
  const harnessName = (): string => harnessOf(harnesses(), row()?.agent ?? '').name;
  const more = (): MenuEntry[] => [
    { value: 'transcript', label: t('shell.task.transcript'), icon: 'transcript', keys: 'V' },
    { value: 'rerun', label: t('shell.task.rerun'), icon: 'rerun', keys: '⇧R' },
    { value: 'openIn', label: t('shell.task.openIn', { harness: harnessName() }), icon: 'terminal', keys: 'T' },
    { kind: 'separator' },
    { value: 'fork', label: t('shell.task.fork'), icon: 'fork' },
    { value: 'copy', label: t('shell.task.copyLink'), icon: 'copy' },
    { value: 'archive', label: t('shell.task.archive'), icon: 'archive' },
    { value: 'delete', label: t('shell.task.delete'), icon: 'trash', danger: true },
  ];
  const onMore = (v: string): void => {
    if (v === 'transcript') setStepsOpen(!stepsOpen());
    else if (v === 'rerun') copy(rerun);
    else if (v === 'openIn' || v === 'shell') side('shell');
    else if (v === 'fork') copy(fork);
    else if (v === 'copy') void shell.platform.copy(location.href).then((ok) => shell.toast.show(t(ok ? 'shell.task.copied' : 'shell.task.copyFailed')));
    else if (v === 'archive') {
      void run(archive, { id: key, archived: true }).catch(() => undefined);
      shell.navigate({ t: 'archive', id: key as never });
    } else if (v === 'delete') {
      void run(remove, { id: key }).catch(() => undefined);
      shell.navigate({ t: 'delete', id: key as never });
    }
  };
  const actions = (s: SessionRow): TaskAction[] => [
    { id: 'transcript', deskOnly: true, key: 'V', icon: 'transcript', label: t('shell.task.transcript'), title: t('shell.task.transcriptTitle'), act: { onClick: () => setStepsOpen(!stepsOpen()) } },
    { id: 'rerun', deskOnly: true, key: '⇧R', icon: 'rerun', label: t('shell.task.rerun'), title: t('shell.task.rerunTitle'), act: { menu: { items: agentMenu(t, harnesses(), s.agent, false), onSelect: (a) => copy(rerun, a) } } },
    { id: 'openIn', deskOnly: true, key: 'T', icon: 'terminal', label: t('shell.task.openIn', { harness: harnessOf(harnesses(), s.agent).name }), title: t('shell.task.openInTitle', { harness: harnessOf(harnesses(), s.agent).name }), act: { onClick: () => side('shell') } },
    { id: 'changes', key: 'D', icon: 'file', label: t('shell.task.changes'), title: t('shell.task.changesTitle'), part: 'split.changes', act: { onClick: () => side('changes') } },
    { id: 'shell', key: '⌃`', icon: 'shell', label: t('shell.task.shell'), title: t('shell.task.shellTitle'), part: 'split.shell', act: { onClick: () => side('shell') } },
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
      else if (act === 'openIn' || act === 'shell') side('shell');
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
  const attach = (): void => {
    setPicking(true);
    void shell.platform.pickFiles({ multiple: true }).then((picked) => {
      setPicking(false);
      if (picked.length) att.add(picked);
    });
  };
  return (
    <Show when={row()}>
      {(s) => {
        const h = (): { name: string; logo?: string } => harnessOf(harnesses(), s().agent);
        const branch = (): string => String(s().summary['branch'] ?? '');
        const color = (): string => String(s().summary['color'] ?? 'slate');
        const ov = createMemo(() => overlapsOf(s()));
        const mode = (): Mode => (['plan', 'edits', 'auto'].includes(String(s().summary['mode'])) ? (s().summary['mode'] as Mode) : 'auto');
        return (
          <>
            <TaskBody
              details={
                <TaskDetails
                  harness={t('shell.task.harness', { name: h().name })}
                  {...(h().logo && { logo: h().logo })}
                  project={String(s().summary['project'] ?? '')}
                  color={color()}
                  status={statusOf(s(), t)}
                  {...(branch() && { branch: { head: branch().replace(/-[0-9a-f]{6}$/, ''), tail: branch().match(/-[0-9a-f]{6}$/)?.[0] ?? '', title: branch() } })}
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
                    const steps = createMemo((): { kind: string; label?: string; detail?: string; out?: string; bad?: boolean }[] => {
                      const all = stepsOf(turn.id);
                      const kindOf = (e: EventRow): string => e.kind ?? e.body?.kind ?? '';
                      // a tool's output: on the step itself, or the tool_output that names its call
                      const outputs = new Map(all.filter((e) => kindOf(e) === 'tool_output' && e.body?.callId).map((e) => [e.body?.callId ?? '', e.body?.text ?? '']));
                      const ev = all.filter((e) => kindOf(e) === 'tool' || kindOf(e) === 'tool_error');
                      if (!ev.length) return [...(b.activity ?? [])];
                      return ev.map((e) =>
                        kindOf(e) === 'tool_error'
                          ? { kind: 'error', label: e.body?.text ?? e.body?.name ?? '', bad: true }
                          : { kind: e.body?.tool ?? 'tool', label: e.body?.label ?? '', ...(e.body?.detail && { detail: e.body.detail }), ...((e.body?.output ?? outputs.get(e.body?.callId ?? '')) && { out: e.body?.output ?? outputs.get(e.body?.callId ?? '') ?? '' }) },
                      );
                    });
                    const cwd = String((s() as { body?: { cwd?: string } }).body?.cwd ?? s().summary['cwd'] ?? '');
                    const here = (text: string): string => (cwd ? text.replace(new RegExp(`(/private)?${cwd.replace(/^\/private/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?`, 'g'), '') : text);
                    const count = (k: string): number => steps().filter((a) => a.kind === k).length;
                    const blocks = b.presentation?.blocks ?? [];
                    const changes = b.ext?.['wisp.runtime']?.changes ?? b.changes ?? [];
                    const figures = changeFigures(changes);
                    const tokens = (b.stats?.inputTokens ?? 0) + (b.stats?.outputTokens ?? 0);
                    return (
                      <>
                      <TurnView
                        prompt={turn.prompt}
                        harness={h().name}
                        {...(h().logo && { logo: h().logo })}
                        time={clock(turn.started_at)}
                        timeTitle={longTime(turn.started_at)}
                        {...(b.checkpoint?.commit && { sha: { short: b.checkpoint.commit.slice(0, 7), title: t('shell.task.checkpoint', { branch: b.checkpoint.branch ?? '', sha: b.checkpoint.commit }) } })}
                        {...(hero?.title && { hero: { title: hero.title, summary: hero.summary ?? '' } })}
                        {...(blocks.length > 0 && { answer: <Answer blocks={blocks} ctx={answerContext({ shell, key, turnId: turn.id, latest: () => turn.id === turns().at(-1)?.id, reply, draft, openChanges: () => side('changes'), apps: () => ((b as { ext?: Record<string, unknown> }).ext?.['wisp.apps'] ?? {}) as Record<string, unknown> })} /> })}
                        {...(turn.status === 'running' && { live: s().summary.live || t('shell.task.starting') })}
                        actsTitle={t('shell.task.activity')}
                        acts={[
                          { icon: 'read', text: String(count('read')), title: t('shell.task.read', { n: count('read') }) },
                          { icon: 'pen', text: String(count('edit')), title: t('shell.task.edited', { n: count('edit') }) },
                          { icon: 'terminal', text: String(count('run')), title: t('shell.task.ran', { n: count('run') }) },
                        ]}
                        stats={[{ text: duration((b.endedAt ?? (turn.status === 'running' ? Date.now() : turn.started_at)) - turn.started_at) }, ...(b.stats?.costUsd !== undefined ? [{ text: `$${b.stats.costUsd.toFixed(2)}` }] : [])]}
                        receipt={{ text: t('shell.task.tokens', { n: tokens }), title: t('shell.task.tokensTitle', { n: tokens }) }}
                        {...(changes.length > 0 && { files: { label: t('shell.task.files', { n: figures.files }), plus: `+${figures.plus}`, minus: `−${figures.minus}`, act: { onClick: () => side('changes') } } })}
                        activity={{ open: stepsOpen(), onToggle: () => setStepsOpen(!stepsOpen()), items: steps().map((a) => ({ icon: ACT_ICON[a.kind] ?? 'tool', text: here(a.label ?? a.kind), ...(a.detail && { detail: here(a.detail) }), ...(a.out && { out: here(a.out) }), ...(a.bad && { bad: true }) })) }}
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
                                run(restore, { id: key, turn: turn.id }).then(() => shell.toast.success(t('shell.task.restored')), () => undefined).finally(() => setRestoring(false));
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
                        moreAct={{ menu: { items: ov().slice(1).map((x) => ({ value: x.id, label: titleOf(x.id), hint: overlapLine(x, t) })), onSelect: (id) => shell.navigate({ t: 'openTask', id: id as never }) } }}
                      />
                    )}
                  </Show>
                  {/* what waits on you, over the reply box (shell-task's question and queue): `shell.task:foot` */}
                  <Slot input="shell.task:foot" layout="stack" id={key} session={() => s() as never} />
                  <ReplyBox
                    placeholder={t('shell.task.reply', { name: h().name })}
                    value={text()}
                    onInput={(v) => {
                      setText(v);
                      menu.typed(v);
                    }}
                    onSend={send}
                    suggest={menu.suggest()}
                    onPaste={att.paste}
                    onFiles={att.add}
                    inputRef={(el) => (input = el)}
                    attach={t('shell.home.attach')}
                    attachAct={{ onClick: attach, pending: picking() }}
                    mode={{ label: t(`shell.mode.${mode()}`), title: t('shell.home.fullAutoTitle'), icon: MODE_ICON[mode()], act: { menu: { items: modeMenu(t, mode()), onSelect: (m) => void run(setMode, { id: key, mode: m }).catch(() => undefined) } } }}
                    runner={{ title: t('shell.task.runner', { name: h().name }), ...(h().logo && { logo: h().logo }), act: { menu: { items: agentMenu(t, harnesses(), s().agent, false), onSelect: (a) => void run(setAgent, { id: key, agent: a }).catch(() => undefined) } } }}
                    team={t('shell.home.delegateTitle')}
                    teamAct={{ menu: { items: teamMenu(t, harnesses(), team()), onSelect: (v) => { const next = new Set(team()); if (next.has(v)) next.delete(v); else next.add(v); setTeam(next); } } }}
                    goal={t('shell.task.goal')}
                    goalOn={goal() !== undefined}
                    goalAct={{ onClick: () => setGoalText(goal() === undefined ? '' : undefined) }}
                    {...(goal() !== undefined && { goalLine: { label: t('shell.home.goal'), placeholder: t('shell.home.goalPlaceholder'), value: goal() ?? '', onInput: setGoalText } })}
                    later={t('shell.home.later')}
                    laterAct={{ menu: { items: whenMenu(t), onSelect: (w) => setWhen(w as When) } }}
                    send={t('shell.home.send')}
                    extras={[
                      ...files().map((f, i) => ({ id: `file:${i}:${f.name}`, icon: 'clip' as const, label: f.name, removeLabel: t('shell.home.remove', { name: f.name }), onRemove: () => att.remove(f) })),
                      ...(when() ? [{ id: 'when', icon: 'clock' as const, label: t('shell.when.chip', { when: t(`shell.when.${when()}`) }), removeLabel: t('shell.when.clear'), onRemove: () => setWhen(undefined) }] : []),
                    ]}
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
          </>
        );
      }}
    </Show>
  );
}
