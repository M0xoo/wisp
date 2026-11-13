// The Crew section's folded row (v1 crew.js stripHtml, .cr-strip): the folded members' faces (each opens its
// thread; a fine pointer only), how many and what they're doing, and a chevron that shows them all; Show fewer
// folds them again. Faces are keyed by id, so a spirit never restarts its animation as the words change.
import { For, type JSX } from 'solid-js';
import { flag } from '../core/props.ts';
import { Icon } from '../content/Icon.tsx';
import { Face } from './Face.tsx';

export interface CrewStripFace {
  readonly id: string;
  readonly name: string;
  readonly avatar: string;
  readonly color?: string | undefined;
  /** "Ada · Checks in every hour" */
  readonly title: string;
  readonly label: string;
  /** the member open in the main pane */
  readonly on?: boolean;
}

export function CrewListStrip(props: { readonly faces: readonly CrewStripFace[]; readonly words: string; readonly title: string; readonly onFace: (id: string) => void; readonly onExpand: () => void }): JSX.Element {
  return (
    <div data-kit="cr-strip" data-part="crew.strip" onClick={() => props.onExpand()}>
      <span data-kit="cr-faces">
        <For each={props.faces}>
          {(f) => (
            <button
              type="button"
              data-kit="cr-face"
              data-on={flag(f.on === true)}
              title={f.title}
              aria-label={f.label}
              onClick={(e) => {
                e.stopPropagation();
                props.onFace(f.id);
              }}
            >
              <Face avatar={f.avatar} name={f.name} {...(f.color !== undefined && { color: f.color })} size="xs" />
            </button>
          )}
        </For>
      </span>
      <button type="button" data-kit="cr-fold" aria-expanded="false" title={props.title}>
        <span data-kit="cr-sub">{props.words}</span>
        <Icon name="chevron" size="sm" />
      </button>
    </div>
  );
}

export function CrewListFewer(props: { readonly label: string; readonly onClick: () => void }): JSX.Element {
  return (
    <button type="button" data-kit="cr-fewer" data-part="crew.fewer" onClick={() => props.onClick()}>
      {props.label}
    </button>
  );
}
