// Test a connector: start it through the proxy, the way an agent would, and list its tools (v1
// connectors.js probe). The proxy runs in-process here, so no token has to leave wisp for it.

import type { Scope } from '@wisp/kernel';
import type { ProbeResult, ProxySpec } from '@wisp-plugin/connectors-api';
import { clip } from './model.ts';
import { runProxy, type ProxyDeps } from './proxy.ts';

const PROBE_MS = 60_000; // npx may download the server first

export function probe(spec: ProxySpec, deps: Omit<ProxyDeps, 'out' | 'err'>, scope: Scope, version: string): Promise<ProbeResult> {
  const c = spec.connector;
  return new Promise((resolve) => {
    const timers = scope.child(`probe:${c.id}`);
    let err = '';
    const tools: string[] = [];
    let done = false;
    const finish = (result: Omit<ProbeResult, 'at'>): void => {
      if (done) return;
      done = true;
      timers.dispose();
      session.kill();
      resolve({ at: deps.now(), ...result });
    };
    // The row already names it: "wisp: " and "<name>: " in front say nothing more.
    const tidy = (t: string): string => t.replace(/^wisp: /, '').replace(`${c.name}: `, '').replace(/^./, (x) => x.toUpperCase());
    const failed = (fallback: string): void => {
      const tail = err.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' · ');
      const error = clip(tidy(tail || fallback), 300);
      // Refused for want of a sign-in: the row offers Sign in.
      finish({ ok: false, error, ...(/needs sign-in|HTTP 40[13]/i.test(error) && { auth: true }) });
    };
    const send = (msg: Record<string, unknown>): void => session.send(JSON.stringify({ jsonrpc: '2.0', ...msg }));
    const onLine = (line: string): void => {
      let m: { id?: unknown; method?: unknown; error?: { message?: string }; result?: { tools?: { name?: string }[]; nextCursor?: string } };
      try {
        m = JSON.parse(line) as typeof m;
      } catch {
        return;
      }
      const id = typeof m.id === 'number' ? m.id : null;
      if (id === 1) {
        if (m.error) return failed(tidy(m.error.message || 'It refused to start'));
        send({ method: 'notifications/initialized' });
        send({ id: 2, method: 'tools/list', params: {} });
      } else if (id !== null && id >= 2) {
        if (m.error) return failed(tidy(m.error.message || 'It wouldn’t list its tools'));
        tools.push(...(m.result?.tools || []).map((t) => t.name).filter((n): n is string => !!n));
        // A long list comes in pages; three are plenty to show.
        if (m.result?.nextCursor && id < 4) send({ id: id + 1, method: 'tools/list', params: { cursor: m.result.nextCursor } });
        else finish({ ok: true, tools: tools.slice(0, 200), count: tools.length });
      } else if (m.method && m.id != null) {
        send({ id: m.id, error: { code: -32601, message: 'wisp is only listing tools' } });
      }
    };
    const session = runProxy(spec, { ...deps, out: onLine, err: (t) => (err = (err + t + '\n').slice(-4000)) });
    timers.timeout(PROBE_MS, () => failed('It didn’t answer within a minute'));
    session.exited.then((code) => failed(`It stopped before answering (exit ${code})`), (e: unknown) => failed(String(e)));
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wisp', version } } });
  });
}
