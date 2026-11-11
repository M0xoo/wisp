// `shell-task.turn`, under each turn (`shell.turn:foot`, the turn's key as its id): why it stopped (HaltCard), what
// holds it (HeldCard), what moved in the CLI since the last turn (WhatChanged) and its receipt (Receipt). The turn
// and its siblings are the task's `turn` rows; the plan shares are wisp.budget's, in the turn's ext slot.
import { Show, createMemo, createResource, type JSX } from 'solid-js';
import { defineCommand, entityKey, ownerOf, type EntityKey } from '@wisp/client';
import type { ExtensionProps } from '@wisp/shell/contract';
import { Stack, useSignal } from '@wisp/ui';
import { useShell } from '../shell.ts';
import { HaltCard } from './HaltCard.tsx';
import { HeldCard } from './HeldCard.tsx';
import { docOf, haltOf, heldOf, receiptOf, whatChanged, type TurnDoc } from './model.ts';
import { Receipt } from './Receipt.tsx';
import { handoffTargets, limitTarget, type AgentLike, type Target } from './vendors.ts';
import { WhatChanged } from './WhatChanged.tsx';

const bare = (k: string): string => k.slice(k.indexOf(':') + 1);

const release = defineCommand<{ key: EntityKey; turnId: string; action: 'start' | 'skip' }>({ id: 'runtime.release', owner: (a) => a.key, wire: (a) => ({ id: bare(a.key), turnId: a.turnId, action: a.action }), optimistic: 'none', pending: 'the held turn’s buttons' });
const signIn = defineCommand<{ key: EntityKey; turnId: string }>({ id: 'runtime.signIn', owner: (a) => a.key, wire: (a) => ({ id: bare(a.key), turnId: a.turnId }), optimistic: 'none', pending: 'Sign in' });
const followUp = defineCommand<{ key: EntityKey; text: string; run?: { agent: string; model?: string } }>({
  id: 'runtime.followUp',
  owner: (a) => a.key,
  wire: (a) => ({ id: bare(a.key), text: a.text, ...(a.run && { run: { agent: a.run.agent, ...(a.run.model && { model: a.run.model }) } }) }),
  optimistic: 'none',
  pending: 'the card’s buttons, locked at once',
});
const addLater = defineCommand<{ key: EntityKey; sessionId: string; text: string; at: number }>({ id: 'later.add', owner: (a) => a.key, wire: (a) => ({ sessionId: a.sessionId, text: a.text, at: a.at }), optimistic: 'none', pending: 'Wait until' });
const agents = defineCommand<{ key: EntityKey }, AgentLike[]>({ id: 'runtime.agents', owner: (a) => a.key, wire: () => ({}), optimistic: 'none', pending: 'the hand-off buttons' });
/** v1's words for carrying on after a limit (server/later.js LIMIT_CARRY_ON). */
const CARRY_ON = 'Carry on from where the last run stopped at the usage limit.';

export default function TurnFoot(props: ExtensionProps): JSX.Element {
  const shell = useShell();
  const t = shell.t;
  const c = props.client;
  const turnKey = (props.id ?? '') as EntityKey;
  const row = useSignal(c.entities.row<unknown>('turn', turnKey));
  const all = useSignal(c.entities.list<unknown>('turn'));
  const doc = createMemo((): TurnDoc | undefined => docOf(row()));
  const task = (): { id: string; agent: string; [k: string]: unknown } | undefined => props.session?.();
  const taskKey = (): EntityKey => entityKey(ownerOf(turnKey), bare(String(task()?.id ?? ''))) as EntityKey;
  const siblings = createMemo((): TurnDoc[] => {
    const sid = bare(String(task()?.id ?? ''));
    return (all() as unknown[]).map(docOf).filter((d): d is TurnDoc => !!d && (d as { sessionId?: string }).sessionId === sid);
  });
  const halt = createMemo(() => {
    const d = doc();
    return d ? haltOf(d) : null;
  });
  // the harnesses set up here, asked once a refused or limited turn shows
  const [set] = createResource(
    () => (halt()?.kind === 'refused' || halt()?.kind === 'limit' ? turnKey : undefined),
    () => c.run(agents, { key: taskKey() }).catch(() => [] as AgentLike[]),
  );
  const from = (): string => doc()?.agent ?? String(task()?.agent ?? '');
  const targets = (): Target[] => {
    const h = halt();
    const list = set() ?? [];
    if (h?.kind === 'refused') return handoffTargets({ from: h.agent || from(), fromModel: h.model, ...(h.vendor && { vendor: h.vendor }), agents: list });
    const one = h?.kind === 'limit' ? limitTarget(from(), list) : undefined;
    return one ? [one] : [];
  };
  const nameOf = (agent: string): string => shell.harnesses()().find((x) => x.id === agent)?.name ?? (set() ?? []).find((a) => a.id === agent)?.name ?? agent;
  const quiet = (p: Promise<unknown>): void => {
    p.catch(() => {}); // the shell's onError toasts it
  };
  return (
    <Show when={doc()}>
      {(d) => (
        <Stack gap="2" part="turn.foot">
          <Show when={heldOf(d())}>{(h) => <HeldCard label={h().label} why={h().why} t={t} onStart={() => quiet(c.run(release, { key: taskKey(), turnId: d().id, action: 'start' }))} onSkip={() => quiet(c.run(release, { key: taskKey(), turnId: d().id, action: 'skip' }))} />}</Show>
          <Show when={halt()}>
            {(h) => (
              <HaltCard
                halt={h()}
                name={nameOf(from())}
                t={t}
                targets={targets()}
                nameOf={nameOf}
                onHand={(to) => {
                  // the refused prompt again, or carry on after the limit, on the other harness (v1 POST /reply with a run)
                  const text = h().kind === 'refused' ? ((d() as { prompt?: string }).prompt ?? '') : CARRY_ON;
                  return c.run(followUp, { key: taskKey(), text, run: { agent: to.agent, ...(to.model && { model: to.model }) } });
                }}
                onWait={(until) =>
                  // v1 limitCard Wait until: the carry-on follow-up, scheduled for the reset (wisp.later)
                  c.run(addLater, { key: taskKey(), sessionId: bare(String(task()?.id ?? '')), text: CARRY_ON, at: until })
                }
                onSignIn={() => {
                  quiet(c.run(signIn, { key: taskKey(), turnId: d().id }));
                  shell.navigate({ t: 'openOverlay', overlay: { kind: 'viewer', id: 'shell-settings.sheet' as never, params: { pane: 'agents' } } });
                }}
                onRetry={() => quiet(c.run(followUp, { key: taskKey(), text: (d() as { prompt?: string }).prompt ?? '' }))}
              />
            )}
          </Show>
          <Show when={whatChanged(siblings(), d(), nameOf(from()))}>{(line) => <WhatChanged line={line()} t={t} />}</Show>
          <Show when={receiptOf(d(), t)}>{(r) => <Receipt line={r()} />}</Show>
        </Stack>
      )}
    </Show>
  );
}
