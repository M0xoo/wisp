// Usage at a glance under Home's prompt box (v1 #790 split.js paintUsage): each plan's 5-hour and fullest weekly
// window as a thin meter, amber near the line, red when used up; the row opens Settings → Usage. Hidden until a CLI
// reports its plan. Read again whenever the plan topic changes (a run recorded its windows, a setting moved): no polling.
import { createMemo, createResource, onCleanup, type JSX } from 'solid-js';
import { entityKey } from '@wisp/client';
import type { ExtensionProps } from '@wisp/shell/contract';
import { useShell } from '@wisp/shell';
import { englishT, HomeUsage as HomeUsageRow, timeLabel, useSignal, type HomeUsageGroup } from '@wisp/ui';
import { accountNames, agents, META, plans, TOPIC, type AccountPlan } from './commands.ts';
import { pct } from './drain.ts';
import { holdLine, homeTone, homeUsage, type HomeHarness } from './home-usage.ts';
import { stopLine, windowLine } from './plan.ts';
import { t } from './i18n.ts';
import { fromRow } from './source.ts';

const PLANNED = [
  { agent: 'claude', name: 'Claude Code', key: 'autoStopClaude' },
  { agent: 'codex', name: 'Codex', key: 'autoStopCodex' },
] as const;

export default function HomeUsage(props: ExtensionProps): JSX.Element {
  const c = props.client;
  const peer = c.home;
  const scope = c.scope.child('home-usage');
  onCleanup(() => scope.dispose());
  c.watch(peer, TOPIC, scope, { passive: true });
  // the plan's rows (budget_acc): each change is a new reading, so the windows are asked again
  const accs = useSignal(c.entities.list('budget_acc'));
  const meta = useSignal(c.entities.row<{ body: Record<string, string> }>(META, entityKey(peer, 'settings')));
  const holdSrc = fromRow(c, 'budget.limitHold', '90');
  const marks = useSignal(useShell().harnesses());
  const logoOf = (id: string): string | undefined => marks().find((m) => m.id === id)?.logo;
  // which harnesses are set up here: detecting them takes a while, so the row shows before and drops one that isn't
  const [setUp] = createResource(() => c.run(agents, { peer }).catch(() => [] as { id: string; available: boolean }[]));
  const [read] = createResource(
    () => ({ n: accs().length, rows: accs() }),
    async () =>
      Promise.all(
        PLANNED.map(async (p) => {
          const [accounts, names] = await Promise.all([
            c.run(plans, { peer, agent: p.agent }).catch(() => [] as AccountPlan[]),
            c.run(accountNames, { peer, agent: p.agent }).catch(() => ({ accounts: [] })),
          ]);
          return { agent: p.agent, name: p.name, accounts, names: names.accounts };
        }),
      ),
  );
  const when = (at: number): string => timeLabel(at, Date.now(), englishT);
  const groups = createMemo((): HomeUsageGroup[] => {
    const known = setUp();
    const list: HomeHarness[] = (read.latest ?? []).map((h) => ({ ...h, available: known?.length ? (known.find((a) => a.id === h.agent)?.available ?? false) : undefined }));
    const body = meta()?.body ?? {};
    const hold = holdLine((holdSrc.value as () => unknown)());
    return homeUsage(list).map((r) => {
      const stop = stopLine(body[PLANNED.find((p) => p.agent === r.agent)?.key ?? ''], body['autoStop']);
      const who = r.accountLabel ? t('budget.home.who', { name: r.name, account: r.accountLabel }) : r.name;
      return {
        key: `${r.agent}:${r.account}`,
        logo: logoOf(r.agent),
        who,
        account: r.accountLabel || undefined,
        windows: r.windows.map((w) => ({
          key: w.id,
          short: w.short,
          used: w.used,
          pct: pct(w.used),
          tone: homeTone(w, stop, hold),
          tip: t('budget.home.tip', { who, label: w.label, pct: pct(w.used), line: windowLine(w, stop, when) }),
          aria: t('budget.home.aria', { who, label: w.label }),
        })),
      };
    });
  });
  const open = (): void => c.navigate({ t: 'openOverlay', overlay: { kind: 'viewer', id: 'shell-settings.sheet' as never, params: { pane: 'usage' } } });
  return <HomeUsageRow part="home.usage.row" groups={groups()} title={t('budget.home.title')} onOpen={open} />;
}
