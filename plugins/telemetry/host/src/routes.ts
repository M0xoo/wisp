// v1's telemetry routes (server/routes/meta.js), same method, path, body and answer.
import type { PluginContext } from '@wisp/kernel';
import { MACHINES_SERVICE } from '@wisp-plugin/machines-api';
import { pageEvent } from '@wisp-plugin/telemetry-api';
import { parseFeedback, sendFeedback } from './feedback.ts';
import { record, type Handler, type HttpService, type RouteOptions } from './kernel.ts';
import type { Telemetry } from './telemetry.ts';

export function routes(ctx: PluginContext, http: HttpService, telemetry: Telemetry): void {
  const add = (method: string, path: string, handler: Handler, opts: RouteOptions): void => ctx.scope.add(http.route(method, path, handler, opts));

  // Feedback for the wisp team: thumbs on a turn and/or a note. { rating?, text?, kind?, sessionId?, turnId?, source? }
  add(
    'POST',
    '/feedback',
    async (c) => {
      const args = parseFeedback(await c.body());
      const out = await sendFeedback(
        {
          telemetry,
          run: (cmd, a) => ctx.run(cmd, a, { caller: c.caller }),
          emit: (type, data) => ctx.emit(type, data),
          machines: () => ctx.tryUse(MACHINES_SERVICE),
          now: () => ctx.clock.now(),
        },
        args,
      );
      return { status: 200, json: { ...out } };
    },
    { permission: 'feedback:send', summary: 'Send feedback to the wisp team' },
  );

  // A click on the page worth counting (PAGE_EVENTS). Unknown events are ignored.
  add(
    'POST',
    '/telemetry/event',
    async (c) => {
      const b = record(await c.body());
      const p = pageEvent(b['event'], b['props'] ?? {});
      if (p && typeof b['event'] === 'string') telemetry.track(b['event'], p);
      return { status: 200, json: { ok: true, tracked: !!p && telemetry.enabled } };
    },
    { permission: 'telemetry:track', summary: 'Count a page event' },
  );
}
