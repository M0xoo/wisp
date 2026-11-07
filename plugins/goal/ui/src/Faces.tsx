// A judge's face: a crew member's colour and initials, or the harness's. Tinted by its last vote
// (the status dot: met green, can't red, not yet amber, no answer faded), named in its tooltip.

import { For, type JSX } from 'solid-js';
import type { ProjectColor } from '@wisp/tokens';
import { Avatar, Inline, Tooltip } from '@wisp/ui';
import type { PluginClient } from '@wisp/client';
import { isCrew, judgeLabel, VOTE_TONE } from './rules.ts';
import { useCrew, useHarnesses } from './task.ts';
import type { Judge, MemberRow, Verdict } from './types.ts';

const PC = new Set(['violet', 'teal', 'amber', 'rose', 'sky', 'lime', 'orange', 'indigo', 'slate']);
export const colorOf = (m: MemberRow | undefined): ProjectColor | undefined => (m && PC.has(m.color) ? (`pc-${m.color}` as ProjectColor) : undefined);

export interface FaceProps {
  readonly client: PluginClient;
  /** a judge, or a vote's who (name + agent/crew) */
  readonly who: Judge | { name: string; agent?: string; crew?: string };
  readonly verdict?: Verdict | undefined;
  readonly size?: 'sm' | 'md' | 'lg';
  readonly tip?: string;
}

export function Face(props: FaceProps): JSX.Element {
  const crew = useCrew(props.client);
  const harnesses = useHarnesses(props.client);
  const member = (): MemberRow | undefined => {
    const w = props.who as { crew?: string };
    return w.crew ? crew().find((m) => m.id === w.crew) : undefined;
  };
  const name = (): string => {
    const w = props.who as Judge & { name?: string };
    if ('crew' in w || 'agent' in w) return w.name ?? judgeLabel(w as Judge, crew(), harnesses());
    return (w as { name?: string }).name ?? '';
  };
  const avatar = (): JSX.Element => (
    <Avatar part="goal.judge" name={name()} size={props.size ?? 'sm'} shape={isCrew(props.who as Judge) ? 'circle' : 'square'} {...(colorOf(member()) && { color: colorOf(member()) as ProjectColor })} {...(props.verdict && { status: VOTE_TONE[props.verdict] })} />
  );
  return <Tooltip content={props.tip ?? name()}>{avatar()}</Tooltip>;
}

/** The judges' faces in a row, each with its vote. */
export function Faces(props: { readonly client: PluginClient; readonly judges: readonly Judge[]; readonly votes?: readonly ({ verdict: Verdict; why?: string; name?: string } | undefined)[] | null; readonly tip?: (i: number) => string }): JSX.Element {
  return (
    <Inline gap="1" part="goal.judges">
      <For each={props.judges}>{(j, i) => <Face client={props.client} who={j} verdict={props.votes?.[i()]?.verdict} {...(props.tip && { tip: props.tip(i()) })} />}</For>
    </Inline>
  );
}
