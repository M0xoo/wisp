// Shared QA scaffolding: an isolated wisp (its own WISP_HOME, port and temp repo) running wisp's
// fake agents, and Playwright loaded from outside the repo (wisp adds no dependencies).
//
//   PW_DIR   a folder with playwright-core installed (default /tmp/wisp-qa-pw):
//            mkdir -p /tmp/wisp-qa-pw && npm i --prefix /tmp/wisp-qa-pw playwright-core
//   CHROME   Chrome to drive (default: the system Google Chrome)

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeBins, makeRepo, until } from '../test/helpers.js';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const OUT = process.env.QA_OUT || path.join(ROOT, 'qa', 'out');
fs.mkdirSync(OUT, { recursive: true });

export const CHROME =
  process.env.CHROME ||
  (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome');

export function playwright() {
  const dir = process.env.PW_DIR || (process.platform === 'win32' ? path.join(os.tmpdir(), 'wisp-qa-pw') : '/tmp/wisp-qa-pw');
  try {
    return createRequire(path.join(dir, 'package.json'))('playwright-core');
  } catch {
    throw new Error(`playwright-core not found in ${dir}: npm i --prefix ${dir} playwright-core`);
  }
}

// The env a QA wisp runs with: fake agents first on PATH, no telemetry, nothing of the user's.
export function qaEnv(extra = {}) {
  const bins = installFakeBins(); // also puts them on this process's PATH
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wisp-qa-home-'));
  // Not the dev wisp's: WISP_DEV pins Electron's debug port, WISP_PORT/WISP_HOME point at yours.
  const { WISP_DEV, WISP_DEBUG_PORT, WISP_PORT, ...base } = process.env;
  return {
    bins,
    home,
    env: {
      ...base,
      WISP_HOME: home,
      WISP_TELEMETRY: '0',
      WISP_FEEDBACK: '0',
      DO_NOT_TRACK: '1',
      FAKE_DELAY: process.env.FAKE_DELAY || '1200',
      ...extra,
    },
  };
}

// `node bin/wisp.js --no-open` on its own port and home. Resolves once /api/config answers.
export async function startWisp({ port = 4490, extraEnv = {} } = {}) {
  // A wisp left on the port from an earlier run would answer instead, with its own state.
  const busy = await fetch(`http://localhost:${port}/api/health`).then(() => true, () => false);
  if (busy) throw new Error(`port ${port} is taken: lsof -ti tcp:${port} -sTCP:LISTEN | xargs kill`);
  const { env, home, bins } = qaEnv({ WISP_PORT: String(port), ...extraEnv });
  const repo = makeRepo();
  const log = fs.openSync(path.join(OUT, `wisp-${port}.log`), 'w');
  const child = spawn(process.execPath, [path.join(ROOT, 'bin/wisp.js'), '--no-open', '--port', String(port)], {
    env,
    stdio: ['ignore', log, log],
  });
  const url = `http://localhost:${port}`;
  await until(async () => (await fetch(`${url}/api/config`)).ok, { timeout: 30_000, what: `wisp on ${port}` });
  return { url, home, bins, repo, child, env, stop: () => child.kill('SIGTERM') };
}

export async function api(url, p, body, method = body ? 'POST' : 'GET') {
  const res = await fetch(url + p, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}

// A tiny scenario runner: each check is named after its scenario id in qa/scenarios/*.md.
export function runner(surface) {
  const results = [];
  const check = async (id, title, fn) => {
    const t0 = Date.now();
    try {
      await fn();
      results.push({ id, title, ok: true, ms: Date.now() - t0 });
      console.log(`  ✔ ${id} ${title}`);
    } catch (err) {
      results.push({ id, title, ok: false, ms: Date.now() - t0, error: String(err?.message || err).split('\n')[0] });
      console.log(`  ✗ ${id} ${title}\n      ${String(err?.message || err).split('\n')[0]}`);
    }
  };
  const done = () => {
    const failed = results.filter((r) => !r.ok);
    fs.writeFileSync(path.join(OUT, `${surface}.json`), JSON.stringify(results, null, 2));
    console.log(`\n  ${surface}: ${results.length - failed.length} passed, ${failed.length} failed · ${OUT}`);
    return failed.length ? 1 : 0;
  };
  return { check, done, results };
}

export const ok = (v, msg) => {
  if (!v) throw new Error(msg);
};
