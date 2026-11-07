// wisp.telemetry: anonymous usage stats and error reports to PostHog, and the feedback users send the
// wisp team (v1 server/telemetry.js, server/services/telemetry.js, server/services/feedback.js).
//
// It activates on startup (justified: it counts app_started, sends what the last run left in its
// outbox, flushes every 15 s and reports crashes; none of that waits for a command).
import os from 'node:os';
import type { EventEnvelope, Json, PluginContext } from '@wisp/kernel';
import type { Store } from '@wisp/store';
import { COMMANDS, EVENTS as RUNTIME, type AgentStatus, type Session, type Turn } from '@wisp-plugin/runtime-api';
import { POINTS, type ConfigPart } from '@wisp-plugin/settings-api';
import { SETTINGS, TELEMETRY, TELEMETRY_ID, errorInfo, type TelemetryService } from '@wisp-plugin/telemetry-api';
import { definePlugin, maybeService, type AppService, type HttpService, type NetService } from './kernel.ts';
import { routes } from './routes.ts';
import { tables } from './schema.ts';
import { envDisabled, FLUSH_MS, hostOf, keyOf, shellOf, Telemetry, TIMEOUT_MS, type Env } from './telemetry.ts';
import { endedProps, runProps, startedProps } from './turns.ts';

export { openapi } from './openapi.ts';

export const NOTICE = 'wisp sends anonymous usage stats and error reports (no prompts, paths or code). Opt out: Settings, or WISP_TELEMETRY=0 / DO_NOT_TRACK=1.';

/** PostHog's batch endpoint over the `net` service: true once it has them. */
export const poster =
  (net: NetService, env: Env) =>
  async (batch: Json[]): Promise<boolean> => {
    const key = keyOf(env);
    if (!key) return false;
    try {
      const res = await net.fetch(`${hostOf(env)}/batch/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ api_key: key, batch }), timeoutMs: TIMEOUT_MS });
      return res.ok;
    } catch {
      return false;
    }
  };

function create(ctx: PluginContext, env: Env): Telemetry {
  const app = maybeService<AppService>(ctx, 'app');
  const store = ctx.service<Store>('store');
  return new Telemetry({
    store,
    tables: tables(store),
    env,
    setting: () => ctx.settings.get(SETTINGS.telemetry),
    post: poster(ctx.service<NetService>('net'), env),
    scrub: { home: os.homedir(), root: app?.root ?? '' },
    common: { $lib: 'wisp', $process_person_profile: false, version: app?.version ?? '0.0.0', os: process.platform, osRelease: os.release(), arch: process.arch, node: process.versions.node, shell: shellOf(env) },
    now: () => ctx.clock.now(),
  });
}

/** turn_started / turn_ended, and an agent's error as an AgentError (v1 trackTurns). */
function trackTurns(ctx: PluginContext, t: Telemetry): void {
  const load = async (sessionId: string, turnId: string): Promise<{ s: Session; turn: Turn | undefined } | undefined> => {
    const s = await ctx.run<Session>(COMMANDS.get, { id: sessionId }).catch(() => undefined);
    if (!s) return undefined;
    const turns = await ctx.run<Turn[]>(COMMANDS.turns, { id: sessionId }).catch((): Turn[] => []);
    return { s, turn: turns.find((x) => x.id === turnId) };
  };
  ctx.on<{ sessionId: string; turnId: string }>(RUNTIME.started, async (e) => {
    if (!t.enabled) return; // the reads cost something: only when it will be sent
    const got = await load(e.data.sessionId, e.data.turnId);
    if (got) t.track('turn_started', startedProps(got.s, got.turn));
  });
  ctx.on<{ sessionId: string; turnId: string; status: string; interrupted?: boolean; errorText?: string }>(RUNTIME.ended, async (e: EventEnvelope<{ sessionId: string; turnId: string; status: string; interrupted?: boolean; errorText?: string }>) => {
    if (!t.enabled) return;
    const got = await load(e.data.sessionId, e.data.turnId);
    if (!got) return;
    t.track('turn_ended', endedProps(got.s, got.turn, e.data));
    if (e.data.errorText) t.captureError({ name: 'Error', message: e.data.errorText }, { type: 'AgentError', ...runProps(got.s, got.turn) });
  });
}

/** app_started: which harnesses are installed, and their versions (v1, once the server listens). */
async function appStarted(ctx: PluginContext, t: Telemetry): Promise<void> {
  if (!t.enabled) return;
  const agents = await ctx.run<AgentStatus[]>(COMMANDS.agents, {}).catch((): AgentStatus[] => []);
  const on = agents.filter((a) => a.available);
  t.track('app_started', { agentsInstalled: on.map((a) => a.id), ...Object.fromEntries(on.map((a) => [`${a.id}Version`, a.version])) });
}

function service(ctx: PluginContext, t: Telemetry): TelemetryService {
  return {
    track: (event, props) => t.track(event, props),
    captureError: (err, props) => t.captureError(err, props),
    enabled: () => t.enabled,
    startupNotice: () => (t.enabled && ctx.settings.get(SETTINGS.notice) !== 'seen' ? NOTICE : null),
  };
}

export default definePlugin({
  id: TELEMETRY_ID,
  setup(ctx: PluginContext) {
    const env: Env = process.env;
    const t = create(ctx, env);
    ctx.provide(TELEMETRY, service(ctx, t));
    const part: ConfigPart = { plugin: TELEMETRY_ID, read: () => ({ telemetry: { available: !envDisabled(env), enabled: t.enabled }, feedback: t.feedbackAvailable }) };
    ctx.contribute(POINTS.config, part);
    routes(ctx, ctx.service<HttpService>('http'), t);
    trackTurns(ctx, t);
    ctx.scope.interval(FLUSH_MS, () => void t.flush());
    ctx.scope.add(() => t.persist()); // switched off or shut down: what's queued goes next start
    if (!envDisabled(env)) {
      const crashed = (err: unknown): void => t.crashed(errorInfo(err));
      process.on('uncaughtExceptionMonitor', crashed);
      ctx.scope.add(() => process.off('uncaughtExceptionMonitor', crashed));
    }
    void t.restore();
    ctx.scope.timeout(0, () => void appStarted(ctx, t));
  },
});
