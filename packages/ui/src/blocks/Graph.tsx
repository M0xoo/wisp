// The `graph` block (v1 R.graph): a PR's or merge's branches as lanes, the merge target on top with its state,
// each commit's message, branch tag and meta; conflicting commits numbered and their conflicts listed under (file,
// ours / theirs, the resolution; hovering a number lights its commit), the checks, and a foot that says where the
// merge stands with the block's one action (live on the latest answer: reply, or draft when it says so).
import { For, Show, createMemo, createSignal, type JSX } from 'solid-js';
import { Icon } from '../content/Icon.tsx';
import { Wrap } from '../layout/Stack.tsx';
import type { IconName } from '../content/icons.ts';
import { InlineMd } from './content-parts.tsx';
import { fileLine } from './content-util.ts';
import { useBlockT, useBlocks } from './context.tsx';
import { graphPicture, layoutGraph, mergeOf, sameHash, type GraphRow, type MergeState } from './graph-layout.ts';
import { bool, items, list, num, obj, oneOf, opt, str } from './read.ts';
import type { BlockProps } from './types.ts';

const STATE_ICON: Readonly<Record<Exclude<MergeState, ''>, IconName>> = {
  conflict: 'warn',
  ready: 'check',
  merged: 'branch',
  blocked: 'x',
  pending: 'clock',
};
const CHECK_ICON: Readonly<Record<string, IconName>> = {
  pass: 'check',
  fail: 'x',
  pending: 'clock',
  skip: 'skip',
};

interface Conflict {
  readonly file: string;
  readonly n: number | undefined;
  readonly commit: string;
  readonly detail: string;
  readonly ours: string;
  readonly theirs: string;
  readonly oursLabel: string;
  readonly theirsLabel: string;
  readonly resolution: string;
}
interface Check {
  readonly label: string;
  readonly status: string;
  readonly value: string;
  readonly detail: string;
}

export function GraphBlock(props: BlockProps): JSX.Element {
  const ctx = useBlocks();
  const t = useBlockT();
  const b = props.block;
  const g = layoutGraph(list(b['commits']), str(b['into']), str(b['head']));
  const conflicts = items<Conflict>(
    b['conflicts'],
    (o) => ({
      file: str(o['file']),
      n: num(o['n']),
      commit: str(o['commit']),
      detail: str(o['detail']),
      ours: str(o['ours']),
      theirs: str(o['theirs']),
      oursLabel: str(o['oursLabel']),
      theirsLabel: str(o['theirsLabel']),
      resolution: str(o['resolution']),
    }),
    (s) => ({
      file: s,
      n: undefined,
      commit: '',
      detail: '',
      ours: '',
      theirs: '',
      oursLabel: '',
      theirsLabel: '',
      resolution: '',
    }),
  );
  const nConflicts = conflicts.length || g.conflictNo.size;
  const merge = mergeOf(b['merge'], nConflicts, g.into);
  const pic = graphPicture(g, merge);
  const base = g.into || g.lanes[0] || t('block.graph.base');
  const checks = items<Check>(
    b['checks'],
    (o) => ({
      label: str(o['label']),
      status: str(o['status']) || 'pass',
      value: str(o['value']),
      detail: str(o['detail']),
    }),
    (s) => ({ label: s, status: 'pass', value: '', detail: '' }),
  );
  const [lit, setLit] = createSignal<number | undefined>();
  const [open, setOpen] = createSignal(b['expanded'] !== false);
  const numFor = (c: Conflict): number | undefined => {
    if (c.n) return c.n;
    const r = c.commit ? g.rows.find((o) => sameHash(o.c.hash, c.commit)) : undefined;
    return r ? g.conflictNo.get(r.i) : undefined;
  };
  const pr = oneOf(b['state'], ['open', 'draft', 'merged', 'closed', ''] as const, merge === 'merged' ? 'merged' : '');
  const actionObj = typeof b['action'] === 'string' ? { label: str(b['action']) } : obj(b['action']);
  const action = opt(actionObj['label']) ?? (typeof b['action'] === 'object' && b['action'] ? t('block.graph.continue') : undefined);
  const live = ctx.latest !== false;
  const act = (): void => {
    if (!live) return;
    const text = opt(actionObj['reply']) ?? action ?? '';
    if (bool(actionObj['draft'])) ctx.draft?.(text);
    else ctx.reply?.(text);
  };
  const stateNote = (): string =>
    opt(b['note']) ??
    (merge === 'conflict'
      ? t(nConflicts === 1 ? 'block.graph.conflict' : 'block.graph.conflicts', {
          n: nConflicts,
        })
      : merge
        ? t(`block.graph.state.${merge}`)
        : '');
  const tagOf = (r: GraphRow): string | undefined => (g.tips.has(r.i) ? g.lanes[r.lane] || undefined : undefined);
  const toneOf = createMemo(() => new Map(pic.dots.map((d) => [d.i, d.tone])));
  return (
    <div data-kit="rb-graph" data-card="" data-part="block.graph">
      <Show when={opt(b['title']) || opt(b['ref']) || pr}>
        <div data-kit="rb-g-head">
          <h3>
            <InlineMd source={str(b['title'])} part="block.graph.title" />
            {' '}
            <Show when={opt(b['ref'])}>{(r) => <span data-kit="rb-g-ref">{r()}</span>}</Show>
          </h3>
          <Show when={pr}>
            <span data-kit="rb-g-pr" data-state={pr}>
              <i />
              {t(`block.graph.pr.${pr as 'open'}`)}
            </span>
          </Show>
        </div>
      </Show>
      <div data-kit="rb-g-body" style={{ '--k-g-w': `${pic.width}px` }}>
        <svg data-kit="rb-g-svg" width={pic.width} height={pic.height} viewBox={`0 0 ${pic.width} ${pic.height}`} aria-hidden="true">
          <For each={pic.wires}>{(w) => <path data-kit="rb-g-wire" data-kind={w.kind} data-tone={w.tone} d={w.d} pathLength={w.kind === 'tail' ? undefined : 1} style={{ '--k': String(w.k) }} />}</For>
          <For each={pic.dots}>{(d) => <circle data-kit="rb-g-dot" data-kind={d.kind} data-tone={d.tone} cx={d.x} cy={d.y} r={d.kind === 'merge' ? 4.5 : 4} style={{ '--k': String(d.row) }} />}</For>
          <Show when={pic.target}>
            {(tg) => (
              <g data-kit="rb-g-target" data-state={merge} transform={`translate(${tg().x} ${tg().y})`}>
                <circle r="7.5" />
                <Show when={merge === 'conflict'}>
                  <path d="M0 -3.6V0.6M0 3V3.2" />
                </Show>
                <Show when={merge === 'ready'}>
                  <path d="M-3 0.2L-0.9 2.3L3.2 -2" />
                </Show>
                <Show when={merge === 'blocked'}>
                  <path d="M-2.6 -2.6L2.6 2.6M2.6 -2.6L-2.6 2.6" />
                </Show>
              </g>
            )}
          </Show>
        </svg>
        <ol data-kit="rb-g-rows">
          <Show when={g.into}>
            <li data-kit="rb-g-row" data-target="" data-state={merge}>
              <span data-kit="rb-g-msg">{t(merge === 'merged' ? 'block.graph.mergedInto' : 'block.graph.mergeInto', { into: g.into })}</span>
              <span data-kit="rb-g-state">{stateNote()}</span>
            </li>
          </Show>
          <For each={g.rows}>
            {(r) => {
              const n = g.conflictNo.get(r.i);
              return (
                <li
                  data-kit="rb-g-row"
                  data-tone={r.c.conflict ? 'conflict' : r.lane === g.head ? 'head' : 'other'}
                  data-lit={n !== undefined && lit() === n ? '' : undefined}
                  title={r.c.note || undefined}
                  onMouseEnter={() => n !== undefined && setLit(n)}
                  onMouseLeave={() => setLit(undefined)}
                >
                  <span data-kit="rb-g-msg">
                    <InlineMd source={r.c.message || r.c.hash} part="block.graph.message" />
                  </span>
                  <Show when={tagOf(r)}>
                    {(tag) => (
                      <span data-kit="rb-g-tag" data-tone={toneOf().get(r.i)}>
                        {tag()}
                      </span>
                    )}
                  </Show>
                  <Show when={n}>{(k) => <span data-kit="rb-g-num">{k()}</span>}</Show>
                  <span data-kit="rb-g-meta">
                    <Show when={r.c.hash}>
                      <code>{r.c.hash.slice(0, 7)}</code>
                    </Show>{' '}
                    {[r.c.author, r.c.when].filter(Boolean).join(' · ')}
                  </span>
                </li>
              );
            }}
          </For>
        </ol>
      </div>
      <Show when={checks.length > 0}>
        <div data-kit="rb-g-checks">
          <Wrap gap="3" part="block.graph.checks">
            <For each={checks}>
              {(c) => (
                <span data-kit="rb-g-check" data-state={c.status} title={c.detail || undefined}>
                  <Icon name={CHECK_ICON[c.status] ?? 'check'} size="sm" />
                  <b>{c.label}</b>
                  <Show when={c.value}>
                    <span>{c.value}</span>
                  </Show>
                </span>
              )}
            </For>
          </Wrap>
        </div>
      </Show>
      <Show when={conflicts.length > 0 && open()}>
        <ol data-kit="rb-g-conflicts">
          <For each={conflicts}>
            {(c, i) => {
              const n = numFor(c);
              const loc = c.file ? fileLine(c.file) : undefined;
              return (
                <li data-lit={n !== undefined && lit() === n ? '' : undefined} onMouseEnter={() => n !== undefined && setLit(n)} onMouseLeave={() => setLit(undefined)}>
                  <Wrap gap="4" align="baseline" part="block.graph.conflict">
                    <span data-kit="rb-g-num" data-plain={n ? undefined : ''}>
                      {n ?? i() + 1}
                    </span>
                    <Show when={loc}>
                      {(l) => (
                        <button type="button" data-kit="cb-link-mono" disabled={!ctx.openFile} onClick={() => ctx.openFile?.(l().path, l().line)}>
                          {c.file}
                        </button>
                      )}
                    </Show>
                    <Show when={c.detail}>
                      <span data-kit="rb-g-c-detail">
                        <InlineMd source={c.detail} part="block.graph.detail" />
                      </span>
                    </Show>
                  </Wrap>
                  <Show when={c.ours || c.theirs}>
                    <div data-kit="rb-g-sides">
                      <Show when={c.ours}>
                        <div data-kit="rb-g-side" data-side="ours">
                          <span>{c.oursLabel || g.lanes[g.head] || t('block.graph.ours')}</span>
                          <code>{c.ours}</code>
                        </div>
                      </Show>
                      <Show when={c.theirs}>
                        <div data-kit="rb-g-side" data-side="theirs">
                          <span>{c.theirsLabel || g.into || g.lanes[0] || t('block.graph.theirs')}</span>
                          <code>{c.theirs}</code>
                        </div>
                      </Show>
                    </div>
                  </Show>
                  <Show when={c.resolution}>
                    <div data-kit="rb-g-res">
                      <Icon name="check" size="sm" />
                      <span>
                        <InlineMd source={c.resolution} part="block.graph.resolution" />
                      </span>
                    </div>
                  </Show>
                </li>
              );
            }}
          </For>
        </ol>
      </Show>
      <Show when={merge || opt(b['summary']) || action}>
        <div data-kit="rb-g-foot" data-state={merge}>
          <Show when={merge}>{(m) => <Icon name={STATE_ICON[m() as Exclude<MergeState, ''>]} size="sm" />}</Show>
          <span data-kit="rb-g-foot-text">
            <Show
              when={opt(b['summary'])}
              fallback={
                <Show
                  when={merge === 'conflict'}
                  fallback={
                    merge === 'ready'
                      ? t('block.graph.ready')
                      : merge === 'merged'
                        ? t('block.graph.mergedInto', { into: base })
                        : merge === 'blocked'
                          ? t('block.graph.blocked')
                          : merge === 'pending'
                            ? t('block.graph.pending')
                            : ''
                  }
                >
                  <button type="button" data-kit="rb-g-count" disabled={conflicts.length === 0} onClick={() => setOpen(!open())}>
                    {t(nConflicts === 1 ? 'block.graph.conflict' : 'block.graph.conflicts', { n: nConflicts })}
                  </button>{' '}
                  {t('block.graph.with', { base })}
                </Show>
              }
            >
              {(s) => <InlineMd source={s()} part="block.graph.summary" />}
            </Show>
          </span>
          <Show when={action && (ctx.reply || ctx.draft)}>
            <button type="button" data-kit="rb-btn" data-primary="" disabled={!live} onClick={act}>
              {action}
            </button>
          </Show>
        </div>
      </Show>
    </div>
  );
}
