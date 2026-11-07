// Forget what Auto learned: asks first (a red button in an alert dialog), then the peer recomputes.

import { createSignal, type JSX } from 'solid-js';
import type { PluginClient } from '@wisp/client';
import { Button, Dialog, Inline, Text } from '@wisp/ui';
import { routerReset } from '../commands.ts';
import { toastOf } from '../host.ts';
import { t } from '../i18n.ts';

export function ResetButton(props: { readonly client: PluginClient }): JSX.Element {
  const [asking, setAsking] = createSignal(false);
  const forget = (): void => {
    setAsking(false);
    props.client
      .run(routerReset, { peer: props.client.home })
      .then(() => toastOf(props.client)?.show(t('wisp.router.learned.forgot'), { tone: 'success' }))
      .catch(() => {});
  };
  return (
    <Inline gap="3" part="router.reset">
      <Button variant="ghost" tone="bad" size="sm" onClick={() => setAsking(true)}>
        {t('wisp.router.learned.reset')}
      </Button>
      <Text size="sm" tone="muted" truncate>
        {t('wisp.router.learned.reset-hint')}
      </Text>
      <Dialog
        open={asking()}
        onOpenChange={setAsking}
        role="alertdialog"
        size="sm"
        title={t('wisp.router.learned.reset-ask')}
        footer={
          <Inline gap="2" justify="end">
            <Button variant="secondary" onClick={() => setAsking(false)}>
              {t('wisp.router.learned.cancel')}
            </Button>
            <Button variant="danger" onClick={forget}>
              {t('wisp.router.learned.reset-ok')}
            </Button>
          </Inline>
        }
      >
        {null}
      </Dialog>
    </Inline>
  );
}
