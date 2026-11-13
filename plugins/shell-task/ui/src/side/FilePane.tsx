// The task's file view (v1 features/editor.js, design/v1-reference/task.editor): ‹ back to Changes, the file's name,
// Saved / Unsaved and Save (⌘S); the text, highlighted and editable; and the why-gutter (ADR-0033): each line's task
// from the repo's agent history, a click opens it. The file is read from the task's folder (`worktrees.source`) and
// saved back only if it hasn't changed since (`worktrees.save`), never while the agent works on the task.
import { Show, createMemo, createResource, createSignal, type JSX } from 'solid-js';
import { defineCommand, entityKey, type EntityKey } from '@wisp/client';
import { Box, Button, EmptyState, FileView, IconButton, Inline, Stack, Text, langOfPath, useSignal } from '@wisp/ui';
import { useShell } from '../shell.ts';
import { useTask } from '../task-context.tsx';
import { askText, gutterOf, placeOf, statusOf, type BlameLine } from './file-view.ts';

interface Source {
  readonly path: string;
  readonly text: string;
  readonly hash: string;
  readonly root: string;
}

const source = defineCommand<{ key: EntityKey; id: string; path: string }, Source>({
  id: 'worktrees.source',
  owner: (a) => a.key,
  wire: (a) => ({ id: a.id, path: a.path }),
  optimistic: 'none',
  pending: 'the file view',
});
const save = defineCommand<{ key: EntityKey; id: string; path: string; text: string; hash: string }, { hash: string }>({
  id: 'worktrees.save',
  owner: (a) => a.key,
  wire: (a) => ({ id: a.id, path: a.path, text: a.text, hash: a.hash }),
  optimistic: 'none',
  pending: 'Save, then Saved',
});
const grep = defineCommand<{ key: EntityKey; id: string; def: string }, { path: string; line: number; text: string }[]>({
  id: 'worktrees.grep',
  owner: (a) => a.key,
  wire: (a) => ({ id: a.id, def: a.def }),
  optimistic: 'none',
  pending: 'Go to definition',
});
const blame = defineCommand<{ key: EntityKey; repo: string; path: string }, { byLine?: BlameLine[] }>({
  id: 'history.blame',
  owner: (a) => a.key,
  wire: (a) => ({ target: a.path, repo: a.repo, byLine: true }),
  optimistic: 'none',
  pending: 'the why-gutter',
});

export function FilePane(props: { readonly path: string }): JSX.Element {
  const place = createMemo(() => placeOf(props.path));
  const path = (): string => place().file;
  const shell = useShell();
  const task = useTask();
  const t = shell.t;
  const [file, { refetch }] = createResource(
    () => path(),
    (path) => task.client.run(source, { key: task.key, id: task.id, path }).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) })),
  );
  const loaded = (): Source | undefined => {
    const f = file();
    return f && 'text' in f ? f : undefined;
  };
  const [draft, setDraft] = createSignal<string | undefined>(undefined);
  const [hash, setHash] = createSignal<string | undefined>(undefined);
  const [saving, setSaving] = createSignal(false);
  // what's on disk as far as this view knows: the text it opened, then each text it saved
  const [savedText, setSavedText] = createSignal<string | undefined>(undefined);
  const text = (): string => draft() ?? loaded()?.text ?? '';
  const saved = (): string => savedText() ?? loaded()?.text ?? '';
  const dirty = (): boolean => draft() !== undefined && draft() !== saved();
  const [why] = createResource(
    () => loaded(),
    (f) => task.client.run(blame, { key: task.key, repo: f.root, path: f.path }).catch(() => ({ byLine: [] as BlameLine[] })),
  );
  const sessions = useSignal(task.client.entities.keys('session'));
  const gutter = createMemo(() => {
    const lines = why()?.byLine ?? [];
    if (!lines.some((l) => l.task)) return undefined;
    return gutterOf(lines, text().split('\n').length).map((m) =>
      m
        ? {
            label: m.label,
            title: m.title,
            first: m.first,
            onOpen: () => {
              const key = entityKey(task.peer, m.task);
              // a task of this wisp opens; one from someone else's history shows what it was
              if (sessions().includes(key as never)) shell.navigate({ t: 'openTask', id: key as never });
              else shell.toast.show(m.title);
            },
          }
        : undefined,
    );
  });
  const doSave = (): void => {
    const f = loaded();
    const body = draft();
    if (!f || body === undefined || !dirty() || saving()) return;
    setSaving(true);
    void task.client
      .run(save, { key: task.key, id: task.id, path: f.path, text: body, hash: hash() ?? f.hash })
      .then(
        (r) => {
          setHash(r.hash);
          setSavedText(body);
        },
        () => undefined,
      )
      .finally(() => setSaving(false));
  };
  const back = (): void => shell.navigate({ t: 'openSide', side: { kind: 'changes', id: task.key as never } });
  // ✦: ask the task's agent about this file (the selected lines, when some are)
  const [lines, setLines] = createSignal<{ readonly from: number; readonly to: number } | undefined>(undefined);
  const ask = (): void => {
    const box = shell.prompts?.get('reply');
    if (!box) return;
    const now = box.text();
    box.set(`${now}${now && !now.endsWith(' ') ? ' ' : ''}${askText(path(), lines())}`);
    box.focus();
  };
  // Go to definition: where the name is declared in the task's folder, opened at its line
  const goTo = (name: string): void => {
    void task.client.run(grep, { key: task.key, id: task.id, def: name }).then(
      (found) => {
        // a file of the same kind first (a .rs name in .rs files), not this one, then whatever was found
        const ext = (f: string): string => f.slice(f.lastIndexOf('.') + 1);
        const hit = found.find((h) => h.path !== path() && ext(h.path) === ext(path())) ?? found.find((h) => ext(h.path) === ext(path())) ?? found[0];
        if (!hit) return shell.toast.show(t('shell-task.file.noDefinition', { name }));
        shell.navigate({ t: 'openSide', side: { kind: 'changes', id: task.key as never, file: `${hit.path}#L${hit.line}` } });
      },
      () => undefined,
    );
  };
  const error = (): string | undefined => {
    const f = file();
    return f && 'error' in f ? f.error : undefined;
  };
  const status = (): string => t(`shell-task.file.${statusOf({ loading: file.loading, saving: saving(), dirty: dirty(), error: error() })}`);
  return (
    <Stack gap="0" grow part="side.file">
      <Inline gap="2" align="center" part="side.file.head">
        <IconButton icon="back" size="sm" variant="ghost" label={t('shell-task.file.back')} onClick={back} />
        <Text mono size="sm" truncate title={path()}>
          {path().split('/').pop() ?? path()}
        </Text>
        <Box grow />
        <IconButton icon="spark" size="sm" variant="ghost" label={t('shell-task.file.ask')} onClick={ask} part="side.file.ask" />
        <Text size="sm" tone="muted" nowrap part="side.file.status">
          {status()}
        </Text>
        <Show when={dirty()}>
          <Button size="sm" variant="primary" loading={saving()} onClick={doSave}>
            {t('shell-task.file.save')}
          </Button>
        </Show>
      </Inline>
      <Show
        when={!error()}
        fallback={
          <EmptyState
            icon="file"
            title={error() ?? ''}
            compact
            action={
              <Button size="sm" variant="secondary" onClick={() => void refetch()}>
                {t('shell-task.file.retry')}
              </Button>
            }
          />
        }
      >
        <Box grow part="side.file.body">
          <FileView
            text={text()}
            lang={langOfPath(path())}
            onInput={(v) => setDraft(v)}
            onSave={doSave}
            gutter={gutter()}
            line={place().line}
            onSelectLines={setLines}
            onDefinition={goTo}
            aria-label={t('shell-task.file.label', { path: path() })}
            part="side.file.view"
          />
        </Box>
      </Show>
    </Stack>
  );
}
