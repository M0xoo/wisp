// Tasks · Repo over the list (ADR-0033): your tasks, live, or the project's committed agent history. The Repo view
// is this plugin's main view (`history.repo`); Tasks goes back to New task with the list.
import type { JSX } from 'solid-js';
import type { ExtensionProps } from '@wisp/shell';
import { useShell } from '@wisp/shell';
import { Tabs, useSignal } from '@wisp/ui';
import { t } from './i18n.ts';
import { REPO_VIEW } from './views.ts';

export default function RepoTabs(_p: ExtensionProps): JSX.Element {
  const shell = useShell();
  const nav = useSignal(shell.nav);
  const on = (): string => {
    const m = nav().main as { kind: string; id?: string };
    return m.kind === 'view' && m.id === REPO_VIEW ? 'repo' : 'tasks';
  };
  return (
    <Tabs
      part="history.tabs"
      variant="pill"
      aria-label={t('history.tab.label')}
      value={on()}
      items={[
        { value: 'tasks', label: t('history.tab.tasks') },
        { value: 'repo', label: t('history.tab.repo'), icon: 'branch' },
      ]}
      onChange={(v) => (v === 'repo' ? shell.navigate({ t: 'openView', id: REPO_VIEW as never, params: {} }) : shell.navigate({ t: 'home' }))}
    />
  );
}
