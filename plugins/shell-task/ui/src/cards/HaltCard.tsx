// A finished turn that stopped short (v1 turns.js limitCard / refusalCard, sign-in-card.js): signed out (Sign in,
// and the turn runs again once you have), a usage limit (Send again, or Hand to another harness), refused (Hand to
// a harness on another company's model, the model pinned; or a note saying none is set up). One
// click, never by itself; the buttons lock at once and come back if the hand-off is refused.
import { For, Match, Show, Switch, createSignal, type JSX } from 'solid-js';
import { Banner, Button, Inline, Text } from '@wisp/ui';
import type { Halt, T } from './model.ts';
import type { Target } from './vendors.ts';

export function HaltCard(props: {
  readonly halt: Halt;
  readonly name: string;
  readonly t: T;
  /** where a refused or limited turn can go (empty: none set up) */
  readonly targets: readonly Target[];
  readonly nameOf: (agent: string) => string;
  readonly onSignIn: () => void;
  readonly onRetry: () => void;
  readonly onHand: (to: Target) => Promise<unknown>;
  /** a limit's Wait until: the carry-on follow-up at the reset */
  readonly onWait?: (until: number) => Promise<unknown>;
}): JSX.Element {
  const h = (): Halt => props.halt;
  const [locked, setLocked] = createSignal(false);
  const title = (): string => {
    const k = h().kind;
    return k === 'signedOut'
      ? props.t('shell-task.halt.signedOut', { name: props.name })
      : k === 'limit'
        ? props.t('shell-task.halt.limit', { name: props.name })
        : props.t('shell-task.halt.refused', { name: props.name });
  };
  const text = (): string => {
    const x = h();
    return x.kind === 'signedOut' ? props.t('shell-task.halt.signedOutWhy') : x.text;
  };
  const hand = (to: Target): void => {
    setLocked(true);
    props.onHand(to).catch(() => setLocked(false)); // the shell's toast says why
  };
  const handButtons = (): JSX.Element => (
    <For each={props.targets}>
      {(to, i) => (
        <Button
          size="sm"
          variant={i() === 0 && h().kind === 'refused' ? 'primary' : 'ghost'}
          icon="agent"
          disabled={locked()}
          title={props.t(to.model ? 'shell-task.halt.handTipModel' : 'shell-task.halt.handTip', { name: props.nameOf(to.agent), model: to.model })}
          onClick={() => hand(to)}
        >
          {props.t('shell-task.halt.hand', { name: props.nameOf(to.agent) })}
        </Button>
      )}
    </For>
  );
  return (
    <Banner part={`turn.halt.${h().kind}`} tone={h().kind === 'refused' ? 'bad' : 'warn'} icon={h().kind === 'signedOut' ? 'lock' : 'warn'} title={title()}>
      <Show when={text()}>
        <Text size="sm">{text()}</Text>
      </Show>
      <Inline gap="2" part="turn.halt.acts">
        <Switch>
          <Match when={h().kind === 'signedOut'}>
            <Button size="sm" variant="primary" onClick={() => props.onSignIn()}>
              {props.t('shell-task.halt.signIn')}
            </Button>
          </Match>
          <Match when={h().kind === 'refused'}>{handButtons()}</Match>
          <Match when={h().kind === 'limit' && h()}>
            {(l) => {
              const lim = l() as Extract<Halt, { kind: 'limit' }>;
              const at = (): string => (lim.until ? new Date(lim.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
              return (
                <>
                  <Show
                    when={lim.until && !lim.waiting && props.onWait}
                    fallback={
                      <Show
                        when={lim.waiting && lim.until}
                        fallback={
                          <Button size="sm" variant="ghost" icon="replay" disabled={locked()} onClick={() => props.onRetry()}>
                            {props.t('shell-task.halt.retry')}
                          </Button>
                        }
                      >
                        <Text size="sm" tone="muted">
                          {props.t('shell-task.halt.waiting', { at: at() })}
                        </Text>
                      </Show>
                    }
                  >
                    <Button
                      size="sm"
                      variant="primary"
                      icon="clock"
                      disabled={locked()}
                      onClick={() => {
                        setLocked(true);
                        props.onWait?.(lim.until ?? 0).catch(() => setLocked(false));
                      }}
                    >
                      {props.t('shell-task.halt.wait', { at: at() })}
                    </Button>
                  </Show>
                  {handButtons()}
                  <Show when={lim.extra}>
                    {(u) => (
                      <Button size="sm" variant="ghost" icon="external" onClick={() => window.open(u(), '_blank', 'noopener')}>
                        {props.t('shell-task.halt.extra')}
                      </Button>
                    )}
                  </Show>
                </>
              );
            }}
          </Match>
        </Switch>
      </Inline>
      <Show when={h().kind === 'refused' && props.targets.length === 0}>
        <Text size="sm" tone="muted">
          {props.t('shell-task.halt.noTarget')}
        </Text>
      </Show>
    </Banner>
  );
}
