// Small parts both boxes use: the file chips (a Wrap: chips may wrap as a group, design/layout.md
// §5), a confirm dialog, and the bar items other plugins attach to `shell.composer:bar` /
// `shell.launcher:bar` (Ship it, Mark done, a model picker), drawn in the form the Toolbar gives.
import { createSignal, For, Show, type JSX } from 'solid-js';
import { Button, Dialog, FileChip, Text, Wrap, fileSize, useSignal, type IconName, type ToolbarItem } from '@wisp/ui';
import { ExtView, extensionPropsOf, usePluginClient, type ExtensionProps, type ResolvedExtension } from './shell.ts';
import type { Env } from '../env.ts';
import { iconOf } from '../model/tray.ts';
import type { Services } from '../types.ts';
import type { Tray } from './useTray.ts';
import { liveItem } from './pickers.tsx';

export function Chips(p: { readonly env: Env; readonly tray: Tray }): JSX.Element {
  const t = p.env.t;
  return (
    <Show when={p.tray.files().length > 0}>
      <Wrap gap="2" part="composer.chips" aria-label={t('shell-composer.attach.label')}>
        <For each={p.tray.files()}>
          {(f) => (
            <FileChip
              name={f.name}
              size={fileSize(f.size)}
              icon={iconOf(f.mime)}
              status={f.status}
              {...(f.thumb && { thumb: f.thumb })}
              title={f.status === 'failed' ? t('shell-composer.attach.failed', { message: f.error ?? '' }) : f.status === 'uploading' ? t('shell-composer.attach.uploading', { name: f.name }) : f.name}
              removeLabel={t('shell-composer.attach.remove')}
              onRemove={() => p.tray.remove(f.key)}
            />
          )}
        </For>
      </Wrap>
    </Show>
  );
}

/** One confirm at a time: `ask` resolves true on the danger button, false on anything else. */
export function useConfirm(env: Env): { ask(text: string, action: string): Promise<boolean>; view: () => JSX.Element } {
  const [open, setOpen] = createSignal<{ text: string; action: string; done: (ok: boolean) => void } | undefined>(undefined);
  const close = (ok: boolean): void => {
    open()?.done(ok);
    setOpen(undefined);
  };
  return {
    ask: (text, action) => new Promise((done) => setOpen({ text, action, done })),
    view: () => (
      <Dialog
        open={open() !== undefined}
        onOpenChange={(o) => !o && close(false)}
        role="alertdialog"
        size="sm"
        title={open()?.action ?? ''}
        footer={
          <>
            <Button variant="ghost" onClick={() => close(false)}>
              {env.t('shell-composer.keep')}
            </Button>
            <Button variant="danger" onClick={() => close(true)}>
              {open()?.action ?? ''}
            </Button>
          </>
        }
      >
        <Text>{open()?.text ?? ''}</Text>
      </Dialog>
    ),
  };
}

/**
 * Extensions on one of this box's bar inputs as Toolbar items: their declared icon, label and
 * priority; their component draws the form it's given (`form` in its props).
 */
export function attachedItems(o: {
  readonly shell: Services;
  readonly input: string;
  readonly scoped: Pick<ExtensionProps, 'session' | 'id'>;
}): () => readonly ToolbarItem[] {
  const list = useSignal(o.shell.extensions(o.input));
  const made = new Map<string, ToolbarItem>();
  const itemOf = (ext: ResolvedExtension): ToolbarItem => {
    const bar = ext.def.bar;
    const client = usePluginClient(ext.plugin);
    return liveItem({
      id: ext.id,
      priority: bar?.priority ?? 0,
      label: () => o.shell.t(bar?.label ?? ext.id),
      icon: () => (bar?.icon ?? 'dots') as IconName,
      onSelect: () => bar?.select?.(extensionPropsOf(ext, client, o.scoped)),
      render: (form) => <ExtView ext={ext} form={form} {...o.scoped} />,
    });
  };
  // one item per extension id, made once, so its control isn't redrawn on every change
  return () =>
    list().map((ext) => {
      const key = `${ext.id}:${ext.order}`;
      const have = made.get(key);
      if (have) return have;
      const item = itemOf(ext);
      made.set(key, item);
      return item;
    });
}
