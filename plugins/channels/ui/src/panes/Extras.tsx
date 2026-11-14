// Settings → Phone's rows past each channel's fields (v1 phone.js): Send me (ntfy, Telegram), who is linked and
// Unlink, Slack's manifest, Discord's endpoint URL (a cloud computer) and invite, email's address and New address.
import { For, Show, type JSX } from 'solid-js';
import { Button, Checkbox, CopyCommand, Inline, Link, SettingsRow, Text } from '@wisp/ui';
import { t, type Key } from '../i18n.ts';
import { notifies, toggled, unlinkable } from '../lib.ts';
import { NOTIFY, type ChannelSetup, type SetupArgs } from '../types.ts';

type Save = (a: Omit<SetupArgs, 'transport'>) => void;
type Copy = (text: string, done?: Key) => void;

/** What a channel offers besides its setup: Slack's manifest, Discord's invite, email's New address. */
export interface Extras {
  readonly busy: (what: string) => boolean;
  readonly invite: () => string | undefined;
  readonly copyManifest: () => void;
  readonly copyInvite: () => void;
  readonly rotate: () => void;
}

/** Slack's first step: the app manifest, with this wisp's values (its private URL on a cloud computer). */
export function Manifest(props: { readonly show: boolean; readonly cloud: boolean; readonly extras: Extras }): JSX.Element {
  return (
    <Show when={props.show}>
      <SettingsRow
        part="channels.manifest"
        title={t('channels.manifest')}
        description={t(props.cloud ? 'channels.manifest.hint.cloud' : 'channels.manifest.hint')}
        control={
          <Inline gap="2">
            <Button size="sm" variant="primary" icon="copy" part="channels.manifest.copy" loading={props.extras.busy('manifest')} onClick={() => props.extras.copyManifest()}>
              {t('channels.manifest.copy')}
            </Button>
            <Link href="https://api.slack.com/apps" external part="channels.manifest.site">
              {t('channels.sites.slack')}
            </Link>
          </Inline>
        }
      />
    </Show>
  );
}

/** Send me (v1's events): what ntfy and Telegram tell you about without being asked. */
export function SendMe(props: { readonly row: ChannelSetup; readonly onSave: Save }): JSX.Element {
  return (
    <Show when={notifies(props.row.transport)}>
      <SettingsRow
        part="channels.sendMe"
        title={t('channels.sendMe')}
        description={t('channels.sendMe.hint')}
        control={
          <Inline gap="3">
            <For each={NOTIFY}>
              {(e) => (
                <Checkbox
                  part="channels.sendMe.event"
                  label={t(`channels.sendMe.${e}`)}
                  checked={props.row.notify.includes(e)}
                  onChange={(on) => props.onSave({ notify: toggled(props.row.notify, e, on) })}
                />
              )}
            </For>
          </Inline>
        }
      />
    </Show>
  );
}

/** Discord on a cloud computer: the Interactions Endpoint URL to paste in the Developer Portal. */
export function Endpoint(props: { readonly row: ChannelSetup; readonly cloud: boolean; readonly onCopy: Copy }): JSX.Element {
  return (
    <Show when={props.row.transport === 'discord' && props.cloud}>
      <SettingsRow
        part="channels.endpoint"
        title={t('channels.endpoint')}
        description={t('channels.endpoint.hint')}
        wideControl
        control={
          <Show when={props.row.endpoint} fallback={<Text tone="muted">{t('channels.endpoint.none')}</Text>}>
            {(url) => <CopyCommand part="channels.endpoint.url" bare command={url()} label={t('channels.copy')} onCopy={(u) => props.onCopy(u)} />}
          </Show>
        }
      />
    </Show>
  );
}

/** Discord's Add to a server: in its final shape from the start, its link once the bot has connected. */
export function Invite(props: { readonly row: ChannelSetup; readonly extras: Extras }): JSX.Element {
  return (
    <Show when={props.row.transport === 'discord' && props.row.enabled}>
      <SettingsRow
        part="channels.invite"
        title={t('channels.invite')}
        description={t('channels.invite.hint')}
        control={
          <Inline gap="2">
            <Show
              when={props.extras.invite()}
              fallback={
                <Button size="sm" variant="primary" icon="external" disabled>
                  {t('channels.invite.open')}
                </Button>
              }
            >
              {(url) => (
                <Link href={url()} external part="channels.invite.open">
                  {t('channels.invite.open')}
                </Link>
              )}
            </Show>
            <Button size="sm" variant="ghost" icon="copy" part="channels.invite.copy" disabled={props.extras.invite() === undefined} onClick={() => props.extras.copyInvite()}>
              {t('channels.invite.copy')}
            </Button>
          </Inline>
        }
      />
    </Show>
  );
}

/** Who is linked (Telegram's chat, Slack's and Discord's people), and Unlink. */
export function Who(props: { readonly row: ChannelSetup; readonly name: string; readonly onSave: Save }): JSX.Element {
  return (
    <Show when={props.row.transport !== 'email' && (props.row.linked > 0 || props.row.who !== undefined)}>
      <SettingsRow
        part="channels.who"
        title={props.row.who ? t('channels.linkedTo', { who: props.row.who }) : t('channels.linked', { count: props.row.linked })}
        control={
          <Show when={unlinkable(props.row)}>
            <Button size="sm" variant="ghost" part="channels.unlink" title={t('channels.unlink.title', { name: props.name })} onClick={() => props.onSave({ unlink: true })}>
              {t('channels.unlink')}
            </Button>
          </Show>
        }
      />
    </Show>
  );
}

/** Email on a cloud computer: its secret address, Copy and New address (the old one stops at once). */
export function EmailAddress(props: { readonly row: ChannelSetup; readonly extras: Extras; readonly onCopy: Copy }): JSX.Element {
  return (
    <Show when={props.row.transport === 'email' && props.row.enabled}>
      <SettingsRow
        part="channels.email.address"
        title={t('channels.email.address')}
        description={t('channels.email.address.hint')}
        wideControl
        control={
          <Inline gap="2">
            <Show when={props.row.who}>{(who) => <CopyCommand part="channels.email.address.copy" bare command={who()} label={t('channels.copy')} onCopy={(a) => props.onCopy(a)} />}</Show>
            <Button size="sm" variant="ghost" icon="replay" part="channels.email.rotate" loading={props.extras.busy('rotate')} onClick={() => props.extras.rotate()}>
              {t('channels.email.rotate')}
            </Button>
          </Inline>
        }
      />
    </Show>
  );
}
