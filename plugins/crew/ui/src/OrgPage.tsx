// Org (v1 org.js, F-crew-14): the whole crew as a chart of who hands work to whom, and the place to change it. The
// rail's Org, a member's "No delegates ›" and ⌘K open it. Members sit in tiers (org-graph.ts); arrows go from a
// member to its delegates. Select one and the rest of the chart becomes its picker: + makes that one its delegate,
// ✓ takes it off. The column beside it says how it works, or, for the selected member, who it hands work to and gets
// work from, each with a ×. Every change is one optimistic crew.update of the member's team (rolled back with a
// toast if refused).
import { createMemo, createSignal, For, Show, type JSX } from 'solid-js';
import type { EntityKey, PluginClient } from '@wisp/client';
import { useShell } from '@wisp/shell';
import { Icon, OrgMe, OrgPerson, OrgSection, OrgView, useSignal, type OrgCard, type OrgEdge } from '@wisp/ui';
import { updateMember } from './commands.ts';
import { crewData } from './data.ts';
import { t, type Key } from './i18n.ts';
import { cadenceText } from './model.ts';
import { alone, graph, linkTeam, tiers, unlinkTeam } from './more/org-graph.ts';
import type { Member } from './types.ts';
import { VIEW } from './views.ts';

type Row = Member & { readonly key: EntityKey };

// size-ok: one page whose parts share the graph and the selection
export default function OrgPage(props: { readonly client: PluginClient }): JSX.Element {
  const c = props.client;
  const shell = useShell();
  const say = t as (k: string, v?: Readonly<Record<string, string | number>>) => string;
  const data = crewData(c);
  const members = useSignal(data.members);
  const harnesses = useSignal(shell.harnesses());
  // a row may leave out an empty team (the store skips it): no delegates
  const list = createMemo(() => (members() as unknown as readonly Row[]).map((m) => (Array.isArray(m.team) ? m : { ...m, team: [] })));
  const g = createMemo(() => graph(list()));
  const [sel, setSel] = createSignal<string | undefined>();
  const byId = (id: string): Row | undefined => list().find((m) => m.id === id);
  const selected = (): Row | undefined => (sel() ? byId(sel() as string) : undefined);

  const card = (m: Row): OrgCard => ({ id: m.id, name: m.name, role: m.role || t('wisp.crew.org.member'), avatar: m.avatar, color: m.color, state: { text: m.paused ? t('wisp.crew.org.paused') : cadenceText(m, say as never) } });
  const links = (): number => [...g().out.values()].reduce((n, x) => n + x.length, 0);
  const count = (): string =>
    list().length
      ? [say('wisp.crew.org.members', { count: list().length }), links() ? say('wisp.crew.org.links', { count: links() }) : t('wisp.crew.org.noLinks')].join(' · ')
      : '';
  const edges = createMemo((): OrgEdge[] =>
    list().flatMap((m) =>
      (g().out.get(m.id) ?? []).map((to) => ({
        from: m.id,
        to,
        on: !!sel() && (m.id === sel() || to === sel()),
        off: !!m.machine,
        tip: `${m.name} → ${byId(to)?.name ?? ''}`,
      })),
    ),
  );
  const setTeam = (m: Row, team: Member['team']): void => void c.run(updateMember, { key: m.key, id: m.id, team }).catch(() => undefined);
  const link = (fromId: string, toId: string): void => {
    const m = byId(fromId);
    const to = byId(toId);
    if (!m || !to) return;
    const next = linkTeam(m, to);
    if (next) setTeam(m, next);
  };
  const unlink = (fromId: string, toId: string): void => {
    const m = byId(fromId);
    if (m) setTeam(m, unlinkTeam(m, toId));
  };
  const isDelegate = (id: string): boolean => !!selected()?.team.some((x) => x.crew === id);
  const harnessOf = (id: string): { name: string; logo?: string | undefined } => {
    const h = harnesses().find((x) => x.id === id);
    return { name: h?.name ?? id, logo: h?.logo };
  };

  const hint = (): { text: string; on: boolean } | undefined => {
    const m = selected();
    if (m) return { text: say('wisp.crew.org.choosing', { name: m.name }), on: true };
    return list().length ? { text: t('wisp.crew.org.hint'), on: false } : undefined;
  };

  const side = (): JSX.Element => (
    <Show
      when={selected()}
      fallback={
        <>
          <OrgSection title={t('wisp.crew.org.how')}>
            <p>{t('wisp.crew.org.howText')}</p>
          </OrgSection>
          <Show when={list().some((m) => (g().out.get(m.id)?.length ?? 0) > 0)}>
            <OrgSection title={t('wisp.crew.org.handOut')}>
              <For each={list().filter((m) => (g().out.get(m.id)?.length ?? 0) > 0)}>
                {(m) => <OrgPerson name={m.name} sub={say('wisp.crew.org.delegates', { count: g().out.get(m.id)?.length ?? 0 })} avatar={m.avatar ?? ''} color={m.color} onPick={() => setSel(m.id)} />}
              </For>
            </OrgSection>
          </Show>
          <OrgSection title="" note>
            <p>
              <Icon name="info" size="sm" />
              <span>{t('wisp.crew.org.alone')}</span>
            </p>
          </OrgSection>
        </>
      }
    >
      {(m) => (
        <>
          <OrgMe
            name={m().name}
            role={m().role || t('wisp.crew.org.member')}
            avatar={m().avatar}
            color={m().color}
            state={{ text: cadenceText(m(), say as never) }}
            actions={[
              { icon: 'crew', label: t('wisp.crew.org.open'), onClick: () => c.navigate({ t: 'openCrew', id: m().key as never }) },
              { icon: 'pen', label: t('wisp.crew.org.edit'), onClick: () => c.navigate({ t: 'openOverlay', overlay: { kind: 'dialog', id: VIEW.editor as never, params: { id: m().id } } }) },
            ]}
          />
          <OrgSection title={t('wisp.crew.org.handsTo')} count={m().team.length || undefined}>
            <Show when={m().team.length > 0} fallback={<p>{t('wisp.crew.org.nobodyYet')}</p>}>
              <For each={m().team}>
                {(x) => {
                  const to = x.crew ? byId(x.crew) : undefined;
                  return to ? (
                    <OrgPerson name={to.name} sub={to.role} avatar={to.avatar ?? ''} color={to.color} onPick={() => setSel(to.id)} unlink={{ label: say('wisp.crew.org.remove', { name: to.name }), onClick: () => unlink(m().id, to.id) }} />
                  ) : (
                    <OrgPerson name={harnessOf(x.agent).name + ((x.count ?? 1) > 1 ? ` ×${x.count}` : '')} sub={x.use || x.label || x.name} logo={harnessOf(x.agent).logo} />
                  );
                }}
              </For>
            </Show>
          </OrgSection>
          <OrgSection title={t('wisp.crew.org.getsFrom')}>
            <Show when={(g().inc.get(m().id) ?? []).length > 0} fallback={<p>{say('wisp.crew.org.nobodyFrom', { name: m().name })}</p>}>
              <For each={(g().inc.get(m().id) ?? []).map(byId).filter((x): x is Row => !!x)}>
                {(x) => <OrgPerson name={x.name} sub={x.role} avatar={x.avatar ?? ''} color={x.color} onPick={() => setSel(x.id)} unlink={{ label: say('wisp.crew.org.stop', { name: x.name, to: m().name }), onClick: () => unlink(x.id, m().id) }} />}
              </For>
            </Show>
          </OrgSection>
        </>
      )}
    </Show>
  );

  return (
    <OrgView
      title={t('wisp.crew.org.title')}
      role={t('wisp.crew.org.role')}
      count={count()}
      actions={[{ id: 'add', icon: 'plus', label: t('wisp.crew.org.add'), title: t('wisp.crew.org.addTitle'), onClick: () => c.navigate({ t: 'openOverlay', overlay: { kind: 'dialog', id: VIEW.editor as never, params: {} } }) }]}
      close={{ label: t('wisp.crew.org.close'), onClick: () => c.navigate({ t: 'home' }) }}
      hint={hint()}
      tiers={tiers(list(), g()).map((tier) => tier.map(card))}
      alone={alone(list(), g()).map(card)}
      aloneLabel={t('wisp.crew.org.notConnected')}
      edges={edges()}
      selected={sel()}
      pick={(id) => (isDelegate(id) ? 'remove' : 'add')}
      pickLabel={(id, how) => say(how === 'add' ? 'wisp.crew.org.pickAdd' : 'wisp.crew.org.pickRemove', { name: byId(id)?.name ?? '', of: selected()?.name ?? '' })}
      onSelect={setSel}
      onPick={(id) => {
        const s = sel();
        if (!s) return;
        if (isDelegate(id)) unlink(s, id);
        else link(s, id);
      }}
      side={side()}
    />
  );
}

export type { Key };
