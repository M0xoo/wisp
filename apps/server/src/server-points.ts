// wisp.server: the edge as a plugin. It owns the points through which features tell the edge what it
// must not know by name (plugins/server/api): status parts, agents' capability sets, v1 events, quiet
// and open routes, topic readers. Its setup only keeps its context, so the edge can read the points.
import type { Manifest, PluginContext, PluginDef } from '@wisp/kernel';
import { POINTS, SERVER_ID, type CallerPart, type LegacyPart, type OpenPart, type QuietPart, type StatusPart, type TopicPart } from '@wisp-plugin/server-api';
import { VERSION } from './meta.ts';

export const SERVER_MANIFEST: Manifest = {
  wispPlugin: 1,
  id: SERVER_ID,
  name: 'Server',
  version: VERSION.replace(/-.*$/, ''),
  api: '^1',
  description: 'The HTTP edge: routes, sign-in, sync, status. Every feature reaches it through its points.',
  activation: ['onStartup'],
  contributes: {
    points: [
      { id: POINTS.status, version: 1, kind: 'list' },
      { id: POINTS.caller, version: 1, kind: 'list' },
      { id: POINTS.legacy, version: 1, kind: 'list' },
      { id: POINTS.quiet, version: 1, kind: 'list' },
      { id: POINTS.open, version: 1, kind: 'list' },
      { id: POINTS.topics, version: 1, kind: 'list' },
    ],
  },
};

/** What the edge reads from its points; empty until the plugin is set up. */
export class EdgePoints {
  #ctx: PluginContext | undefined;
  readonly def: PluginDef = {
    id: SERVER_ID,
    setup: (ctx) => {
      this.#ctx = ctx;
      ctx.scope.add(() => (this.#ctx = undefined));
    },
  };
  #list<T>(point: string): readonly T[] {
    return this.#ctx?.contributions<T>(point) ?? [];
  }
  status = (): readonly StatusPart[] => this.#list<StatusPart>(POINTS.status);
  callers = (): readonly CallerPart[] => this.#list<CallerPart>(POINTS.caller);
  legacy = (): readonly LegacyPart[] => this.#list<LegacyPart>(POINTS.legacy);
  quiet = (): readonly QuietPart[] => this.#list<QuietPart>(POINTS.quiet);
  open = (): readonly OpenPart[] => this.#list<OpenPart>(POINTS.open);
  topics = (): readonly TopicPart[] => this.#list<TopicPart>(POINTS.topics);

  /** server.caller: the first plugin that knows this session decides its set */
  setFor(session: string): string | undefined {
    for (const p of this.callers()) {
      const set = p.setFor(session);
      if (set) return set;
    }
    return undefined;
  }
}

/** '/api/hooks/:id' matches '/api/hooks/abc'; whole segments. */
export function pathMatches(pattern: string, path: string): boolean {
  const a = pattern.split('/').filter(Boolean);
  const b = path.split('/').filter(Boolean);
  return a.length === b.length && a.every((s, i) => s.startsWith(':') || s === b[i]);
}
