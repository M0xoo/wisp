// The shell's own top bar items. Brand: home on the desktop (a modified click still opens the
// link); Search: the command palette, with its shortcut.

import type { JSX } from 'solid-js';
import { Button, IconButton } from '@wisp/ui';
import type { ExtensionProps } from '../contract.ts';
import { useShell } from '../context.tsx';
import { displayCombo } from '../keys.ts';

export function Brand(_p: ExtensionProps): JSX.Element {
  const shell = useShell();
  return (
    <Button variant="ghost" size="sm" icon="spark" part="shell.brand" aria-label={shell.t('shell.home')} title={shell.t('shell.home')} onClick={() => shell.navigate({ t: 'home' })}>
      {shell.t('shell.brand')}
    </Button>
  );
}

export function SearchButton(p: ExtensionProps): JSX.Element {
  const shell = useShell();
  const kbd = displayCombo('mod+k', shell.platform.apple).join('');
  const label = shell.t('shell.search');
  return p.form === 'icon' ? (
    <IconButton icon="search" label={label} size="sm" part="shell.search" onClick={() => shell.palette.open()} />
  ) : (
    <Button variant="ghost" size="sm" icon="search" kbd={kbd} part="shell.search" onClick={() => shell.palette.open()}>
      {label}
    </Button>
  );
}
