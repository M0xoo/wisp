// Comments (v1 comments.js): the card a comment is written in (where it is, the code, the note, Cancel and Comment
// ⌘↵), and the tray over the reply box where they wait, numbered, until the next follow-up takes them (a line with
// Send comments, then a row each: its number, its words, where, ×).
import { For, Show, onMount, type JSX } from 'solid-js';
import { Icon } from '../content/Icon.tsx';
import type { KitProps } from '../core/props.ts';

export interface CommentCardProps extends KitProps {
  readonly n: number;
  /** "math.js:2" */
  readonly where: string;
  readonly code: string;
  readonly value: string;
  readonly placeholder: string;
  readonly onInput: (v: string) => void;
  readonly onSave: () => void;
  readonly onCancel: () => void;
  readonly labels: { readonly save: string; readonly cancel: string; readonly hint: string };
}

export function CommentCard(props: CommentCardProps): JSX.Element {
  let box: HTMLTextAreaElement | undefined;
  onMount(() => box?.focus());
  return (
    <div id={props.id} data-kit="cmt-card" data-part={props.part ?? 'comment.card'}>
      <div data-kit="cmt-head">
        <span data-kit="cmt-n">{props.n}</span>
        <span data-kit="cmt-file">{props.where}</span>
        <span data-kit="cmt-code">{props.code}</span>
      </div>
      <textarea
        ref={(el) => (box = el)}
        data-kit="textarea"
        data-cmt=""
        rows={2}
        value={props.value}
        placeholder={props.placeholder}
        onInput={(e) => props.onInput(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            props.onSave();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            props.onCancel();
          }
        }}
      />
      <div data-kit="cmt-foot">
        <span data-kit="cmt-hint">{props.labels.hint}</span>
        <button type="button" data-kit="button" data-variant="ghost" data-size="sm" onClick={() => props.onCancel()}>
          <span data-kit="button-content">
            <span data-kit="button-label">{props.labels.cancel}</span>
          </span>
        </button>
        <button type="button" data-kit="button" data-variant="primary" data-size="sm" disabled={props.value.trim() === ''} onClick={() => props.onSave()}>
          <span data-kit="button-content">
            <span data-kit="button-label">{props.labels.save}</span>
          </span>
        </button>
      </div>
    </div>
  );
}

export interface CommentTrayProps extends KitProps {
  readonly items: readonly { readonly key: string; readonly say: string; readonly where: string; readonly onRemove: () => void; readonly onOpen?: () => void }[];
  /** "2 comments go with your next follow-up" */
  readonly line: string;
  readonly send: { readonly label: string; readonly onClick: () => void; readonly hidden?: boolean };
  readonly removeLabel: string;
}

export function CommentTray(props: CommentTrayProps): JSX.Element {
  return (
    <Show when={props.items.length > 0}>
      <div id={props.id} data-kit="cmt-tray" data-part={props.part ?? 'comment.tray'}>
        <div data-kit="cmt-bar">
          <span data-kit="cmt-for">{props.line}</span>
          <button type="button" data-kit="button" data-variant="ghost" data-size="xs" data-hide={props.send.hidden ? '' : undefined} onClick={() => props.send.onClick()}>
            <span data-kit="button-content">
              <Icon name="send" size="sm" />
              <span data-kit="button-label">{props.send.label}</span>
            </span>
          </button>
        </div>
        <ol data-kit="cmt-list">
          <For each={props.items}>
            {(c, i) => (
              <li data-kit="cmt-row">
                <button type="button" data-kit="cmt-body" onClick={() => c.onOpen?.()}>
                  <span data-kit="cmt-n">{i() + 1}</span>
                  <span data-kit="cmt-say">{c.say}</span>
                  <span data-kit="cmt-on">{c.where}</span>
                </button>
                <button type="button" data-kit="cmt-x" title={props.removeLabel} aria-label={props.removeLabel} onClick={() => c.onRemove()}>
                  <Icon name="x" size="sm" />
                </button>
              </li>
            )}
          </For>
        </ol>
      </div>
    </Show>
  );
}
