import fs from 'node:fs';
import { execFile } from 'node:child_process';
const tasks = JSON.parse(fs.readFileSync('wisp-tasks.json', 'utf8'));
const out = {};
const queue = [...tasks];
const worker = async () => { for (let t; (t = queue.shift()); ) {
  const r = await new Promise((res) => execFile(process.execPath, ['wisp.mjs', 'validate', t.id], { maxBuffer: 64 << 20, timeout: 3600_000 }, (e, so, se) => { try { res(JSON.parse(so.trim().split('\n').at(-1))); } catch { res({ id: t.id, ok: false, why: (se || e?.message || '').slice(-500) }); } }));
  out[t.id] = r; console.log(t.id, r.ok, 'f2p', r.f2p?.length, 'p2p', r.p2p?.length, 'flaky', r.flaky?.length, r.why || '');
  fs.writeFileSync('out/wisp-valid.json', JSON.stringify(out, null, 1));
} };
await Promise.all([worker(), worker()]);
