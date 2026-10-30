// Data for stress runs (qa/mobile-perf.mjs with PERF_STRESS=<n>): a sessions folder with n tasks
// cloned from real ones, plus the extremes: a task with hundreds of turns, and one whose prompt and
// answer are each hundreds of KB. The source folder is only read.
//
//   node qa/stress-data.mjs <from sessions dir> <to sessions dir> [n]

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const HUGE = 'f00000000001'; // many turns
export const WORDY = 'f00000000002'; // a huge prompt and answer

const id = () => randomBytes(6).toString('hex');
const para = (i) => `Paragraph ${i}: the agent should keep the list stable while the page refreshes, never move what the reader is looking at, and roll back with a toast when the server refuses. `.repeat(4);

export function makeStress(from, to, n = 4000) {
  fs.mkdirSync(to, { recursive: true });
  const src = fs
    .readdirSync(from)
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.join(from, f))
    .filter((f) => fs.statSync(f).size < 120 * 1024)
    .map((f) => JSON.parse(fs.readFileSync(f, 'utf8')))
    .filter((s) => s.turns?.length && !s.parentId && !s.crew && s.state !== 'running');
  const now = Date.now();
  let bytes = 0;
  for (let i = 0; i < n; i++) {
    const s = structuredClone(src[i % src.length]);
    s.id = id();
    s.title = `${s.title} · ${i}`;
    s.createdAt = now - (i + 10) * 9 * 60e3;
    s.updatedAt = s.createdAt + 5 * 60e3;
    for (const k of ['children', 'groupId', 'forkedFrom', 'movedTo', 'later', 'watch', 'goal', 'pending']) delete s[k];
    s.unread = false;
    if (!['done', 'review'].includes(s.state)) s.state = 'done';
    const json = JSON.stringify(s);
    bytes += json.length;
    fs.writeFileSync(path.join(to, `${s.id}.json`), json);
  }
  // Hundreds of turns, newest on top of Needs you.
  const turns = [];
  for (const s of src) for (const t of s.turns) if (turns.length < 400 && t.status !== 'running') turns.push({ ...structuredClone(t), id: id() });
  const huge = { ...structuredClone(src[0]), id: HUGE, title: `Huge task: ${turns.length} turns`, turns, state: 'review', unread: true, createdAt: now - 864e5, updatedAt: now - 60e3 };
  for (const k of ['children', 'groupId', 'forkedFrom', 'movedTo', 'later', 'watch', 'goal']) delete huge[k];
  fs.writeFileSync(path.join(to, `${HUGE}.json`), JSON.stringify(huge));
  // One turn: a pasted prompt of ~150 KB and an answer of ~300 KB.
  const prompt = Array.from({ length: 300 }, (_, i) => para(i)).join('\n\n');
  const t0 = structuredClone(src[0].turns.at(-1));
  const answer = Array.from({ length: 600 }, (_, i) => `## Part ${i}\n\n${para(i)}\n\n- one\n- two\n\n\`\`\`js\nconst x${i} = ${i};\n\`\`\``).join('\n\n');
  const wordy = {
    ...structuredClone(src[0]),
    id: WORDY,
    title: 'Huge prompt and answer',
    state: 'review',
    unread: true,
    createdAt: now - 7200e3,
    updatedAt: now - 120e3,
    turns: [{ ...t0, id: id(), prompt, presentation: { ...(t0.presentation || {}), blocks: [{ type: 'markdown', text: answer }] } }],
  };
  for (const k of ['children', 'groupId', 'forkedFrom', 'movedTo', 'later', 'watch', 'goal']) delete wordy[k];
  fs.writeFileSync(path.join(to, `${WORDY}.json`), JSON.stringify(wordy));
  return { tasks: n + 2, mb: Math.round((bytes + JSON.stringify(huge).length + JSON.stringify(wordy).length) / 1e6), hugeTurns: turns.length };
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(makeStress(process.argv[2], process.argv[3], Number(process.argv[4] || 4000)));
