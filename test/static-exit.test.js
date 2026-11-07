// process.exit waits for the job running on the thread pool, however long it takes. wisp's biggest
// is the phone's module pack at its best brotli: as one job, a wisp stopped just after it started
// goes 10 s and more later on a busy machine (grid-boxd's "the box never exited").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { until } from './helpers.js';

const STATIC = new URL('../server/http/static.js', import.meta.url).href;
const { serveStatic } = await import('../server/http/static.js');

const get = (encoding) =>
  new Promise((resolve) => {
    const res = { writeHead() {}, end: (body) => resolve(body) };
    serveStatic({ method: 'GET', url: '/_pack', headers: { 'accept-encoding': encoding } }, res, '/_pack');
  });

test('a wisp stopped while the pack compresses does not wait for all of it, and the pack comes out whole', async () => {
  const body = await get('');
  const params = { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_LGWIN]: 24, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: body.length };

  // How long one job of it takes here and now: the yardstick, so load doesn't change the verdict.
  const start = Date.now();
  await promisify(zlib.brotliCompress)(body, { params });
  const whole = Date.now() - start;

  const script = `import(${JSON.stringify(STATIC)}).then(({ warmStatic }) => { warmStatic(); setTimeout(() => { console.log('exiting'); process.exit(0); }, 100); });`;
  const p = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  const asked = await new Promise((r) => p.stdout.once('data', () => r(Date.now())));
  await new Promise((r) => p.once('exit', r));
  const lag = Date.now() - asked;
  assert.ok(lag < whole / 2, `exit took ${lag} ms; compressing all of it takes ${whole} ms`);

  // Once it's ready /_pack answers with it, and it holds every module.
  const ready = await until(async () => { const b = await get('br'); return b.length < (await promisify(zlib.brotliCompress)(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } })).length && b; }, { timeout: 60_000, what: 'the best brotli' });
  assert.equal(zlib.brotliDecompressSync(ready).toString(), body.toString());
});
