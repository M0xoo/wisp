// The open task as v1 shows it (web/js/features/split.js, feed.js openBody, transcript.js): its head,
// its turns (the ask, the answer's brief, the trail), the details column with the task's actions,
// the overlap note and the reply box. It renders at once from the list's row (design/feedback.md);
// the turns fill in as the task's own topic arrives. Sending clears the box at once.

import { For, Show, createMemo, createSignal, onCleanup, type JSX } from 'solid-js';
import { defineCommand, ownerOf, type EntityKey } from '@wisp/client';
import { OverlapNote, ReplyBox, TaskBody, TaskDetails, TaskHead, TurnView, useSignal, type TaskAction } from '@wisp/ui';
import { useShell } from '../context.tsx';
import { SESSION, type SessionRow } from '../rows.ts';
import { HARNESS, longTime, overlapLine, overlapsOf, statusOf } from './rows-view.ts';

interface TurnBody {
  readonly prompt?: string;
  readonly startedAt?: number;
  readonly endedAt?: number | null;
  readonly checkpoint?: { readonly commit?: string; readonly branch?: string };
  readonly presentation?: { readonly blocks?: readonly { readonly type: string; readonly title?: string; readonly summary?: string }[] };
  readonly stats?: { readonly costUsd?: number; readonly durationMs?: number; readonly inputTokens?: number; readonly outputTokens?: number };
  readonly activity?: readonly { readonly kind: string }[];
  readonly changes?: readonly { readonly file: string; readonly edits?: readonly unknown[] }[];
}

interface TurnRow {
  readonly id: string;
  readonly session_id: string;
  readonly idx: number;
  readonly prompt: string;
  readonly started_at: number;
  readonly body: TurnBody;
}

const followUp = defineCommand<{ session: string; text: string }>({ id: 'runtime.followUp', owner: (a) => a.session, optimistic: 'none' });

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
  const send = (): void => {
    const v = text().trim();
    if (!v) return;
    setText('');
    shell.client.commands.run(followUp, { session: key, text: v }).catch(() => setText(v));
  };
  const actions = (s: SessionRow): TaskAction[] => [
    { id: 'transcript', deskOnly: true, key: 'V', icon: 'transcript', label: t('shell.task.transcript'), title: t('shell.task.transcriptTitle') },
    { id: 'rerun', deskOnly: true, key: '⇧R', icon: 'rerun', label: t('shell.task.rerun'), title: t('shell.task.rerunTitle') },
    { id: 'takeover', deskOnly: true, key: 'T', icon: 'terminal', label: t('shell.task.takeover'), title: t('shell.task.takeoverTitle') },
    { id: 'changes', key: 'D', icon: 'file', label: t('shell.task.changes'), title: t('shell.task.changesTitle'), part: 'split.changes', onClick: () => shell.navigate({ t: 'toggleSide', side: { kind: 'changes', id: s.id as never } }) },
    { id: 'shell', key: '⌃`', icon: 'shell', label: t('shell.task.shell'), title: t('shell.task.shellTitle'), part: 'split.shell', onClick: () => shell.navigate({ t: 'toggleSide', side: { kind: 'shell', id: s.id as never } }) },
    { id: 'ship', key: 'S', icon: 'send', label: t('shell.task.ship'), title: t('shell.task.shipTitle') },
    { id: 'done', key: 'E', icon: 'done', label: t('shell.task.done'), title: t('shell.card.done'), tone: 'good', onClick: () => shell.navigate({ t: 'markDone', id: s.id as never }) },
    { id: 'more', icon: 'dots', label: t('shell.task.more'), title: t('shell.task.more') },
  ];
  return (
    <Show when={row()}>
      {(s) => {
        const h = (): { name: string; logo?: string } => HARNESS[s().agent] ?? { name: s().agent };
        const branch = (): string => String(s().summary['branch'] ?? '');
        const color = (): string => String(s().summary['color'] ?? 'slate');
        const ov = createMemo(() => overlapsOf(s()));
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
                        actsTitle={t('shell.task.activity')}
                        acts={[
                          { icon: 'read', text: String(count('read')), title: t('shell.task.read', { n: count('read') }) },
                          { icon: 'pen', text: String(count('edit')), title: t('shell.task.edited', { n: count('edit') }) },
                          { icon: 'terminal', text: String(count('run')), title: t('shell.task.ran', { n: count('run') }) },
                        ]}
                        stats={[{ text: `${Math.max(0, (b.endedAt ?? turn.started_at) - turn.started_at)}ms` }, { text: `$${(b.stats?.costUsd ?? 0).toFixed(2)}` }]}
                        receipt={{ text: t('shell.task.tokens', { n: tokens }), title: t('shell.task.tokensTitle', { n: tokens }) }}
                        {...((b.changes?.length ?? 0) > 0 && { files: { label: t('shell.task.files', { n: b.changes?.length ?? 0 }), plus: `+${edits ? 1 : 0}`, minus: `−${edits ? 1 : 0}` } })}
                        tools={[
                          { id: 'notes', icon: 'text', label: t('shell.task.notes') },
                          { id: 'rollback', icon: 'replay', label: t('shell.task.rollback') },
                          { id: 'fork', icon: 'fork', label: t('shell.task.fork'), part: 'turn.fork' },
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
                    mode={{ label: t('shell.home.fullAuto'), title: t('shell.home.fullAutoTitle') }}
                    runner={{ title: t('shell.task.runner', { name: h().name }), ...(h().logo && { logo: h().logo }) }}
                    team={t('shell.home.delegateTitle')}
                    goal={t('shell.task.goal')}
                    later={t('shell.home.later')}
                    send={t('shell.home.send')}
                  />
                </>
              }
            />
            <TaskHead
              title={s().title}
              color={color()}
              renameLabel={t('shell.task.rename')}
              panelLabel={t('shell.task.panel')}
              closeLabel={t('shell.task.close')}
              {...(props.onBack && { onBack: props.onBack, backLabel: t('shell.home.back') })}
              onClose={() => shell.navigate({ t: 'home' })}
            />
          </>
        );
      }}
    </Show>
  );
}
