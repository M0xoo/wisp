// What a face's card beside the rail says (v1 crew.js paintCard), on `shell.rail:card` with the member's id: who it
// is and what it's up to (the same status line as its row), then the jobs it's on, most urgent first, 6 at most, each
// opening its task; the head (and "All N in the thread") opens its thread. While the card is up the rows hold their
// order and take updates in place (holdRows): a job that left gives its place to a newcomer, or stays, gone, until the
// card closes. Nothing is rebuilt and nothing moves under the pointer. The rail draws the card and owns its behaviour.
import { createMemo, createSignal, Show, type JSX } from 'solid-js';
import type { ExtensionProps } from '@wisp/shell/contract';
import { useShell } from '@wisp/shell';
import { RailCardBody, englishT, timeLabel, useSignal, type RailCardRow } from '@wisp/ui';
import { crewData, emptyState } from './data.ts';
import { t } from './i18n.ts';
import { jobSide, statusLine } from './model.ts';
import { CARD_ROWS, cardJobs, holdRows, jobMark } from './rules/jobs.ts';
import type { SessionRow } from './types.ts';

export default function RailCard(props: ExtensionProps): JSX.Element {
  const c = props.client;
  const shell = useShell();
  const say = t as (k: string, v?: Readonly<Record<string, string | number>>) => string;
  const data = crewData(c);
  const members = useSignal(data.members);
  const states = useSignal(data.states);
  const nav = useSignal(shell.nav);
  const now = (): number => c.scope.timers.now();
  const ago = (at: number): string => timeLabel(at, now(), englishT);
  const id = (): string => props.id ?? '';
  const member = createMemo(() => members().find((m) => m.id === id()));
  const st = createMemo(() => states().get(id()) ?? emptyState(!!member()?.paused));
  // the rows while the card is up: each keeps its place, whatever its job does (v1 holdRows)
  const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
  const [held, setHeld] = createSignal<readonly string[]>([], { equals: same });
  const byId = createMemo(() => new Map<string, SessionRow>([...st().jobs, ...st().sent].map((s) => [s.id, s])));
  const rows = createMemo((): RailCardRow[] => {
    const jobs = cardJobs(st());
    const ids = holdRows(held(), jobs.map((s) => s.id), (x) => !byId().has(x));
    queueMicrotask(() => setHeld(ids));
    const open = nav().main.kind === 'task' ? String((nav().main as { id?: unknown }).id) : '';
    return ids.map((x) => {
      const s = byId().get(x);
      if (!s) return { id: x, title: '', mark: '', side: t('wisp.crew.card.gone'), disabled: true };
      return { id: x, title: s.title, mark: jobMark(s) as RailCardRow['mark'], side: jobSide(s, say as never, ago), disabled: !!s.pending, on: open !== '' && (open === x || open.endsWith(`:${x}`)) };
    });
  });
  const openThread = (): void => shell.navigate({ t: 'openCrew', id: id() as never });
  const openJob = (x: string): void => {
    const key = data.sessionKey(x);
    if (key) shell.navigate({ t: 'openTask', id: key as never });
  };
  const line = createMemo(() => {
    const m = member();
    return m ? statusLine(m, st(), { t: say as never, now: now(), when: ago }) : { tone: '' as const, text: '' };
  });
  return (
    <Show when={member()}>
      {(m) => (
        <RailCardBody
          name={m().name}
          role={m().role}
          line={{ text: line().text, ...(line().tone && { tone: line().tone || undefined }) }}
          headTitle={say('wisp.crew.card.open', { name: m().name })}
          rows={rows()}
          none={m().nextAt && !m().paused ? say('wisp.crew.card.next', { when: ago(m().nextAt as number) }) : t('wisp.crew.card.nothing')}
          more={cardJobs(st()).length > CARD_ROWS ? say('wisp.crew.card.all', { count: st().jobs.length + st().sent.length }) : undefined}
          onHead={openThread}
          onRow={openJob}
        />
      )}
    </Show>
  );
}
