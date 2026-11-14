// The `terminal` block (v1 R.terminal): a command and its output on the dark screen, the folder as its title,
// its exit code, and Run to run it again in the task's folder when the host can (BlockContext.run). A long
// output shows its end with the earlier lines behind one line. Output alone (a failure's reason) has no prompt.
import { Show, createSignal, type JSX } from 'solid-js';
import { Icon } from '../content/Icon.tsx';
import { cleanOutput, tailLines } from './content-util.ts';
import { useBlockT } from './context.tsx';
import { ExitBadge, useRun } from './run-result.tsx';
import { num, str } from './read.ts';
import type { BlockProps } from './types.ts';

const KEEP = 200;

export function TerminalBlock(props: BlockProps): JSX.Element {
  const t = useBlockT();
  const [all, setAll] = createSignal(false);
  const cmd = (): string => str(props.block['command']).trim();
  const runner = useRun(cmd, () => str(props.block['title']) || undefined);
  // a run from here replaces what the agent showed (v1 actionRuns)
  const exit = (): number | undefined => runner?.result()?.exitCode ?? num(props.block['exitCode']);
  const out = (): { text: string; hidden: number } => {
    const o = cleanOutput(runner?.result()?.output ?? str(props.block['output']));
    return all() ? { text: o, hidden: 0 } : tailLines(o, KEEP);
  };
  return (
    <div data-kit="cb-term" data-part="block.terminal">
      <div data-kit="cb-term-head">
        <span data-kit="cb-term-lights" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span data-kit="cb-term-title">{str(props.block['title']) || t('block.terminal.title')}</span>
        <Show when={exit() !== undefined}>
          <ExitBadge code={exit() ?? 0} />
        </Show>
        <Show when={cmd() && runner}>
          {(_) => (
            <button type="button" data-kit="cb-term-run" title={t('block.terminal.runAgain')} disabled={runner?.busy()} onClick={() => runner?.go()}>
              <Icon name="rerun" size="sm" />
              <span>{runner?.busy() ? t('block.run.running') : t('block.terminal.run')}</span>
            </button>
          )}
        </Show>
      </div>
      <pre data-kit="cb-term-body" tabIndex={0}>
        <Show when={out().hidden > 0}>
          <button type="button" data-kit="cb-term-earlier" onClick={() => setAll(true)}>
            {t('block.terminal.earlier', { n: out().hidden })}
          </button>
          {'\n'}
        </Show>
        <Show when={cmd()}>
          <span data-kit="cb-term-cmd">
            <span data-kit="cb-term-ps">$</span> {cmd()}
          </span>
          {'\n'}
        </Show>
        <span data-kit="cb-term-out">{out().text}</span>
      </pre>
    </div>
  );
}
