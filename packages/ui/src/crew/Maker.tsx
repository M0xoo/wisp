// The spirit maker (v1 crew.js paintMaker, .ce-maker): a row of choices per part (body, glow, eyes, mouth,
// extra), each choice drawn as the spirit it makes, then Surprise me and an emoji instead. The caller owns the
// avatar; a pick hands back the new code (or the emoji typed).
import { For, Index, type JSX } from 'solid-js';
import { flag } from '../core/props.ts';
import { Icon } from '../content/Icon.tsx';
import { Spirit } from './Spirit.tsx';
import { SPIRIT_PARTS, isSpirit, type SpiritPart } from './spirit-code.ts';
import { makerOptions } from './maker-options.ts';

export interface SpiritMakerProps {
  /** the avatar now: a spirit code, or an emoji */
  readonly avatar: string;
  /** what rolls the parts an emoji avatar has none of (the name) */
  readonly seed: string;
  /** each part's row label (Body, Glow, Eyes, Mouth, Extra) */
  readonly labels: Readonly<Record<SpiritPart, string>>;
  readonly surprise: string;
  readonly emoji: { readonly label: string; readonly title: string };
  readonly onPick: (code: string) => void;
  readonly onRoll: () => void;
  readonly onEmoji: (value: string) => void;
}

export function SpiritMaker(props: SpiritMakerProps): JSX.Element {
  return (
    <div data-kit="ce-maker" data-part="crew.editor.maker">
      <For each={SPIRIT_PARTS}>
        {(part) => (
          <div data-kit="cm-row" role="group" aria-label={props.labels[part]}>
            <span data-kit="ce-lbl">{props.labels[part]}</span>
            <div data-kit="cm-opts" data-layout="wrap">
              {/* Index: a pick changes each option's code in place, so the buttons (and focus) stay */}
              <Index each={makerOptions(props.avatar, props.seed, part)}>
                {(opt) => {
                  const o = (): ReturnType<typeof makerOptions>[number] => opt();
                  return (
                  <button
                    type="button"
                    data-kit="ce-swatch"
                    data-on={flag(o().on)}
                    aria-pressed={o().on}
                    title={o().value}
                    aria-label={`${props.labels[part]}: ${o().value}`}
                    onClick={() => props.onPick(o().code)}
                  >
                    {part === 'color' ? <i data-kit="ce-sw" data-color={o().value} /> : <Spirit code={o().code} mood="idle" />}
                  </button>
                  );
                }}
              </Index>
            </div>
          </div>
        )}
      </For>
      <div data-kit="cm-foot">
        <button type="button" data-kit="button" data-variant="ghost" data-size="xs" onClick={() => props.onRoll()}>
          <Icon name="rerun" size="sm" />
          {props.surprise}
        </button>
        <label data-kit="cm-emoji" title={props.emoji.title}>
          <span>{props.emoji.label}</span>
          <input
            data-kit="ce-input"
            maxlength="8"
            value={isSpirit(props.avatar) ? '' : props.avatar}
            placeholder="🦊"
            autocomplete="off"
            onInput={(e) => props.onEmoji(e.currentTarget.value.trim())}
          />
        </label>
      </div>
    </div>
  );
}
