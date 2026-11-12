// The side panel beside the open task (v1 features/panel.js): its head (Changes · PR · Shell, then close) and
// the pane. Changes: every file the work changed since it left its base, committed or not, from git
// (`git.changes`, the worktree's base, else HEAD); a folder that isn't a repo shows the turns' own edits. PR
// (PrPane.tsx, `ship.details`) and Shell (ShellPane.tsx, wisp.terminal).
import { Match, Show, Switch, type JSX } from 'solid-js';
import { Box, IconButton, Icon, Inline, Stack, Tabs, Text } from '@wisp/ui';
import { TERM_VIEW, isTui, type SidePane } from '../open-task.ts';
import { useShell } from '../shell.ts';
import { useTask } from '../task-context.tsx';
import { PrPane } from './PrPane.tsx';
import { ShellPane } from './ShellPane.tsx';
import { ChangesPane } from './ChangesPane.tsx';
import { FilePane } from './FilePane.tsx';

const PANES: readonly SidePane[] = ['changes', 'pr', 'shell'];

export function SidePanel(props: { readonly pane: SidePane; readonly file?: string }): JSX.Element {
  const shell = useShell();
  const task = useTask();
  const t = shell.t;
  const place = (): { where: string; remote: boolean; branch: string; dirty: number } | undefined => {
    const r = task.task() as { summary?: { branch?: string; machine?: { name?: string } | null; toShip?: { dirty?: number } | null; worktree?: { branch?: string } | null } } | undefined;
    const sum = r?.summary;
    if (!sum) return undefined;
    return { where: sum.machine?.name ?? t('shell-task.side.here'), remote: !!sum.machine, branch: sum.worktree?.branch ?? sum.branch ?? '', dirty: sum.toShip?.dirty ?? 0 };
  };
  const open = (pane: string): void => {
    if (pane === 'changes' || pane === 'pr' || pane === 'shell') shell.navigate({ t: 'openSide', side: { kind: pane, id: task.key as never } });
    if (pane === 'term') shell.navigate({ t: 'openSide', side: { kind: 'view', id: TERM_VIEW as never } });
  };
  // a terminal task's CLI comes first
  const panes = (): readonly SidePane[] => (isTui(task.task()) || props.pane === 'term' ? ['term', ...PANES] : PANES);
  return (
    <Stack gap="0" part={'side.panel panel' as `${string}.${string}`} grow>
      <Inline gap="2" align="center" part="side.head">
        <Tabs
          part="panel.tabs"
          variant="pill"
          aria-label={t('shell-task.side.label')}
          value={props.pane}
          onChange={open}
          items={panes().map((p) => ({ value: p, label: t(`shell-task.side.${p}`), icon: p === 'changes' ? 'file' : p === 'pr' ? 'merge' : 'terminal' }))}
        />
        <Box grow />
        <IconButton icon="x" size="sm" label={t('shell-task.side.close')} onClick={() => shell.navigate({ t: 'closeSide' })} />
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
          </Inline>
        )}
      </Show>
      <Stack gap="0" grow part="side.body">
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
          <Match when={props.pane === 'term'}>
            <ShellPane kind="takeover" />
          </Match>
        </Switch>
      </Stack>
    </Stack>
  );
}
