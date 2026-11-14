// One account's Plan budget in Settings → Usage (v1 features/budget.js budgetHtml's .bg-acct) over the kit's
// PlanAccount: each window with its line, Codex's banked resets, Past your plan, and Where the longest window went
// (each task opens). And per harness, tokens per turn by account (v1 compareHtml) with Copy report.
import { Show, type JSX } from 'solid-js';
import type { PluginClient } from '@wisp/client';
import { useShell } from '@wisp/shell';
import { Button, Callout, Inline, PlanAccount, PlanCompare, Text, type PlanWindowRow } from '@wisp/ui';
import type { AccountPlan } from './commands.ts';
import { pct } from './drain.ts';
import { bankedSoon, bankedWords, compareParts, compareReport, compareWords, overWords, whereRows, windowLine, type Compare } from './plan.ts';
import { t } from './i18n.ts';

/** v1 tone(): full at 100%, warn on pace to run out, at 90% or past the stop line. */
const toneOf = (used: number, stop: number | null, hit: boolean): PlanWindowRow['tone'] => (used >= 1 ? 'full' : hit || used >= 0.9 || (stop !== null && used >= stop) ? 'warn' : undefined);

export function AccountPlanView(props: {
  readonly c: PluginClient;
  readonly name: string;
  readonly logo?: string | undefined;
  /** the account's name when the harness has several; '' for the CLI's own alone */
  readonly label: string;
  readonly a: AccountPlan;
  readonly stop: number | null;
  readonly when: (at: number) => string;
  readonly day: (at: number) => string;
}): JSX.Element {
  const who = (): string => [props.name, props.label].filter(Boolean).join(' · ');
  const open = (id: string): void => props.c.navigate({ t: 'openTask', id: id as never });
  const windows = (): PlanWindowRow[] =>
    props.a.windows.map((w) => {
      const tone = toneOf(w.used, props.stop, !!w.hitAt);
      return { label: w.label, used: w.used, pct: pct(w.used), line: windowLine(w, props.stop, props.when), aria: t('budget.usage.windowAria', { who: who(), label: w.label }), ...(tone && { tone }) };
    });
  const banked = (): { text: string; tip: string; warn: boolean } | undefined => {
    const text = bankedWords(props.a.banked, Date.now(), props.day);
    return text ? { text, tip: t('budget.usage.banked.tip'), warn: bankedSoon(props.a.banked, Date.now()) } : undefined;
  };
  const where = () => {
    const w = whereRows(props.a.where);
    return w && { heading: w.heading, rows: w.rows.map((r) => ({ key: r.key, title: r.title, pct: r.pct, ...(r.tip && { tip: r.tip }), ...(r.id && { onOpen: () => open(r.id as string) }) })) };
  };
  return (
    <PlanAccount
      part="budget.usage.account"
      name={props.name}
      logo={props.logo}
      account={props.label || undefined}
      windows={windows()}
      stop={props.stop}
      stopLabel={props.stop !== null ? t('budget.usage.stopLine', { pct: pct(props.stop) }) : ''}
      note={banked()}
      where={where()}
    >
      <Show when={props.a.overage?.runs ? props.a.overage : undefined}>
        {(o) => (
          <Callout part="budget.usage.over" tone="warn" icon="warn" title={t('budget.usage.over.title')}>
            <Text size="sm">{overWords(o(), props.when)}</Text>
            <Show when={o().sid}>
              {(sid) => (
                <Inline gap="2">
                  <Button size="sm" variant="ghost" onClick={() => open(sid())}>
                    {t('budget.usage.over.open')}
                  </Button>
                </Inline>
              )}
            </Show>
          </Callout>
        )}
      </Show>
    </PlanAccount>
  );
}

/** Tokens per turn by account for one harness (numbers only: it never suggests an account, and wisp never switches). */
export function HarnessCompare(props: { readonly name: string; readonly logo?: string | undefined; readonly list: readonly Compare[]; readonly labelOf: (account: string) => string }): JSX.Element {
  const model = (m: string): string => m || t('budget.usage.compare.default');
  const shell = useShell();
  // the click answers at once (design/feedback.md): the report's on the clipboard, and a toast says what to do with it
  const copy = (): void =>
    void navigator.clipboard?.writeText(compareReport(props.name, props.list, props.labelOf, model, Date.now())).then(
      () => shell.toast.show(t('budget.plan.copied')),
      () => {},
    );
  return (
    <PlanCompare
      part="budget.usage.compare"
      name={props.name}
      logo={props.logo}
      what={t('budget.usage.compare.what')}
      heading={t('budget.usage.compare.median')}
      tip={t('budget.usage.compare.tip')}
      rows={props.list.map((c) => ({ model: model(c.model), words: compareWords(c, props.labelOf), accounts: c.accounts.map((x) => ({ label: props.labelOf(x.account), parts: compareParts(x) })) }))}
      copyLabel={t('budget.usage.compare.copy')}
      onCopy={copy}
    />
  );
}
