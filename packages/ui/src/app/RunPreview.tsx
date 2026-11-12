// The side panel's Preview (v1 features/run.js, .pn-run): the task's app, run from its folder and shown here. Three
// states, each in its final shape at once:
//   idle     what it does, the command (a box of several lines when it has them) and Run
//   live     a slim bar (the dot, the address, Logs, Restart, Stop, Open in browser), then the app in a frame; until
//            it says where it listens, its output in the frame's place
//   ended    how it ended, its last lines, the command again and Run again
// The caller draws the output (a Terminal) and passes it as `logs`.
import { Show, type JSX } from 'solid-js';
import { flag, type KitProps } from '../core/props.ts';
import { Icon } from '../content/Icon.tsx';

export interface RunPreviewLabels {
  readonly intro: string;
  readonly command: string;
  readonly run: string;
  readonly starting: string;
  readonly logs: string;
  readonly restart: string;
  readonly stop: string;
  readonly open: string;
  readonly frame: string;
}

export interface RunPreviewProps extends KitProps {
  readonly state: 'idle' | 'live' | 'ended';
  readonly command: string;
  readonly placeholder: string;
  /** where the command came from ("From .wisp/worktree.json", "package.json's dev script") */
  readonly said?: string | undefined;
  readonly onCommand: (v: string) => void;
  readonly onRun: () => void;
  /** live: where it listens, once it said so */
  readonly url?: string | undefined;
  readonly showLogs: boolean;
  readonly onLogs: () => void;
  readonly onRestart: () => void;
  readonly onStop: () => void;
  readonly onOpen: () => void;
  /** ended: "Exited with code 1" */
  readonly ended?: string | undefined;
  readonly logs: JSX.Element;
  readonly labels: RunPreviewLabels;
}

export function RunPreview(props: RunPreviewProps): JSX.Element {
  const many = (): boolean => props.command.includes('\n');
  const box = (): JSX.Element => (
    <div data-kit="rn-form">
      <label data-kit="rn-lbl" for="rn-cmd">
        {props.labels.command}
      </label>
      <div data-kit="rn-row">
        <Show
          when={many()}
          fallback={
            <input
              id="rn-cmd"
              data-kit="input"
              data-mono=""
              value={props.command}
              placeholder={props.placeholder}
              spellcheck={false}
              autocomplete="off"
              onInput={(e) => props.onCommand(e.currentTarget.value)}
              onKeyDown={(e) => e.key === 'Enter' && !e.isComposing && (e.preventDefault(), props.onRun())}
            />
          }
        >
          <textarea
            id="rn-cmd"
            data-kit="textarea"
            data-mono=""
            rows={Math.max(2, Math.min(6, props.command.split('\n').length))}
            value={props.command}
            spellcheck={false}
            onInput={(e) => props.onCommand(e.currentTarget.value)}
          />
        </Show>
        <button type="button" data-kit="button" data-variant="primary" data-size="sm" onClick={() => props.onRun()}>
          <span data-kit="button-content">
            <Icon name="play" size="sm" />
            <span data-kit="button-label">{props.labels.run}</span>
          </span>
        </button>
      </div>
      <Show when={props.said}>
        <p data-kit="rn-said">{props.said}</p>
      </Show>
    </div>
  );
  return (
    <section id={props.id} data-kit="run-preview" data-part={props.part ?? 'panel.preview'} data-state={props.state}>
      <Show when={props.state === 'live'}>
        <div data-kit="rn-bar" role="group" aria-label={props.labels.frame}>
          <i data-kit="rn-dot" data-on={flag(props.url !== undefined)} />
          <span data-kit="rn-state">{props.url ?? props.labels.starting}</span>
          <button type="button" data-kit="rn-act" aria-pressed={props.showLogs} title={props.labels.logs} onClick={() => props.onLogs()}>
            <Icon name="terminal" size="sm" />
            <span>{props.labels.logs}</span>
          </button>
          <button type="button" data-kit="rn-icon" title={props.labels.restart} aria-label={props.labels.restart} onClick={() => props.onRestart()}>
            <Icon name="replay" size="sm" />
          </button>
          <button type="button" data-kit="rn-icon" data-stop="" title={props.labels.stop} aria-label={props.labels.stop} onClick={() => props.onStop()}>
            <Icon name="stop" size="sm" />
          </button>
          <Show when={props.url}>
            <button type="button" data-kit="rn-icon" title={props.labels.open} aria-label={props.labels.open} onClick={() => props.onOpen()}>
              <Icon name="external" size="sm" />
            </button>
          </Show>
        </div>
        <div data-kit="rn-body">
          <Show when={props.url}>{(u) => <iframe data-kit="rn-frame" src={u()} title={props.labels.frame} />}</Show>
          <div data-kit="rn-log" data-full={flag(props.url === undefined)} hidden={props.url !== undefined && !props.showLogs}>
            {props.logs}
          </div>
        </div>
      </Show>
      <Show when={props.state !== 'live'}>
        <div data-kit="rn-empty">
          <Show
            when={props.state === 'ended'}
            fallback={
              <div data-kit="rn-intro">
                <Icon name="play" />
                <p>{props.labels.intro}</p>
              </div>
            }
          >
            <div data-kit="rn-fail">
              <Icon name="warn" size="sm" />
              <b>{props.ended}</b>
            </div>
            <div data-kit="rn-last">{props.logs}</div>
          </Show>
          {box()}
        </div>
      </Show>
    </section>
  );
}
