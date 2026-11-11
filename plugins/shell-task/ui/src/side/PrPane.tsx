// The side panel's PR pane (v1 features/panel.js paintPr): the task's PRs from `ship.details` (one chip each when
// there are several), the title as a link, #n · state · branch → base · author, the verdict with its one step
// (Merge, Fix conflicts), checks with the passed folded, reviewers, the conversation (outdated threads and bots
// folded), the files, and Open on GitHub · Checked … · Check now. Skeleton rows while the first answer comes.
import { For, Show, createMemo, createResource, createSignal, type JSX } from 'solid-js';
import { defineCommand, type EntityKey } from '@wisp/client';
import { Banner, Button, CheckList, CheckRow, EmptyState, Heading, IconButton, Inline, Link, Skeleton, Stack, Text, ToneChip, Wrap, timeLabel } from '@wisp/ui';
import type { Tone as KitTone } from '@wisp/tokens';
import { useShell } from '../shell.ts';
import { useTask } from '../task-context.tsx';
import { checkGroups, dur, gist, prFiles, talk, verdict, type PrNote, type PrPanel, type Tone } from './pr.ts';

const bare = (k: string): string => k.slice(k.indexOf(':') + 1);
type S = { key: EntityKey; session: string };
const wire = (a: S): { session: string } => ({ session: a.session });
const details = defineCommand<S, PrPanel[]>({ id: 'ship.details', owner: (a) => a.key, wire, optimistic: 'none', pending: 'the PR pane' });
const refresh = defineCommand<S, unknown>({ id: 'ship.refresh', owner: (a) => a.key, wire, optimistic: 'none', pending: 'Check now' });
const merge = defineCommand<S, unknown>({ id: 'ship.merge', owner: (a) => a.key, wire, optimistic: 'none', pending: 'Merge' });
const fixConflicts = defineCommand<S, unknown>({ id: 'ship.fix_conflicts', owner: (a) => a.key, wire, optimistic: 'none', pending: 'Fix conflicts' });

const TONE: Readonly<Record<Tone, KitTone>> = { merged: 'accent', closed: 'neutral', fail: 'bad', pending: 'warn', draft: 'neutral', pass: 'good' };
const STATE: Readonly<Record<string, string>> = { OPEN: 'shell-task.pr.open', MERGED: 'shell-task.pr.stateMerged', CLOSED: 'shell-task.pr.stateClosed' };

export function PrPane(): JSX.Element {
  const shell = useShell();
  const task = useTask();
  const t = shell.t;
  const c = task.client;
  const args = (): S => ({ key: task.key, session: bare(task.key) });
  const [at, setAt] = createSignal(0);
  // the PRs wisp.ship keeps on the task's row (v1 prsOf): none, and there is nothing to ask GitHub about
  const known = (): boolean => {
    const r = (task.task() ?? {}) as { pr?: unknown; also?: readonly { pr?: unknown }[]; prs?: readonly unknown[] };
    return !!r.pr || (r.also ?? []).some((a) => !!a.pr) || (r.prs ?? []).length > 0;
  };
  const [list, { refetch }] = createResource(
    () => (known() ? task.key : undefined),
    // a task ship doesn't track (no worktree, never shipped) has no PR: v1's "This task has no pull request."
    () => c.run(details, args()).then((l) => (setAt(Date.now()), l), () => [] as PrPanel[]),
  );
  const [picked, setPicked] = createSignal(0);
  const [open, setOpen] = createSignal<ReadonlySet<string>>(new Set());
  const unfold = (k: string): void => void setOpen(new Set([...open(), k]));
  const fold = (k: string): void => void setOpen(new Set([...open()].filter((x) => x !== k)));
  const raw = (): { agent?: string; status?: string; body?: { conflictFix?: { step?: string } } } => (task.task() ?? {}) as never;
  const pr = createMemo((): PrPanel | undefined => {
    const l = list() ?? [];
    return l[Math.min(picked(), l.length - 1)];
  });
  const quiet = (p: Promise<unknown>): void => void p.then(() => refetch(), () => {});
  const fixing = (): boolean => ['fixing', 'pushing'].includes(raw().body?.conflictFix?.step ?? '');
  const canAsk = (): boolean => raw().agent !== 'wisp' && raw().status !== 'running';

  const who = (n: { author: string; bot?: boolean }): JSX.Element => (
    <Text size="sm" weight="medium" truncate>
      {n.author}
    </Text>
  );
  const note = (n: PrNote): JSX.Element => (
    <Stack gap="1" part="side.pr.note" as="li">
      <Inline gap="2" justify="between">
        {who(n)}
        <Show when={n.at}>{(a) => <Text size="xs" tone="muted">{timeLabel(a(), Date.now(), t)}</Text>}</Show>
      </Inline>
      <Text size="sm" tone="muted">
        {gist(n.body)}
      </Text>
    </Stack>
  );

  return (
    <Stack gap="4" part="side.pr" grow>
      <Show
        when={known() ? list() : []}
        fallback={
          <Stack gap="2" part="side.pr.skeleton" aria-hidden="true">
            <Skeleton width="2/3" />
            <Skeleton width="1/2" />
            <Skeleton width="full" />
            <Skeleton width="1/2" />
            <Skeleton width="1/2" />
          </Stack>
        }
      >
        <Show when={pr()} fallback={<EmptyState icon="merge" title={t('shell-task.pr.none')} compact />}>
          {(p) => {
            const v = createMemo(() => verdict(p(), { fixing: fixing(), canFix: canAsk() }));
            const g = createMemo(() => checkGroups(p().checkList ?? []));
            const said = createMemo(() => talk(p()));
            const files = createMemo(() => prFiles(p(), open().has('files')));
            return (
              <>
                <Show when={(list() ?? []).length > 1}>
                  <Wrap gap="2" part="side.pr.chips">
                    <For each={list()}>{(x, k) => <ToneChip label={`${x.repo ?? ''} #${x.number}`} tone={TONE[verdict(x).tone]} pressed={k() === picked()} onClick={() => setPicked(k())} />}</For>
                  </Wrap>
                </Show>
                <Stack gap="1">
                  <Link href={p().url} external tone="ink" title={p().title ?? ''} part="side.pr.title">
                    {p().title || t('shell-task.pr.untitled', { n: p().number })}
                  </Link>
                  <Text size="sm" tone="muted" truncate part="side.pr.meta">
                    {[`#${p().number}`, t(p().draft && p().state === 'OPEN' ? 'shell-task.pr.stateDraft' : (STATE[p().state] ?? 'shell-task.pr.open')), p().branch ? `${p().branch} → ${p().base ?? ''}` : '', p().author ? t('shell-task.pr.by', { name: p().author ?? '' }) : ''].filter(Boolean).join(' · ')}
                  </Text>
                </Stack>
                <Banner
                  part={`side.pr.verdict.${v().tone}`}
                  tone={TONE[v().tone]}
                  title={t(v().key, v().vars)}
                  {...((v().act === 'merge' && (list() ?? []).length === 1) || v().act === 'fix'
                    ? {
                        action: (
                          <Button size="sm" variant={v().primary ? 'primary' : 'ghost'} icon={v().act === 'merge' ? 'check' : 'merge'} onClick={() => quiet(c.run(v().act === 'fix' ? fixConflicts : merge, args()))}>
                            {t(v().act === 'fix' ? 'shell-task.pr.fix' : 'shell-task.pr.merge')}
                          </Button>
                        ),
                      }
                    : {})}
                />
                <Show when={p().error}>{(e) => <Banner tone="warn" title={e()} part="side.pr.error" />}</Show>
                <Show when={p().checkList}>
                  <Stack gap="2" part="side.pr.checks">
                    <Heading level={4}>{t('shell-task.pr.checks')}</Heading>
                    <Show when={(p().checkList ?? []).length > 0} fallback={<Text size="sm" tone="muted">{t('shell-task.pr.noChecks')}</Text>}>
                      <CheckList label={t('shell-task.pr.checks')}>
                        <For each={[...g().bad, ...(g().okOpen || open().has('passed') ? g().ok : [])]}>
                          {(k) => (
                            <CheckRow
                              name={k.name}
                              state={k.state === 'skip' ? 'skipped' : (k.state as 'pass' | 'fail' | 'pending')}
                              duration={k.state === 'pending' ? t('shell-task.pr.running') : k.state === 'skip' ? t('shell-task.pr.skipped') : dur(k.ms)}
                              {...(k.url && { actions: <IconButton icon="external" size="xs" label={t('shell-task.pr.logs', { name: k.name })} onClick={() => window.open(k.url, '_blank', 'noopener')} /> })}
                            />
                          )}
                        </For>
                      </CheckList>
                      <Show when={g().ok.length > 0 && !g().okOpen}>
                        <Button size="xs" variant="ghost" icon={open().has('passed') ? 'chevron' : 'check'} part="side.pr.fold" onClick={() => (open().has('passed') ? fold('passed') : unfold('passed'))}>
                          {open().has('passed') ? t('shell-task.pr.foldPassed', { count: g().ok.length }) : [g().passed && t('shell-task.pr.passed', { count: g().passed }), g().skipped && t('shell-task.pr.skippedN', { count: g().skipped })].filter(Boolean).join(' · ')}
                        </Button>
                      </Show>
                    </Show>
                  </Stack>
                </Show>
                <Show when={(p().reviewers ?? []).length > 0}>
                  <Stack gap="2" part="side.pr.reviews">
                    <Heading level={4}>{t('shell-task.pr.reviews')}</Heading>
                    <For each={p().reviewers}>
                      {(r) => (
                        <Inline gap="2" justify="between">
                          {who(r)}
                          <Text size="sm" tone={r.state === 'APPROVED' ? 'good' : 'warn'} nowrap>
                            {t(`shell-task.pr.review.${r.state}`)}
                          </Text>
                        </Inline>
                      )}
                    </For>
                  </Stack>
                </Show>
                <Show when={said().live.length + said().outdated.length + said().people.length + said().bots.length > 0}>
                  <Stack gap="2" part="side.pr.talk">
                    <Heading level={4}>{t('shell-task.pr.talk')}</Heading>
                    <Stack gap="3" as="ul">
                      <For each={[...said().live, ...(open().has('outdated') ? said().outdated : [])]}>
                        {(th) => (
                          <Stack gap="1" as="li" part="side.pr.thread">
                            <Text size="xs" tone="muted" mono truncate>{`${th.path}${th.line ? `:${th.line}` : ''}`}</Text>
                            {note(th.notes[0] as PrNote)}
                          </Stack>
                        )}
                      </For>
                      <For each={[...said().people, ...(open().has('bots') ? said().bots : [])]}>{(n) => note(n)}</For>
                    </Stack>
                    <Inline gap="2">
                      <Show when={said().outdated.length > 0 && !open().has('outdated')}>
                        <Button size="xs" variant="ghost" onClick={() => unfold('outdated')}>
                          {t('shell-task.pr.outdated', { count: said().outdated.length })}
                        </Button>
                      </Show>
                      <Show when={said().bots.length > 0 && !open().has('bots')}>
                        <Button size="xs" variant="ghost" onClick={() => unfold('bots')}>
                          {t('shell-task.pr.bots', { count: said().bots.length })}
                        </Button>
                      </Show>
                    </Inline>
                  </Stack>
                </Show>
                <Show when={files().shown.length > 0}>
                  <Stack gap="2" part="side.pr.files">
                    <Inline gap="2">
                      <Heading level={4}>{t('shell-task.pr.files')}</Heading>
                      <Text size="sm" tone="muted" numeric>{`+${p().additions ?? 0} −${p().deletions ?? 0}`}</Text>
                    </Inline>
                    <For each={files().shown}>
                      {(f) => (
                        <Inline gap="2" justify="between">
                          <Link href={`${p().url}/files`} external tone="ink" title={f.path}>
                            {f.path}
                          </Link>
                          <Text size="sm" tone="muted" numeric nowrap>{`+${f.additions} −${f.deletions}`}</Text>
                        </Inline>
                      )}
                    </For>
                    <Show when={files().more > 0}>
                      <Button size="xs" variant="ghost" onClick={() => unfold('files')}>
                        {t('shell-task.pr.more', { count: files().more })}
                      </Button>
                    </Show>
                  </Stack>
                </Show>
                <Inline gap="2" justify="between" part="side.pr.foot">
                  <Link href={p().url} external tone="muted">
                    {t('shell-task.pr.github')}
                  </Link>
                  <Inline gap="1">
                    <Text size="xs" tone="muted" nowrap>
                      {t('shell-task.pr.checked', { when: timeLabel(at() || Date.now(), Date.now(), t) })}
                    </Text>
                    <IconButton icon="replay" size="xs" label={t('shell-task.pr.checkNow')} onClick={() => quiet(c.run(refresh, args()))} />
                  </Inline>
                </Inline>
              </>
            );
          }}
        </Show>
      </Show>
    </Stack>
  );
}
