// "Shared from outside wisp" above New task's box while what was shared waits there unsent (v1
// share-in.js): any site can post the Home Screen app's form, and neither the worker nor the page can
// tell, so it says where it came from. It goes when the box is sent or emptied.

import type { PluginClient } from '@wisp/client';
import { Callout, useSignal } from '@wisp/ui';
import { createEffect, Show, type JSX } from 'solid-js';
import { launcherKey, SHARED_IN_FIELD, TEXT_FIELD } from './launcher.ts';

export default function SharedInNote(props: { client: PluginClient }): JSX.Element {
  const c = props.client;
  const key = launcherKey(c);
  const shared = useSignal(c.drafts.get<boolean>(key, SHARED_IN_FIELD));
  const text = useSignal(c.drafts.get<string>(key, TEXT_FIELD));
  // Sent (the composer clears the box) or emptied by hand: nothing from outside is waiting any more.
  createEffect(() => {
    if (shared() && !text()) c.drafts.clear(key, SHARED_IN_FIELD);
  });
  return (
    <Show when={shared() && text()}>
      <Callout part="share.in" tone="warn" icon="info">
        {c.t('stuff.share.in.outside')}
      </Callout>
    </Show>
  );
}
