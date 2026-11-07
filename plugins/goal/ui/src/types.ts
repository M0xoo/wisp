// The rows this UI reads, in one file so switching to @wisp/protocol's generated types (ts-rs, from
// crates/wisp-goal-api) is one edit. Until then the truth is v1 (server/goal.js goalView,
// server/goal-runs.js) and the TypeScript reference port (git show v2-ts-server-reference:plugins/
// goal/api/src/index.ts).
//
// Assumed until the Rust side says otherwise:
//   'session' rows (topic 'list') carry the goal as `goal: GoalView` (v1 summarize);
//   'goal_run' rows (topic `session:<id>`) are the check records, keyed by run id;
//   'harness' rows (topic 'config') are the harnesses a judge can run on;
//   'crew_member' rows (topic 'crew') are the crew, read-only here (a crew member can judge).

export const KIND = { session: 'session', run: 'goal_run', harness: 'harness', member: 'crew_member' } as const;
export const PLUGIN = 'wisp.goal';

export const MAX_TEXT = 1000;
export const MAX_JUDGES = 5;
/** This many rounds in a row that changed nothing, or were told the same next step: it's stuck. */
export const STALL = 2;

/** working · checking · met · impossible · paused · out (old goals: ran out of rounds) · handed (Auto moved it) */
export type GoalStatus = 'working' | 'checking' | 'met' | 'impossible' | 'paused' | 'out' | 'handed';
export type Verdict = 'met' | 'not_yet' | 'impossible' | 'unchecked';
export type Vote = 'all' | 'majority' | 'any';
export const VOTES: readonly Vote[] = ['all', 'majority', 'any'];

/** A harness with its model and thinking level, or a crew member (who brings theirs). */
export type HarnessJudge = { agent: string; model: string; effort: string; name?: string };
export type CrewJudge = { crew: string; name?: string };
export type Judge = HarnessJudge | CrewJudge;

export interface TestsResult {
  verdict: 'pass' | 'fail' | 'unknown' | 'skip';
  command: string | null;
}

export interface JudgeVote {
  name: string;
  agent?: string;
  model?: string;
  crew?: string;
  verdict: Verdict;
  why: string;
  next?: string;
  progress?: number | null;
  run?: string;
}

export interface CheckView {
  round: number;
  at: number;
  verdict: Verdict;
  why: string;
  next?: string;
  progress?: number | null;
  tests?: TestsResult;
  tally?: string;
  run?: string;
  /** the judges' votes of that round (the full copy has them; the summary may not) */
  votes?: JudgeVote[];
}

export interface RunningCheck {
  run: string;
  name: string;
  at: number;
  agent?: string;
  model?: string;
  crew?: string;
}

/** The goal on a summary: what the row, the band and the checks need. */
export interface GoalView {
  text: string;
  judges?: Judge[];
  vote?: Vote;
  status: GoalStatus;
  round: number;
  why?: string;
  /** the reset a paused goal's next round waits for (Automations stop at) */
  held?: number;
  setAt: number;
  endedAt?: number;
  checks: CheckView[];
  running?: RunningCheck[];
  last?: { verdict: Verdict; why: string; tally?: string; votes?: Pick<JudgeVote, 'name' | 'verdict' | 'why' | 'run'>[] };
}

/** One step of a check's run, as a task turn's activity holds it. */
export interface RunStep {
  id?: string;
  kind: string;
  label?: string;
  text?: string;
  detail?: string;
  status?: string;
  [k: string]: unknown;
}

/** What one goal check said and did (v1 goal-runs/<task>/<run>.json → a goal_run row). */
export interface GoalRun {
  id: string;
  task: string;
  turnId: string;
  round: number;
  name: string;
  agent?: string;
  model?: string;
  effort?: string;
  crew?: string;
  status: 'running' | 'done' | 'stopped' | 'error';
  /** how a run with no verdict ended */
  end?: 'timeout' | 'stopped' | 'error' | 'nojson' | 'interrupted';
  verdict?: Verdict;
  why?: string;
  next?: string;
  progress?: number;
  evidence?: string[];
  turn: { id: string; prompt: string; status: string; startedAt: number; endedAt?: number; activity: RunStep[] };
}

/** A task row as the list holds it: the fields the goal UI reads. */
export interface SessionRow {
  id: string;
  title: string;
  agent: string;
  state: string;
  pending?: boolean;
  parentId?: string;
  delegated?: boolean;
  sideOf?: { id: string; title: string };
  kind?: string;
  tui?: boolean;
  crew?: { id: string; job: string };
  goal?: GoalView;
}

/** A harness a judge can run on (v1 /api/agents). */
export interface HarnessRow {
  id: string;
  name: string;
  available: boolean;
  models: { id: string; label: string }[];
  efforts?: string[];
  /** the model and thinking level the user last picked for it */
  model?: string;
  effort?: string;
}

/** A crew member, as far as a judge needs one. */
export interface MemberRow {
  id: string;
  name: string;
  role: string;
  color: string;
  avatar: string;
}

/** What opened a check's page: enough to paint its head before the record arrives. */
export interface RunHint {
  task: string;
  run: string;
  name: string;
  round: number;
  verdict?: Verdict;
  why?: string;
  next?: string;
  agent?: string;
  model?: string;
  crew?: string;
  live?: boolean;
}
