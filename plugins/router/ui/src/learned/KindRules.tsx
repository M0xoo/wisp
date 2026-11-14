// The per-kind rules set from the launcher's preview ("Never Opus 5.5 for UI tasks"), each with ×.

import { For, Show, type JSX } from 'solid-js';
import { IconButton, Inline, Pill, Wrap } from '@wisp/ui';
import { t } from '../i18n.ts';
import { kindRules } from '../rules.ts';
import type { ArmReport } from '../types.ts';

export function KindRules(props: { readonly blocked: readonly string[]; readonly arms: readonly ArmReport[]; readonly onDrop: (rule: string) => void }): JSX.Element {
  const list = (): ReturnType<typeof kindRules> => kindRules(props.blocked, props.arms);
  return (
    <Show when={list().length > 0}>
      <Wrap gap="2" part="router.kinds">
        <For each={list()}>
          {(k) => (
            <Inline gap="1" part="router.kind">
              <Pill variant="outline">{t('wisp.router.rule.kind', { what: k.what, kind: k.kind })}</Pill>
              <IconButton icon="x" size="xs" label={t('wisp.router.rule.allow')} onClick={() => props.onDrop(k.rule)} />
            </Inline>
          )}
        </For>
      </Wrap>
    </Show>
  );
}
