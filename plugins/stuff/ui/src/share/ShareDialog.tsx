// Share… (v1 features/share.js shareTask): share a task with people on your wisp Grid, as a link
// anyone can open or only with a passkey, with its work or without. The dialog opens at once in the
// shape it will have; what goes with the share fills in where its placeholders were. Stop sharing is
// optimistic (the link goes at once, back with a red toast); Share waits for the link, busy in place.

import { untracked, type EntityKey, type ExtensionId, type PluginClient } from '@wisp/client';
import { Button, Callout, Dialog, Stack, Text, Toolbar, useSignal, type ToolbarItem } from '@wisp/ui';
import { createSignal, For, Show, type JSX } from 'solid-js';
import { copyText } from './clipboard.ts';
import { sharePreview, shareCreate, shareStop, SESSION } from './commands.ts';
import { CarryChips, LinkRow, WhoPicker, WorkOption } from './DialogParts.tsx';
import { suggestPasskey } from './link.ts';
import type { ShareableTask, Shared, SharePreview } from './types.ts';

export { SHARE_VIEW, parseShareParams, type ShareParams } from './params.ts';
import { SHARE_VIEW, type ShareParams } from './params.ts';

interface Note {
  readonly text: string;
  readonly tone: 'info' | 'bad';
}

// size-ok: one dialog's state and its three actions, each a few lines
export default function ShareDialog(props: { client: PluginClient; params: ShareParams }): JSX.Element {
  const c = props.client;
  const t = (k: string, v?: Readonly<Record<string, string | number>>): string => c.t(k, v);
  const task = useSignal(c.entities.row<ShareableTask>(SESSION, props.params.session));
  const [info, setInfo] = createSignal<SharePreview | undefined>();
  const [failed, setFailed] = createSignal('');
  const [shared, setShared] = createSignal<Shared | null>(null);
  const [who, setWho] = createSignal<'link' | 'pass'>('link');
  const [passkey, setPasskey] = createSignal('');
  const [work, setWork] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  const [notes, setNotes] = createSignal<readonly Note[]>([]);
  const close = (): void => c.navigate({ t: 'closeOverlay', id: SHARE_VIEW });

  c.run(sharePreview, { session: props.params.session }).then(
    (p) => {
      setInfo(p);
      setShared(p.shared);
      setWork(!!p.work);
      if (p.shared?.locked) setWho('pass');
      setNotes(p.targets[0] ? [{ text: t('stuff.share.where', { host: p.targets[0].host }), tone: 'info' }] : [{ text: t('stuff.share.signIn'), tone: 'bad' }]);
    },
    (err: unknown) => setFailed(err instanceof Error ? err.message : String(err)),
  );

  const pickWho = (v: string): void => {
    setWho(v === 'pass' ? 'pass' : 'link');
    if (v === 'pass' && !untracked(passkey)) setPasskey(suggestPasskey());
  };
  const share = async (): Promise<void> => {
    const locked = who() === 'pass';
    const key = locked ? passkey().trim() : '';
    if (locked && !key && !shared()?.locked) return;
    setBusy(true);
    try {
      // Locked with nothing typed keeps the passkey it has; open sends '' to take it off.
      const r = await c.run(shareCreate, { session: props.params.session, ...(!(locked && !key) && { passkey: key }), work: work() });
      setShared(r);
      const copied = await copyText(r.url);
      const head = t(copied ? (locked ? 'stuff.share.copiedPass' : 'stuff.share.copied') : 'stuff.share.made');
      setNotes([head, ...(r.notes ?? [])].map((text) => ({ text, tone: 'info' })));
    } catch (err) {
      setNotes([{ text: err instanceof Error ? err.message : String(err), tone: 'bad' }]);
    } finally {
      setBusy(false);
    }
  };
  const stop = (): void => {
    const was = shared();
    setShared(null);
    setNotes([{ text: t('stuff.share.stopped'), tone: 'info' }]);
    c.run(shareStop, { session: props.params.session }).catch((err: unknown) => {
      setShared(was);
      setNotes([{ text: err instanceof Error ? err.message : String(err), tone: 'bad' }]);
    });
  };
  const ready = (): boolean => !!info()?.targets.length && !failed();
  const items = (): ToolbarItem[] => [
    ...(shared() ? [{ id: 'stop', label: t('stuff.share.stop'), icon: 'x' as const, tone: 'bad' as const, priority: 1, onSelect: stop }] : []),
    {
      id: 'share',
      label: shared() ? t('stuff.share.update') : t('stuff.share.share'),
      icon: 'share',
      priority: 'pin',
      render: () => (
        <Button
          part="share.go"
          variant="primary"
          size="sm"
          icon="share"
          loading={busy()}
          disabled={!ready() || (who() === 'pass' && !passkey().trim() && !shared()?.locked)}
          onClick={() => void share()}
        >
          {shared() ? t('stuff.share.update') : t('stuff.share.share')}
        </Button>
      ),
    },
  ];

  return (
    <Dialog
      part="share.dialog"
      title={t('stuff.share.title')}
      open
      onOpenChange={(o) => !o && close()}
      size="sm"
      footer={<Toolbar part="share.foot" aria-label={t('stuff.share.actions')} justify="end" items={items()} />}
    >
      <Stack gap="5">
        <Text part="share.task" weight="medium" truncate title={task()?.title ?? ''}>
          {task()?.title ?? ''}
        </Text>
        <Show when={!failed()}>
          <CarryChips t={t} info={info()} turns={task()?.turnCount ?? 0} />
        </Show>
        <WhoPicker t={t} who={who()} onWho={pickWho} passkey={passkey()} onPasskey={setPasskey} kept={!!shared()?.locked} />
        <WorkOption t={t} info={info()} checked={work()} onChange={setWork} />
        <Show when={shared()}>{(s) => <LinkRow t={t} url={s().url} scope={c.scope} />}</Show>
        <Stack part="share.notes" gap="2" aria-live="polite">
          <Show when={failed()}>{(f) => <Callout tone="bad">{f()}</Callout>}</Show>
          <For each={notes()}>{(n) => <Callout tone={n.tone}>{n.text}</Callout>}</For>
        </Stack>
      </Stack>
    </Dialog>
  );
}
