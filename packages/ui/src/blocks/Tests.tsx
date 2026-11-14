// The `tests` block (v1 R.tests): a ring of passed / failed / skipped, the verdict (All green, N failing), the
// counts and how long it took, the command with Re-run when the host can run it, Run by wisp when wisp ran it,
// and each failure with its message and its file (opens in the side panel through BlockContext.openFile).
import { For, Show, type JSX } from 'solid-js';
import { Icon } from '../content/Icon.tsx';
import { Wrap } from '../layout/Stack.tsx';
import { useCountUp } from './content-count.ts';
import { fileLine, fmtDuration } from './content-util.ts';
import { useBlockT, useBlocks } from './context.tsx';
import { items, num, opt, str } from './read.ts';
import { RunOut, useRun } from './run-result.tsx';
import type { BlockProps } from './types.ts';

const C = 2 * Math.PI * 34;
interface Failure {
  readonly name: string;
  readonly message: string | undefined;
  readonly file: string | undefined;
}

function Count(props: { readonly n: number; readonly kind: 'pass' | 'fail' | 'skip'; readonly label: string; readonly delay: number }): JSX.Element {
  const ctx = useBlocks();
  const shown = useCountUp(() => props.n, {
    animate: ctx.reveal !== false,
    delay: props.delay,
  });
  return (
    <span data-kit="cb-tests-count" data-kind={props.kind}>
      <b>{shown() ?? props.n}</b> {props.label}
    </span>
  );
}

export function TestsBlock(props: BlockProps): JSX.Element {
  const ctx = useBlocks();
  const t = useBlockT();
  const n = (k: string): number => Math.max(0, Math.floor(num(props.block[k]) ?? 0));
  const passed = (): number => n('passed');
  const failed = (): number => n('failed');
  const skipped = (): number => n('skipped');
  const total = (): number => passed() + failed() + skipped() || 1;
  const ok = (): boolean => failed() === 0;
  const seg = (count: number, before: number): { 'stroke-dasharray': string; 'stroke-dashoffset': string } => ({
    'stroke-dasharray': `${(count / total()) * C} ${C}`,
    'stroke-dashoffset': String(-((before / total()) * C)),
  });
  const cmd = (): string => str(props.block['command']).trim();
  const runner = useRun(cmd);
  const failures = (): Failure[] =>
    items<Failure>(
      props.block['failures'],
      (o) => ({
        name: str(o['name']),
        message: opt(o['message']),
        file: opt(o['file']),
      }),
      (s) => ({ name: s, message: undefined, file: undefined }),
    );
  return (
    <div data-kit="cb-tests" data-part="block.tests" data-ok={ok() ? '' : undefined}>
      <div data-kit="cb-tests-main">
        <svg data-kit="cb-tests-ring" viewBox="0 0 80 80" aria-hidden="true">
          <circle cx="40" cy="40" r="34" data-seg="track" />
          <circle cx="40" cy="40" r="34" data-seg="pass" {...seg(passed(), 0)} />
          <circle cx="40" cy="40" r="34" data-seg="fail" {...seg(failed(), passed())} />
          <circle cx="40" cy="40" r="34" data-seg="skip" {...seg(skipped(), passed() + failed())} />
        </svg>
        <span data-kit="cb-tests-mark" aria-hidden="true">
          <Icon name={ok() ? 'check' : 'x'} size="lg" />
        </span>
        <div data-kit="cb-tests-text">
          <div data-kit="cb-tests-verdict">
            {ok() ? t('block.tests.green') : t('block.tests.failing', { n: failed() })}
            <Show when={str(props.block['by']) === 'wisp'}>
              <span data-kit="cb-tests-by" title={t('block.tests.byWispWhy')}>
                {t('block.tests.byWisp')}
              </span>
            </Show>
          </div>
          <div data-kit="cb-tests-counts">
            <Wrap gap="6" align="center" part="block.tests.counts">
              <Count n={passed()} kind="pass" label={t('block.tests.passed')} delay={300} />
              <Show when={failed() > 0}>
                <Count n={failed()} kind="fail" label={t('block.tests.failed')} delay={400} />
              </Show>
              <Show when={skipped() > 0}>
                <Count n={skipped()} kind="skip" label={t('block.tests.skipped')} delay={500} />
              </Show>
              <Show when={fmtDuration(num(props.block['durationMs']))}>{(d) => <span data-kit="cb-tests-count">{d()}</span>}</Show>
            </Wrap>
          </div>
          <Show when={cmd()}>
            <div data-kit="cb-tests-cmd">
              <Wrap gap="4" align="center" part="block.tests.command">
                <code>$ {cmd()}</code>
                <Show when={runner}>
                  <button type="button" data-kit="cb-ghost-xs" title={t('block.tests.rerunWhat', { command: cmd() })} disabled={runner?.busy()} onClick={() => runner?.go()}>
                    <Icon name="rerun" size="sm" />
                    <span>{runner?.busy() ? t('block.run.running') : t('block.tests.rerun')}</span>
                  </button>
                </Show>
              </Wrap>
            </div>
          </Show>
        </div>
      </div>
      <Show when={runner?.result()}>{(r) => <RunOut result={r()} command={cmd()} />}</Show>
      <Show when={failures().length > 0}>
        <ul data-kit="cb-tests-failures">
          <For each={failures()}>
            {(f) => (
              <li>
                <Icon name="x" size="sm" />
                <div>
                  <b>{f.name}</b>
                  <Show when={f.message}>{(m) => <pre>{m()}</pre>}</Show>
                  <Show when={f.file}>
                    {(file) => (
                      <button type="button" data-kit="cb-link-mono" disabled={!ctx.openFile} onClick={() => ctx.openFile?.(fileLine(file()).path, fileLine(file()).line)}>
                        {file()}
                      </button>
                    )}
                  </Show>
                </div>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}
