// The open task as v1 shows it (web/js/features/split.js, feed.js openBody, transcript.js): its head,
// its turns (the ask, the answer's brief, the trail), the details column with the task's actions,
// the overlap note and the reply box. It renders at once from the list's row (design/feedback.md);
// the turns fill in as the task's own topic arrives. Every control answers at once (design/feedback.md):
// Mark done, a follow-up, Rerun and Fork show their result before the peer answers; Ship it and a
// restore show their control working; the panes and menus open in the same frame.

import { For, Show, createMemo, createSignal, onCleanup, type JSX } from 'solid-js';
import { entityKey, ownerOf, uuidv7, type EntityKey } from '@wisp/client';
import { OverlapNote, ReplyBox, TaskBody, TaskDetails, TaskHead, TurnView, useSignal, type IconName, type MenuEntry, type TaskAction } from '@wisp/ui';
import { useShell } from '../context.tsx';
import { SESSION, type SessionRow } from '../rows.ts';
import { TaskHeadSlot } from './slots.tsx';
import { longTime, overlapLine, overlapsOf, statusOf } from './rows-view.ts';
import { archive, followUp, fork, remove, rerun, restore, setAgent, setGoal, setMode, setState, shipOpen } from './commands.ts';
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
  shell.client.peers.watch(ownerOf(key), `session:${key}`, scope);
  const row = useSignal(shell.client.entities.row<SessionRow>(SESSION, key));
  const allTurns = useSignal(shell.client.entities.list<TurnRow>('turn'));
  const sessions = useSignal(shell.client.entities.list<SessionRow>(SESSION));
  const turns = createMemo(() => allTurns().filter((x) => x.session_id === key).sort((a, b) => a.idx - b.idx));
  const [text, setText] = createSignal('');
  let input: HTMLTextAreaElement | undefined;
  queueMicrotask(() => shell.nav().layout === 'split' && input?.focus());
  const titleOf = (id: string): string => sessions().find((s) => s.id === id)?.title ?? '';
  const peer = ownerOf(key);
  const run = shell.client.commands.run;
  // what's open in the page: the steps, the notes, a command in flight, the reply's extras
  const [stepsOpen, setStepsOpen] = createSignal(false);
  const [notesOpen, setNotesOpen] = createSignal(false);
  const [shipping, setShipping] = createSignal(false);
  const [restoring, setRestoring] = createSignal(false);
  const [picking, setPicking] = createSignal(false);
  const [files, setFiles] = createSignal<readonly File[]>([]);
  const [team, setTeam] = createSignal<ReadonlySet<string>>(new Set());
  const [goal, setGoalText] = createSignal<string | undefined>(undefined);
  const [when, setWhen] = createSignal<When | undefined>(undefined);
  const nav = useSignal(shell.nav);
  const harnesses = useSignal(shell.harnesses());
  const send = (): void => {
    const v = text().trim();
    if (!v) return;
    setText('');
    const g = goal();
    if (g) void run(setGoal, { id: key, text: g }).catch(() => undefined);
    setGoalText(undefined);
    setFiles([]);
    run(followUp, { id: key, text: v, turnId: entityKey(peer, uuidv7()), idx: turns().length, at: Date.now() }).catch(() => setText(v));
  };
  const side = (kind: 'changes' | 'shell'): void => shell.navigate({ t: 'toggleSide', side: { kind, id: key as never } });
  /** a new task from this one (Rerun, Fork): its row and page show at once */
  const copy = (cmd: typeof rerun, agent?: string): void => {
    const newId = entityKey(peer, uuidv7());
    void run(cmd, { id: key, newId, at: Date.now(), ...(agent && { agent }) }).catch(() => undefined);
    shell.navigate({ t: 'openTask', id: newId as never });
  };
  const ship = (): void => {
    setShipping(true);
    run(shipOpen, { id: key }).then(
      (r) => shell.toast.success(t('shell.task.shipped', { n: r.number })),
      () => undefined,
    ).finally(() => setShipping(false));
  };
  const markDone = (): void => {
    void run(setState, { id: key, state: 'done' }).catch(() => undefined);
    shell.navigate({ t: 'markDone', id: key as never });
  };
  const more = (): MenuEntry[] => [
    { value: 'transcript', label: t('shell.task.transcript'), icon: 'transcript', keys: 'V' },
    { value: 'rerun', label: t('shell.task.rerun'), icon: 'rerun', keys: '⇧R' },
    { value: 'takeover', label: t('shell.task.takeover'), icon: 'terminal', keys: 'T' },
    { kind: 'separator' },
    { value: 'fork', label: t('shell.task.fork'), icon: 'fork' },
    { value: 'copy', label: t('shell.task.copyLink'), icon: 'copy' },
    { value: 'archive', label: t('shell.task.archive'), icon: 'archive' },
    { value: 'delete', label: t('shell.task.delete'), icon: 'trash', danger: true },
  ];
  const onMore = (v: string): void => {
    if (v === 'transcript') setStepsOpen(!stepsOpen());
    else if (v === 'rerun') copy(rerun);
    else if (v === 'takeover' || v === 'shell') side('shell');
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
    { id: 'takeover', deskOnly: true, key: 'T', icon: 'terminal', label: t('shell.task.takeover'), title: t('shell.task.takeoverTitle'), act: { onClick: () => side('shell') } },
    { id: 'changes', key: 'D', icon: 'file', label: t('shell.task.changes'), title: t('shell.task.changesTitle'), part: 'split.changes', act: { onClick: () => side('changes') } },
    { id: 'shell', key: '⌃`', icon: 'shell', label: t('shell.task.shell'), title: t('shell.task.shellTitle'), part: 'split.shell', act: { onClick: () => side('shell') } },
    { id: 'ship', key: 'S', icon: 'send', label: t('shell.task.ship'), title: t('shell.task.shipTitle'), act: { onClick: ship, pending: shipping() } },
    { id: 'done', key: 'E', icon: 'done', label: t('shell.task.done'), title: t('shell.card.done'), tone: 'good', act: { onClick: markDone } },
    { id: 'more', icon: 'dots', label: t('shell.task.more'), title: t('shell.task.more'), act: { menu: { items: more(), onSelect: onMore } } },
  ];
  const attach = (): void => {
    setPicking(true);
    void shell.platform.pickFiles({ multiple: true }).then((picked) => {
      setPicking(false);
      if (picked.length) setFiles([...files(), ...picked]);
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
                <For each={turns()}>
                  {(turn) => {
                    const b = turn.body;
                    const hero = b.presentation?.blocks?.find((x) => x.type === 'hero');
                    const count = (k: string): number => (b.activity ?? []).filter((a) => a.kind === k).length;
                    const edits = (b.changes ?? []).reduce((n, c) => n + (c.edits?.length ?? 0), 0);
                    const tokens = (b.stats?.inputTokens ?? 0) + (b.stats?.outputTokens ?? 0);
                    return (
                      <TurnView
                        prompt={turn.prompt}
                        harness={h().name}
                        {...(h().logo && { logo: h().logo })}
                        time={clock(turn.started_at)}
                        timeTitle={longTime(turn.started_at)}
                        {...(b.checkpoint?.commit && { sha: { short: b.checkpoint.commit.slice(0, 7), title: t('shell.task.checkpoint', { branch: b.checkpoint.branch ?? '', sha: b.checkpoint.commit }) } })}
                        {...(hero?.title && { hero: { title: hero.title, summary: hero.summary ?? '' } })}
                        {...(turn.status === 'running' && { live: s().summary.live || t('shell.task.starting') })}
                        actsTitle={t('shell.task.activity')}
                        acts={[
                          { icon: 'read', text: String(count('read')), title: t('shell.task.read', { n: count('read') }) },
                          { icon: 'pen', text: String(count('edit')), title: t('shell.task.edited', { n: count('edit') }) },
                          { icon: 'terminal', text: String(count('run')), title: t('shell.task.ran', { n: count('run') }) },
                        ]}
                        stats={[{ text: `${Math.max(0, (b.endedAt ?? turn.started_at) - turn.started_at)}ms` }, { text: `$${(b.stats?.costUsd ?? 0).toFixed(2)}` }]}
                        receipt={{ text: t('shell.task.tokens', { n: tokens }), title: t('shell.task.tokensTitle', { n: tokens }) }}
                        {...((b.changes?.length ?? 0) > 0 && { files: { label: t('shell.task.files', { n: b.changes?.length ?? 0 }), plus: `+${edits ? 1 : 0}`, minus: `−${edits ? 1 : 0}`, act: { onClick: () => side('changes') } } })}
                        activity={{ open: stepsOpen(), onToggle: () => setStepsOpen(!stepsOpen()), items: (b.activity ?? []).map((a) => ({ icon: ACT_ICON[a.kind] ?? 'tool', text: a.label ?? a.kind })) }}
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
                    );
                  }}
                </For>
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
                  <ReplyBox
                    placeholder={t('shell.task.reply', { name: h().name })}
                    value={text()}
                    onInput={setText}
                    onSend={send}
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
                      ...files().map((f, i) => ({ id: `file:${i}:${f.name}`, icon: 'clip' as const, label: f.name, removeLabel: t('shell.home.remove', { name: f.name }), onRemove: () => setFiles(files().filter((x) => x !== f)) })),
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
              onPanel={() => side('changes')}
              panelOn={nav().side.kind !== 'none'}
            />
          </>
        );
      }}
    </Show>
  );
}
