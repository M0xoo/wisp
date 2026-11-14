// Send with Goal on (v1 goal.js launcherGoal/replyGoalEmpty, launcher.js; #769), DOM-free. A task meant to keep
// going must not start as a one-shot because "Done when" was left empty: Send stops, the line takes the focus and
// a toast offers "Send without a goal". A goal with nothing to do says so, or Send looks broken.
// `goal`: undefined when Goal is off, else what's typed in Done when.

export type GoalGate = 'send' | 'nothing' | 'sayWhat' | 'askGoal';

export function goalGate(prompt: string, goal: string | undefined): GoalGate {
  if (!prompt.trim()) return goal?.trim() ? 'sayWhat' : 'nothing';
  return goal !== undefined && !goal.trim() ? 'askGoal' : 'send';
}

/** New task's Goal (v1 launcherGoal): on or off, and what's typed in Done when (a draft, kept over a reload). */
export interface HomeGoal {
  readonly on: boolean;
  readonly text: string;
}

/** What a launch sends: Done when's text while Goal is on, else nothing (off). */
export const goalOf = (g: HomeGoal): string | undefined => (g.on ? g.text : undefined);

/** Every prompt starts without a goal: sent, Done when empties and Goal goes off; `back` is it as it was, for a
 *  launch that was refused (v1 goalTaken). */
export const goalSent = (g: HomeGoal): { readonly next: HomeGoal; readonly back: HomeGoal } => ({ next: { on: false, text: g.on ? '' : g.text }, back: g });

/** A bare `/goal` sent from New task: Done when opens (v1 box.goalOpen), nothing starts. */
export const isBareGoal = (text: string): boolean => /^\/goal$/i.test(text.trim());
