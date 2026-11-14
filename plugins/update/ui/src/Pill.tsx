// The top bar's Update pill (v1 #updateBtn, beside the projects) while a newer wisp is out: the update icon and the
// version (v2's head sits in the sidebar, so the bar's short form; "Update to 2.1.0" is its name and tooltip), and
// the kit's pending ring while it installs and restarts (named "Updating…", "Restarting…"). A click installs, asking first when it would stop running
// tasks (the Updates pane's confirm). A failed install toasts why, with Copy command (Open downloads for the app);
// once the new wisp answers with another version the page reloads onto it, and after two minutes without it a
// toast says to start it again.

import { createEffect, createMemo, createSignal, on, Show, type JSX } from 'solid-js';
import { entityKey } from '@wisp/client';
import { useShell } from '@wisp/shell';
import type { ExtensionProps } from '@wisp/shell/contract';
import { Button, IconButton, useSignal } from '@wisp/ui';
import { installUpdate } from './commands.ts';
import { t } from './i18n.ts';
import { usePaneScope, useTopic } from './live.ts';
import { Confirm } from './panes/Updates.tsx';
import { BACK_WITHIN_MS, cameBack, failureAction, notBack, pillOf, restartStep } from './pill.ts';
import { KIND, ROW_ID, TOPIC, type UpdateState } from './types.ts';

/** The version that was restarting (pill.ts restartStep): reload once another answers, else say so after 2 min. */
function useRestartWatch(row: () => UpdateState | undefined, shell: ReturnType<typeof useShell>, scope: ReturnType<typeof usePaneScope>): void {
  const [from, setFrom] = createSignal<string>();
  let wait = 0;
  createEffect(
    on(row, (u, prev) => {
      const step = restartStep(from(), prev, u);
      setFrom(step.from);
      if (step.reload) return shell.platform.reload();
      if (!step.wait) return;
      const mine = ++wait;
      scope.timeout(BACK_WITHIN_MS, () => {
        const now = row();
        if (mine === wait && from() !== undefined && now && !cameBack(from(), now)) shell.toast.error(notBack(now));
      });
    }),
  );
}

/** A failed install says why, with Copy command (Open downloads for the app), as v1's toast did. */
function toastFailed(shell: ReturnType<typeof useShell>, u: UpdateState): void {
  const a = failureAction(u);
  const action = a && {
    label: a.kind === 'open' ? t('update.downloads') : t('update.copy'),
    onClick: () => (a.kind === 'open' ? shell.platform.openExternal(a.target) : void shell.platform.copy(a.target)),
  };
  shell.toast.error(u.error ?? t('update.failed'), { duration: 10_000, ...(action && { action }) });
}

export default function UpdatePill(props: ExtensionProps): JSX.Element {
  const shell = useShell();
  const client = props.client;
  useTopic(client, TOPIC);
  const scope = usePaneScope(client, 'pill');
  const row = useSignal(client.entities.row<UpdateState>(KIND, entityKey(client.home, ROW_ID)));
  const view = createMemo(() => pillOf(row()));
  const [asking, setAsking] = createSignal(false);
  useRestartWatch(row, shell, scope);
  const send = (force: boolean): void => {
    client.run(installUpdate, { peer: client.home, force }).then(
      (r) => {
        const u = r as UpdateState | undefined;
        if (u?.error && u.status === 'idle') toastFailed(shell, u);
      },
      () => {}, // a refusal: the shell's toast, the row rolled back
    );
  };
  const press = (): void => {
    const u = row();
    if (!u || u.status !== 'idle' || !u.available) return;
    if ((u.running ?? 0) > 0) setAsking(true);
    else send(false);
  };
  return (
    <Show when={view()}>
      {(v) => (
        <>
          <Show
            when={props.form !== 'icon'}
            fallback={<IconButton icon="update" label={v().label} title={`${v().label}\n${v().title}`} size="sm" variant="ghost" loading={v().busy} onClick={press} part="update.pill" />}
          >
            <Button variant="accent" size="sm" icon="update" title={`${v().label}\n${v().title}`} aria-label={v().label} loading={v().busy} onClick={press} part="update.pill">
              {v().text}
            </Button>
          </Show>
          <Show when={row()}>
            {(u) => (
              <Confirm
                open={asking()}
                row={u()}
                onClose={() => setAsking(false)}
                onConfirm={() => {
                  setAsking(false);
                  send(true);
                }}
              />
            )}
          </Show>
        </>
      )}
    </Show>
  );
}
