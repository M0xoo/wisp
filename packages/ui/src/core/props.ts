// What every kit component accepts, and what none of them does.
import type { JSX } from 'solid-js';

/**
 * A `data-part` name: a frozen contract plugins restyle through (`[data-part="composer.send"]`).
 * Namespaced with a dot: kit defaults are `ui.*`, a feature names its own (`list.row`).
 */
export type PartName = `${string}.${string}`;

/**
 * CSS custom properties, the only inline style the kit lets through: measured values such as a
 * drag width (`{'--sb-w': '320px'}`). Plain properties (`width`, `color`) are not custom
 * properties, so TypeScript rejects them.
 */
export type CssVars = { readonly [name: `--${string}`]: string | number | undefined };

/**
 * No styling from outside: `class`, `classList` and `style` are typed `never`, so passing one is a
 * type error. Looks come from token-typed props; plugins restyle through `data-part` in
 * `@layer plugins`.
 */
export interface NoStyling {
  readonly class?: never;
  readonly className?: never;
  readonly classList?: never;
  readonly style?: never;
}

export interface KitProps extends NoStyling {
  /** The `data-part` this element renders. Each component has its own default. */
  readonly part?: PartName;
  readonly id?: string;
}

/** Layout and floating components also take measured values as CSS custom properties. */
export interface WithVars {
  readonly vars?: CssVars;
}

export interface WithChildren {
  readonly children?: JSX.Element;
}

/** Accessible name and description, for components whose text isn't their name. */
export interface Labelled {
  readonly 'aria-label'?: string;
  readonly 'aria-labelledby'?: string;
  readonly 'aria-describedby'?: string;
}

/** Inline style for the kit's own elements: its private `--k-*` knobs plus the caller's `vars`. */
export function styleOf(
  own: Readonly<Record<`--${string}`, string | number | undefined>>,
  vars?: CssVars,
): JSX.CSSProperties {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(own)) if (v !== undefined) out[k] = String(v);
  if (vars) for (const [k, v] of Object.entries(vars)) if (v !== undefined) out[k] = String(v);
  return out;
}

/** `true` → `''` so `[data-x]` matches; `false`/`undefined` → no attribute at all. */
export const flag = (on: boolean | undefined): '' | undefined => (on ? '' : undefined);

/** Child part names: `ui.dialog` + `title` → `ui.dialog.title`. */
export const sub = (part: PartName, name: string): PartName => `${part}.${name}`;
