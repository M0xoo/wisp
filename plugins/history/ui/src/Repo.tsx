// The Repo tab (ADR-0033): a project's committed agent history, from everyone who worked on it, read from .wisp/
// and git (`history.list`). Grouped by month, filtered by words, a path or an agent; a row opens its read-only
// report (`history.report`) with Resume (a new task that carries on from there, on today's code).
import { createEffect, createMemo, createResource, createSignal, For, onCleanup, Show, type JSX } from 'solid-js';
import { defineCommand, entityKey, type PeerId, type PluginClient } from '@wisp/client';
import { useShell } from '@wisp/shell';
import { Button, EmptyState, Icon, Input, ListRow, Markdown, SelectSetting, SettingsGroup, Stack, Text, englishT, timeLabel } from '@wisp/ui';
import { t } from './i18n.ts';
import { byMonth, repoLine, resumePrompt, type RepoTask } from './model.ts';

interface Project {
  readonly id: string;
  readonly name: string;
  readonly path: string;
}
interface Report {
  readonly task: RepoTask;
  readonly prompt: string;
  readonly report: string;
}

const projectsOf = defineCommand<{ peer: PeerId }, { name: string; spec?: { path?: string } }[]>({ id: 'resources.export', owner: (a) => a.peer, wire: () => ({ kinds: ['project'] }), optimistic: 'none', pending: 'the projects' });
const list = defineCommand<{ peer: PeerId; repo: string; grep?: string; path?: string }, RepoTask[]>({
  id: 'history.list',
  owner: (a) => a.peer,
  wire: ({ peer: _p, ...a }) => a,
  optimistic: 'none',
  pending: 'the repo history',
});
const report = defineCommand<{ peer: PeerId; repo: string; id: string }, Report>({ id: 'history.report', owner: (a) => a.peer, wire: ({ peer: _p, ...a }) => a, optimistic: 'none', pending: 'the report' });
const resume = defineCommand<{ peer: PeerId; prompt: string; title: string; cwd: string; agent?: string; forkOf: string }, { id: string }>({
  id: 'runtime.create',
  owner: (a) => a.peer,
  wire: (a) => ({ prompt: a.prompt, title: a.title, cwd: a.cwd, ...(a.agent && { agent: a.agent }), lineage: { forkOf: a.forkOf } }),
  optimistic: 'none',
  pending: 'Resume',
});

/** The filter box: `auth/` is a path, the rest are words. */
const filterOf = (q: string): { grep?: string; path?: string } => {
  const w = q.trim();
  if (!w) return {};
  return w.endsWith('/') || (w.includes('/') && !w.includes(' ')) ? { path: w } : { grep: w };
};

export default function Repo(props: { readonly client: PluginClient; readonly params: { project?: string } }): JSX.Element {
  const c = props.client;
  const shell = useShell();
  const say = t as (k: string, v?: Readonly<Record<string, string | number>>) => string;
  // the projects as runtime keeps them: `project` resources (resources.export), each a name and its folder
  const [projectList] = createResource(() =>
    c
      .run(projectsOf, { peer: c.home })
      .then((rs) => rs.map((r) => ({ id: r.name, name: r.name, path: r.spec?.path ?? '' })).filter((p) => !!p.path))
      .catch((): Project[] => []),
  );
  const projects = (): Project[] => projectList() ?? [];
  const [picked, setPicked] = createSignal(props.params.project ?? '');
  const project = createMemo(() => projects().find((p) => p.id === picked()) ?? projects()[0]);
  // the first project once they arrive, so the picker shows which one this is
  createEffect(() => {
    const first = projects()[0];
    if (!picked() && first) setPicked(first.id);
  });
  const [q, setQ] = createSignal('');
  const [asked, setAsked] = createSignal('');
  const scope = c.scope.child('repo');
  onCleanup(() => scope.dispose());
  let cancel: (() => void) | undefined;
  const typed = (v: string): void => {
    setQ(v);
    cancel?.();
    cancel = scope.timeout(250, () => setAsked(v));
  };
  const [rows] = createResource(
    () => (project() ? [project()?.path ?? '', asked()] : undefined),
    ([repo, words]) => c.run(list, { peer: c.home, repo: repo as string, ...filterOf(words as string) }).catch((): RepoTask[] => []),
  );
  const [open, setOpen] = createSignal<string | undefined>(undefined);
  const [shown] = createResource(
    () => (open() && project() ? [project()?.path ?? '', open() ?? ''] : undefined),
    ([repo, id]) => c.run(report, { peer: c.home, repo: repo as string, id: id as string }).catch(() => undefined),
  );
  const month = (at: number): string => new Date(at).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const goResume = (r: Report): void => {
    const p = project();
    if (!p) return;
    void c
      .run(resume, { peer: c.home, prompt: resumePrompt(r.task.title, r.prompt, r.report), title: say('history.report.resumed', { title: r.task.title }), cwd: p.path, ...(r.task.agent && { agent: r.task.agent }), forkOf: r.task.id })
      .then((out) => shell.navigate({ t: 'openTask', id: entityKey(c.home, out.id) as never }), () => undefined);
  };
  return (
    <Stack gap="4" pad="4" part="history.repo">
      <Stack gap="1">
        <Text weight="semibold" size="lg">
          {t('history.repo.title')}
        </Text>
        <Text size="sm" tone="muted">
          {t('history.repo.lede')}
        </Text>
      </Stack>
      <Show
        when={open()}
        fallback={
          <>
            <SettingsGroup part="history.repo.head">
              <SelectSetting part="history.repo.project" title={t('history.repo.project')} source={{ value: () => project()?.id ?? '', set: setPicked }} items={projects().map((p) => ({ value: p.id, label: p.name }))} />
            </SettingsGroup>
            <Input type="search" icon="search" size="sm" value={q()} placeholder={t('history.repo.filter')} aria-label={t('history.repo.filter')} onInput={typed} part="history.repo.filter" />
            <Show when={!rows.loading} fallback={<Text size="sm" tone="muted">{t('history.repo.loading')}</Text>}>
              <Show when={(rows() ?? []).length > 0} fallback={<EmptyState icon="branch" compact title={project() ? t('history.repo.none') : t('history.repo.pick')} part="history.repo.empty" />}>
                <For each={byMonth(rows() ?? [], month)}>
                  {(g) => (
                    <Stack gap="0" part="history.repo.month">
                      <Text size="xs" tone="faint" weight="medium">
                        {g.label}
                      </Text>
                      <For each={g.tasks}>
                        {(r) => (
                          <ListRow
                            part="history.repo.row"
                            title={r.title}
                            sub={repoLine(r, say)}
                            lead={<Icon name="branch" size="sm" tone="faint" />}
                            time={<Text size="xs" tone="faint">{timeLabel(r.createdAt, Date.now(), englishT)}</Text>}
                            onOpen={() => setOpen(r.id)}
                          />
                        )}
                      </For>
                    </Stack>
                  )}
                </For>
              </Show>
            </Show>
          </>
        }
      >
        <Stack gap="3" part="history.report">
          <span>
            <Button size="sm" variant="ghost" icon="back" onClick={() => setOpen(undefined)}>
              {t('history.report.back')}
            </Button>
          </span>
          <Show when={shown()} fallback={<Text size="sm" tone="muted">{t('history.repo.loading')}</Text>}>
            {(r) => (
              <>
                <Stack gap="1">
                  <Text weight="semibold">{r().task.title}</Text>
                  <Text size="sm" tone="muted">
                    {repoLine(r().task, say)}
                  </Text>
                </Stack>
                <Text size="xs" tone="faint" weight="medium">
                  {t('history.report.asked')}
                </Text>
                <Text size="sm">{r().prompt}</Text>
                <Text size="xs" tone="faint" weight="medium">
                  {t('history.report.report')}
                </Text>
                <Show when={r().report.trim()} fallback={<Text size="sm" tone="muted">{t('history.report.none')}</Text>}>
                  <Markdown source={r().report} />
                </Show>
                <span>
                  <Button size="sm" variant="primary" icon="rerun" title={t('history.report.resumeTitle')} onClick={() => goResume(r())}>
                    {t('history.report.resume')}
                  </Button>
                </span>
              </>
            )}
          </Show>
        </Stack>
      </Show>
    </Stack>
  );
}
