// The side panel beside the open task (v1 features/panel.js): its head (Changes · PR · Shell, then close) and
// the pane. Changes: every file the work changed since it left its base, committed or not, from git
// (`git.changes`, the worktree's base, else HEAD); a folder that isn't a repo shows the turns' own edits. PR
// (PrPane.tsx, `ship.details`) and Shell (ShellPane.tsx, wisp.terminal).
import { Match, Show, Switch, createEffect, createMemo, createResource, type JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { computed, defineCommand, readonly, entityKey, type EntityKey } from '@wisp/client';
import { Box, IconButton, type IconName, Icon, Inline, Menu, Stack, Tabs, Text, useSignal } from '@wisp/ui';
import { editorUrl } from '../editor.ts';
import { TAB_VIEW, TERM_VIEW, WATCH_VIEW, isTui, pickedTab, tabKey, type SidePane } from '../open-task.ts';
import { useShell } from '../shell.ts';
import { useTask } from '../task-context.tsx';
import { PrPane } from './PrPane.tsx';
import { ShellPane } from './ShellPane.tsx';
import { ChangesPane } from './ChangesPane.tsx';
import { FilePane } from './FilePane.tsx';
import { PreviewPane } from './PreviewPane.tsx';
import { WatchPane } from './WatchPane.tsx';

const bare = (k: string): string => k.slice(k.indexOf(':') + 1);
/** whether a terminal app can open here for this page (wisp.terminal) */
const shellInfo = defineCommand<{ key: EntityKey; id: string }, { app: boolean }>({
  id: 'terminal.shell.info',
  owner: (a) => a.key,
  wire: (a) => ({ id: a.id }),
  optimistic: 'none',
  pending: 'the place menu',
});
/** v1 POST /sessions/:id/open-shell: the folder in the terminal app Settings names */
const openApp = defineCommand<{ key: EntityKey; cwd: string }, { ok: boolean }>({
  id: 'terminal.app.open',
  owner: (a) => a.key,
  wire: (a) => ({ cwd: a.cwd, argv: [] }),
  optimistic: 'none',
  pending: 'Open in terminal app',
});

const PANES: readonly SidePane[] = ['changes', 'pr', 'shell', 'preview'];

export function SidePanel(props: { readonly pane: SidePane; readonly file?: string }): JSX.Element {
  const shell = useShell();
  const task = useTask();
  const t = shell.t;
  const place = (): { where: string; remote: boolean; branch: string; dirty: number; dir: string } | undefined => {
    const r = task.task() as
      | {
          cwd?: string;
          ext?: { 'wisp.worktrees'?: { path?: string } };
          summary?: { branch?: string; machine?: { name?: string } | null; toShip?: { dirty?: number } | null; worktree?: { branch?: string; path?: string } | null };
        }
      | undefined;
    const sum = r?.summary;
    if (!sum) return undefined;
    const dir = r?.ext?.['wisp.worktrees']?.path ?? sum.worktree?.path ?? r?.cwd ?? '';
    return { where: sum.machine?.name ?? t('shell-task.side.here'), remote: !!sum.machine, branch: sum.worktree?.branch ?? sum.branch ?? '', dirty: sum.toShip?.dirty ?? 0, dir };
  };
  // the place row's ⋯ (v1 panel.js placeMenu): copy where the work is, open it in the editor Settings names (its URL
  // scheme), or in the terminal app (wisp.terminal's terminal.app.open; only where one can open: this computer's desktop)
  const editor = useSignal(task.client.entities.row<{ value?: unknown }>('setting', entityKey(task.client.home, 'settings.editor')));
  const [app] = createResource(() =>
    task.client.run(shellInfo, { key: task.key as EntityKey, id: bare(task.key) }).then(
      (i) => i.app,
      () => false,
    ),
  );
  const placeItems = (pl: { branch: string; dir: string; remote: boolean }) => [
    ...(pl.dir ? [{ value: 'path', label: t('shell-task.side.copyPath'), icon: 'copy' as const }] : []),
    ...(pl.branch ? [{ value: 'branch', label: t('shell-task.side.copyBranch'), icon: 'branch' as const }] : []),
    ...(pl.dir && !pl.remote && editorUrl(String(editor()?.value ?? ''), pl.dir) ? [{ value: 'editor', label: t('shell-task.side.openEditor'), icon: 'folder' as const }] : []),
    ...(pl.dir && !pl.remote && app() ? [{ value: 'app', label: t('shell-task.side.openApp'), icon: 'terminal' as const }] : []),
  ];
  const onPlace = (pl: { branch: string; dir: string }, v: string): void => {
    if (v === 'path') void shell.platform.copy(pl.dir);
    if (v === 'branch') void shell.platform.copy(pl.branch);
    if (v === 'editor') {
      const url = editorUrl(String(editor()?.value ?? ''), pl.dir);
      if (url) shell.platform.openExternal(url);
    }
    if (v === 'app') void task.client.run(openApp, { key: task.key as EntityKey, cwd: pl.dir }).catch(() => undefined);
  };
  const open = (pane: string): void => {
    if (pane === 'changes' || pane === 'pr' || pane === 'shell' || pane === 'preview') shell.navigate({ t: 'openSide', side: { kind: pane, id: task.key as never } });
    if (pane === 'term') shell.navigate({ t: 'openSide', side: { kind: 'view', id: TERM_VIEW as never } });
    if (pane === 'watch') shell.navigate({ t: 'openSide', side: { kind: 'view', id: WATCH_VIEW as never } });
    if (extra().some((x) => x.key === pane)) {
      pickedTab(pane);
      shell.navigate({ t: 'openSide', side: { kind: 'view', id: TAB_VIEW as never } });
    }
  };
  // a terminal task's CLI comes first; Watch after the panel's own while the task has one (v1 panel.js tabs)
  const watched = (): boolean => !!(task.task() as { summary?: { watch?: unknown } } | undefined)?.summary?.watch || props.pane === 'watch';
  const panes = (): readonly SidePane[] => [...(isTui(task.task()) || props.pane === 'term' ? (['term'] as const) : []), ...PANES, ...(watched() ? (['watch'] as const) : [])];
  // other plugins' tabs, after the panel's own (v1 panel.js: an app from My Stuff pinned to tasks, "pane:<id>")
  // (a client computed: what the tabs read are the client's signals, the pins setting and the items)
  const defs = shell.sideTabs?.();
  const extra = useSignal(computed(() => (defs?.() ?? []).flatMap((d) => d.tabs({ client: d.client, task: task.key }).map((x) => ({ ...x, key: tabKey(d.plugin, d.id, x.value), def: d })))));
  const picked = useSignal(readonly(pickedTab));
  const shown = createMemo(() => (props.pane === 'tab' ? extra().find((x) => x.key === picked()) : undefined));
  // its tab gone (unpinned while open, or a reload forgot which): Changes, as v1 (panel.js tabOf)
  createEffect(() => {
    if (props.pane === 'tab' && !shown()) shell.navigate({ t: 'openSide', side: { kind: 'changes', id: task.key as never } });
  });
  return (
    <Stack gap="0" part={'side.panel panel' as `${string}.${string}`} grow>
      <Inline gap="2" align="center" part="side.head">
        <Tabs
          part="panel.tabs"
          variant="pill"
          aria-label={t('shell-task.side.label')}
          value={shown()?.key ?? props.pane}
          onChange={open}
          items={[
            ...panes().map((p) => ({
              value: p,
              label: t(`shell-task.side.${p}`),
              icon: (p === 'changes' ? 'file' : p === 'pr' ? 'merge' : p === 'preview' ? 'web' : p === 'watch' ? 'eye' : 'terminal') as IconName,
            })),
            ...extra().map((x) => ({ value: x.key, label: x.label, icon: 'app' as const, ...(x.title !== undefined && { title: x.title }) })),
          ]}
        />
        <Box grow />
        <IconButton icon="x" label={t('shell-task.side.close')} onClick={() => shell.navigate({ t: 'closeSide' })} />
      </Inline>
      {/* v1 panel.js .pn-place: where the task's work is, its branch, and what isn't committed */}
      <Show when={place()}>
        {(pl) => (
          <Inline gap="2" align="center" part="panel.place">
            <Icon name={pl().remote ? 'server' : 'laptop'} size="sm" tone="faint" />
            <Text size="sm" tone="muted" nowrap>
              {pl().where}
            </Text>
            <Show when={pl().branch}>
              <Text size="sm" tone="faint">
                ·
              </Text>
              <Text size="sm" tone="muted" mono truncate title={pl().branch}>
                {pl().branch}
              </Text>
            </Show>
            <Show when={pl().dirty > 0}>
              <Text size="sm" tone="faint" nowrap>
                {t('shell-task.side.uncommitted', { n: pl().dirty })}
              </Text>
            </Show>
            <Box grow />
            <Show when={placeItems(pl()).length > 0}>
              <Menu
                part="panel.place.more"
                trigger={{ icon: 'dots', 'aria-label': t('shell-task.side.more'), variant: 'ghost', size: 'xs' }}
                items={placeItems(pl())}
                onSelect={(v) => onPlace(pl(), v)}
              />
            </Show>
          </Inline>
        )}
      </Show>
      {/* Changes runs edge to edge (v1 #sidePanel .cx); PR and Shell keep the body's padding */}
      <Stack gap="0" grow part={(props.pane === 'changes' && !props.file) || props.pane === 'preview' || props.pane === 'watch' || props.pane === 'tab' ? 'side.body side.flush' : 'side.body'}>
        <Switch>
          <Match when={props.pane === 'changes' && props.file}>{(f) => <FilePane path={f()} />}</Match>
          <Match when={props.pane === 'changes'}>
            <ChangesPane />
          </Match>
          <Match when={props.pane === 'pr'}>
            <PrPane />
          </Match>
          <Match when={props.pane === 'shell'}>
            <ShellPane kind="shell" />
          </Match>
          <Match when={props.pane === 'preview'}>
            <PreviewPane />
          </Match>
          <Match when={props.pane === 'watch'}>
            <WatchPane />
          </Match>
          <Match when={props.pane === 'term'}>
            <ShellPane kind="takeover" />
          </Match>
          <Match when={shown()}>{(x) => <Dynamic component={x().def.component} client={x().def.client} task={task.key} value={x().value} />}</Match>
        </Switch>
      </Stack>
    </Stack>
  );
}
