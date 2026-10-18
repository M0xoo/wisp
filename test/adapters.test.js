// Every adapter against a fake CLI that speaks its real wire format: detection, the command
// line per permission mode, protocol injection, events, diffs, resume, stop and failures.

import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { alive, installFakeBins, makeRepo, records, same, tmp, until } from './helpers.js';

const RECORD = tmp('record');
process.env.FAKE_RECORD = RECORD;
// grok's model catalog cache, where detect() reads each model's reasoning levels.
process.env.GROK_HOME = tmp('grok-home');
fs.writeFileSync(path.join(process.env.GROK_HOME, 'models_cache.json'), JSON.stringify({ models: { 'grok-9': { info: { name: 'Grok 9', description: 'Big', supports_reasoning_effort: true, reasoning_efforts: [{ id: 'xhigh' }, { id: 'high' }, { id: 'low' }] } } } }));
installFakeBins();

const { adapters } = await import('../server/adapters/index.js');
const { systemPrompt } = await import('../server/protocol.js');

const BIN = { claude: 'claude', codex: 'codex', opencode: 'opencode', cursor: 'cursor-agent', antigravity: 'agy', grok: 'grok' };

// What each permission mode must put on the command line.
const MODE_ARGS = {
  claude: { plan: ['--permission-mode', 'plan'], edits: ['--permission-mode', 'acceptEdits'], auto: ['--permission-mode', 'bypassPermissions'] },
  codex: { plan: ['-c', 'sandbox_mode="read-only"'], edits: ['-c', 'sandbox_mode="workspace-write"'], auto: ['--dangerously-bypass-approvals-and-sandbox'] },
  opencode: { plan: ['--agent', 'plan'], edits: [], auto: ['--auto'] },
  cursor: { plan: ['--mode', 'plan'], edits: [], auto: ['--force'] },
  antigravity: { plan: ['--mode', 'plan'], edits: ['--mode', 'accept-edits'], auto: ['--dangerously-skip-permissions'] },
  grok: { plan: ['--permission-mode', 'plan'], edits: ['--permission-mode', 'acceptEdits'], auto: ['--permission-mode', 'bypassPermissions'] },
};
const EFFORT_ARGS = { claude: ['--effort', 'high'], codex: ['-c', 'model_reasoning_effort="high"'], opencode: ['--variant', 'high'], cursor: null, antigravity: ['--effort', 'high'], grok: ['--reasoning-effort', 'high'] };
const RESUME_ARGS = { claude: ['--resume', 'prev-1'], codex: ['resume', 'prev-1'], opencode: ['--session', 'prev-1'], cursor: ['--resume', 'prev-1'], antigravity: ['--conversation', 'prev-1'], grok: ['--resume', 'prev-1'] };

// agy takes the prompt as a stream-json `user` event; the rest read it raw.
const promptOf = (id, stdin) => (id === 'antigravity' ? JSON.parse(stdin.split('\n')[0]).message.content : stdin);
const hasSeq = (arr, seq) => seq.length === 0 || arr.some((_, i) => seq.every((s, j) => arr[i + j] === s));

function run(id, opts = {}) {
  const a = adapters[id];
  const events = [];
  const handle = a.run({ prompt: 'fix the add bug', cwd: opts.cwd || makeRepo(), mode: 'edits', model: '', resumeId: null, attachments: [], mcpServers: {}, systemPrompt: systemPrompt({ askTool: a.askTool }), ...opts, onEvent: (e) => events.push(e) });
  return { handle, events, done: handle.done.then(() => events) };
}

before(() => fs.rmSync(RECORD, { recursive: true, force: true }));
afterEach(() => {
  delete process.env.FAKE_HANG;
  delete process.env.FAKE_FAIL;
  delete process.env.FAKE_ORPHANS;
  delete process.env.FAKE_RATE_LIMIT;
  delete process.env.WISP_RATE_LIMIT_GRACE_MS;
});

for (const id of Object.keys(BIN)) {
  test(`${id}: detect() finds the CLI on PATH and reads its models`, async () => {
    const found = await adapters[id].detect();
    assert.equal(found.available, true, found.error);
    assert.match(found.version, /9\.9\.9/);
    const models = (found.models || adapters[id].models).map((m) => m.id);
    assert.equal(models[0], '', 'Default comes first');
    if (id === 'opencode') {
      assert.deepEqual(models.slice(1), ['fake/model-a', 'fake/model-b']);
      assert.deepEqual(found.models.map((m) => m.efforts), [undefined, ['low', 'high'], []], 'per-model reasoning variants');
    }
    if (id === 'cursor') assert.deepEqual(models.slice(1), ['fast-1', 'big-2']);
    if (id === 'antigravity') {
      assert.deepEqual(models.slice(1), ['gemini-9-pro-high', 'gemini-9-flash']);
      assert.deepEqual(found.models.map((m) => m.efforts), [undefined, [], undefined], 'effort baked into the slug means no selector');
    }
    if (id === 'grok') {
      assert.deepEqual(models.slice(1), ['grok-9', 'grok-9-fast']);
      assert.deepEqual(found.models.map((m) => m.label), ['Default', 'Grok 9', 'grok-9-fast'], 'names from the catalog cache');
      assert.deepEqual(found.models.map((m) => m.efforts), [undefined, ['low', 'high', 'xhigh'], undefined], 'cached levels, low to high');
    }
  });

  test(`${id}: a turn yields session, tools, real diffs and the final presentation`, async () => {
    const cwd = makeRepo();
    const events = await run(id, { cwd }).done;
    const rec = records(RECORD, BIN[id]).at(-1);

    assert.ok(same(rec.cwd, cwd), `ran in ${rec.cwd}, expected ${cwd}`);
    if (id !== 'claude') assert.ok(same(rec.pwd, cwd), `PWD was ${rec.pwd}`);

    // wisp's protocol reaches the agent: as a system prompt flag, or in front of the prompt.
    const PROMPT_FLAG = { claude: '--append-system-prompt', grok: '--rules' };
    if (PROMPT_FLAG[id]) assert.match(rec.argv[rec.argv.indexOf(PROMPT_FLAG[id]) + 1], /running inside wisp/);
    else assert.match(promptOf(id, rec.stdin), /running inside wisp[\s\S]*# Task\n\nfix the add bug/);

    assert.deepEqual(events.find((e) => e.type === 'session'), { type: 'session', id: `${BIN[id]}-session-1` });
    assert.ok(events.some((e) => e.type === 'tool' && e.kind === 'run' && /npm test|Run the tests/.test(e.label)), 'shell command shown');
    assert.ok(events.some((e) => e.type === 'tool' && e.kind === 'edit' && e.file === 'math.js'), 'edit shown with a project-relative path');

    const change = events.find((e) => e.type === 'change' && e.file === 'math.js');
    assert.ok(change, 'math.js change captured');
    assert.match(change.edits[0].before, /a - b/);
    assert.match(change.edits[0].after, /a \+ b/);
    if (id === 'codex') {
      // Only told "math.js changed": the before side must include the uncommitted line.
      assert.match(change.edits[0].before, /\/\/ uncommitted/);
    }
    if (id === 'codex' || id === 'grok') {
      const created = events.find((e) => e.type === 'change' && e.file === 'notes.txt');
      assert.equal(created?.op, 'create');
    }

    const results = events.filter((e) => e.type === 'result');
    assert.equal(results.length, 1, 'exactly one result');
    assert.equal(results[0].isError, false, results[0].text);
    assert.match(results[0].text, /```wisp/);
  });

  for (const mode of ['plan', 'edits', 'auto']) {
    test(`${id}: ${mode} mode command line`, async () => {
      await run(id, { mode, model: 'm-1' }).done;
      const { argv } = records(RECORD, BIN[id]).at(-1);
      assert.ok(hasSeq(argv, MODE_ARGS[id][mode]), `${argv.join(' ')} lacks ${MODE_ARGS[id][mode].join(' ')}`);
      for (const other of ['plan', 'edits', 'auto'].filter((m) => m !== mode && MODE_ARGS[id][m].length)) {
        assert.ok(!hasSeq(argv, MODE_ARGS[id][other]), `${mode} must not pass ${other} flags`);
      }
      assert.ok(argv.includes('m-1'), 'model passed');
    });
  }

  test(`${id}: thinking level on the command line`, async () => {
    await run(id, { model: 'm-1', effort: 'high' }).done;
    const { argv } = records(RECORD, BIN[id]).at(-1);
    const want = EFFORT_ARGS[id];
    if (want) assert.ok(hasSeq(argv, want), `${argv.join(' ')} lacks ${want.join(' ')}`);
    else assert.ok(!argv.includes('high'), 'no effort flag for a harness without one');
    await run(id, { model: 'm-1', effort: '' }).done;
    assert.ok(!records(RECORD, BIN[id]).at(-1).argv.includes('high'), 'no flag when unset');
  });

  test(`${id}: follow-ups resume the session without re-sending the protocol`, async () => {
    const events = await run(id, { resumeId: 'prev-1', prompt: 'and add a test' }).done;
    const rec = records(RECORD, BIN[id]).at(-1);
    assert.ok(hasSeq(rec.argv, RESUME_ARGS[id]), rec.argv.join(' '));
    if (id !== 'claude') assert.equal(promptOf(id, rec.stdin).startsWith('and add a test'), true, 'no protocol prefix on resume');
    assert.equal(events.find((e) => e.type === 'session')?.id, 'prev-1');
  });

  test(`${id}: stop() kills the agent and reports a stopped result`, async () => {
    process.env.FAKE_HANG = '1';
    const r = run(id);
    await until(() => r.events.some((e) => e.type === 'tool'));
    const { pid } = records(RECORD, BIN[id]).at(-1);
    r.handle.stop();
    const events = await r.done;
    const result = events.filter((e) => e.type === 'result');
    assert.equal(result.length, 1);
    assert.equal(result[0].stopped, true);
    await until(() => !alive(pid), { timeout: 5000 });
  });

  test(`${id}: a CLI failure surfaces its stderr`, async () => {
    process.env.FAKE_FAIL = '1';
    const events = await run(id).done;
    const result = events.filter((e) => e.type === 'result');
    assert.equal(result.length, 1);
    assert.equal(result[0].isError, true);
    assert.match(result[0].text, /not logged in/);
  });
}

test('claude: a resume that first reports stopped background tasks still ends on the real answer', async () => {
  process.env.FAKE_ORPHANS = '1';
  const events = await run('claude', { resumeId: 'prev-1' }).done;
  const results = events.filter((e) => e.type === 'result');
  assert.equal(results.length, 1, 'the empty zero-turn result is not the end of the turn');
  assert.match(results[0].text, /Fake claude finished/);
  assert.equal(results[0].stats.turns, 3);
  assert.ok(events.some((e) => e.type === 'change'), 'the work after it is reported too');
});

test('codex: MCP server and attachments are passed as config overrides and flags', async () => {
  const img = path.join(tmp('att'), 'shot one.png');
  fs.writeFileSync(img, 'png');
  await run('codex', {
    attachments: [{ path: img, mime: 'image/png', size: 3 }],
    mcpServers: { wisp: { command: process.execPath, args: ['/x/mcp-ask.js'], env: { WISP_URL: 'http://127.0.0.1:1', WISP_SESSION: 's1' } } },
  }).done;
  const { argv, stdin } = records(RECORD, 'codex').at(-1);
  assert.ok(hasSeq(argv, ['-c', `mcp_servers.wisp.command=${JSON.stringify(process.execPath)}`]), 'command survives quoting (Windows paths have backslashes)');
  assert.ok(hasSeq(argv, ['-c', 'mcp_servers.wisp.env={WISP_URL="http://127.0.0.1:1",WISP_SESSION="s1"}']));
  assert.ok(hasSeq(argv, ['-i', img]), 'image attached with -i, spaces intact');
  assert.match(stdin, /1 image is attached/);
});

test('cursor: no ask_user tool, so the protocol asks for a question block', async () => {
  await run('cursor').done;
  const { stdin } = records(RECORD, 'cursor-agent').at(-1);
  assert.match(stdin, /end with a "question" block/);
  assert.doesNotMatch(stdin, /ask_user/);
});

test('antigravity: no ask_user tool, denied shell surfaces as a tool error', async () => {
  const events = await run('antigravity').done;
  const { stdin } = records(RECORD, 'agy').at(-1);
  assert.match(promptOf('antigravity', stdin), /end with a "question" block/);
  assert.doesNotMatch(stdin, /ask_user/);
  assert.deepEqual(events.find((e) => e.type === 'tool_error'), { type: 'tool_error', name: 'run_command', text: 'run_command needs approval' });
  assert.ok(events.some((e) => e.type === 'text' && e.text === 'Fixed it.'), 'text deltas joined per step');
  assert.equal(events.find((e) => e.type === 'result').stats.durationMs, 10);
});

test('grok: MCP server via a throwaway --agent file, cleaned up after the turn', async () => {
  const events = await run('grok', { mcpServers: { wisp: { command: process.execPath, args: ['/x/mcp-ask.js'], env: { WISP_SESSION: 's1' } } } }).done;
  const { argv, stdin } = records(RECORD, 'grok').at(-1);
  assert.equal(stdin, 'fix the add bug', 'prompt file holds just the prompt; the protocol rides --rules');
  assert.ok(hasSeq(argv, ['--disallowed-tools', 'ask_user_question']), "grok's own question tool can't be answered headless");
  const agentFile = argv[argv.indexOf('--agent') + 1];
  assert.ok(agentFile && !fs.existsSync(agentFile), 'temp agent file removed');
  assert.ok(!fs.existsSync(argv[argv.indexOf('--prompt-file') + 1]), 'temp prompt file removed');
  assert.deepEqual(events.find((e) => e.type === 'tool_error'), { type: 'tool_error', name: 'run_terminal_command', text: '1 failing' });
  assert.equal(events.find((e) => e.type === 'result').stats.costUsd, 0.02);

  await run('grok').done;
  assert.ok(!records(RECORD, 'grok').at(-1).argv.includes('--agent'), 'no agent file without an MCP server');
});

// A rate-limited free model: opencode retries without a word, so wisp stops it and says why.
test('opencode: a rate limit that never clears ends the turn with what to do, not a hang', async () => {
  process.env.FAKE_RATE_LIMIT = '1';
  process.env.WISP_RATE_LIMIT_GRACE_MS = '300';
  const { events, done } = run('opencode', { model: 'opencode/big-pickle' });
  await done;
  const results = events.filter((e) => e.type === 'result');
  assert.equal(results.length, 1);
  assert.equal(results[0].isError, true);
  assert.ok(!results[0].stopped, 'not shown as stopped by the user');
  assert.match(results[0].text, /`opencode\/big-pickle` is rate-limited right now.*opencode auth login/);
  assert.ok(records(RECORD, 'opencode').at(-1).argv.join(' ').includes('--print-logs --log-level ERROR'), 'errors are logged to stderr');
});

test('opencode: a rate limit that clears on a retry lets the turn finish', async () => {
  process.env.FAKE_RATE_LIMIT = 'recover';
  process.env.WISP_RATE_LIMIT_GRACE_MS = '300';
  const events = await run('opencode').done;
  await new Promise((r) => setTimeout(r, 400)); // past the grace period: nothing more may arrive
  const results = events.filter((e) => e.type === 'result');
  assert.equal(results.length, 1);
  assert.equal(results[0].isError, false, results[0].text);
});
