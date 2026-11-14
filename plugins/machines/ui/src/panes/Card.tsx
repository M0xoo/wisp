// One machine in Machines (v1 machines.js card): what it is and where, its state and one button (Connect, Try again,
// Wake, Disconnect, Cancel), ⋯ (Edit, Restart / Stop wisp there, Remove); online: its wisp version, Update to X and its
// coding agents; connecting or failed: the steps; failed: what to do, with Let me in (the password once) when the key
// isn't allowed in yet.
import { createSignal, Show, type JSX } from 'solid-js';
import { Button, Callout, CopyCommand, Inline, Input, Link, Menu, Pill, SettingsRow, Stack, Steps, Text } from '@wisp/ui';
import type { PeerBody, PeerView, StatusBody } from '../commands.ts';
import { t } from '../i18n.ts';
import { kindOf, menuOf, offersLetIn, primaryOf, removeLabel, stepsOf, troubleTitle, whereOf } from '../view.ts';

const say = t as (k: string, v?: Readonly<Record<string, string | number>>) => string;
const TAILSCALE_GUIDE = 'https://trywisp.dev/guides/connect-machines-with-tailscale.html';
const TONE: Readonly<Record<string, 'good' | 'warn' | 'bad' | 'neutral'>> = { online: 'good', connecting: 'neutral', reconnecting: 'warn', asleep: 'neutral', off: 'neutral', error: 'bad', incompatible: 'bad' };
const ICON = { ssh: 'server', grid: 'laptop', cloud: 'cloud' } as const;

export type CardAct = 'connect' | 'disconnect' | 'edit' | 'restart' | 'update' | 'stop' | 'remove';

export interface CardProps {
  readonly m: PeerBody;
  readonly s: StatusBody | undefined;
  readonly view: PeerView | undefined;
  readonly onAct: (a: CardAct) => void;
  /** the password: resolves when it went in, rejects with what to do */
  readonly onLetIn: (password: string) => Promise<void>;
  readonly onCopy: (command: string) => void;
  /** the edit form, while it's open on this card */
  readonly editing?: JSX.Element;
}

function LetIn(props: { readonly host: string; readonly command?: string; readonly onLetIn: (p: string) => Promise<void>; readonly onCopy: (c: string) => void }): JSX.Element {
  const [pw, setPw] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [err, setErr] = createSignal('');
  const go = (): void => {
    if (!pw() || busy()) return;
    setBusy(true);
    setErr('');
    props.onLetIn(pw()).then(
      () => setPw(''),
      (e: unknown) => setErr(e instanceof Error ? e.message : String(e)),
    ).finally(() => setBusy(false));
  };
  return (
    <Stack gap="2" part="machines.letin">
      <Inline gap="2">
        <Input
          type="password"
          size="sm"
          aria-label={t('machines.letin.label', { host: props.host })}
          placeholder={t('machines.letin.placeholder', { host: props.host })}
          value={pw()}
          onInput={setPw}
          onKeyDown={(e: KeyboardEvent) => e.key === 'Enter' && go()}
        />
        <Button size="sm" variant="primary" icon="lock" disabled={busy() || !pw()} onClick={go} part="machines.letin.go">
          {busy() ? t('machines.letin.busy') : t('machines.letin.go')}
        </Button>
      </Inline>
      <Text size="sm" tone="muted">
        {t('machines.letin.never')}
      </Text>
      <Show when={err()}>{(e) => <Text tone="bad" part="machines.letin.error">{e()}</Text>}</Show>
      <Show when={props.command}>
        {(cmd) => (
          <Stack gap="1">
            <Text size="sm" tone="muted">
              {t('machines.letin.byHand')}
            </Text>
            <CopyCommand command={cmd()} label={t('machines.copy')} onCopy={props.onCopy} />
          </Stack>
        )}
      </Show>
    </Stack>
  );
}

function Trouble(props: { readonly m: PeerBody; readonly s: StatusBody; readonly view: PeerView | undefined; readonly onAct: (a: CardAct) => void; readonly onLetIn: (p: string) => Promise<void>; readonly onCopy: (c: string) => void }): JSX.Element {
  const h = () => props.s.hint ?? undefined;
  const log = (): string => [...new Set([h()?.title ? props.s.error : '', ...(props.view?.log ?? [])].filter(Boolean))].join('\n');
  return (
    <Callout tone={props.s.state === 'reconnecting' ? 'warn' : 'bad'} title={troubleTitle(props.s, say)} part="machines.trouble">
      <Stack gap="2">
        <Show when={h()?.text}>{(x) => <Text size="sm">{x()}</Text>}</Show>
        <Show
          when={offersLetIn(props.s)}
          fallback={<Show when={h()?.command}>{(cmd) => <CopyCommand command={cmd()} label={t('machines.copy')} onCopy={props.onCopy} />}</Show>}
        >
          <LetIn host={props.m.address.replace(/^.*@/, '')} {...(h()?.command && { command: h()?.command as string })} onLetIn={props.onLetIn} onCopy={props.onCopy} />
        </Show>
        <Show when={h()?.url}>
          {(u) => (
            <Link href={u()} external>
              {t('machines.getNode')}
            </Link>
          )}
        </Show>
        <Show when={h()?.tailscale}>
          <Link href={TAILSCALE_GUIDE} external>
            {t('machines.tailscale.anywhere')}
          </Link>
        </Show>
        <Show when={props.s.stale}>
          <Button size="sm" variant="ghost" icon="replay" onClick={() => props.onAct('restart')}>
            {t('machines.restart')}
          </Button>
        </Show>
        <Show when={log()}>
          <Text size="sm" mono tone="muted" part="machines.log">
            {log()}
          </Text>
        </Show>
      </Stack>
    </Callout>
  );
}

export function MachineCard(props: CardProps): JSX.Element {
  const st = (): string => props.s?.state ?? 'off';
  const k = () => kindOf(props.m);
  const p = () => primaryOf(props.m, st());
  const stateText = (): string => (k() === 'grid' && st() === 'asleep' ? t('machines.state.offline') : say(`machines.state.${st()}`));
  const ready = () => (props.s?.remote?.agents ?? []).filter((a) => a.available);
  const busy = (): boolean => st() === 'connecting' || st() === 'reconnecting';
  return (
    <Stack gap="2" part="machines.card">
      <SettingsRow
        part="machines.row"
        wideControl
        tile={ICON[k()]}
        title={props.m.name}
        description={
          <>
            <Pill size="sm" variant="outline">
              {say(`machines.kind.${k()}`)}
            </Pill>{' '}
            {whereOf(props.m, say)}
          </>
        }
        control={
          <Inline gap="2">
            <Pill tone={TONE[st()] ?? 'neutral'} dot live={busy()} variant="plain">
              {stateText()}
            </Pill>
            <Button size="sm" variant={p().primary ? 'primary' : 'ghost'} onClick={() => props.onAct(p().act)} part="machines.row.go">
              {say(p().label)}
            </Button>
            <Menu
              trigger={{ icon: 'dots', 'aria-label': t('machines.more', { name: props.m.name }), variant: 'ghost', size: 'sm' }}
              items={menuOf(props.m, st()).flatMap((a) => [
                ...(a === 'remove' ? [{ kind: 'separator' as const }] : []),
                {
                  value: a,
                  label: a === 'remove' ? say(removeLabel(props.m)) : say(`machines.menu.${a}`),
                  icon: ({ edit: 'pen', restart: 'replay', stop: 'stop', remove: 'trash' } as const)[a],
                  ...((a === 'remove' || a === 'stop') && { danger: true }),
                },
              ])}
              onSelect={(v) => props.onAct(v as CardAct)}
            />
          </Inline>
        }
      />
      <Show when={st() === 'online'}>
        <Inline gap="2" part="machines.meta">
          <Text size="sm" tone="muted">
            {t('machines.version', { version: props.s?.remote?.version ?? '' })}
          </Text>
          <Show when={props.view?.outdated}>
            {(v) => (
              <Button size="sm" variant="ghost" icon="replay" title={t('machines.update.title', { name: props.m.name, version: v() })} onClick={() => props.onAct('update')} part="machines.update">
                {t('machines.update', { version: v() })}
              </Button>
            )}
          </Show>
          <Show when={ready().length > 0} fallback={<Text size="sm" tone="bad">{t('machines.noAgents')}</Text>}>
            <Text size="sm" tone="muted" part="machines.agents">
              {ready()
                .map((a) => a.name || a.id)
                .join(' · ')}
            </Text>
          </Show>
          <Show when={(props.view?.working ?? 0) > 0}>
            <Text size="sm" tone="muted">
              {t('machines.working', { count: props.view?.working ?? 0 })}
            </Text>
          </Show>
        </Inline>
      </Show>
      <Show when={(busy() || st() === 'error') && (props.s?.steps?.length ?? 0) > 0}>
        <Steps items={stepsOf(props.s?.steps)} part="machines.steps" />
      </Show>
      <Show when={(st() === 'error' || st() === 'reconnecting') && props.s?.error ? props.s : undefined}>
        {(s) => <Trouble m={props.m} s={s()} view={props.view} onAct={props.onAct} onLetIn={props.onLetIn} onCopy={props.onCopy} />}
      </Show>
      {props.editing}
    </Stack>
  );
}
