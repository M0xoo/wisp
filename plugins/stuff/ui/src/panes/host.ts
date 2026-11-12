// What wisp's page does with a pinned pane's call (v1 panes.js paneCall, grantNow, confirmed): the call is checked against
// what you allowed and its arguments capped (bridge.ts), a write is held to six a minute, asks the server for the grant
// first (an app whose code changed since you allowed it has lost tasks:write), and goes only after your click on its
// card: one card at a time, and what holds after the card (still pinned, still allowed) is what counts. Reads get the
// light shapes (light.ts). DOM-free: the page passes what it knows and does.
import { argsOf, isWrite, PANE_WRITES_PER_MIN, refusal, type LaunchArgs } from './bridge.ts';
import { launchBody, type LaunchDefaults } from './grant.ts';
import { lightMember, lightPrs, listedTasks, lightTask } from './light.ts';
import type { CrewRow, Grant, Item, TaskRow } from '../types.ts';

/** The confirm card a write waits on (v1 pane-card.js): its head, its rows (label, value), the words it sends. */
export interface PaneCard {
  readonly head: string;
  readonly rows: readonly (readonly [string, string])[];
  readonly prompt: string;
}

export interface PaneHostDeps {
  /** the app as My Stuff has it now */
  item(): Item | undefined;
  /** still pinned where it shows */
  pinned(): boolean;
  /** the server's word on what it may use now (stuff.grant) */
  grant(): Promise<Grant>;
  /** your answer on the card */
  card(c: PaneCard): Promise<boolean>;
  tasks(): readonly TaskRow[];
  crew(): readonly CrewRow[];
  usage(): Promise<unknown>;
  /** a project by name or id: its folder */
  project(name: string): { name: string; path: string } | undefined;
  defaults(): LaunchDefaults;
  harnessName(agent: string | undefined): string;
  launch(body: Record<string, unknown>): Promise<TaskRow | undefined>;
  followUp(id: string, text: string): Promise<void>;
  done(id: string): Promise<void>;
  /** wisp.on('tasks'): the page pushes the list to this pane from now on */
  watch(): void;
  now(): number;
  t(key: string, vars?: Readonly<Record<string, string | number>>): string;
}

export interface PaneHost {
  call(method: string, raw: unknown): Promise<unknown>;
}

/** One card waiting for you at a time, across every pane (a pane can't line up clicks). */
const cards = { waiting: false };

export function paneHost(d: PaneHostDeps): PaneHost {
  let writes: number[] = [];
  const grantNow = async (method: string): Promise<void> => {
    const g = await d.grant();
    if (g.changed) throw new Error(d.t('stuff.pane.changedSince'));
    const why = refusal(method, g.allowed);
    if (why) throw new Error(why);
  };
  const confirmed = async (method: string, c: PaneCard): Promise<void> => {
    if (cards.waiting) throw new Error(d.t('stuff.pane.cardWaiting'));
    cards.waiting = true;
    let yes = false;
    try {
      yes = await d.card(c);
    } finally {
      cards.waiting = false;
    }
    if (!yes) throw new Error(d.t('stuff.pane.notSent'));
    if (!d.pinned()) throw new Error(d.t('stuff.pane.unpinned'));
    await grantNow(method);
  };
  const listed = (): TaskRow[] => listedTasks(d.tasks());
  const light = (s: TaskRow): Record<string, unknown> | null => lightTask(s, { harness: d.harnessName(s.agent) });
  const task = (id: string): TaskRow => {
    const s = listed().find((x) => x.id === id);
    if (!s) throw new Error(d.t('stuff.pane.noTask', { id: id.slice(0, 40) }));
    return s;
  };
  return {
    async call(method, raw) {
      const it = d.item();
      const write = isWrite(method);
      // a changed app's list has lost tasks:write: that's for the server to say, in those words
      const why = write && it?.changed ? '' : refusal(method, it?.allowed ?? []);
      if (why) throw new Error(why);
      const checked = argsOf(method, Array.isArray(raw) ? (raw as unknown[]) : []);
      if ('error' in checked) throw new Error(checked.error);
      const args = checked.args;
      if (write) {
        const now = d.now();
        writes = writes.filter((at) => now - at < 60_000);
        if (writes.length >= PANE_WRITES_PER_MIN) throw new Error(d.t('stuff.pane.slowDown', { count: PANE_WRITES_PER_MIN }));
        writes.push(now);
        await grantNow(method);
      }
      const title = it?.title ?? '';
      switch (method) {
        case 'tasks.list':
          return listed().map(light);
        case 'tasks.get':
          return light(task(args[0] as string));
        case 'tasks.watch':
          d.watch();
          return true;
        case 'tasks.launch': {
          const a = args[0] as LaunchArgs;
          const p = a.project ? d.project(a.project) : undefined;
          if (a.project && !p) throw new Error(d.t('stuff.pane.noProject', { name: a.project }));
          // your defaults pick the harness and the mode: a pane can't pick Full auto for itself
          const body = launchBody(d.defaults(), a.prompt, p ?? null);
          await confirmed(method, {
            head: d.t('stuff.pane.card.launch', { name: title }),
            rows: [
              [d.t('stuff.pane.card.project'), p?.name ?? d.t('stuff.pane.card.noProject')],
              [d.t('stuff.pane.card.harness'), d.harnessName(body['agent'] as string | undefined)],
            ],
            prompt: String(body['prompt'] ?? ''),
          });
          const out = await d.launch(body);
          return out ? light(out) : { queued: true };
        }
        case 'tasks.followUp': {
          const [id, text] = args as [string, string];
          const s = task(id);
          await confirmed(method, {
            head: d.t('stuff.pane.card.followUp', { name: title }),
            rows: [
              [d.t('stuff.pane.card.task'), s.title || d.t('stuff.pane.card.untitled')],
              [d.t('stuff.pane.card.harness'), d.harnessName(s.agent)],
            ],
            prompt: text,
          });
          task(id); // it may have gone while the card was up
          await d.followUp(id, text);
          return true;
        }
        case 'tasks.done': {
          const s = task(args[0] as string);
          if (s.state !== 'done') await d.done(s.id);
          return true;
        }
        case 'prs.list':
          return lightPrs(d.tasks());
        case 'crew.list':
          return d.crew().map(lightMember);
        case 'usage.accounts':
          return d.usage();
        default:
          throw new Error(refusal(method));
      }
    },
  };
}
