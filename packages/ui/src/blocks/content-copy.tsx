// Copy (v1 copy()): the clipboard is the one piece of the outside world a content block touches
// itself, and only here. The button says Copied for a moment, then goes back.
import { createSignal, type JSX } from 'solid-js';
import { IconButton } from '../controls/Button.tsx';
import type { PartName } from '../core/props.ts';
import { useBlockT } from './context.tsx';
import { createTimer } from './content-scope.ts';

/** Writes `text` to the clipboard; false when the page may not (no permission, no clipboard). */
export async function copyText(text: string): Promise<boolean> {
  try {
    const clip = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (!clip) return false;
    await clip.writeText(text);
    return true;
  } catch {
    return false;
  }
}

const COPIED_MS = 1200;

export function CopyButton(props: { readonly text: () => string; readonly part: PartName }): JSX.Element {
  const t = useBlockT();
  const timer = createTimer();
  const [copied, setCopied] = createSignal(false);
  const onClick = (e: MouseEvent): void => {
    e.stopPropagation();
    void copyText(props.text()).then((ok) => {
      if (!ok) return;
      setCopied(true);
      timer.after(COPIED_MS, () => setCopied(false));
    });
  };
  return (
    <IconButton
      part={props.part}
      size="xs"
      icon={copied() ? 'check' : 'copy'}
      tone={copied() ? 'good' : undefined}
      label={copied() ? t('block.copied') : t('block.copy')}
      onClick={onClick}
    />
  );
}
