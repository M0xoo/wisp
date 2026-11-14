// A command run from an answer (terminal, tests, actions): the button's pending state at once, then the host's
// result under the block (exit code, how long, the output), with Send failure to agent when it failed.
import { Show, createSignal, type Accessor, type JSX } from 'solid-js';
import { Icon } from '../content/Icon.tsx';
import { cleanOutput, fmtDuration } from './content-util.ts';
import { useBlockT, useBlocks } from './context.tsx';
import type { RunResult } from './types.ts';

export interface Runner {
  readonly busy: Accessor<boolean>;
  readonly result: Accessor<RunResult | undefined>;
  readonly go: () => void;
}

/** Runs `command` through the host; undefined when the host can't run commands. */
export function useRun(command: () => string, label?: () => string | undefined): Runner | undefined {
  const ctx = useBlocks();
  const [busy, setBusy] = createSignal(false);
  const [result, setResult] = createSignal<RunResult | undefined>();
  if (!ctx.run) return undefined;
  const run = ctx.run;
  return {
    busy,
    result,
    go: () => {
      if (busy() || !command()) return;
      setBusy(true);
      Promise.resolve(run(command(), label?.()))
        .then((r) => r && setResult(r), () => undefined)
        .finally(() => setBusy(false));
    },
  };
}

export function ExitBadge(props: { readonly code: number }): JSX.Element {
  const t = useBlockT();
  return (
    <span data-kit="cb-exit" data-ok={props.code === 0 ? '' : undefined} data-bad={props.code === 0 ? undefined : ''}>
      {t('block.terminal.exit', { code: props.code })}
    </span>
  );
}

/** The output of a run, on the dark screen; failed and the host takes replies: Send failure to agent. */
export function RunOut(props: { readonly result: RunResult; readonly command: string }): JSX.Element {
  const ctx = useBlocks();
  const t = useBlockT();
  const ok = (): boolean => props.result.exitCode === 0;
  return (
    <div data-kit="cb-run-out" data-part="block.run" data-ok={ok() ? '' : undefined}>
      <div data-kit="cb-run-bar">
        <ExitBadge code={props.result.exitCode} />
        <Show when={fmtDuration(props.result.durationMs)}>{(d) => <span data-kit="cb-run-dur">{d()}</span>}</Show>
      </div>
      <pre data-kit="cb-run-text">{cleanOutput(props.result.output) || t('block.run.empty')}</pre>
      <Show when={!ok() && ctx.reply}>
        <button
          type="button"
          data-kit="cb-ghost-xs"
          onClick={() => ctx.reply?.(`Command \`${props.command}\` failed (exit ${props.result.exitCode}):\n\`\`\`\n${cleanOutput(props.result.output).slice(0, 1600)}\n\`\`\``)}
        >
          <Icon name="send" size="sm" />
          <span>{t('block.run.sendFailure')}</span>
        </button>
      </Show>
    </div>
  );
}
