// New task's Run on (v1 launcher.js where-btn, F-comp-9/10): this computer first, then the computers you added, the
// picked one checked; picking one makes it the only place (v1 0.45: one machine at a time from the menu).
import type { MenuEntry } from '@wisp/ui';

export function whereItems(peers: readonly string[], picked: string, home: string, name: (p: string) => string, t: (k: string) => string): MenuEntry[] {
  const others = peers.filter((p) => p !== home);
  return [
    { value: home, label: t('shell.card.thisComputer'), icon: 'laptop', checked: picked === home },
    ...others.map((p): MenuEntry => ({ value: p, label: name(p), icon: 'server', checked: picked === p })),
  ];
}
