// Settings → Setup (ADR-0034, ADR-0026 "wisp as code"): everything set up here as code. What it holds (crew,
// agents, workflows, triggers… with how many of each); Share setup (the whole setup or some kinds, as the formula
// `wisp export` writes, to copy or save); and Import (paste a formula: the plan as cards, added, changed and
// removed in words, each ticked; the secrets it needs; what it would let act; then Apply, which rolls everything
// back if one fails).
import { createMemo, createResource, createSignal, For, Show, type JSX } from 'solid-js';
import { defineCommand, type PeerId, type PluginClient } from '@wisp/client';
import { useShell } from '@wisp/shell';
import { Button, Callout, Checkbox, Code, Inline, SettingsGroup, SettingsRow, Stack, Text, TextArea } from '@wisp/ui';
import { t } from './i18n.ts';
import { changeLines, formatOf, groups, keyOf, kindCounts, opTitle, picked, type KindInfo, type Plan, type Resource } from './model.ts';

const kinds = defineCommand<{ peer: PeerId }, KindInfo[]>({ id: 'resources.kinds', owner: (a) => a.peer, wire: () => ({}), optimistic: 'none', pending: 'the kinds' });
const exported = defineCommand<{ peer: PeerId }, Resource[]>({ id: 'resources.export', owner: (a) => a.peer, wire: () => ({}), optimistic: 'none', pending: 'your setup' });
const write = defineCommand<{ peer: PeerId; kinds: string[] }, { text: string; count: number }>({
  id: 'resources.write',
  owner: (a) => a.peer,
  wire: (a) => ({ kinds: a.kinds }),
  optimistic: 'none',
  pending: 'Share setup',
});
const read = defineCommand<{ peer: PeerId; text: string }, { resources: Resource[]; secrets: string[] }>({
  id: 'resources.read',
  owner: (a) => a.peer,
  wire: (a) => ({ text: a.text, format: formatOf(a.text) }),
  optimistic: 'none',
  pending: 'Import',
});
const plan = defineCommand<{ peer: PeerId; resources: Resource[] }, Plan>({
  id: 'resources.plan',
  owner: (a) => a.peer,
  wire: (a) => ({ resources: a.resources }),
  optimistic: 'none',
  pending: 'the plan',
});
const apply = defineCommand<{ peer: PeerId; resources: Resource[] }, unknown>({
  id: 'resources.apply',
  owner: (a) => a.peer,
  wire: (a) => ({ resources: a.resources, trust: true }),
  optimistic: 'none',
  pending: 'Apply',
});

// size-ok: one pane in three parts that share its peer and its toasts
export default function Setup(props: { readonly client: PluginClient }): JSX.Element {
  const c = props.client;
  const shell = useShell();
  const peer = c.home;
  const say = t as (k: string, v?: Readonly<Record<string, string | number>>) => string;
  const [ks] = createResource(() => c.run(kinds, { peer }).catch((): KindInfo[] => []));
  // reading every kind takes a few seconds (the harness kind looks for each harness): say so meanwhile
  const [have, { refetch }] = createResource(() => c.run(exported, { peer }).catch((): Resource[] => []));
  const counts = createMemo(() => kindCounts(ks() ?? [], have() ?? []));
  // Share setup
  const [sharing, setSharing] = createSignal<ReadonlySet<string>>(new Set());
  const [text, setText] = createSignal('');
  const [writing, setWriting] = createSignal(false);
  const share = (): void => {
    setWriting(true);
    void c
      .run(write, { peer, kinds: [...sharing()] })
      .then(
        (w) => setText(w.text),
        () => undefined,
      )
      .finally(() => setWriting(false));
  };
  const copy = (): void => void shell.platform.copy(text()).then((ok) => ok && shell.toast.show(t('resources.share.copied')));
  // Import
  const [pasted, setPasted] = createSignal('');
  const [read_, setRead] = createSignal<{ resources: Resource[]; secrets: string[] } | undefined>(undefined);
  const [thePlan, setPlan] = createSignal<Plan | undefined>(undefined);
  const [off, setOff] = createSignal<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = createSignal(false);
  const look = (): void => {
    setBusy(true);
    c.run(read, { peer, text: pasted() })
      .then(async (r) => {
        setRead(r);
        setOff(new Set<string>());
        setPlan(await c.run(plan, { peer, resources: r.resources }));
      })
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };
  const go = (): void => {
    const r = read_();
    const p = thePlan();
    if (!r || !p) return;
    setBusy(true);
    c.run(apply, { peer, resources: picked(r.resources, p, off()) })
      .then(() => {
        shell.toast.success(t('resources.import.done'));
        setPasted('');
        setRead(undefined);
        setPlan(undefined);
        void refetch();
      })
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };
  const toggle = (set: ReadonlySet<string>, k: string): Set<string> => {
    const n = new Set(set);
    if (n.has(k)) n.delete(k);
    else n.add(k);
    return n;
  };
  return (
    <>
      <SettingsGroup part="resources.have" title={t('resources.have')} description={t('resources.have.hint')}>
        <Show
          when={counts().length > 0}
          fallback={<SettingsRow part="resources.have.none" title="" description={t(have.loading ? 'resources.have.loading' : 'resources.have.none')} control={<span />} />}
        >
          <For each={counts()}>
            {(k) => (
              <SettingsRow
                part="resources.kind"
                title={k.section}
                description={say('resources.count', { count: k.count })}
                control={<Checkbox aria-label={t('resources.share.include')} checked={sharing().has(k.kind)} onChange={() => setSharing(toggle(sharing(), k.kind))} />}
              />
            )}
          </For>
        </Show>
      </SettingsGroup>
      <SettingsGroup part="resources.share" title={t('resources.share')} description={t('resources.share.hint')}>
        <SettingsRow
          part="resources.share.go"
          title={sharing().size ? say('resources.share.some', { count: sharing().size }) : t('resources.share.all')}
          control={
            <Button size="sm" variant="secondary" icon="share" loading={writing()} onClick={share}>
              {t('resources.share.make')}
            </Button>
          }
        />
        <Show when={text()}>
          <Code block lang="yaml" title="wisp.yml" part="resources.share.text">
            {text()}
          </Code>
          <SettingsRow
            part="resources.share.copy"
            title=""
            control={
              <Button size="sm" variant="ghost" icon="copy" onClick={copy}>
                {t('resources.share.copy')}
              </Button>
            }
          />
        </Show>
      </SettingsGroup>
      <SettingsGroup part="resources.import" title={t('resources.import')} description={t('resources.import.hint')}>
        <TextArea part="resources.import.text" value={pasted()} onInput={setPasted} minRows={4} maxRows={14} placeholder={t('resources.import.placeholder')} aria-label={t('resources.import')} />
        <SettingsRow
          part="resources.import.look"
          title=""
          control={
            <Button size="sm" variant="secondary" loading={busy() && !thePlan()} disabled={!pasted().trim()} onClick={look}>
              {t('resources.import.look')}
            </Button>
          }
        />
      </SettingsGroup>
      <Show when={thePlan()}>
        {(p) => (
          <Stack gap="3" part="resources.plan">
            <Show when={(p().problems ?? []).length > 0}>
              <Callout tone="bad" title={t('resources.plan.problems')}>
                {(p().problems ?? []).join('\n')}
              </Callout>
            </Show>
            <Show when={(p().missing_secrets ?? []).length > 0}>
              <Callout tone="warn" title={t('resources.plan.secrets')}>
                {say('resources.plan.secretsList', { names: (p().missing_secrets ?? []).join(', ') })}
              </Callout>
            </Show>
            <Show when={(p().sensitive ?? []).length > 0}>
              <Callout tone="warn" title={t('resources.plan.trust')}>
                {(p().sensitive ?? []).join('\n')}
              </Callout>
            </Show>
            <For each={groups(p())}>
              {(g) => (
                <SettingsGroup part="resources.plan.group" title={say(`resources.plan.${g.id}`, { count: g.ops.length })}>
                  <For each={g.ops}>
                    {(o) => (
                      <SettingsRow
                        part="resources.op"
                        title={opTitle(o, say)}
                        description={changeLines(o).join(' · ') || undefined}
                        control={
                          <Show when={o.op !== 'delete'}>
                            <Checkbox aria-label={t('resources.plan.take')} checked={!off().has(keyOf(o))} onChange={() => setOff(toggle(off(), keyOf(o)))} />
                          </Show>
                        }
                      />
                    )}
                  </For>
                </SettingsGroup>
              )}
            </For>
            <Inline gap="2" justify="between">
              <Text size="sm" tone="muted">
                {say('resources.plan.unchanged', { count: p().unchanged })}
              </Text>
              <Button size="sm" variant="primary" loading={busy()} disabled={(p().problems ?? []).length > 0 || groups(p()).length === 0} onClick={go}>
                {t('resources.plan.apply')}
              </Button>
            </Inline>
          </Stack>
        )}
      </Show>
    </>
  );
}
