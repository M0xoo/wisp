// A finished turn's full transcript (v1 features/transcript.js renderTranscript), drawn with the kit's Timeline:
// the head ("Transcript · 1 message · 4 steps"), each step on the rail (an edit with its +/−, a command that isn't
// already its label, what it printed or the error in full behind a chevron), the agent's messages as prose, and
// where the turn ended. The answer follows it (TaskView). What a step printed of a .env file (`cat .env`) reads
// KEY=•••• under v1's Reveal line (env-reveal.ts keeps what's shown, per task).
import { For, Show, createSignal, type JSX } from 'solid-js';
import { EnvMask, Icon, Markdown, Text, Timeline, TimelineEnd, TimelineMessage, TimelineStep, DOTS, envFileNamed, envName, maskText, readsEnvFile, type EnvReveal, type IconName } from '@wisp/ui';
import type { ShellContext } from '../contract.ts';
import { changeFigures } from './rows-view.ts';

const ICON: Readonly<Record<string, IconName>> = { read: 'read', edit: 'pen', run: 'terminal', error: 'warn', text: 'text', tool: 'tool', search: 'search' };

export interface TranscriptStepRow {
  readonly kind: string;
  readonly label?: string;
  /** the whole title when the label was cut (v1 #780): what the opened step shows */
  readonly title?: string;
  readonly detail?: string;
  readonly out?: string;
  readonly bad?: boolean;
  readonly file?: string;
  /** the event (its per-session seq) that carried `out`: what Reveal asks the server for */
  readonly seq?: number;
}

type Change = Parameters<typeof changeFigures>[0][number];

/** What a step's opened detail shows of its output: masked when it read a .env file and isn't revealed. The server
 *  sends it masked already (ADR-0050): shown, it is what Reveal brought back (`raw`), the masked text until then;
 *  masking here again is the second layer for an older server's step. */
export function stepOutput(a: TranscriptStepRow, maskOn: boolean, shown: boolean, raw?: string): { readonly text: string; readonly env: boolean } | undefined {
  if (a.out === undefined) return undefined;
  const masked = maskText(a.out);
  const env = maskOn && readsEnvFile(a) && (masked !== a.out || a.out.includes(DOTS));
  if (!env) return { text: a.out, env };
  // shown: the server's copy; until it comes, the masked text (an older server's step is its own copy already)
  return { text: shown ? (raw ?? (a.out.includes(DOTS) ? masked : a.out)) : masked, env };
}

function Step(props: {
  readonly a: TranscriptStepRow;
  readonly index: number;
  readonly changes: readonly Change[];
  readonly here: (s: string) => string;
  readonly env: EnvReveal | undefined;
  readonly t: ShellContext['t'];
}): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const a = props.a;
  // the step's event names it to the server; an older row without one is its place in the list (no Reveal to ask)
  const id = a.seq !== undefined ? `step:${a.seq}` : `index:${props.index}`;
  const shown = (): boolean => props.env?.shown(id) ?? false;
  const rawOut = (): string | undefined => {
    const r = props.env?.raw?.(id);
    const v = r?.['output'] ?? r?.['text'];
    return typeof v === 'string' ? v : undefined;
  };
  const out = () => stepOutput(a, props.env?.on() ?? true, shown(), rawOut());
  const t = props.t;
  const change = props.changes.find((c) => (c as { file?: string }).file === a.file);
  const nums = a.kind === 'edit' && change ? changeFigures([change]) : undefined;
  const command = a.kind === 'run' && a.detail && !(a.label ?? '').includes(a.detail.slice(0, 24)) ? props.here(a.detail) : undefined;
  const more = a.out ?? (a.kind === 'error' ? a.label : undefined);
  // a step whose label was cut opens to its whole title (v1 #779/#780), with its output when it has one
  const opens = more !== undefined || a.title !== undefined;
  return (
    <TimelineStep
      icon={ICON[a.kind] ?? 'tool'}
      label={props.here(open() && a.title ? a.title : (a.label ?? a.kind))}
      kind={a.kind}
      {...(command !== undefined && { command })}
      {...(nums && { nums: { add: nums.plus, del: nums.minus } })}
      {...(a.bad || a.kind === 'error' ? { tone: 'bad' as const } : {})}
      {...(opens && {
        expanded: open(),
        onToggle: () => setOpen(!open()),
        detail: () =>
          more === undefined ? null : (
            <>
              <Show when={out()?.env}>
                <EnvMask
                  part="turn.transcript.envMask"
                  shown={shown()}
                  what={t(shown() ? 'shell.env.shown' : 'shell.env.hidden', { name: envName(a.file || envFileNamed(a.detail) || envFileNamed(a.label)) })}
                  action={t(shown() ? 'shell.env.hide' : 'shell.env.reveal')}
                  onToggle={(on) => props.env?.set(id, on)}
                />
              </Show>
              <pre>{props.here(out()?.text ?? more)}</pre>
            </>
          ),
      })}
    />
  );
}

export function TurnTranscript(props: {
  readonly steps: readonly TranscriptStepRow[];
  /** masked .env output shown (Reveal), per task; without it the output stays masked */
  readonly env?: EnvReveal;
  readonly changes: readonly Change[];
  readonly here: (s: string) => string;
  readonly status: string;
  readonly t: ShellContext['t'];
}): JSX.Element {
  const t = props.t;
  const msgs = (): number => props.steps.filter((a) => a.kind === 'text').length;
  const steps = (): number => props.steps.length - msgs();
  const count = (): string =>
    [
      msgs() ? t(msgs() === 1 ? 'shell.task.messages.one' : 'shell.task.messages.other', { n: msgs() }) : '',
      steps() ? t(steps() === 1 ? 'shell.task.steps.one' : 'shell.task.steps.other', { n: steps() }) : '',
    ]
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
        {(a, i) =>
          a.kind === 'text' ? (
            <TimelineMessage>
              <Markdown source={props.here(a.label ?? '')} />
            </TimelineMessage>
          ) : (
            <Step a={a} index={i()} changes={props.changes} here={props.here} env={props.env} t={t} />
          )
        }
      </For>
      <TimelineEnd
        icon={props.status === 'error' ? 'warn' : 'done'}
        label={t(props.status === 'error' ? 'shell.task.endedError' : 'shell.task.finished')}
        tone={props.status === 'error' ? 'bad' : 'good'}
      />
    </Timeline>
  );
}
