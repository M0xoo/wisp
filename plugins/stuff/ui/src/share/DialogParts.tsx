// The pieces of Share…: what goes with it (chips, placeholders until the answer), who can open it
// (a passkey suggested the moment you pick it), its work, and the link with Copy.

import type { Scope } from '@wisp/client';
import { Button, Checkbox, IconButton, Inline, Input, RadioGroup, Skeleton, Stack, Text, Wrap, Pill } from '@wisp/ui';
import { createSignal, For, Show, type JSX } from 'solid-js';
import { copyText } from './clipboard.ts';
import { PASSKEY_MAX, suggestPasskey } from './link.ts';
import { carryChips, carryTip, workOption, type T } from './model.ts';
import type { SharePreview } from './types.ts';

export function CarryChips(props: { t: T; info: SharePreview | undefined; turns: number }): JSX.Element {
  return (
    <Show
      when={props.info}
      fallback={
        <Inline part="share.carry" gap="2" aria-busy="true" aria-label={props.t('stuff.share.carrying')}>
          <Skeleton shape="pill" width="avatar-lg" />
          <Skeleton shape="pill" width="avatar-md" />
          <Skeleton shape="pill" width="avatar-lg" />
        </Inline>
      }
    >
      {(info) => (
        <Wrap part="share.carry" gap="2" aria-label={props.t('stuff.share.carrying')}>
          <For each={carryChips(props.t, info(), props.turns)}>
            {(c) => (
              <Pill variant="outline" icon={c.icon} title={carryTip(props.t, info())}>
                {c.text}
              </Pill>
            )}
          </For>
        </Wrap>
      )}
    </Show>
  );
}

export function WhoPicker(props: { t: T; who: 'link' | 'pass'; onWho: (v: string) => void; passkey: string; onPasskey: (v: string) => void; kept: boolean }): JSX.Element {
  const t = props.t;
  return (
    <Stack part="share.who" gap="3">
      <RadioGroup
        label={t('stuff.share.who')}
        value={props.who}
        onChange={props.onWho}
        options={[
          { value: 'link', label: t('stuff.share.who.link'), hint: t('stuff.share.who.linkHint') },
          { value: 'pass', label: t('stuff.share.who.pass'), hint: t('stuff.share.who.passHint') },
        ]}
      />
      <Show when={props.who === 'pass'}>
        <Inline part="share.passkey" gap="2">
          <Input
            aria-label={t('stuff.share.passkey')}
            value={props.passkey}
            onInput={props.onPasskey}
            mono
            autocomplete="off"
            spellcheck={false}
            maxLength={PASSKEY_MAX}
            {...(props.kept && !props.passkey && { placeholder: t('stuff.share.passkeyKept') })}
          />
          <IconButton icon="rerun" label={t('stuff.share.newPasskey')} onClick={() => props.onPasskey(suggestPasskey())} />
        </Inline>
      </Show>
    </Stack>
  );
}

export function WorkOption(props: { t: T; info: SharePreview | undefined; checked: boolean; onChange: (v: boolean) => void }): JSX.Element {
  // Until the answer it reads as the usual case; no work to send turns it off and says why.
  const opt = (): { can: boolean; hint: string } => (props.info ? workOption(props.t, props.info.work) : { can: true, hint: props.t('stuff.share.work.default') });
  return (
    <Stack part="share.work" gap="1">
      <Checkbox label={props.t('stuff.share.work')} checked={props.checked && opt().can} disabled={!opt().can} onChange={props.onChange} />
      <Text size="sm" tone="muted">
        {opt().hint}
      </Text>
    </Stack>
  );
}

export function LinkRow(props: { t: T; url: string; scope: Scope }): JSX.Element {
  const [copied, setCopied] = createSignal(false);
  const copy = (): void => {
    void copyText(props.url).then((ok) => {
      if (!ok) return;
      setCopied(true);
      props.scope.timeout(2200, () => setCopied(false));
    });
  };
  return (
    <Inline part="share.link" gap="2">
      <Input aria-label={props.t('stuff.share.link')} value={props.url} readOnly mono />
      {/* The label keeps its width: "Copied" is no wider than "Copy link" */}
      <Button size="sm" icon={copied() ? 'check' : 'copy'} onClick={copy}>
        {copied() ? props.t('stuff.share.copiedShort') : props.t('stuff.share.copy')}
      </Button>
    </Inline>
  );
}
