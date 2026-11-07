// Settings → Updates (v1 General → Updates and the top bar's update pill, web/js/features/update.js):
// the channel, with what it means and why this copy can't follow it; the version and Update now
// (asking first when it would stop running tasks, as v1 did on 'agents are running'); when it last
// checked, and Check now. A failed install says why, with the command to run by hand.

import { createSignal, Show, type JSX } from 'solid-js';
import { entityKey, type DeepReadonly, type PluginClient } from '@wisp/client';
import { Banner, Button, Dialog, Link, SelectSetting, SettingsGroup, SettingsRow, Text, Time, useSignal } from '@wisp/ui';
import { checkNow, installUpdate } from '../commands.ts';
import { t } from '../i18n.ts';
import { useCopy, useNow, useTopic } from '../live.ts';
import { fromRow, text } from '../source.ts';
import { KEYS, KIND, ROW_ID, TOPIC, type UpdateState } from '../types.ts';
import { channelHint, channelItems, showsInstall, versionLine } from '../words.ts';

type Row = DeepReadonly<UpdateState>;
const quiet = (p: Promise<unknown>): void => void p.catch(() => {}); // the shell toasts a refusal

function Channel(props: { readonly client: PluginClient; readonly row: Row | undefined }): JSX.Element {
  const src = text(fromRow(props.client, KEYS.channel, 'stable'), 'stable');
  const channel = useSignal(src.value);
  return (
    <SelectSetting
      part="settings.update.channel"
      title={t('update.channel')}
      description={channelHint(channel(), props.row)}
      items={channelItems()}
      source={src}
      locked={(by) => t('update.locked', { by })}
    />
  );
}

function InstallButton(props: { readonly row: Row; readonly onInstall: () => void }): JSX.Element {
  const label = (): string => (props.row.status === 'installing' ? t('update.updating') : props.row.status === 'restarting' ? t('update.restarting') : t('update.now'));
  return (
    <Button part="settings.update.install" variant="primary" size="sm" icon="update" loading={props.row.status !== 'idle'} onClick={() => props.onInstall()}>
      {label()}
    </Button>
  );
}

function Version(props: { readonly row: Row; readonly onInstall: () => void }): JSX.Element {
  return (
    <SettingsRow
      part="settings.update.version"
      title={t('update.version')}
      description={versionLine(props.row)}
      control={
        <Show when={showsInstall(props.row)} fallback={<Text size="sm" tone="muted" mono numeric nowrap>{props.row.current}</Text>}>
          <InstallButton row={props.row} onInstall={props.onInstall} />
        </Show>
      }
    />
  );
}

function Checked(props: { readonly client: PluginClient; readonly row: Row }): JSX.Element {
  const now = useNow(props.client);
  const check = (): void => quiet(props.client.run(checkNow, { peer: props.client.home }));
  const when = (): JSX.Element => {
    if (props.row.checking) return t('update.checking');
    if (!props.row.enabled) return t('update.checked.off');
    const at = props.row.checked_at;
    return at ? <Time at={at} now={now()} layout="inline" /> : t('update.checked.never');
  };
  return (
    <SettingsRow
      part="settings.update.checked"
      title={t('update.checked')}
      description={when()}
      control={
        <Button part="settings.update.check" size="sm" icon="rerun" loading={props.row.checking === true} disabled={!props.row.enabled} onClick={check}>
          {t('update.check')}
        </Button>
      }
    />
  );
}

function Failed(props: { readonly client: PluginClient; readonly row: Row }): JSX.Element {
  const { copied, copy } = useCopy(props.client);
  const action = (): JSX.Element => {
    const cmd = props.row.command;
    if (!cmd) return undefined;
    if (props.row.method === 'app') return <Link href={cmd} external>{t('update.downloads')}</Link>;
    return <Button size="sm" icon={copied() ? 'check' : 'copy'} onClick={() => copy(cmd)}>{copied() ? t('update.copied') : t('update.copy')}</Button>;
  };
  return (
    <Banner part="settings.update.error" tone="bad" title={t('update.failed')} action={action()}>
      {props.row.error}
    </Banner>
  );
}

function Confirm(props: { readonly open: boolean; readonly row: Row; readonly onClose: () => void; readonly onConfirm: () => void }): JSX.Element {
  return (
    <Dialog
      part="settings.update.confirm"
      open={props.open}
      onOpenChange={(o) => !o && props.onClose()}
      role="alertdialog"
      size="sm"
      title={t('update.confirm.title', { latest: props.row.latest ?? '' })}
      footer={
        <>
          <Button variant="ghost" onClick={() => props.onClose()}>{t('update.cancel')}</Button>
          <Button variant="primary" icon="update" onClick={() => props.onConfirm()}>{t('update.confirm.ok')}</Button>
        </>
      }
    >
      <Text as="p">{t('update.confirm.body', { count: props.row.running ?? 0 })}</Text>
    </Dialog>
  );
}

export default function Updates(props: { readonly client: PluginClient }): JSX.Element {
  useTopic(props.client, TOPIC);
  const row = useSignal(props.client.entities.row<UpdateState>(KIND, entityKey(props.client.home, ROW_ID)));
  const [asking, setAsking] = createSignal(false);
  const send = (force: boolean): void => quiet(props.client.run(installUpdate, { peer: props.client.home, force }));
  const install = (): void => {
    const u = row();
    if (!u || u.status !== 'idle') return;
    if ((u.running ?? 0) > 0) setAsking(true);
    else send(false);
  };
  return (
    <>
      <SettingsGroup part="settings.update.channel-group">
        <Channel client={props.client} row={row()} />
      </SettingsGroup>
      <Show when={row()}>
        {(u) => (
          <>
            <Show when={u().error && u().status === 'idle'}>
              <Failed client={props.client} row={u()} />
            </Show>
            <SettingsGroup part="settings.update.version-group">
              <Version row={u()} onInstall={install} />
              <Checked client={props.client} row={u()} />
            </SettingsGroup>
            <Confirm
              open={asking()}
              row={u()}
              onClose={() => setAsking(false)}
              onConfirm={() => {
                setAsking(false);
                send(true);
              }}
            />
          </>
        )}
      </Show>
    </>
  );
}
