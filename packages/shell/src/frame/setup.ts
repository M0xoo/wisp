// No coding agent on this computer (v1 setup.js, F-comp-40): New task offers to install opencode (its free models
// need no account), so a first run goes from `npx wisp-agents` to a working task in one click; Re-check looks again
// for one you installed yourself. Unknown until the first detection is back (an empty list), so a slow start
// doesn't flash the strip.
import { createResource, createSignal, type Accessor } from 'solid-js';
import { defineCommand } from '@wisp/client';
import type { LauncherSetupProps } from '@wisp/ui';
import type { ShellContext } from '../contract.ts';
import type { AgentOffer } from './runner.ts';

/** what wisp installs itself (accounts.install) */
export const INSTALLABLE = 'opencode';

const agentsOf = defineCommand<{ peer: string }, AgentOffer[]>({ id: 'runtime.agents', owner: (a) => a.peer, wire: () => ({}), optimistic: 'none', pending: 'the harness list' });
const install = defineCommand<{ peer: string; agent: string }, unknown>({
  id: 'accounts.install',
  owner: (a) => a.peer,
  wire: ({ agent }) => ({ agent }),
  optimistic: 'none',
  pending: 'Installing…',
});
const recheck = defineCommand<{ peer: string }, unknown>({ id: 'accounts.recheck', owner: (a) => a.peer, wire: () => ({}), optimistic: 'none', pending: 'Re-check' });

/** The launch would have nowhere to run: the harness list is in, and none of it is set up. */
export const needsSetup = (agents: readonly { readonly available: boolean }[] | null | undefined): boolean => !!agents && agents.length > 0 && !agents.some((a) => a.available);

/** The strip's words: installing, the last failure, or the offer. */
export function setupWords(t: ShellContext['t'], busy: boolean, failed: string): { line: string; cta: string; bad: boolean } {
  if (busy) return { line: t('shell.setup.installing'), cta: t('shell.setup.installingCta'), bad: false };
  if (failed) return { line: t('shell.setup.failed', { why: failed }), cta: t('shell.setup.retry'), bad: true };
  return { line: t('shell.setup.none'), cta: t('shell.setup.install'), bad: false };
}

/** The strip for this computer's New task, or undefined while a harness is there (or the list isn't in yet). */
export function useSetup(shell: ShellContext, peer: Accessor<string>, logo: () => string | undefined, onReady: () => void): Accessor<LauncherSetupProps | undefined> {
  const [agents, { refetch }] = createResource(peer, (p) => shell.client.commands.run(agentsOf, { peer: p }).catch(() => [] as AgentOffer[]));
  const [busy, setBusy] = createSignal(false);
  const [looking, setLooking] = createSignal(false);
  const [failed, setFailed] = createSignal('');
  const name = (): string => agents()?.find((a) => a.id === INSTALLABLE)?.name ?? INSTALLABLE;
  const doInstall = (): void => {
    if (busy()) return;
    setBusy(true);
    setFailed('');
    void shell.client.commands
      .run(install, { peer: peer(), agent: INSTALLABLE })
      .then(async () => {
        await refetch();
        shell.toast.success(shell.t('shell.setup.ready', { name: name() }), { duration: 7000 });
        onReady();
      })
      .catch((e: unknown) => setFailed(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  const doRecheck = (): void => {
    setLooking(true);
    void shell.client.commands
      .run(recheck, { peer: peer() })
      .then(async () => {
        const now = await refetch();
        if (needsSetup(now)) shell.toast.show(shell.t('shell.setup.still'));
      })
      .catch((e: unknown) => shell.toast.error(e instanceof Error ? e.message : String(e)))
      .finally(() => setLooking(false));
  };
  return () => {
    if (!needsSetup(agents())) return undefined;
    const w = setupWords(shell.t, busy(), failed());
    return {
      logo: logo(),
      line: w.line,
      bad: w.bad,
      busy: busy(),
      recheck: { label: shell.t('shell.setup.recheck'), busy: looking(), onClick: doRecheck },
      install: { label: w.cta, onClick: doInstall },
    };
  };
}
