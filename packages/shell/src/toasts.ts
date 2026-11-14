// Toasts the peers ask for and the ones a refused command needs (plan §4.6.5): a reject rolls the
// optimistic patch back (the client does that) and says why here. A notice can carry where its
// Open goes; Open navigates with openFromToast, which closes whatever sits over the target (#573).

import type { CommandError, Scope, Target } from '@wisp/client';
import type { Toaster } from '@wisp/ui';
import type { ShellContext } from './contract.ts';

interface ToastNotice {
  message?: unknown;
  tone?: unknown;
  description?: unknown;
  target?: unknown;
}

const isTarget = (v: unknown): v is Target => typeof v === 'object' && v !== null && typeof (v as { to?: unknown }).to === 'string';

/** ClientOptions.onError for createClient: the rollback toast. */
export function commandErrorToast(toaster: Pick<Toaster, 'error'>): (err: CommandError, cmd: string) => void {
  return (err, cmd) => {
    toaster.error(err.message || cmd);
  };
}

export function wireNotices(ctx: ShellContext, owner: Scope): void {
  owner.add(
    ctx.client.peers.onNotice((_peer, n) => {
      if (n.kind !== 'toast') return;
      const d = (n.data ?? {}) as ToastNotice;
      if (typeof d.message !== 'string') return;
      const tone = d.tone === 'success' || d.tone === 'error' || d.tone === 'info' ? d.tone : 'info';
      const target = isTarget(d.target) ? d.target : undefined;
      ctx.toast.show(d.message, {
        tone,
        ...(typeof d.description === 'string' && { description: d.description }),
        ...(target && { action: { label: ctx.t('shell.toast.open'), onClick: () => ctx.navigate({ t: 'openFromToast', target }) } }),
      });
    }),
  );
}
