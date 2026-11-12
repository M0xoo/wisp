// Watch (v1 features/watch.js, panel.js tab 'watch', F-page-32): the page an agent keeps beside its task while it
// works (`wisp_watch`). A caption line (a live dot while the task runs, what the agent says it's doing; a url watch adds
// its address and Open in a new tab), the page in a sealed frame, and how to run the thing yourself under it. Only a
// new page (`rev`) loads the frame again; a new state is posted into it, so nothing flashes. The watch and its page
// come with the task's topic (runtime's `watch` and `watch_page` rows).
import { Show, createEffect, createMemo, on, untrack, type JSX } from 'solid-js';
import { AppFrame, EmptyState, Icon, IconButton, Inline, Orb, Stack, Text, readTheme, themeCss, useSignal, type AppFrameController } from '@wisp/ui';
import { useShell } from '../shell.ts';
import { useTask } from '../task-context.tsx';
import { appSandbox, runLine, shortUrl, watchDoc } from './watch-doc.ts';

interface WatchBody {
  readonly title: string;
  readonly caption?: string;
  readonly state?: unknown;
  readonly run?: { readonly command: string; readonly cwd: string; readonly note?: string };
  readonly seq: number;
  readonly rev: number;
  readonly closed?: boolean;
  readonly url?: string;
}

export function WatchPane(): JSX.Element {
  const shell = useShell();
  const task = useTask();
  const t = shell.t;
  const w = useSignal(task.client.entities.row<{ body?: WatchBody }>('watch', task.key));
  const page = useSignal(task.client.entities.row<{ body?: { html?: string } }>('watch_page', task.key));
  const watch = (): WatchBody | undefined => w()?.body;
  const live = (): boolean => {
    const st = (task.task() as { state?: string } | undefined)?.state;
    return !watch()?.closed && (st === 'running' || st === 'waiting');
  };
  const caption = (): string => watch()?.caption || t(watch()?.closed ? 'shell-task.watch.finished' : live() ? 'shell-task.watch.working' : 'shell-task.watch.stopped');
  let frame: AppFrameController | undefined;
  // the page, built again only when it changed (rev); the state it starts with is the one at that moment
  const doc = createMemo(
    on(
      () => [watch()?.rev, page()?.body?.html] as const,
      ([, html]) => {
        if (html === undefined || watch()?.url) return undefined;
        const th = readTheme();
        return watchDoc(html, { vars: th.vars, scheme: th.scheme, state: untrack(() => watch()?.state ?? null) });
      },
    ),
  );
  // a new state (seq) reaches the page without a reload
  createEffect(
    on(
      () => watch()?.seq,
      () => frame?.post({ type: 'state', state: untrack(() => watch()?.state ?? null) }),
      { defer: true },
    ),
  );
  const origin = globalThis.origin ?? '';
  return (
    <Show when={watch()} fallback={<EmptyState icon="eye" title={t('shell-task.watch.none')} compact />}>
      {(wt) => (
        <Stack gap="0" grow part="watch.pane">
          <Inline gap="2" align="center" part="watch.caption">
            <Show when={live()} fallback={<Icon name={wt().closed ? 'done' : 'pause'} size="sm" tone="muted" />}>
              <Orb live label={caption()} />
            </Show>
            <Text size="sm" tone="muted" truncate title={caption()}>
              {caption()}
            </Text>
            <Show when={wt().url}>
              {(u) => (
                <>
                  <Text size="sm" tone="faint" mono truncate title={u()}>
                    {shortUrl(u())}
                  </Text>
                  <IconButton icon="external" size="xs" label={t('shell-task.watch.openTab')} onClick={() => shell.platform.openExternal(u())} />
                </>
              )}
            </Show>
          </Inline>
          <Stack gap="0" grow part="watch.box">
            <Show
              when={wt().url}
              fallback={
                <Show when={doc()}>
                  {(d) => (
                    <AppFrame
                      title={wt().title || t('shell-task.side.watch')}
                      srcdoc={d()}
                      sandbox="allow-scripts"
                      controller={(c) => (frame = c)}
                      onTheme={(th) => frame?.post({ type: 'theme', css: themeCss(th.vars, th.scheme), scheme: th.scheme })}
                    />
                  )}
                </Show>
              }
            >
              {(u) => <AppFrame title={wt().title || t('shell-task.side.watch')} src={u()} sandbox={appSandbox(u(), origin)} controller={(c) => (frame = c)} />}
            </Show>
          </Stack>
          <Show when={wt().run}>
            {(r) => (
              <Stack gap="1" part="watch.run">
                <Inline gap="1" align="center" part="watch.label">
                  <Icon name="terminal" size="sm" tone="muted" />
                  <Text size="sm" tone="muted">
                    {t('shell-task.watch.runIt')}
                  </Text>
                </Inline>
                <Inline gap="2" align="center" part="watch.cmd">
                  <Text size="sm" mono truncate title={r().cwd}>
                    {r().command}
                  </Text>
                  <IconButton icon="copy" size="xs" label={t('shell-task.watch.copyRun')} onClick={() => void shell.platform.copy(runLine(r()))} />
                </Inline>
                <Show when={r().note}>
                  {(n) => (
                    <Text size="sm" tone="faint">
                      {n()}
                    </Text>
                  )}
                </Show>
              </Stack>
            )}
          </Show>
        </Stack>
      )}
    </Show>
  );
}
