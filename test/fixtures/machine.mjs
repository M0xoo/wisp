// A stub GET /machine answer, in the shape design/machine.md gives (feat/machine-api): the page's
// tests and QA (qa/web.mjs WEB-MACHINE) use it until the server's route lands.
const GB = 1024 ** 3;
const MB = 1024 ** 2;

export function machineFixture({ now = Date.now(), tasks = [], crew = [], tight = true } = {}) {
  const history = [];
  for (let i = 24 * 60; i >= 0; i--) {
    const at = now - i * 60_000;
    const wave = Math.sin(i / 9) * 6 + Math.sin(i / 37) * 4;
    history.push({ at, freePct: Math.max(4, (tight ? 18 : 48) + wave - (i < 40 ? (40 - i) / 6 : 0)), cpu: Math.max(5, 90 + wave * 9), runs: i < 300 ? 9 : 4, held: i < 25, worktreeBytes: Math.round((i > 600 ? 24 : 21) * GB + (i % 7) * MB) });
  }
  const t = (id, title, rss, cpu, bytes, extra = {}) => ({ id, title, crew: null, rss, cpu, procs: 3, worktreeBytes: bytes, ...extra });
  return {
    at: now,
    mem: { total: 24 * GB, freePct: tight ? 12 : 52, pressure: null },
    cpu: { pct: 164, cores: 8 },
    disk: { free: 61 * GB, total: 494 * GB, worktrees: 21 * GB, reclaimable: 9.4 * GB },
    wisp: { rss: 410 * MB, cpu: 6 },
    guard: { held: 'memory', why: 'Waiting for memory: 12% free, needs 20%', floor: 15, ceiling: 200, maxRuns: 8, runs: 9, pausedUntil: 0, battery: { pct: 64, charging: true, hold: 20 } },
    tasks: tasks.length
      ? tasks
      : [
          t('t1', 'Run the full test suite on the Tauri shell', 3.4 * GB, 182, 2.3 * GB),
          t('t2', 'Fix the flaky crew queue test', 1.2 * GB, 64, 412 * MB),
          t('t3', 'Rename the Settings → Usage rows', 340 * MB, 4, 96 * MB),
          t('j1', 'Nightly triage of new issues', 1.9 * GB, 48, 820 * MB, { crew: 'm1' }),
          t('j2', 'Weekly dependency bump', 760 * MB, 22, 1.1 * GB, { crew: 'm1' }),
        ],
    crew: crew.length ? crew : [{ id: 'm1', name: 'Sana', rss: 2.66 * GB, cpu: 70, jobs: 2 }],
    leftovers: [
      { pid: 48211, command: 'node /Users/me/.wisp/worktrees/wisp-tauri-npm/bin/wisp.js --port 4821', rss: 182 * MB, cpu: 0.4, task: 't9', since: now - 42 * 60_000 },
      { pid: 48302, command: 'claude --resume 7f3a…', rss: 96 * MB, cpu: 0, task: null, since: now - 31 * 60_000 },
    ],
    history,
    reclaim: [
      { kind: 'merged', count: 25, bytes: 3.1 * GB, ids: Array.from({ length: 25 }, (_, i) => `m${i}`) },
      { kind: 'crew', count: 189, bytes: 5.2 * GB, ids: Array.from({ length: 189 }, (_, i) => `c${i}`) },
      { kind: 'done', count: 6, bytes: 610 * MB, ids: Array.from({ length: 6 }, (_, i) => `d${i}`) },
      { kind: 'leftover', count: 29, bytes: 1.4 * GB, ids: Array.from({ length: 29 }, (_, i) => `wisp-left-${i}`) },
    ],
  };
}
