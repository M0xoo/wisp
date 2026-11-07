// Shared scaffolding for the edge's tests: a wisp in a temp home on a free port, and raw requests
// (node:http, so a test can send any Host or Origin, which fetch refuses to).
import { mkdtempSync } from 'node:fs';
import http, { type IncomingHttpHeaders } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startServer, type RunningServer, type ServerOptions } from '../src/server.ts';

process.env['WISP_TELEMETRY'] = '0'; // tests never report anywhere
process.env['WISP_FEEDBACK'] = '0';

export const tmp = (prefix: string): string => mkdtempSync(path.join(os.tmpdir(), `wisp-${prefix}-`));

export const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

export function boot(opts: ServerOptions = {}): Promise<RunningServer> {
  return startServer({ home: tmp('edge'), port: 0, web: null, log: quiet, ...opts });
}

export interface Answer {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  text: string;
  json(): unknown;
}

export function request(port: number, p: string, o: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: o.method ?? 'GET', headers: { host: `127.0.0.1:${port}`, ...o.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        const text = body.toString('utf8');
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, text, json: () => JSON.parse(text) as unknown });
      });
    });
    req.on('error', reject);
    req.end(o.body);
  });
}

/** POST JSON, as the page does. */
export const post = (port: number, p: string, body: unknown, headers: Record<string, string> = {}): Promise<Answer> =>
  request(port, p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

export const asRecord = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});
