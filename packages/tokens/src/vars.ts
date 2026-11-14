// Typed references to the CSS variables tokens.css defines. The kit uses these instead of writing
// `var(--space-3)` by hand, so a renamed token breaks the build, not the page.
import type { ColorToken, FontSize, Radius, Shadow, Size, Space, Tone, ZLayer } from './generated.ts';

export const spaceVar = (s: Space): string => `var(--space-${s})`;
export const radiusVar = (r: Radius): string => `var(--radius-${r})`;
export const sizeVar = (s: Size): string => `var(--size-${s})`;
export const fontSizeVar = (s: FontSize): string => `var(--fs-${s})`;
export const colorVar = (c: ColorToken): string => `var(--${c})`;
export const toneVar = (t: Tone): string => `var(--tone-${t})`;
export const shadowVar = (s: Shadow): string => `var(--shadow-${s})`;
export const zVar = (z: ZLayer): string => `var(--z-${z})`;
