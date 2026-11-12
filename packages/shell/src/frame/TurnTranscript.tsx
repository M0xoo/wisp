// A finished turn's full transcript (v1 features/transcript.js renderTranscript), drawn with the kit's Timeline:
// the head ("Transcript · 1 message · 4 steps"), each step on the rail (an edit with its +/−, a command that isn't
// already its label, what it printed or the error in full behind a chevron), the agent's messages as prose, and
// where the turn ended. The answer follows it (TaskView).
import { For, createSignal, type JSX } from 'solid-js';
import { Icon, Markdown, Text, Timeline, TimelineEnd, TimelineMessage, TimelineStep, type IconName } from '@wisp/ui';
import type { ShellContext } from '../contract.ts';
import { changeFigures } from './rows-view.ts';

const ICON: Readonly<Record<string, IconName>> = { read: 'read', edit: 'pen', run: 'terminal', error: 'warn', text: 'text', tool: 'tool', search: 'search' };

export interface TranscriptStepRow {
  readonly kind: string;
  readonly label?: string;
  readonly detail?: string;
  readonly out?: string;
  readonly bad?: boolean;
  readonly file?: string;
}

type Change = Parameters<typeof changeFigures>[0][number];

function Step(props: { readonly a: TranscriptStepRow; readonly changes: readonly Change[]; readonly here: (s: string) => string }): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const a = props.a;
  const change = props.changes.find((c) => (c as { file?: string }).file === a.file);
  const nums = a.kind === 'edit' && change ? changeFigures([change]) : undefined;
  const command = a.kind === 'run' && a.detail && !(a.label ?? '').includes(a.detail.slice(0, 24)) ? props.here(a.detail) : undefined;
  const more = a.out ?? (a.kind === 'error' ? a.label : undefined);
  return (
    <TimelineStep
      icon={ICON[a.kind] ?? 'tool'}
      label={props.here(a.label ?? a.kind)}
      kind={a.kind}
      {...(command !== undefined && { command })}
      {...(nums && { nums: { add: nums.plus, del: nums.minus } })}
      {...(a.bad || a.kind === 'error' ? { tone: 'bad' as const } : {})}
      {...(more !== undefined && { expanded: open(), onToggle: () => setOpen(!open()), detail: () => <pre>{props.here(more)}</pre> })}
    />
  );
}

export function TurnTranscript(props: {
  readonly steps: readonly TranscriptStepRow[];
  readonly changes: readonly Change[];
  readonly here: (s: string) => string;
  readonly status: string;
  readonly t: ShellContext['t'];
}): JSX.Element {
  const t = props.t;
  const msgs = (): number => props.steps.filter((a) => a.kind === 'text').length;
  const steps = (): number => props.steps.length - msgs();
  const count = (): string =>
    [msgs() ? t(msgs() === 1 ? 'shell.task.messages.one' : 'shell.task.messages.other', { n: msgs() }) : '', steps() ? t(steps() === 1 ? 'shell.task.steps.one' : 'shell.task.steps.other', { n: steps() }) : '']
      .filter(Boolean)
      .join(' · ');
  return (
    <Timeline
      part="turn.transcript"
      head={
        <>
          <Icon name="transcript" size="sm" />
          <Text size="sm" weight="medium" tone="muted">
            {t('shell.task.transcript')}
          </Text>
          <Text size="sm" tone="faint" truncate>{`· ${count()}`}</Text>
        </>
      }
    >
      <For each={props.steps}>
        {(a) =>
          a.kind === 'text' ? (
            <TimelineMessage>
              <Markdown source={props.here(a.label ?? '')} />
            </TimelineMessage>
          ) : (
            <Step a={a} changes={props.changes} here={props.here} />
          )
        }
      </For>
      <TimelineEnd icon={props.status === 'error' ? 'warn' : 'done'} label={t(props.status === 'error' ? 'shell.task.endedError' : 'shell.task.finished')} tone={props.status === 'error' ? 'bad' : 'good'} />
    </Timeline>
  );
}
