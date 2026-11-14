// The `actions` block (v1 R.actions): a titled list of one-click steps. A step with a command runs in the task's
// folder (BlockContext.run; `confirm` asks first, in place) and shows its exit code and output under it; a step
// with a reply sends it to the agent (and says Sent). Without a host for either, the step is plain text.
import { For, Show, createSignal, type JSX } from 'solid-js';
import { Icon } from '../content/Icon.tsx';
import { BlockTitle, InlineMd } from './content-parts.tsx';
import { useBlockT, useBlocks } from './context.tsx';
import { bool, items, opt, str } from './read.ts';
import { ExitBadge, RunOut, useRun } from './run-result.tsx';
import type { BlockProps } from './types.ts';

interface Step {
  readonly label: string;
  readonly command: string | undefined;
  readonly reply: string | undefined;
  readonly detail: string | undefined;
  readonly confirm: boolean;
}

function Row(props: { readonly step: Step; readonly index: number }): JSX.Element {
  const ctx = useBlocks();
  const t = useBlockT();
  const s = props.step;
  const runner = s.command ? useRun(() => s.command ?? '', () => s.label) : undefined;
  const [asking, setAsking] = createSignal(false);
  const [sent, setSent] = createSignal(false);
  const can = (): boolean => (s.command ? !!runner : !!ctx.reply);
  const go = (): void => {
    if (s.command) {
      if (s.confirm && !asking()) return void setAsking(true);
      setAsking(false);
      runner?.go();
    } else {
      ctx.reply?.(s.reply ?? s.label);
      setSent(true);
    }
  };
  return (
    <li data-kit="rb-act" data-part="block.actions.item" style={{ '--k': String(props.index) }} data-ok={runner?.result()?.exitCode === 0 ? '' : undefined} data-bad={runner?.result() && runner.result()?.exitCode !== 0 ? '' : undefined}>
      <div data-kit="rb-act-bar">
        <div data-kit="rb-act-info">
          <b>{s.label}</b>
          <Show when={s.command}>{(c) => <code data-kit="rb-act-cmd">$ {c()}</code>}</Show>
          <Show when={s.detail}>
            {(d) => (
              <span data-kit="rb-act-detail">
                <InlineMd source={d()} part="block.actions.detail" />
              </span>
            )}
          </Show>
        </div>
        <Show when={can()}>
          <div data-kit="rb-act-side">
            <Show when={runner?.result()}>{(r) => <ExitBadge code={r().exitCode} />}</Show>
            <Show when={asking()}>
              <button type="button" data-kit="cb-ghost-xs" onClick={() => setAsking(false)}>
                {t('block.actions.cancel')}
              </button>
            </Show>
            <button type="button" data-kit="cb-ghost-xs" data-part="block.actions.go" disabled={runner?.busy() || sent()} title={asking() ? t('block.actions.confirm') : undefined} onClick={go}>
              <Icon name={s.command ? (runner?.result() ? 'rerun' : 'play') : sent() ? 'check' : 'send'} size="sm" />
              <span>{s.command ? (runner?.busy() ? t('block.run.running') : asking() ? t('block.actions.confirmRun') : runner?.result() ? t('block.actions.again') : t('block.actions.run')) : sent() ? t('block.actions.sent') : t('block.actions.send')}</span>
            </button>
          </div>
        </Show>
      </div>
      <Show when={runner?.result()}>{(r) => <RunOut result={r()} command={s.command ?? ''} />}</Show>
    </li>
  );
}

export function ActionsBlock(props: BlockProps): JSX.Element {
  const t = useBlockT();
  const steps = (): Step[] =>
    items<Step>(
      props.block['items'],
      (o) => ({ label: str(o['label']) || opt(o['command']) || opt(o['reply']) || t('block.actions.name'), command: opt(o['command']), reply: opt(o['reply']), detail: opt(o['detail']) ?? opt(o['note']), confirm: bool(o['confirm']) }),
      (s) => ({ label: s, command: s, reply: undefined, detail: undefined, confirm: false }),
    );
  return (
    <div data-kit="rb-actions" data-card="" data-part="block.actions">
      <Show when={str(props.block['title'])}>
        <BlockTitle part="block.actions.title" title={str(props.block['title'])} icon="terminal" />
      </Show>
      <ul data-kit="rb-act-list">
        <For each={steps()}>{(s, i) => <Row step={s} index={i()} />}</For>
      </ul>
    </div>
  );
}
