// Skeleton: a placeholder with the real thing's shape and size, so loading never looks empty and
// the real controls replace it without a jump (design/ux.md).
import type { JSX } from 'solid-js';
import type { Size } from '@wisp/tokens';
import { sizeVar } from '@wisp/tokens';
import type { KitProps } from '../core/props.ts';

export type SkeletonWidth = Size | 'full' | '3/4' | '2/3' | '1/2' | '1/3' | '1/4';

export interface SkeletonProps extends KitProps {
  readonly shape?: 'line' | 'block' | 'circle' | 'pill';
  readonly width?: SkeletonWidth;
  readonly height?: Size;
}

const FRACTION: Readonly<Record<string, string>> = { full: '100%', '3/4': '75%', '2/3': '66.667%', '1/2': '50%', '1/3': '33.333%', '1/4': '25%' };

export function Skeleton(props: SkeletonProps): JSX.Element {
  const width = (): string | undefined => {
    const w = props.width;
    if (w === undefined) return undefined;
    return FRACTION[w] ?? sizeVar(w as Size);
  };
  return (
    <span
      id={props.id}
      aria-hidden="true"
      data-kit="skeleton"
      data-part={props.part ?? 'ui.skeleton'}
      data-shape={props.shape ?? 'line'}
      style={{
        ...(width() ? { '--k-w': width() } : {}),
        ...(props.height ? { '--k-h': sizeVar(props.height) } : {}),
      }}
    />
  );
}
