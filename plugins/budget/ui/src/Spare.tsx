// Home's notes on plans (v1 split.js paintSpare): Spare allowance (a long window resetting within a day with a fifth
// or more left: "38% of Codex’s weekly window left · resets 21:00", Use Codex, ×) and Window changes (a window that
// appeared, went, changed length or moved its reset: its line and ×), two of each at most. Settings → Usage turns
// either off (budget.spareCard, budget.windowNotice). Use only puts the harness in the prompt box.
import { createResource, createMemo, onCleanup, type JSX } from 'solid-js';
import type { ExtensionProps } from '@wisp/shell/contract';
import { useShell } from '@wisp/shell';
import { englishT, SpareCards, timeLabel, useSignal, type SpareCard } from '@wisp/ui';
import { dismissNotice, plans, TOPIC, type AccountPlan } from './commands.ts';
import { noticeWords } from './drain.ts';
import { t } from './i18n.ts';
import { fromRow } from './source.ts';
import { pruneSeen, spareKey, spareOf, spareWhose } from './spare.ts';

const PLANNED = [
  { agent: 'claude', name: 'Claude Code' },
  { agent: 'codex', name: 'Codex' },
] as const;
const EVERY = 5 * 60_000;

const on = (v: unknown, dflt: boolean): boolean => (v === true || v === 'on' ? true : v === false || v === 'off' ? false : dflt);

export default function Spare(props: ExtensionProps): JSX.Element {
  const c = props.client;
  const peer = c.home;
  const scope = c.scope.child('home-spare');
  onCleanup(() => scope.dispose());
  c.watch(peer, TOPIC, scope, { passive: true });
  const marks = useSignal(useShell().harnesses());
  const logoOf = (id: string): string | undefined => marks().find((m) => m.id === id)?.logo;
  const spareOn = fromRow(c, 'budget.spareCard', true);
  const noticeOn = fromRow(c, 'budget.windowNotice', true);
  const seenStore = c.defineStore<Record<string, number>>({
    id: 'budget.spareSeen',
    version: 1,
    defaults: {},
    persist: true,
    check: (v) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, number>) : undefined),
  });
  const seen = useSignal(seenStore.value);
  const now = (): number => c.scope.timers.now();
  const [windows, { refetch: again }] = createResource(async () => {
    const out: { agent: string; name: string; accounts: AccountPlan[] }[] = [];
    for (const p of PLANNED) out.push({ ...p, accounts: await c.run(plans, { peer, agent: p.agent }).catch(() => []) });
    return out;
  });
  // read again every few minutes: a reset comes closer, a window resets (the cards follow)
  scope.interval(EVERY, () => void again());
  const when = (at: number): string => timeLabel(at, now(), englishT);
  const cards = createMemo((): SpareCard[] => {
    const list = windows() ?? [];
    const spare = on((spareOn.value as () => unknown)(), true) ? spareOf(list, { now: now(), seen: seen() as Record<string, number> }).slice(0, 2) : [];
    const out: SpareCard[] = spare.map((x) => ({
      key: spareKey(x),
      logo: logoOf(x.agent),
      bold: `${Math.round(x.left * 100)}%`,
      text: t('budget.spare.text', { whose: spareWhose(x), when: when(x.resetsAt) }),
      tip: t('budget.spare.tip', { when: when(x.resetsAt) }),
      label: t('budget.spare.label', { left: Math.round(x.left * 100), whose: spareWhose(x), when: when(x.resetsAt) }),
      ...(props.pickAgent && { use: { label: t('budget.spare.use', { name: x.name }), title: t('budget.spare.useTitle', { name: x.name }), onClick: () => props.pickAgent?.(x.agent) } }),
      hide: { label: t('budget.spare.hide'), onClick: () => seenStore.set((cur) => ({ ...pruneSeen(cur as Record<string, number>, now()), [spareKey(x)]: x.resetsAt })) },
    }));
    if (on((noticeOn.value as () => unknown)(), true)) {
      const notes = list.flatMap((h) => h.accounts.flatMap((a) => (a.notices ?? []).map((n) => ({ h, a, n })))).slice(0, 2);
      for (const { h, a, n } of notes)
        out.push({
          key: `${h.agent}:${a.account}:${n.window}:notice`,
          logo: logoOf(h.agent),
          text: noticeWords(n, [h.name, a.account !== 'default' ? a.account : ''].filter(Boolean).join(' · '), when),
          label: noticeWords(n, h.name, when),
          hide: {
            label: t('budget.usage.notice.hide'),
            onClick: () =>
              void c.run(dismissNotice, { peer, agent: h.agent, account: a.account, window: n.window }).then(
                () => void again(),
                () => {},
              ),
          },
        });
    }
    return out;
  });
  return <SpareCards part="home.spare" cards={cards()} />;
}
