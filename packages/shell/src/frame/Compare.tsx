// Compare runs (v1 features/compare.js compareView, F-comp-30): the runs of one ask (tasks sharing a `groupId`, as
// `wisp --compare` starts them) side by side: their numbers in one table, a neutral sentence against run A, each
// run's last answer, Open card, and Keep this (the others are archived and their worktrees deleted with their
// changes, after a confirm). Live: every run's topic is watched while the dialog is open, so a run still working
// fills its column in place when it finishes; nothing re-renders a column whose answer didn't change.
import { createEffect, createMemo, createSignal, getOwner, onCleanup, runWithOwner, Show, type JSX } from 'solid-js';
import { defineCommand, ownerOf, type EntityKey } from '@wisp/client';
import { Answer, Button, CompareRuns, Dialog, Inline, Text, useSignal, type CompareRunView } from '@wisp/ui';
import { useShell } from '../context.tsx';
import { SESSION, type SessionRow } from '../rows.ts';
import { answerContext } from './answer-ctx.ts';
import { isStub, keepTurnsWhole } from './turn-window.ts';
import { archive, stopRun, trialKeep } from './commands.ts';
import { differsWords, runOrder, trialOf, variantOf, variantWords } from './trial.ts';
import { compareRows, compareSentence, letter, planShares, type CompareRun, type CompareTurn, type PlanShare } from './compare.ts';
import { useNow } from '../clock.ts';
import { harnessOf } from './harness.ts';
import { statusOf } from './rows-view.ts';

interface TurnRow {
  readonly id: string;
  readonly session_id: string;
  readonly idx: number;
  readonly prompt: string;
  readonly started_at: number;
  readonly status?: string;
  readonly body: CompareTurn & {
    readonly prompt?: string;
    readonly ext?: { readonly 'wisp.runtime'?: { readonly changes?: CompareTurn['changes'] }; readonly 'wisp.apps'?: unknown; readonly 'wisp.budget'?: { readonly plan?: readonly PlanShare[] } };
  };
}

interface EventRow {
  readonly turn_id: string;
  readonly kind?: string;
  readonly body?: { readonly kind?: string };
}

/** worktrees.clean: the kept run's siblings' folders go, with their changes (v1 discardWorktree) */
const clean = defineCommand<{ peer: string; ids: string[] }>({
  id: 'worktrees.clean',
  owner: (a) => a.peer as never,
  wire: (a) => ({ ids: a.ids, force: true }),
  optimistic: 'none',
  pending: 'Keep this',
});

const bareOf = (key: string): string => key.slice(key.indexOf(':') + 1);

export default function Compare(props: { readonly params: { readonly id: string } }): JSX.Element {
  const shell = useShell();
  const t = shell.t;
  const sessions = useSignal(shell.client.entities.list<SessionRow>(SESSION));
  const allTurns = useSignal(shell.client.entities.list<TurnRow>('turn'));
  const allEvents = useSignal(shell.client.entities.list<EventRow>('event'));
  const harnesses = useSignal(shell.harnesses());
  const scope = shell.client.scope.child(`compare:${props.params.id}`);
  onCleanup(() => scope.dispose());
  const group = createMemo(() => {
    const g = sessions().find((s) => s.id === props.params.id)?.summary['groupId'];
    if (typeof g !== 'string' || !g) return [];
    // a trial's runs in run order (A as given, B changed), whatever order they were created in
    return runOrder(sessions().filter((s) => s.summary['groupId'] === g && !s.archived));
  });
  // each run's turns and steps come with its topic: watched while the dialog is open (the scope ends with it)
  const watched = new Set<string>();
  const owner = getOwner();
  createEffect(() => {
    for (const s of group()) {
      if (watched.has(s.id)) continue;
      watched.add(s.id);
      shell.client.peers.watch(ownerOf(s.id as EntityKey), `session:${bareOf(s.id)}`, scope);
      // its every turn whole, edits included: the task's topic sends turns past its latest 8 as stubs (v1 #788)
      const run = s;
      // owned by the dialog, not this effect: its re-runs (a run joining) must not end the watch's own effect
      runWithOwner(owner, () => keepTurnsWhole({ scope, bare: bareOf(run.id), watch: (topic, sc) => shell.client.peers.watch(ownerOf(run.id as EntityKey), topic, sc), stubbed: () => turnsOf(run).some((x) => isStub(x.body)) }));
    }
  });
  const turnsOf = (s: SessionRow): TurnRow[] =>
    allTurns()
      .filter((x) => x.session_id === s.id || x.session_id === bareOf(s.id))
      .sort((a, b) => a.idx - b.idx);
  const stepsOf = (turnId: string): string[] =>
    allEvents()
      .filter((e) => e.turn_id === turnId)
      .map((e) => e.kind ?? e.body?.kind ?? '');
  const runs = createMemo((): CompareRun[] =>
    group().map((s) => ({
      id: s.id,
      agent: s.agent,
      createdAt: s.created_at,
      state: s.state,
      turns: turnsOf(s).map((x) => ({
        ...x.body,
        status: x.status ?? x.body.status ?? '',
        startedAt: x.body.startedAt ?? x.started_at,
        changes: x.body.ext?.['wisp.runtime']?.changes ?? x.body.changes ?? [],
        steps: stepsOf(x.id),
        plan: x.body.ext?.['wisp.budget']?.plan ?? [],
      })),
    })),
  );
  const prompt = (): string => {
    const first = group()[0];
    const turn = first ? turnsOf(first)[0] : undefined;
    return turn?.prompt ?? turn?.body.prompt ?? '';
  };
  const live = (s: SessionRow): boolean => s.state === 'running' || s.state === 'waiting';
  const answerOf = (s: SessionRow): JSX.Element => {
    const last = turnsOf(s).at(-1);
    const blocks = last?.body.presentation?.blocks ?? [];
    if (!last || live(s) || last.status === 'running' || blocks.length === 0) return <p>{String(s.summary.live || t('shell.compare.working'))}</p>;
    return (
      <Answer
        blocks={blocks as never}
        ctx={answerContext({
          shell,
          key: s.id as EntityKey,
          turnId: last.id,
          // inert here: a reply or an action belongs on the task's own page (Open card)
          latest: () => false,
          title: () => s.title,
          reply: () => undefined,
          draft: () => undefined,
          openChanges: () => undefined,
          apps: () => (last.body.ext?.['wisp.apps'] ?? {}) as Record<string, unknown>,
        })}
      />
    );
  };
  /** Try it two ways: what differed, against run A (v1 compare.js trialLine), under the ask */
  const differs = createMemo(() => {
    // the peer's link says what differed (the instant rows don't yet)
    const link = group()
      .map((s) => trialOf(s.summary))
      .find((l) => l?.differs);
    if (!link?.differs) return undefined;
    const a = group()[0];
    return { text: differsWords(t, link.differs, String(a?.summary.model || '')), same: link.differs.length === 0 };
  });
  const views = createMemo((): CompareRunView[] =>
    group().map((s, i) => {
      const h = harnessOf(harnesses(), s.agent);
      const st = statusOf(s, t);
      const effort = String(s.body?.['effort'] ?? '');
      const model = String(s.summary.model || '') || t('shell.compare.defaultModel');
      return {
        id: s.id,
        letter: letter(i),
        harness: h.name,
        logo: h.logo,
        // a trial's runs share a harness: the variant is what tells them apart (v1 runVariant)
        base: [model, effort && effort.charAt(0).toUpperCase() + effort.slice(1), ...variantWords(t, variantOf(s.summary))].filter(Boolean).join(' · '),
        state: live(s) ? { label: t(s.state === 'waiting' ? 'shell.compare.asking' : 'shell.compare.workingPill'), tone: 'warn', live: true } : st,
        body: answerOf(s),
        working: live(s),
      };
    }),
  );
  const [asking, setAsking] = createSignal<string | undefined>();
  /** how the confirm and the toast name the run: its harness, or its letter when two ran on one harness */
  const keepWho = (id: string): { ask: string; kept: string } => {
    const i = group().findIndex((s) => s.id === id);
    const s = group()[i];
    const same = group().filter((x) => x.agent === s?.agent).length > 1;
    if (same) return { ask: t('shell.compare.run', { letter: letter(i) }), kept: t('shell.compare.keptRun', { letter: letter(i) }) };
    const name = harnessOf(harnesses(), s?.agent ?? '').name;
    return { ask: t('shell.compare.whose', { name }), kept: t('shell.compare.kept', { name }) };
  };
  const keep = (id: string): void => {
    setAsking(undefined);
    const others = group().filter((s) => s.id !== id);
    const who = keepWho(id);
    // optimistic: the others leave the list now; stopping them and deleting their folders goes on behind. A trial's
    // Keep also says on both runs which one you kept (v1 trialKept), and archives the other on the peer
    if (group().some((s) => trialOf(s.summary))) void shell.client.commands.run(trialKeep, { id, others: others.map((o) => o.id) }).catch(() => undefined);
    else for (const o of others) void shell.client.commands.run(archive, { id: o.id, archived: true }).catch(() => undefined);
    shell.navigate({ t: 'closeOverlay', id: 'shell.compare' as never });
    shell.navigate({ t: 'openTask', id: id as never });
    shell.toast.success(who.kept);
    void (async () => {
      for (const o of others) if (live(o)) await shell.client.commands.run(stopRun, { id: o.id }).catch(() => undefined);
      const byPeer = new Map<string, string[]>();
      for (const o of others) byPeer.set(ownerOf(o.id as EntityKey), [...(byPeer.get(ownerOf(o.id as EntityKey)) ?? []), bareOf(o.id)]);
      for (const [peer, ids] of byPeer) await shell.client.commands.run(clean, { peer, ids }).catch(() => undefined);
    })();
  };
  // the Plan row reads a running turn up to now (v1 planShares)
  const now = useNow(shell.client);
  const rows = createMemo(() => compareRows(runs(), t, now()));
  const total = createMemo(() => planShares(runs(), now(), t).total);
  return (
    <Show when={group().length > 1} fallback={<Text as="p">{t('shell.compare.gone')}</Text>}>
      <CompareRuns
        prompt={prompt()}
        rows={rows()}
        runs={views()}
        total={total()}
        sentence={compareSentence(runs(), t)}
        differs={differs()}
        labels={{ runs: t('shell.compare.runs'), open: t('shell.compare.open'), keep: t('shell.compare.keep'), stillWorking: t('shell.compare.stillWorking') }}
        onOpen={(id) => {
          shell.navigate({ t: 'closeOverlay', id: 'shell.compare' as never });
          shell.navigate({ t: 'openTask', id: id as never });
        }}
        onKeep={(id) => setAsking(id)}
      />
      <Show when={asking()}>
        {(id) => (
          <Dialog
            open
            onOpenChange={(open) => !open && setAsking(undefined)}
            role="alertdialog"
            size="sm"
            title={t('shell.compare.keepAsk', { who: keepWho(id()).ask })}
            part="compare.keep.confirm"
            footer={
              <Inline gap="3" justify="end">
                <Button variant="secondary" size="sm" onClick={() => setAsking(undefined)}>
                  {t('shell.stop.cancel')}
                </Button>
                <Button variant="danger" size="sm" icon="check" onClick={() => keep(id())} part="compare.keep.go">
                  {t('shell.compare.keepOk')}
                </Button>
              </Inline>
            }
          >
            <Text as="p">{group().length === 2 ? t('shell.compare.keepOne') : t('shell.compare.keepMany', { n: group().length - 1 })}</Text>
          </Dialog>
        )}
      </Show>
    </Show>
  );
}
