// Rename and Delete task, asked over the list. Rename: the title selected, Enter saves, Escape keeps
// it as it was; an empty or unchanged title sends nothing (v1 actions.js rename). Delete asks first,
// in v1's words: the question, then what happens, then the action on the button (design/copy.md).

import { createSignal, Show, type JSX } from 'solid-js';
import { Button, Dialog, Input, Inline } from '@wisp/ui';
import { deleteTask, renameTask } from '../actions.ts';
import { KIND, type Session } from '../types.ts';
import { useEnv } from './env.ts';

export function RenameDialog(): JSX.Element {
  const env = useEnv();
  const t = env.shell.t;
  const [text, setText] = createSignal('');
  const field: { el?: HTMLInputElement } = {};
  const title = (): string => {
    const k = env.renaming();
    return k ? (env.client.entities.peek<Session>(KIND.session, k)?.title ?? '') : '';
  };
  const close = (): void => env.askRename(undefined);
  const save = (): void => {
    const k = env.renaming();
    if (k) renameTask(env.actions, k, text());
    close();
  };
  return (
    <Show when={env.renaming()}>
      <Dialog
        open
        size="sm"
        title={t('shell-list.rename.title')}
        onOpenChange={(o) => !o && close()}
        initialFocus={() => {
          setText(title());
          queueMicrotask(() => field.el?.select());
          return field.el ?? null;
        }}
        part="list.rename"
        footer={
          <Inline gap="3" justify="end">
            <Button variant="ghost" onClick={close}>
              {t('shell-list.dialog.cancel')}
            </Button>
            <Button variant="primary" onClick={save} disabled={!text().trim() || text().trim() === title()}>
              {t('shell-list.rename.save')}
            </Button>
          </Inline>
        }
      >
        <Input
          ref={(el) => (field.el = el)}
          value={text()}
          onInput={setText}
          aria-label={t('shell-list.rename.label')}
          maxLength={200}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.isComposing) {
              e.preventDefault();
              save();
            }
          }}
        />
      </Dialog>
    </Show>
  );
}

export function DeleteDialog(): JSX.Element {
  const env = useEnv();
  const t = env.shell.t;
  const close = (): void => env.askDelete(undefined);
  const confirm = (): void => {
    const k = env.deleting();
    close();
    if (k) deleteTask(env.actions, k);
  };
  return (
    <Show when={env.deleting()}>
      <Dialog
        open
        size="sm"
        role="alertdialog"
        title={t('shell-list.delete.title')}
        description={t('shell-list.delete.body')}
        onOpenChange={(o) => !o && close()}
        part="list.delete"
        footer={
          <Inline gap="3" justify="end">
            <Button variant="ghost" onClick={close}>
              {t('shell-list.dialog.cancel')}
            </Button>
            <Button variant="danger" onClick={confirm}>
              {t('shell-list.delete.ok')}
            </Button>
          </Inline>
        }
      />
    </Show>
  );
}
