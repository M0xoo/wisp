// Share… (v1 crew-share.js shareMember): one member or the whole crew as a .crew.json. What goes along (their name,
// brief, schedule, mode and harness) and what stays (project, computer, log, jobs); the kit, notebook and delegates
// to tick; the peer's check of it (crew.export: notes, and a secret that refuses it) on every change; then Download
// or Copy, or Share link (crew.share, ADR-0052: a wisp Cloud link like every other share, no GitHub token). Whoever
// adds them picks a project, and they join paused (Import…, which takes the link).
import { createEffect, createSignal, For, on, Show, type JSX } from 'solid-js';
import { defineCommand, type PeerId, type PluginClient } from '@wisp/client';
import { useShell } from '@wisp/shell';
import { Button, Checkbox, Face, Icon, Inline, Input, Stack, Text, useSignal } from '@wisp/ui';
import { crewData, type CrewMember } from './data.ts';
import { t } from './i18n.ts';
import { cadenceText } from './model.ts';
import { bundleText, shareNotes, shareWhat, type ShareOpts } from './share.ts';
import { VIEW } from './views.ts';

interface Exported {
  readonly bundle: Record<string, unknown>;
  readonly notes: readonly string[];
  readonly file: string;
}

const exportCrew = defineCommand<{ peer: PeerId; ids: string[] } & ShareOpts, Exported>({
  id: 'crew.export',
  owner: (a) => a.peer,
  wire: ({ peer: _p, ...rest }) => rest,
  optimistic: 'none',
  pending: 'the share dialog’s check line',
});

interface SharedLink {
  readonly url: string;
}

// a link on wisp Cloud (crew.share): the pressed button shows its pending ring until the link comes back
const shareLink = defineCommand<{ peer: PeerId; ids: string[] } & ShareOpts, SharedLink>({
  id: 'crew.share',
  owner: (a) => a.peer,
  wire: ({ peer: _p, ...rest }) => rest,
  optimistic: 'none',
  pending: 'the share dialog’s Share link button',
});

/** A file saved from the page: the browser's download (the link freed a second later, through the plugin's scope). */
function download(c: PluginClient, name: string, text: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name;
  a.click();
  c.scope.timeout(1000, () => URL.revokeObjectURL(a.href));
}

export default function ShareCrew(props: { readonly client: PluginClient; readonly params: unknown }): JSX.Element {
  const c = props.client;
  const shell = useShell();
  const say = t as (k: string, v?: Readonly<Record<string, string | number>>) => string;
  const all = useSignal(crewData(c).members);
  const ids = (): readonly string[] => ((props.params as { ids?: unknown } | null)?.ids as string[] | undefined) ?? all().map((m) => m.id);
  const members = (): CrewMember[] => all().filter((m) => ids().includes(m.id) || ids().includes(m.key));
  const one = (): CrewMember | undefined => (members().length === 1 ? members()[0] : undefined);
  const what = () => shareWhat(members(), all());
  const [opts, setOpts] = createSignal<ShareOpts>(what().start);
  const [out, setOut] = createSignal<{ r?: Exported; bad?: string } | undefined>(undefined);
  const [link, setLink] = createSignal<string | undefined>(undefined);
  const [linking, setLinking] = createSignal(false);
  const [copied, setCopied] = createSignal(false);
  // the whole crew (no ids) is kept under one link, so sharing it again updates that link
  const whole = (): boolean => !(props.params as { ids?: unknown } | null)?.ids;
  const close = (): void => c.navigate({ t: 'closeOverlay', id: VIEW.share as never });
  let seq = 0;
  // the file for these options, checked by the peer (its secret scan refuses one with a key in it)
  createEffect(
    on([opts, () => members().map((m) => m.id).join()], ([o, key]) => {
      if (!key) return;
      const n = ++seq;
      setOut(undefined); // Copy and Download wait for the bundle these options make
      setLink(undefined); // a link made for other options isn't this one
      c.run(exportCrew, { peer: c.home, ids: members().map((m) => m.id), ...o })
        .then((r) => n === seq && setOut({ r }))
        .catch((e: unknown) => n === seq && setOut({ bad: e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e) }));
    }),
  );
  const title = (): string => one()?.name ?? t('wisp.crew.share.crew');
  const copy = (): void => {
    const r = out()?.r;
    if (!r) return;
    void navigator.clipboard.writeText(bundleText(r.bundle)).then(
      () => {
        close();
        shell.toast.success(say('wisp.crew.share.copied', { name: title() }));
      },
      () => shell.toast.error(t('wisp.crew.share.copyFailed')),
    );
  };
  const save = (): void => {
    const r = out()?.r;
    if (!r) return;
    download(c, r.file, bundleText(r.bundle));
    close();
  };
  const makeLink = (): void => {
    if (!out()?.r || linking()) return;
    setLinking(true);
    const n = seq; // options changed while it ran: that link isn't for what's ticked now
    c.run(shareLink, { peer: c.home, ids: whole() ? [] : members().map((m) => m.id), ...opts() })
      .then((r) => n === seq && setLink(r.url))
      .catch((e: unknown) => shell.toast.error(e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e)))
      .finally(() => setLinking(false));
  };
  const copyLink = (): void => {
    const url = link();
    if (!url) return;
    void navigator.clipboard.writeText(url).then(
      () => {
        setCopied(true);
        c.scope.timeout(2200, () => setCopied(false));
      },
      () => shell.toast.error(t('wisp.crew.share.copyFailed')),
    );
  };
  const set = (k: keyof ShareOpts, v: boolean): void => void setOpts({ ...opts(), [k]: v });
  return (
    <Stack gap="4" part="crew.share">
      <Inline gap="3" align="center">
        <For each={members()}>{(m) => <Face avatar={m.avatar} name={m.name} color={m.color} size={one() ? 'lg' : 'sm'} mood="idle" />}</For>
        <Stack gap="0">
          <Text weight="semibold">{one()?.name ?? say('wisp.crew.share.members', { count: members().length })}</Text>
          <Text size="sm" tone="muted">
            {one() ? [one()?.role, cadenceText(one() as CrewMember, say as never)].filter(Boolean).join(' · ') : members().map((m) => m.name).join(', ')}
          </Text>
        </Stack>
      </Inline>
      <Text size="sm" tone="muted">
        {t('wisp.crew.share.hint')}
      </Text>
      <Stack gap="2">
        <Checkbox
          checked={opts().kit}
          disabled={!what().kits}
          label={what().kits ? say('wisp.crew.share.kit', { count: what().kits }) : t('wisp.crew.share.kitNone')}
          onChange={(v) => set('kit', v)}
        />
        <Checkbox checked={opts().notebook} disabled={!what().noted} label={t(what().noted ? 'wisp.crew.share.notebook' : 'wisp.crew.share.notebookNone')} onChange={(v) => set('notebook', v)} />
        <Show when={what().mates.length}>
          <Checkbox checked={opts().team} label={say('wisp.crew.share.team', { names: what().mates.join(', ') })} onChange={(v) => set('team', v)} />
        </Show>
      </Stack>
      <div aria-live="polite">
        <Show when={out()?.bad} fallback={<For each={shareNotes(out()?.r?.notes ?? [], what().mates)}>{(n) => <Inline gap="2" align="start"><Icon name="info" size="sm" tone="muted" /><Text size="sm" tone="muted">{n}</Text></Inline>}</For>}>
          {(b) => (
            <Inline gap="2" align="start">
              <Icon name="lock" size="sm" tone="bad" />
              <Text size="sm" tone="bad">
                {b()}
              </Text>
            </Inline>
          )}
        </Show>
      </div>
      <Show when={link()}>
        {(url) => (
          <Stack gap="1" part="crew.share.link">
            <Inline gap="2">
              <Input aria-label={t('wisp.crew.share.link')} value={url()} readOnly mono />
              {/* the label keeps its width: "Copied" is no wider than "Copy link" */}
              <Button size="sm" icon={copied() ? 'check' : 'copy'} onClick={copyLink}>
                {t(copied() ? 'wisp.crew.share.linkCopied' : 'wisp.crew.share.copyLink')}
              </Button>
            </Inline>
            <Text size="sm" tone="muted">
              {t('wisp.crew.share.linkHint')}
            </Text>
          </Stack>
        )}
      </Show>
      <Inline gap="2" justify="end">
        <Button variant="ghost" size="sm" icon="download" disabled={!out()?.r} onClick={save}>
          {t('wisp.crew.share.download')}
        </Button>
        <Button variant="ghost" size="sm" icon="copy" disabled={!out()?.r} onClick={copy}>
          {t('wisp.crew.share.copy')}
        </Button>
        <Show when={!link()}>
          <Button variant="primary" size="sm" icon="share" disabled={!out()?.r} loading={linking()} onClick={makeLink}>
            {t('wisp.crew.share.makeLink')}
          </Button>
        </Show>
      </Inline>
    </Stack>
  );
}
