// Projects (v1 features/projects.js, design/v1-reference/projects): add a folder or a GitHub URL (cloned for you),
// your projects in your order (drag a row, or Alt+↑/↓, v1 #772) with how many tasks each has, rename, recolour and
// remove; and the git repos found on this computer, one click to add. Every write is a resource op on wisp.runtime's
// `project` kind, shown at once and rolled back with a toast if refused.

import { createMemo, createResource, createSignal, For, Show, type JSX } from 'solid-js';
import { defineCommand, entityKey, type PeerId, type PluginClient } from '@wisp/client';
import { Button, Card, Dot, Grid, Icon, IconButton, Inline, Input, ListRow, Menu, PathField, Stack, Text, reorderable, useSignal } from '@wisp/ui';
import type { ProjectColor } from '@wisp/tokens';
import { useShell } from '../context.tsx';
import { usePluginClient } from '../slot.tsx';
import { SESSION, type SessionRow } from '../rows.ts';
import { useProjects } from './projects.ts';
import { projectOf, type ProjectView } from './rows-view.ts';

const COLORS = ['violet', 'teal', 'amber', 'rose', 'sky', 'lime', 'orange', 'indigo', 'slate'] as const;
const IS_URL = /^(https?:\/\/|git@|ssh:\/\/)/;

interface Found {
  readonly path: string;
  readonly name: string;
}

const row = (peer: string, name: string, spec: Record<string, unknown>) => ({ e: 'project', id: entityKey(peer as PeerId, name), op: 'upsert' as const, v: { id: name, body: spec } as never });

/** Add or change a project: its spec, as a resource. */
const putProject = defineCommand<{ peer: string; name: string; spec: Record<string, unknown> }>({
  id: 'resources.apply',
  owner: (a) => a.peer,
  wire: (a) => ({ resources: [{ kind: 'project', name: a.name, spec: a.spec }], trust: true }),
  optimistic: (_b, a) => [row(a.peer, a.name, a.spec)],
});
const dropProject = defineCommand<{ peer: string; name: string }>({
  id: 'resources.apply',
  owner: (a) => a.peer,
  wire: (a) => ({ resources: [], destroy: [`project.${a.name}`] }),
  optimistic: (_b, a) => [{ e: 'project', id: entityKey(a.peer as PeerId, a.name), op: 'del' }],
});
const renameProject = defineCommand<{ peer: string; from: string; to: string; spec: Record<string, unknown> }>({
  id: 'resources.rename',
  owner: (a) => a.peer,
  wire: (a) => ({ kind: 'project', from: a.from, to: a.to }),
  optimistic: (_b, a) => [{ e: 'project', id: entityKey(a.peer as PeerId, a.from), op: 'del' }, row(a.peer, a.to, a.spec)],
});
/** v1 GET /fs?q=: the folders the typed path could go on to (answered in the form typed: `~/…` stays `~/…`) */
const folders = defineCommand<{ peer: string; q: string }, string[]>({ id: 'runtime.folders', owner: (a) => a.peer, wire: (a) => ({ q: a.q }), optimistic: 'none', pending: 'the folder suggestions' });
const discover = defineCommand<{ peer: string }, Found[]>({ id: 'runtime.discover', owner: (a) => a.peer, wire: () => ({}), optimistic: 'none', pending: 'Found on this machine' });
const clone = defineCommand<{ peer: string; url: string }, { dir: string }>({ id: 'git.clone', owner: (a) => a.peer, wire: (a) => ({ url: a.url }), optimistic: 'none', pending: 'Add' });

/** Where a found repo is, as v1 showed it: its folder's parent, your home as `~` (`/Users/me/code/web` → `~/code`). */
export function whereIs(path: string): string {
  const parent = path.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/';
  return parent.replace(/^\/(?:Users|home)\/[^/]+/, '~').replace(/^[A-Za-z]:\\Users\\[^\\]+/, '~');
}

/** A project's name from its folder or URL: its last part, without `.git`, as a resource name. */
export function nameFor(source: string, taken: readonly string[]): string {
  const last = source.trim().replace(/\/+$/, '').split(/[/:]/).pop() ?? '';
  const base =
    last
      .replace(/\.git$/, '')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'project';
  let name = base;
  for (let i = 2; taken.includes(name); i++) name = `${base}-${i}`;
  return name;
}

export default function Projects(_p: { readonly client: PluginClient; readonly params: unknown }): JSX.Element {
  const shell = useShell();
  const t = shell.t;
  const home = usePluginClient('shell').home;
  const { list, reorder } = useProjects(shell, home);
  const rows = useSignal(shell.client.entities.list<unknown>('project'));
  const sessions = useSignal(shell.client.entities.list<SessionRow>(SESSION));
  const [source, setSource] = createSignal('');
  const [adding, setAdding] = createSignal(false);
  const [found, { refetch }] = createResource(() => shell.client.commands.run(discover, { peer: home }).catch((): Found[] => []));
  const specOf = (id: string): Record<string, unknown> => {
    const r = rows().find((x) => (x as { id?: string }).id === id) as { body?: Record<string, unknown> } | undefined;
    return { ...(r?.body ?? {}) };
  };
  const counts = createMemo(() => {
    const out = new Map<string, number>();
    for (const s of sessions()) {
      const p = projectOf(String(s.summary['cwd'] ?? ''), list());
      if (p) out.set(p.id, (out.get(p.id) ?? 0) + 1);
    }
    return out;
  });
  const add = (path: string, name?: string): void => {
    // a folder that's a project already stays one project (v1 addProject returned the one it had)
    const had = list().find((p) => p.path.replace(/\/+$/, '') === path.trim().replace(/\/+$/, ''));
    if (had) return void shell.toast.show(t('shell.projects.already', { name: had.name }));
    const n =
      name ??
      nameFor(
        path,
        list().map((p) => p.id),
      );
    void shell.client.commands.run(putProject, { peer: home, name: n, spec: { path } }).then(
      () => void refetch(),
      () => undefined,
    );
  };
  const submit = (): void => {
    const v = source().trim();
    if (!v) return;
    setSource('');
    if (!IS_URL.test(v)) return add(v);
    setAdding(true);
    void shell.client.commands
      .run(clone, { peer: home, url: v })
      .then(
        (c) =>
          add(
            c.dir,
            nameFor(
              v,
              list().map((p) => p.id),
            ),
          ),
        () => setSource(v),
      )
      .finally(() => setAdding(false));
  };
  const ids = (): string[] => list().map((p) => p.id);
  const recolor = (p: ProjectView, color: string): void => void shell.client.commands.run(putProject, { peer: home, name: p.id, spec: { ...specOf(p.id), color } }).catch(() => undefined);
  // rename in place: the row's name becomes a field (Enter keeps it, Escape leaves it)
  const [editing, setEditing] = createSignal<string | undefined>(undefined);
  const [draft, setDraft] = createSignal('');
  const rename = (p: ProjectView): void => {
    setDraft(p.name);
    setEditing(p.id);
  };
  const saveName = (p: ProjectView): void => {
    setEditing(undefined);
    const to = nameFor(
      draft(),
      list()
        .map((x) => x.id)
        .filter((x) => x !== p.id),
    );
    if (!draft().trim() || to === p.id) return;
    void shell.client.commands.run(renameProject, { peer: home, from: p.id, to, spec: specOf(p.id) }).catch(() => undefined);
  };
  return (
    <Stack gap="4" part="projects.dialog">
      <Inline gap="2" part="projects.add">
        <PathField
          value={source()}
          onInput={setSource}
          suggest={(q) => shell.client.commands.run(folders, { peer: home, q })}
          skip={(q) => IS_URL.test(q)}
          onPick={(p) => {
            setSource('');
            add(p);
          }}
          onEnter={submit}
          placeholder={t('shell.projects.placeholder')}
          aria-label={t('shell.projects.add')}
        />
        <Show when={shell.platform.pickFolder}>
          {(pick) => (
            <Button variant="ghost" icon="folder" part="projects.browse" onClick={() => void pick()().then((dir) => dir && add(dir))}>
              {t('shell.projects.browse')}
            </Button>
          )}
        </Show>
        <Button variant="primary" loading={adding()} disabled={!source().trim()} onClick={submit}>
          {t('shell.projects.add')}
        </Button>
      </Inline>
      <Text size="sm" tone="muted">
        {t('shell.projects.hint')}
      </Text>
      <Stack gap="0" part="projects.list">
        <For each={list()}>
          {(p) => (
            <ListRow
              part="projects.row"
              reorder={reorderable('projects', p.id, ids, reorder)}
              lead={<Dot color={`pc-${COLORS.includes(p.color as never) ? p.color : 'slate'}` as ProjectColor} />}
              title={p.name}
              sub={
                <Show when={editing() === p.id} fallback={p.path}>
                  <Input
                    size="sm"
                    value={draft()}
                    onInput={setDraft}
                    autofocus
                    aria-label={t('shell.projects.rename')}
                    onBlur={() => saveName(p)}
                    onKeyDown={(e) => (e.key === 'Enter' ? (e.preventDefault(), saveName(p)) : e.key === 'Escape' && (e.preventDefault(), setEditing(undefined)))}
                  />
                </Show>
              }
              pills={
                <Text size="sm" tone="muted">
                  {t((counts().get(p.id) ?? 0) === 1 ? 'shell.projects.task' : 'shell.projects.tasks', { count: counts().get(p.id) ?? 0 })}
                </Text>
              }
              actions={
                <Inline gap="1">
                  <Menu
                    items={[
                      { value: 'rename', label: t('shell.projects.rename'), icon: 'pen' },
                      { kind: 'separator' as const },
                      ...COLORS.map((c) => ({ value: `color:${c}`, label: t(`shell.projects.color.${c}`), ...(p.color === c && { checked: true }) })),
                    ]}
                    onSelect={(v) => (v === 'rename' ? rename(p) : recolor(p, v.slice(6)))}
                    trigger={{ icon: 'dots', 'aria-label': t('shell.projects.more', { name: p.name }), size: 'sm' }}
                    placement="bottom-end"
                    part="projects.row.more"
                  />
                  <IconButton
                    icon="trash"
                    size="sm"
                    variant="ghost"
                    label={t('shell.projects.remove', { name: p.name })}
                    onClick={() => void shell.client.commands.run(dropProject, { peer: home, name: p.id }).catch(() => undefined)}
                  />
                </Inline>
              }
            />
          )}
        </For>
      </Stack>
      <Show when={(found() ?? []).length > 0}>
        <Stack gap="2" part="projects.found">
          <Inline gap="1">
            <Text weight="semibold">{t('shell.projects.found')}</Text>
            <Text size="sm" tone="muted">
              {t('shell.projects.foundHint')}
            </Text>
          </Inline>
          <Grid min="pick-max" gap="2">
            <For each={found()}>
              {(f) => (
                <Card interactive pad="4" onClick={() => add(f.path)} part="projects.found.repo" aria-label={t('shell.projects.addFound', { name: f.name })}>
                  <Inline gap="2" align="start">
                    <Icon name="plus" size="sm" tone="accent" />
                    <Stack gap="0">
                      <Text weight="semibold" truncate>
                        {f.name}
                      </Text>
                      <Text size="sm" tone="muted" truncate>
                        {whereIs(f.path)}
                      </Text>
                    </Stack>
                  </Inline>
                </Card>
              )}
            </For>
          </Grid>
        </Stack>
      </Show>
    </Stack>
  );
}
