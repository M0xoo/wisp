// Thumbs on a turn (v1 turns.js .rate, feedback.js rateTurn / whyForm): 👍 / 👎 at the end of the trail, faint until
// the turn is hovered or rated; clicking the one that's on takes it back. After 👎, one optional line on what went
// wrong, under the trail (the rating already went).
import { createSignal, For, onMount, type JSX } from 'solid-js';
import { Button } from '../controls/Button.tsx';
import { TextArea } from '../controls/Input.tsx';
import { Icon } from '../content/Icon.tsx';
import { flag } from '../core/props.ts';

export type Rating = 'up' | 'down';

export interface RateProps {
  readonly rating?: Rating | undefined;
  readonly labels: { readonly up: string; readonly down: string };
  /** the next rating: null takes it back */
  readonly onRate: (next: Rating | null) => void;
}

export function RateButtons(props: RateProps): JSX.Element {
  // 👍 pops once when it's given (v1 .thanked)
  const [thanked, setThanked] = createSignal(false);
  return (
    <span data-kit="rate" data-part="turn.rate" data-rated={flag(!!props.rating)} data-thanked={flag(thanked())}>
      <For each={['up', 'down'] as const}>
        {(r) => (
          <button
            type="button"
            data-kit="rate-btn"
            data-rate={r}
            data-on={flag(props.rating === r)}
            aria-pressed={props.rating === r}
            title={props.labels[r]}
            aria-label={props.labels[r]}
            onClick={() => {
              const next = props.rating === r ? null : r;
              setThanked(next === 'up');
              props.onRate(next);
            }}
          >
            <Icon name={r === 'up' ? 'thumb-up' : 'thumb-down'} />
          </button>
        )}
      </For>
    </span>
  );
}

export interface WhyFormProps {
  readonly labels: { readonly placeholder: string; readonly note: string; readonly skip: string; readonly send: string };
  /** the words, trimmed; empty sends nothing */
  readonly onSend: (text: string) => void;
  readonly onSkip: () => void;
  /** Escape */
  readonly onClose: () => void;
}

export function WhyForm(props: WhyFormProps): JSX.Element {
  const [text, setText] = createSignal('');
  let box: HTMLTextAreaElement | undefined;
  onMount(() => requestAnimationFrame(() => box?.focus()));
  const send = (): void => {
    const v = text().trim();
    if (v) props.onSend(v);
    else props.onClose();
  };
  return (
    <form
      data-kit="why"
      data-part="turn.why"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <TextArea
        ref={(el) => (box = el)}
        value={text()}
        onInput={setText}
        minRows={2}
        maxRows={6}
        maxLength={4000}
        placeholder={props.labels.placeholder}
        aria-label={props.labels.placeholder}
        part="turn.why.text"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            send();
          }
          if (e.key === 'Escape') {
            e.stopPropagation();
            props.onClose();
          }
        }}
      />
      <div data-kit="why-foot">
        <span data-kit="why-note">{props.labels.note}</span>
        <Button variant="link" size="xs" part="turn.why.skip" onClick={() => props.onSkip()}>
          {props.labels.skip}
        </Button>
        <Button variant="primary" size="xs" type="submit" part="turn.why.send">
          {props.labels.send}
        </Button>
      </div>
    </form>
  );
}
