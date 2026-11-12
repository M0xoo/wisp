// Pins (v1 panes.js pinApp / unpinApp / allowApp): an app from My Stuff pinned on Home or beside tasks is the
// `stuff.panes` setting ("<app>@home,<app>@task"). Pinning shows at once (the setting's own optimistic write) and says
// so with Undo; an app that asks to use wisp gets the Allow card first, from your click, never by itself, and never
// while the task it's for, or the task that made it, runs in Full auto. The cards (Allow, and a pane's write waiting
// on your click) render here, wherever pins are made.
import { createEffect, For, on, Show, untrack, type JSX } from 'solid-js';
import { entityKey, setSetting, type EntityKey, type PluginClient, type SettingRow } from '@wisp/client';
import { useShell } from '@wisp/shell';
import { Button, Dialog, Inline, PaneCard, Stack, Text, useSignal, type PaneSeg } from '@wisp/ui';
import { allowPane } from './commands.ts';
import { PANE_USES, hasInvisible, isUse, showInvisible } from './panes/bridge.ts';
import { missingOf, panesAt, runsFullAuto, withPin } from './panes/grant.ts';
import { stuffState } from './state.ts';
import type { Item, PaneWhere, TaskRow } from './types.ts';

/** wisp.stuff's setting (its manifest): "<app>@home,<app>@task" */
export const PANES_KEY = 'stuff.panes';

/** v1 pane-card.js SEND_DELAY_MS: a click or key the pane timed for the moment the card opens can't land on Send */
export const SEND_DELAY_MS = 600;

/** A pane's text cut where a character doesn't print: each such one a chip of its code (`<U+202E>`). */
export const segs = (text: string): PaneSeg[] => {
  const out: PaneSeg[] = [];
  for (const ch of text) {
    if (hasInvisible(ch)) out.push({ text: showInvisible(ch), hidden: true });
    else if (out.length && !out[out.length - 1]?.hidden) out[out.length - 1] = { text: (out[out.length - 1]?.text ?? '') + ch };
    else out.push({ text: ch });
  }
  return out;
};

type Say = (k: string, v?: Readonly<Record<string, string | number>>) => string;

export interface Pins {
  /** the apps pinned at a place, in their order */
  at(where: PaneWhere, items: readonly Item[]): Item[];
  pinned(it: Item, where: PaneWhere, items: readonly Item[]): boolean;
  pin(key: EntityKey, it: Item, where: PaneWhere, items: readonly Item[]): Promise<boolean>;
  unpin(it: Item, where: PaneWhere, items: readonly Item[]): Promise<void>;
  /** the Allow card from your click (Allow… on a pane's bar); true once it's allowed */
  allow(key: EntityKey, it: Item, task?: TaskRow | null): Promise<boolean>;
}

/** Call inside a component: the pins follow the setting (a Solid signal over the store's row). */
export function pinsOf(c: PluginClient): Pins {
  const st = stuffState(c);
  const shell = useShell();
  const say: Say = (k, v) => c.t(k, v);
  // the setting as the server keeps it (wisp.stuff's manifest: `stuff.panes`); a refused write rolls back with a toast
  const row = useSignal(c.entities.row<SettingRow>('setting', entityKey(c.home, PANES_KEY)));
  const value = (): string => {
    const v = row()?.value;
    return typeof v === 'string' ? v : '';
  };
  const setValue = (v: string): Promise<void> => c.run(setSetting, { peer: c.home, key: PANES_KEY, value: v }).then(() => undefined);
  const ask = (head: string, lines: readonly string[], risky: boolean, ok: string, alt?: string): Promise<'ok' | 'alt' | false> =>
    new Promise((done) => st.setModal({ kind: 'allow', head, lines, risky, ok, ...(alt && { alt }), done: (a) => (st.setModal(undefined), done(a)) }));
  const fullAuto = (it: Item, task: TaskRow | null | undefined): TaskRow | undefined => {
    const from = it.from?.session ? (c.entities.peek<TaskRow>('session', `${c.home}:${it.from.session}` as EntityKey) as TaskRow | undefined) : undefined;
    return [task ?? undefined, from].find((s) => runsFullAuto(s as never));
  };
  const allow = async (key: EntityKey, it: Item, task?: TaskRow | null, pinning?: PaneWhere): Promise<boolean> => {
    const want = (it.uses ?? []).filter(isUse);
    if (!want.length) return true;
    const run = fullAuto(it, task);
    if (run) {
      shell.toast.error(say('stuff.pane.notWhile', { name: run.title ?? '' }));
      return false;
    }
    const head = pinning ? say(`stuff.pane.allowHead.pin.${pinning}`, { name: it.title }) : say('stuff.pane.allowHead', { name: it.title });
    const answer = await ask(
      head,
      want.map((u) => say(PANE_USES[u])),
      !!it.risky?.includes('webrtc'),
      pinning ? say('stuff.pane.allowAndPin') : say('stuff.pane.allowOk'),
      pinning ? say('stuff.pane.pinWithout') : undefined,
    );
    if (!answer) return false;
    if (answer === 'alt') return true;
    return c.run(allowPane, { key, id: it.id, uses: want, ...(task && { task: task.id }) } as never).then(
      () => true,
      () => false,
    );
  };
  const pins: Pins = {
    at: (where, items) => panesAt(value(), where, items),
    pinned: (it, where, items) => panesAt(value(), where, items).some((x) => x.id === it.id),
    async pin(key, it, where, items) {
      if (pins.pinned(it, where, items)) return true;
      if (missingOf(it).length && !(await allow(key, it, null, where))) return false;
      return setValue(withPin(value(), it, where, true, items)).then(
        () => {
          shell.toast.show(say(`stuff.pane.pinned.${where}`, { name: it.title }), { action: { label: say('stuff.pane.undo'), onClick: () => void pins.unpin(it, where, items) } });
          return true;
        },
        () => false,
      );
    },
    unpin: (it, where, items) =>
      setValue(withPin(value(), it, where, false, items)).then(
        () => void shell.toast.show(say('stuff.pane.unpinnedToast', { name: it.title })),
        () => undefined,
      ),
    allow: (key, it, task) => allow(key, it, task),
  };
  return pins;
}

/** The Allow card and a pane's write card, as the stuff state holds them (one at a time). */
export function PaneCards(props: { readonly client: PluginClient }): JSX.Element {
  const st = stuffState(props.client);
  const say: Say = (k, v) => props.client.t(k, v);
  const modal = useSignal(st.modal);
  // v1 pane-card.js: a dialog you open over a waiting card (⌘K) replaces it: that's a Cancel, so the pane's call
  // doesn't wait for ever and no other card is held up
  const nav = useSignal(useShell().nav);
  createEffect(
    on(
      () => nav().overlays.length,
      (n, before) => {
        const m = untrack(modal);
        if (before !== undefined && n > before && m?.kind === 'card') m.done(false);
      },
    ),
  );
  return (
    <Show when={modal()}>
      {(m) => {
        const x = m();
        if (x.kind === 'allow')
          return (
            <Dialog
              open
              role="alertdialog"
              size="sm"
              title={x.head}
              part="stuff.allow"
              onOpenChange={(o) => !o && x.done(false)}
              footer={
                <Inline gap="4">
                  <Button variant="ghost" onClick={() => x.done(false)}>
                    {say('stuff.pane.cancel')}
                  </Button>
                  <Show when={x.alt}>
                    {(alt) => (
                      <Button variant="secondary" onClick={() => x.done('alt')}>
                        {alt()}
                      </Button>
                    )}
                  </Show>
                  <Button variant="primary" onClick={() => x.done('ok')}>
                    {x.ok}
                  </Button>
                </Inline>
              }
            >
              <Stack gap="3">
                <For each={x.lines}>{(l) => <Text size="sm">{`• ${l}`}</Text>}</For>
                <Text size="sm" tone="muted">
                  {say('stuff.pane.allowFoot')}
                  {x.risky ? ` ${say('stuff.pane.allowRisk')}` : ''}
                </Text>
              </Stack>
            </Dialog>
          );
        // v1 pane-card.js: what a pane wrote, marked where a character doesn't print; Send waits a moment, Cancel has the focus
        const n = [...x.prompt].length;
        const hidden = [...x.prompt].filter(hasInvisible).length;
        return (
          <PaneCard
            part="stuff.card"
            head={segs(x.head)}
            from={say('stuff.pane.card.from')}
            rows={x.rows.map((r) => ({ label: r[0], value: segs(r[1]), ...(r[2] && { warn: true }) }))}
            promptLabel={say('stuff.pane.card.prompt')}
            hiddenCount={hidden ? say('stuff.pane.card.invisible', { count: hidden }) : undefined}
            length={say('stuff.pane.card.chars', { count: n })}
            prompt={segs(x.prompt)}
            cancel={say('stuff.pane.cancel')}
            send={say('stuff.pane.send')}
            armMs={SEND_DELAY_MS}
            onAnswer={(yes) => x.done(yes)}
          />
        );
      }}
    </Show>
  );
}
