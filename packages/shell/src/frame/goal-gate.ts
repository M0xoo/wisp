// Send with Goal on (v1 goal.js launcherGoal/replyGoalEmpty, launcher.js; #769), DOM-free. A task meant to keep
// going must not start as a one-shot because "Done when" was left empty: Send stops, the line takes the focus and
// a toast offers "Send without a goal". A goal with nothing to do says so, or Send looks broken.
// `goal`: undefined when Goal is off, else what's typed in Done when.

export type GoalGate = 'send' | 'nothing' | 'sayWhat' | 'askGoal';

export function goalGate(prompt: string, goal: string | undefined): GoalGate {
  if (!prompt.trim()) return goal?.trim() ? 'sayWhat' : 'nothing';
  return goal !== undefined && !goal.trim() ? 'askGoal' : 'send';
}
