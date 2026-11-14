// One harness · model · thinking level on "What Auto learned" (v1 auto.js's table row): its
// chance, your picks, Auto's runs, cost and time, its state, and Never / Prefer for the model.

import { Show, type JSX } from 'solid-js';
import { Button, Icon, Inline, ListRow, Pill, Text, Tooltip } from '@wisp/ui';
import { t } from '../i18n.ts';
import { byTypeLine, cost, modelName, pct, ruleOn, sourceOf, TIER_WORD, type RuleKind, type RuleSet } from '../rules.ts';
import type { ArmReport } from '../types.ts';

const STATE_TONE: Readonly<Record<string, 'good' | 'warn' | 'bad' | 'neutral'>> = { ready: 'good', new: 'warn', untried: 'neutral', cooling: 'warn', gone: 'bad' };
const STATE_KEYS = ['ready', 'new', 'untried', 'cooling', 'gone'] as const;
type StateKey = (typeof STATE_KEYS)[number];
const stateKey = (s: string): StateKey => (STATE_KEYS as readonly string[]).includes(s) ? (s as StateKey) : 'ready';

/** "9:00 PM": when a cooling arm is back. */
export const clock = (at: number): string => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(at);

function numbers(a: ArmReport): string {
  const none = t('wisp.router.learned.none');
  if (a.state === 'untried') return [none, `${t('wisp.router.learned.col.picks')} ${a.picks || none}`].join(' · ');
  return [
    `${t('wisp.router.learned.col.works')} ${pct(a.chance)}`,
    `${t('wisp.router.learned.col.picks')} ${a.picks || none}`,
    `${t('wisp.router.learned.col.tasks')} ${a.n || none}`,
    cost(a.usd),
    t('wisp.router.learned.minutes', { n: a.minutes }),
  ].join(' · ');
}

function StatePill(props: { readonly arm: ArmReport }): JSX.Element {
  const key = (): StateKey => stateKey(props.arm.state);
  const label = (): string => {
    const word = t(`wisp.router.state.${key()}`);
    return props.arm.coolingUntil ? t('wisp.router.state.until', { state: word, time: clock(props.arm.coolingUntil) }) : word;
  };
  const tip = (): string => (props.arm.coolingUntil ? t('wisp.router.state.cooling-tip', { why: props.arm.coolingWhy ?? t('wisp.router.state.cooling'), time: clock(props.arm.coolingUntil) }) : '');
  return (
    <Show when={tip()} fallback={<Pill part="router.state" tone={STATE_TONE[key()] ?? 'neutral'} dot>{label()}</Pill>}>
      <Tooltip content={tip()}>
        <Pill part="router.state" tone={STATE_TONE[key()] ?? 'neutral'} dot>
          {label()}
        </Pill>
      </Tooltip>
    </Show>
  );
}

export interface ArmRowProps {
  readonly arm: ArmReport;
  readonly rules: RuleSet;
  readonly onToggle: (kind: RuleKind, arm: ArmReport) => void;
}

export function ArmRow(props: ArmRowProps): JSX.Element {
  const a = (): ArmReport => props.arm;
  const tier = (): string => t(`wisp.router.tier.${TIER_WORD[a().tier] ?? 'everyday'}`);
  const src = (): string => {
    const s = sourceOf(a());
    return s ? t(`wisp.router.src.${s}`) : '';
  };
  const sub = (): string => [numbers(a()), src(), byTypeLine(a())].filter(Boolean).join(' · ');
  const toggle = (kind: RuleKind, label: 'never' | 'prefer'): JSX.Element => (
    <Button
      size="xs"
      variant="ghost"
      part={`router.rule-${label}`}
      pressed={ruleOn(props.rules, kind, a())}
      title={t(`wisp.router.rule.${label}-tip`, { model: modelName(a()) })}
      onClick={() => props.onToggle(kind, a())}
    >
      {t(`wisp.router.rule.${label}`)}
    </Button>
  );
  return (
    <ListRow
      part="router.arm"
      title={a().label}
      lead={<Icon name="agent" />}
      sub={<Text size="sm" tone="muted" truncate title={sub()}>{sub()}</Text>}
      pills={
        <Inline gap="2">
          <Pill part="router.tier" variant="outline" title={t('wisp.router.tier.hint', { tier: tier() })}>
            {tier()}
          </Pill>
          <StatePill arm={a()} />
        </Inline>
      }
      actions={
        <Inline gap="1">
          {toggle('blocked', 'never')}
          {toggle('prefer', 'prefer')}
        </Inline>
      }
    />
  );
}
