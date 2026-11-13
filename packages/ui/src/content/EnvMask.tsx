// The line over a masked .env view (v1 env-mask.js maskBar): what's hidden, and Reveal (or Hide) at its end. Fixed
// height and a fixed-width button, so Reveal ⇄ Hide moves nothing. The caller says the words (translated) and keeps
// whether it's shown; the button only asks to flip it.
import type { JSX } from 'solid-js';
import { sub, type KitProps, type PartName } from '../core/props.ts';

export interface EnvMaskProps extends KitProps {
  /** the file's values show as they are */
  readonly shown: boolean;
  /** "app.env’s values are hidden" / "Showing app.env’s values" */
  readonly what: string;
  /** "Reveal" / "Hide" */
  readonly action: string;
  readonly onToggle: (show: boolean) => void;
  /** the button's own part (Changes' `changes.envReveal`); default `<part>.reveal` */
  readonly buttonPart?: PartName;
}

export function EnvMask(props: EnvMaskProps): JSX.Element {
  const part = (): PartName => props.part ?? 'ui.envMask';
  return (
    <div id={props.id} data-kit="env-mask" data-part={part()}>
      <span data-kit="env-mask-what">{props.what}</span>
      <button
        type="button"
        data-kit="env-mask-btn"
        data-part={props.buttonPart ?? sub(part(), 'reveal')}
        aria-pressed={props.shown}
        onClick={(e) => {
          e.stopPropagation(); // a step's row or a file's head would fold
          props.onToggle(!props.shown);
        }}
      >
        {props.action}
      </button>
    </div>
  );
}

/** The file's name as the line says it (`apps/web/.env.local` → `.env.local`). */
export const envName = (file: unknown): string => String(file || '.env').split(/[\\/]/).pop() || '.env';
