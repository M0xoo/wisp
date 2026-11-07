// Records G6 fixtures from v1 (run by hand, never by the test suite):
//
//   node packages/harness-kit/g6/record.ts <harness id> <fixtures dir>
//
// For each scenario in <fixtures dir>/scenarios.json, v1's adapter runs its fake CLI
// (test/fixtures/fake-agent.mjs, which speaks each CLI's real wire format) through cli.mjs in
// record mode, in a fresh git repo; the raw stdout becomes <name>.jsonl (the repo's path as @CWD@)
// and <name>.meta.json. Then v1's adapter parses that fixture again through cli.mjs in replay mode,
// in an empty folder, and what it reports becomes the golden <name>.v1.json.
//
// A scenario: { name, prompt?, env?: {FAKE_…; @ROOT@ is the repo}, opts?: {mode, resumeId, prior, …}, stopAfter?, drop?, note? }

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLI, collect, loadFixtures, replayEnv, v1Adapter, writeGolden, type FixtureMeta } from './index.ts';

interface Scenario {
  name: string;
  prompt?: string;
  env?: Record<string, string>;
  opts?: Record<string, unknown>;
  stopAfter?: number;
  drop?: string[];
  note?: string;
}

const BINS: Record<string, string> = { claude: 'claude', codex: 'codex', opencode: 'opencode', cursor: 'cursor-agent', antigravity: 'agy', grok: 'grok', copilot: 'copilot' };
const ROOT = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
const FAKE = path.join(ROOT, 'test', 'fixtures', 'fake-agent.mjs');
export const SYSTEM_PROMPT = '# You are running inside wisp\nAnswer with a ```wisp block.\n';

/** v1 test/helpers.js makeRepo: a committed buggy math.js plus one uncommitted line. */
function makeRepo(): string {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'wisp-g6-repo-')));
  const git = (...a: string[]): void => void execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'wisp test');
  writeFileSync(path.join(dir, 'math.js'), 'export function add(a, b) {\n  return a - b;\n}\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  appendFileSync(path.join(dir, 'math.js'), '// uncommitted\n');
  return dir;
}

/** The options a G6 run starts from on both sides; a fixture's opts go on top. */
export function baseRun(cwd: string, env: Record<string, string>): Record<string, unknown> {
  return { prompt: 'fix the add bug', cwd, dirs: [], mode: 'edits', model: '', effort: '', attachments: [], mcpServers: {}, grants: [], systemPrompt: SYSTEM_PROMPT, runEnv: env, env, signal: new AbortController().signal };
}

async function main(): Promise<void> {
  const [id, dirArg] = process.argv.slice(2);
  if (!id || !dirArg || !BINS[id]) throw new Error('usage: record.ts <harness id> <fixtures dir>');
  const dir = path.resolve(dirArg);
  const bins = mkdtempSync(path.join(os.tmpdir(), 'wisp-g6-bin-'));
  const fake = path.join(bins, `${BINS[id]}.mjs`);
  copyFileSync(FAKE, fake);
  process.env[`WISP_${id.toUpperCase()}_BIN`] = CLI;
  const v1 = await v1Adapter(id);
  if (!v1) throw new Error('v1 is gone: fixtures can no longer be recorded');
  const scenarios = JSON.parse(readFileSync(path.join(dir, 'scenarios.json'), 'utf8')) as Scenario[];
  for (const s of scenarios) {
    const repo = makeRepo();
    const out = path.join(dir, s.name);
    const own = Object.fromEntries(Object.entries(s.env ?? {}).map(([k, v]) => [k, v.replaceAll('@ROOT@', ROOT)]));
    const env = { ...own, WISP_TEE_TARGET: fake, WISP_TEE_OUT: out };
    const opts = { ...(s.prompt !== undefined && { prompt: s.prompt }), ...s.opts };
    const meta0: FixtureMeta = { exit: { code: 0, stderr: '' }, opts, ...(s.stopAfter !== undefined && { stopAfter: s.stopAfter }), ...(s.drop && { drop: s.drop }), ...(s.note && { note: s.note }) };
    await collect(v1, { name: s.name, file: `${out}.jsonl`, meta: meta0, golden: null }, { ...baseRun(repo, env) });
    const at = (t: string): string => t.replaceAll(JSON.stringify(repo).slice(1, -1), '@CWD@');
    writeFileSync(`${out}.jsonl`, at(readFileSync(`${out}.jsonl`, 'utf8')));
    const raw = JSON.parse(at(readFileSync(`${out}.raw-meta.json`, 'utf8'))) as { argv: string[]; exit: FixtureMeta['exit'] };
    rmSync(`${out}.raw-meta.json`);
    writeFileSync(`${out}.meta.json`, `${JSON.stringify({ ...meta0, exit: raw.exit, argv: raw.argv }, null, 2)}\n`);
    rmSync(repo, { recursive: true, force: true });
  }
  // The goldens: v1 parsing exactly those bytes, in an empty folder.
  for (const f of (await loadFixtures(dir)).filter((x) => scenarios.some((s) => s.name === x.name))) {
    const cwd = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'wisp-g6-run-')));
    const events = await collect(v1, f, baseRun(cwd, replayEnv(f)));
    await writeGolden(f, events, [cwd]);
    rmSync(cwd, { recursive: true, force: true });
    console.log(`${f.name}: ${events.length} events`);
  }
  rmSync(bins, { recursive: true, force: true });
}

await main();
