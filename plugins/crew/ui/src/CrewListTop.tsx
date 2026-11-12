// The phone's Crew section at the top of the list (v1 #secCrew): with no rail, the crew is reached here. A folding
// Crew heading with Org and +, a row per member opening their thread, a dashed row to add the first one.
import { createMemo, createSignal, Show, type JSX } from 'solid-js';
import type { ExtensionProps } from '@wisp/shell/contract';
import { useShell } from '@wisp/shell';
import { CrewListSection, useSignal, type CrewListRow } from '@wisp/ui';
import { crewData } from './data.ts';
import { t } from './i18n.ts';
import { cadenceText } from './model.ts';
import type { Member } from './types.ts';
import { VIEW } from './views.ts';

export default function CrewListTop(props: ExtensionProps): JSX.Element {
  const c = props.client;
  const shell = useShell();
  const nav = useSignal(shell.nav);
  const say = t as (k: string, v?: Readonly<Record<string, string | number>>) => string;
  const members = useSignal(crewData(c).members);
  const [folded, setFolded] = createSignal(false);
  const orgOn = (): boolean => nav().main.kind === 'view' && String((nav().main as { id?: unknown }).id) === VIEW.org;
  const rows = createMemo((): CrewListRow[] =>
    (members() as unknown as readonly (Member & { key: string })[]).map((m) => ({
      id: m.key,
      name: m.name,
      role: m.role,
      avatar: m.avatar,
      color: m.color,
      sub: m.paused ? t('wisp.crew.org.paused') : cadenceText(m, say as never),
      paused: m.paused,
    })),
  );
  return (
    // only where there's no rail: the phone's stacked list
    <Show when={nav().layout === 'stack'}>
      <CrewListSection
        name={t('wisp.crew.list.name')}
        count={rows().length}
        collapsed={folded()}
        onToggle={() => setFolded(!folded())}
        org={rows().length > 0 ? { label: t('wisp.crew.org.title'), title: t('wisp.crew.list.orgTitle'), on: orgOn(), onClick: () => c.navigate({ t: 'openView', id: VIEW.org as never, params: null }) } : undefined}
        add={{ label: t('wisp.crew.org.addTitle'), onClick: () => c.navigate({ t: 'openOverlay', overlay: { kind: 'dialog', id: VIEW.editor as never, params: {} } }) }}
        rows={rows()}
        empty={{ title: t('wisp.crew.list.emptyTitle'), sub: t('wisp.crew.list.emptySub') }}
        openLabel={(name) => say('wisp.crew.list.open', { name })}
        onOpen={(id) => c.navigate({ t: 'openCrew', id: id as never })}
      />
    </Show>
  );
}
