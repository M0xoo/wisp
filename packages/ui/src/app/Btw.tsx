// /btw side questions under a task's transcript (v1 btw.js item, the .btw cards): the question with its btw tag, then
// the answer (Markdown), or "… is answering on the side · the run carries on" while it's on its way, or what went
// wrong; × dismisses (or cancels one still answering). Value for value; the owner gives the words.
import { For, Show, type JSX } from 'solid-js';
import { Icon } from '../content/Icon.tsx';
import { Markdown } from '../content/markdown/Markdown.tsx';

export interface BtwItem {
  readonly id: string;
  readonly question: string;
  readonly answer?: string;
  readonly pending?: boolean;
  readonly error?: string | undefined;
  /** "Side question, asked 14:05" */
  readonly tip: string;
}

export function BtwList(props: {
  readonly items: readonly BtwItem[];
  readonly waiting: string;
  readonly dismiss: (pending: boolean) => string;
  readonly onDismiss: (id: string) => void;
}): JSX.Element {
  return (
    <Show when={props.items.length > 0}>
      <div data-kit="btw-list" data-part="task.btw">
        <For each={props.items}>
          {(b) => (
            <div data-kit="btw" data-pending={b.pending ? '' : undefined} data-part="task.btw.item">
              <div data-kit="btw-q">
                <span data-kit="btw-tag" title={b.tip}>
                  <Icon name="ask" />
                  btw
                </span>
                <span data-kit="btw-text">{b.question}</span>
              </div>
              <Show
                when={!b.pending}
                fallback={
                  <div data-kit="btw-wait">
                    <span data-kit="btw-dots">
                      <i />
                      <i />
                      <i />
                    </span>
                    {props.waiting}
                  </div>
                }
              >
                <Show
                  when={b.error}
                  fallback={
                    <div data-kit="btw-a">
                      <Markdown source={b.answer ?? ''} />
                    </div>
                  }
                >
                  {(e) => (
                    <div data-kit="btw-err">
                      <Icon name="warn" />
                      <span>{e()}</span>
                    </div>
                  )}
                </Show>
              </Show>
              <button type="button" data-kit="btw-x" title={props.dismiss(b.pending === true)} aria-label={props.dismiss(b.pending === true)} onClick={() => props.onDismiss(b.id)}>
                <Icon name="x" />
              </button>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}
