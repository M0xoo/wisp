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
// codex's copy of its catalog, read when `codex debug models` isn't there; config.toml picks the
// model Default runs.
process.env.CODEX_HOME = tmp('codex-home');
fs.writeFileSync(
  path.join(process.env.CODEX_HOME, 'models_cache.json'),
  JSON.stringify({
    models: [
      { slug: 'gpt-9-mini', display_name: 'GPT-9-Mini', description: 'Small', visibility: 'list', priority: 9, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] },
      { slug: 'codex-auto-review', display_name: 'Codex Auto Review', visibility: 'hide', priority: 1 },
      { slug: 'gpt-9', display_name: 'GPT-9', description: 'Big', visibility: 'list', priority: 2, supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'max' }] },
    ],
  }),
);
fs.writeFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), 'model = "gpt-9-mini"\n\n[profiles.x]\nmodel = "gpt-9"\n');
installFakeBins();

const { adapters } = await import('../server/adapters/index.js');
const { systemPrompt } = await import('../server/protocol.js');

const BIN = { claude: 'claude', codex: 'codex', opencode: 'opencode', cursor: 'cursor-agent', antigravity: 'agy', grok: 'grok', copilot: 'copilot' };

// What each permission mode must put on the command line.
const MODE_ARGS = {
  claude: { plan: ['--permission-mode', 'plan'], edits: ['--permission-mode', 'acceptEdits'], auto: ['--permission-mode', 'bypassPermissions'] },
  codex: { plan: ['-c', 'sandbox_mode="read-only"'], edits: ['-c', 'sandbox_mode="workspace-write"'], auto: ['--dangerously-bypass-approvals-and-sandbox'] },
  opencode: { plan: ['--agent', 'plan'], edits: [], auto: ['--auto'] },
  cursor: { plan: ['--mode', 'plan'], edits: [], auto: ['--force'] },
  antigravity: { plan: ['--mode', 'plan'], edits: ['--mode', 'accept-edits'], auto: ['--dangerously-skip-permissions'] },
  grok: { plan: ['--permission-mode', 'plan'], edits: ['--permission-mode', 'acceptEdits'], auto: ['--permission-mode', 'bypassPermissions'] },
  copilot: { plan: ['--mode', 'plan'], edits: ['--allow-tool=write'], auto: ['--allow-all'] },
};
const EFFORT_ARGS = { claude: ['--effort', 'high'], codex: ['-c', 'model_reasoning_effort="high"'], opencode: ['--variant', 'high'], cursor: null, antigravity: ['--effort', 'high'], grok: ['--reasoning-effort', 'high'], copilot: ['--reasoning-effort', 'high'] };
const RESUME_ARGS = { claude: ['--resume', 'prev-1'], codex: ['resume', 'prev-1'], opencode: ['--session', 'prev-1'], cursor: ['--resume', 'prev-1'], antigravity: ['--conversation', 'prev-1'], grok: ['--resume', 'prev-1'], copilot: ['--resume=prev-1'] };

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
  delete process.env.FAKE_MCP_POLICY;
  delete process.env.FAKE_SESSION_ERROR;
});

for (const id of Object.keys(BIN)) {
  test(`${id}: detect() finds the CLI on PATH and reads its models`, async () => {
    const found = await adapters[id].detect();
    assert.equal(found.available, true, found.error);
    assert.match(found.version, id === 'opencode' ? /^1\.99\.0$/ : /9\.9\.9/); // opencode's fake is 1.x: 2.x takes other flags
    const models = (found.models || adapters[id].models).map((m) => m.id);
    assert.equal(models[0], '', 'Default comes first');
    if (id === 'opencode') {
      assert.deepEqual(models.slice(1), ['fake/model-a', 'fake/model-b']);
      assert.deepEqual(found.models.map((m) => m.efforts), [undefined, ['low', 'high'], []], 'per-model reasoning variants');
      assert.equal(found.hasKey, true, 'a provider from `opencode auth list`');
    }
    // Thinking levels from the CLI itself (--help, the catalog), not a list wisp keeps.
    const levels = { claude: ['low', 'medium', 'high', 'xhigh', 'max'], antigravity: ['low', 'medium', 'high', 'xhigh', 'max'], copilot: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], grok: ['low', 'high', 'xhigh'] };
    if (levels[id]) assert.deepEqual(found.efforts, levels[id], 'levels the CLI reports');
    if (id === 'codex') {
      assert.deepEqual(models.slice(1), ['gpt-10', 'gpt-10-mini'], 'listed models from `codex debug models`, by priority');
      assert.deepEqual(found.models.map((m) => m.label), ['Default', 'GPT-10', 'GPT-10-Mini']);
      assert.deepEqual(found.models.map((m) => m.efforts), [undefined, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], ['low', 'high']], 'each model’s own levels');
      // config.toml names gpt-9-mini, which this catalog lacks: Default takes codex's first choice.
      assert.deepEqual(found.efforts, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
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
    if (id === 'copilot') {
      assert.deepEqual(models.slice(1), ['claude-opus-9.5', 'gpt-9.1-sol'], 'the `model` list from copilot help config');
      assert.deepEqual(found.models.map((m) => m.label), ['Default', 'Claude Opus 9.5', 'GPT-9.1 Sol']);
    }
  });

  if (id === 'codex')
    test('codex: a lean run (the retro) turns codex\'s extras off and swaps its base prompt for one line', async () => {
      await run(id, { lean: true, mode: 'plan', systemPrompt: '# wisp retro\nReply with JSON.' }).done;
      const argv = records(RECORD, BIN[id]).at(-1).argv;
      for (const f of ['plugins', 'apps', 'multi_agent']) assert.ok(argv.includes(`features.${f}=false`), f);
      const file = argv.find((a) => a.startsWith('model_instructions_file='));
      assert.ok(file, 'a base prompt file');
      assert.equal(fs.existsSync(JSON.parse(file.slice(file.indexOf('=') + 1))), false, 'removed once the run ends');
      if (process.platform !== 'win32') assert.ok(argv.includes('developer_instructions="# wisp retro\\nReply with JSON."'));
    });

  if (id === 'codex')
    test('codex: without `debug models`, detect() reads the cached catalog; Default takes config.toml’s model', async () => {
      process.env.FAKE_CODEX_NO_DEBUG = '1';
      try {
        const found = await adapters.codex.detect();
        assert.deepEqual(found.models.map((m) => m.id), ['', 'gpt-9', 'gpt-9-mini'], 'hidden models stay out');
        assert.deepEqual(found.models.map((m) => m.efforts), [undefined, ['medium', 'max'], ['low', 'high']]);
        assert.deepEqual(found.efforts, ['low', 'high'], 'the top-level model, not the profile’s');
      } finally {
        delete process.env.FAKE_CODEX_NO_DEBUG;
      }
    });

  test(`${id}: a turn yields session, tools, real diffs and the final presentation`, async () => {
    const cwd = makeRepo();
    const events = await run(id, { cwd }).done;
    const rec = records(RECORD, BIN[id]).at(-1);

    assert.ok(same(rec.cwd, cwd), `ran in ${rec.cwd}, expected ${cwd}`);
    if (id !== 'claude') assert.ok(same(rec.pwd, cwd), `PWD was ${rec.pwd}`);

    // wisp's protocol reaches the agent: as a system prompt flag, or in front of the prompt. Codex
    // (0.53+, not on Windows) takes it as developer instructions, ahead of the task's folder, so it's cached.
    const PROMPT_FLAG = { claude: '--append-system-prompt', grok: '--rules' };
    const developer = id === 'codex' && process.platform !== 'win32' && rec.argv.find((a) => a.startsWith('developer_instructions='));
    if (PROMPT_FLAG[id]) assert.match(rec.argv[rec.argv.indexOf(PROMPT_FLAG[id]) + 1], /running inside wisp/);
    else if (id === 'codex' && process.platform !== 'win32') {
      assert.match(developer || '', /^developer_instructions="# You are running inside wisp/);
      assert.equal(promptOf(id, rec.stdin).trim(), 'fix the add bug', 'the prompt alone on stdin');
    } else assert.match(promptOf(id, rec.stdin), /running inside wisp[\s\S]*# Task\n\nfix the add bug/);

    // copilot is handed a fresh session id rather than making one up.
    const sid = id === 'copilot' ? rec.argv[rec.argv.indexOf('--session-id') + 1] : `${BIN[id]}-session-1`;
    assert.deepEqual(events.find((e) => e.type === 'session'), { type: 'session', id: sid });
    assert.ok(events.some((e) => e.type === 'tool' && e.kind === 'run' && /Running tests|Run the tests/.test(e.label)), 'shell command shown');
    assert.ok(events.some((e) => e.type === 'tool' && e.kind === 'edit' && e.file === 'math.js'), 'edit shown with a project-relative path');

    const change = events.find((e) => e.type === 'change' && e.file === 'math.js');
    assert.ok(change, 'math.js change captured');
    assert.match(change.edits[0].before, /a - b/);
    assert.match(change.edits[0].after, /a \+ b/);
    if (id === 'codex') {
      // Only told "math.js changed": the before side must include the uncommitted line.
      assert.match(change.edits[0].before, /\/\/ uncommitted/);
    }
    if (id === 'codex' || id === 'grok' || id === 'copilot') {
      const created = events.find((e) => e.type === 'change' && e.file === 'notes.txt');
      assert.equal(created?.op, 'create');
    }

    const results = events.filter((e) => e.type === 'result');
    assert.equal(results.length, 1, 'exactly one result');
    assert.equal(results[0].isError, false, results[0].text);
    assert.match(results[0].text, /```wisp/);
  });

  // The transcript: what a finished call returned, matched to the call that made it.
  if (['claude', 'codex', 'opencode', 'grok', 'copilot'].includes(id)) {
    test(`${id}: a finished call's output comes back with its call`, async () => {
      const events = await run(id).done;
      const out = events.find((e) => e.type === 'tool_output');
      if (id === 'opencode') {
        // It reports a call once it has run, output and all.
        assert.equal(events.find((e) => e.type === 'tool' && e.kind === 'run').output, '1 failing');
        return;
      }
      assert.ok(out, 'a tool_output event');
      const call = events.find((e) => e.type === 'tool' && e.id === out.id);
      assert.ok(call, `tool_output ${out.id} names a call that was announced`);
      if (id === 'codex') assert.deepEqual([call.kind, out.text], ['run', ' M math.js']);
      if (id === 'claude' || id === 'copilot') assert.match(out.text, /a - b/);
      if (id === 'claude') assert.ok(!events.some((e) => e.type === 'tool_output' && e.id === 't3'), 'a failed call is an error, not output');
    });
  }

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

  // A task across several folders: Claude and Codex get the others as writable dirs (Codex in its
  // sandbox's writable roots too, which resume takes as well); the rest only hear the paths.
  if (id === 'claude' || id === 'codex')
    test(`${id}: the task's other folders on the command line`, async () => {
      const web = tmp('also-web');
      await run(id, { dirs: [web] }).done;
      const { argv } = records(RECORD, BIN[id]).at(-1);
      assert.ok(hasSeq(argv, ['--add-dir', web]), argv.join(' '));
      if (id === 'codex') {
        assert.ok(hasSeq(argv, ['-c', `sandbox_workspace_write.writable_roots=${JSON.stringify([web])}`]), argv.join(' '));
        await run(id, { dirs: [web], resumeId: 'prev-1', prompt: 'more' }).done;
        assert.ok(records(RECORD, BIN[id]).at(-1).argv.includes(`sandbox_workspace_write.writable_roots=${JSON.stringify([web])}`), 'kept on resume');
      }
      if (id === 'claude') assert.deepEqual(adapters[id].resumeCommand({ resumeId: 'r1', dirs: [web] }).slice(-2), ['--add-dir', web], 'take over gets them too');
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

test('claude: passes --chrome when Claude in Chrome is enabled by default', async () => {
  const dir = tmp('claude-config');
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    await run('claude').done;
    assert.ok(!records(RECORD, 'claude').at(-1).argv.includes('--chrome'), 'no config: off');
    fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ claudeInChromeDefaultEnabled: true }));
    await run('claude').done;
    assert.ok(records(RECORD, 'claude').at(-1).argv.includes('--chrome'), 'follows the /chrome default');
    process.env.WISP_CLAUDE_CHROME = '0';
    await run('claude').done;
    assert.ok(!records(RECORD, 'claude').at(-1).argv.includes('--chrome'), 'env override wins');
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.WISP_CLAUDE_CHROME;
  }
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

// Only free models (no provider, no key in the environment) doesn't count as set up on home.
test('opencode: `auth list` tells a provider or key from the free models alone', async () => {
  const { hasKey } = await import('../server/adapters/opencode.js');
  const creds = (n) => `\n┌  Credentials ~/.local/share/opencode/auth.json\n│\n└  ${n} credentials\n`;
  assert.equal(hasKey(creds(0)), false);
  assert.equal(hasKey(creds(1)), true);
  assert.equal(hasKey(`${creds(0)}\n┌  Environment\n│\n●  Anthropic ANTHROPIC_API_KEY\n│\n└  1 environment variable\n`), true);
  assert.equal(hasKey(`\x1b[90m└  \x1b[0m0 credentials`), false, 'colours stripped');
  assert.equal(hasKey(''), null, 'unknown output says nothing');
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

// opencode 2 refuses `--log-level ERROR` ("invalid --log-level value") and has no --variant.
test('opencode: 2.x gets lowercase --log-level and the effort on the model', async () => {
  const { majorVersion } = await import('../server/adapters/opencode.js');
  assert.equal(majorVersion('1.18.35'), 1);
  assert.equal(majorVersion('opencode v2.2.0'), 2);
  assert.equal(majorVersion(''), 0);
  try {
    process.env.FAKE_OPENCODE_VERSION = 'opencode v2.2.0';
    await adapters.opencode.detect();
    await run('opencode', { model: 'fake/model-a', effort: 'high' }).done;
    const argv = records(RECORD, 'opencode').at(-1).argv;
    assert.ok(hasSeq(argv, ['--log-level', 'error']), argv.join(' '));
    assert.ok(hasSeq(argv, ['--model', 'fake/model-a#high']), argv.join(' '));
    assert.ok(!argv.includes('--variant'));
  } finally {
    delete process.env.FAKE_OPENCODE_VERSION;
    await adapters.opencode.detect();
  }
  await run('opencode', { model: 'fake/model-a', effort: 'high' }).done;
  assert.ok(hasSeq(records(RECORD, 'opencode').at(-1).argv, ['--log-level', 'ERROR', '--model', 'fake/model-a', '--variant', 'high']), '1.x keeps its flags');
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

test('claude: permission prompts go to wisp only in Edits mode, and only with its server injected', async () => {
  const wisp = { wisp: { command: process.execPath, args: ['-e', ''] } };
  const argvOf = async (opts) => (await run('claude', opts).done, records(RECORD, 'claude').at(-1).argv);
  const prompt = (argv) => argv[argv.indexOf('--permission-prompt-tool') + 1];
  assert.equal(prompt(await argvOf({ mode: 'edits', mcpServers: wisp })), 'mcp__wisp__approve');
  assert.ok(!(await argvOf({ mode: 'plan', mcpServers: wisp })).includes('--permission-prompt-tool'));
  assert.ok(!(await argvOf({ mode: 'auto', mcpServers: wisp })).includes('--permission-prompt-tool'));
  assert.ok(!(await argvOf({ mode: 'edits' })).includes('--permission-prompt-tool'), 'a subagent (no server) keeps the old deny');
  const argv = await argvOf({ mode: 'edits', mcpServers: wisp, grants: ['Bash(npm publish)'] });
  assert.ok(hasSeq(argv, ['--allowedTools', 'mcp__wisp', 'Bash(npm publish)']));
  assert.deepEqual(adapters.claude.permission('Write', { file_path: path.join('/repo', 'src', 'a.js') }, '/repo'), { tool: 'Write', action: `write ${path.join('src', 'a.js')}`, detail: path.join('src', 'a.js'), why: '' });
});

test('grok, cursor, antigravity: what their permissions refused comes out as blocked events', async () => {
  const grok = await run('grok', { prompt: 'BLOCKED publish it' }).done;
  assert.deepEqual(grok.filter((e) => e.type === 'blocked'), [{ type: 'blocked', tool: 'Edit', detail: 'calc.py' }]);
  const cursor = await run('cursor').done;
  assert.deepEqual(cursor.filter((e) => e.type === 'blocked'), [{ type: 'blocked', tool: 'shell', detail: 'npm test' }]);
  const agy = await run('antigravity').done;
  assert.deepEqual(agy.filter((e) => e.type === 'blocked'), [{ type: 'blocked', tool: 'run_command', detail: 'npm test' }]);
});

test('copilot: prompt on stdin, MCP server through --additional-mcp-config, its own asking off', async () => {
  const wisp = { wisp: { command: process.execPath, args: ['/x/mcp-ask.js'], env: { WISP_SESSION: 's1' } } };
  const events = await run('copilot', { mcpServers: wisp }).done;
  const { argv } = records(RECORD, 'copilot').at(-1);
  assert.ok(!argv.includes('-p') && !argv.some((a) => /fix the add bug/.test(a)), 'the prompt is not on the command line');
  const cfg = JSON.parse(argv[argv.indexOf('--additional-mcp-config') + 1]);
  assert.deepEqual(cfg.mcpServers.wisp, { type: 'local', command: process.execPath, args: ['/x/mcp-ask.js'], env: { WISP_SESSION: 's1' }, tools: ['*'], timeout: 7 * 24 * 3600 * 1000 });
  assert.ok(argv.includes('--allow-tool=wisp'), 'wisp’s tools need no permission outside Full auto');
  assert.ok(argv.includes('--no-ask-user'), "copilot's own question tool can't be answered headless");
  assert.ok(!events.some((e) => e.type === 'text' && e.text === 'subagent chatter'), 'subagent steps stay out of the trail');
  assert.ok(events.some((e) => e.type === 'thinking'));
  assert.deepEqual(events.find((e) => e.type === 'result').stats, { durationMs: 6, inputTokens: 10, outputTokens: 5 });
  assert.equal(adapters.copilot.askTool, 'wisp-ask_user', 'how copilot names an MCP tool: <server>-<tool>');

  await run('copilot').done;
  const plain = records(RECORD, 'copilot').at(-1).argv;
  assert.ok(!plain.includes('--additional-mcp-config') && !plain.includes('--allow-tool=wisp'), 'nothing to add without a server');
});

test('copilot: a follow-up reports only its own tokens, though copilot counts the whole session', async () => {
  const first = await run('copilot').done;
  const id = first.find((e) => e.type === 'session').id;
  const next = await run('copilot', { resumeId: id, prompt: 'and add a test' }).done;
  assert.deepEqual(next.find((e) => e.type === 'result').stats, { durationMs: 6, inputTokens: 15, outputTokens: 7 });
  const unseen = await run('copilot', { resumeId: 'from-before-a-restart', prompt: 'more' }).done;
  assert.deepEqual(unseen.find((e) => e.type === 'result').stats, { durationMs: 6 }, 'no baseline: no tokens rather than the whole session');
});

test('copilot: a refused command comes back blocked with its --allow-tool rule, which the retry passes', async () => {
  const events = await run('copilot', { prompt: 'BLOCKED publish it' }).done;
  assert.deepEqual(events.filter((e) => e.type === 'blocked'), [{ type: 'blocked', tool: 'shell', detail: 'npm publish', rule: ['shell(npm publish)'] }]);
  assert.ok(events.some((e) => e.type === 'tool_error' && /Permission denied/.test(e.text)));
  const retry = await run('copilot', { prompt: 'BLOCKED publish it', grants: [['shell(npm publish)']] }).done;
  assert.ok(records(RECORD, 'copilot').at(-1).argv.includes('--allow-tool=shell(npm publish)'));
  assert.deepEqual(retry.filter((e) => e.type === 'blocked'), []);
  assert.match(retry.find((e) => e.type === 'result').text, /Published/);
});

test('copilot: a lead with a team turns its own subagents off; Take over resumes the session', async () => {
  await run('copilot', { delegating: true }).done;
  assert.ok(records(RECORD, 'copilot').at(-1).argv.includes('--excluded-tools=task'));
  assert.deepEqual(adapters.copilot.resumeCommand({ resumeId: 'r1', model: 'gpt-9.1-sol', effort: 'high' }), ['copilot', '--resume=r1', '--model', 'gpt-9.1-sol', '--reasoning-effort', 'high']);
});

test('take over in a folder wisp made starts without the trust question, for every harness', async () => {
  const dir = fs.realpathSync(tmp('made-by-wisp'));
  const cmd = (id, trusted) => adapters[id].resumeCommand({ resumeId: 'r1', cwd: dir, trusted });
  assert.deepEqual(cmd('cursor', true).slice(-1), ['--trust']);
  assert.deepEqual(cmd('grok', true).slice(-1), ['--trust']);
  assert.deepEqual(cmd('antigravity', true).slice(-2), ['--settings', JSON.stringify({ trustedWorkspaces: [dir] })]);
  for (const id of ['cursor', 'grok', 'antigravity']) assert.ok(!cmd(id, false).some((a) => /trust/i.test(a)), `${id}: the user's own folder keeps its question`);
  // The rest have no flag for it: their config records the answer, as their own dialog would.
  const { trustFolder: codexTrust } = await import('../server/adapters/codex.js');
  const codexHome = tmp('trust-codex');
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "x"');
  codexTrust(dir, codexHome);
  codexTrust(dir, codexHome);
  assert.equal(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'), `model = "x"\n\n[projects.${JSON.stringify(dir)}]\ntrust_level = "trusted"\n`, 'once, after what was there');
  const { trustFolder: copilotTrust } = await import('../server/adapters/copilot.js');
  const copilotHome = tmp('trust-copilot');
  fs.writeFileSync(path.join(copilotHome, 'config.json'), JSON.stringify({ model: 'x', trusted_folders: ['/elsewhere'] }));
  copilotTrust(dir, copilotHome);
  copilotTrust(dir, copilotHome);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(copilotHome, 'config.json'), 'utf8')), { model: 'x', trusted_folders: ['/elsewhere', dir] });
  const { trustFolder: claudeTrust } = await import('../server/adapters/claude.js');
  const claudeHome = tmp('trust-claude');
  const file = path.join(claudeHome, '.claude.json');
  fs.writeFileSync(file, JSON.stringify({ numStartups: 3, projects: { [dir]: { allowedTools: ['Bash'] } } }));
  claudeTrust(dir, { CLAUDE_CONFIG_DIR: claudeHome });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { numStartups: 3, projects: { [dir]: { allowedTools: ['Bash'], hasTrustDialogAccepted: true } } });
  assert.ok(!fs.existsSync(`${file}.lock`), 'its lock is let go');
  const fresh = tmp('trust-claude-none');
  claudeTrust(dir, { CLAUDE_CONFIG_DIR: fresh });
  assert.ok(!fs.existsSync(path.join(fresh, '.claude.json')), 'a claude never run gets no config from wisp');
});

test('copilot: a COPILOT_ALLOW_ALL in the environment does not lift Plan or Edits', async () => {
  process.env.COPILOT_ALLOW_ALL = 'true';
  try {
    await run('copilot', { mode: 'plan' }).done;
    const { argv } = records(RECORD, 'copilot').at(-1);
    assert.ok(!argv.includes('--allow-all'));
    assert.equal(records(RECORD, 'copilot').at(-1).allowAll, undefined);
  } finally {
    delete process.env.COPILOT_ALLOW_ALL;
  }
});

test('copilot: a policy that blocks wisp’s MCP server, and a session error, say so on the card', async () => {
  process.env.FAKE_MCP_POLICY = '1';
  const blocked = await run('copilot', { mcpServers: { wisp: { command: process.execPath, args: ['-e', ''] } } }).done;
  assert.match(blocked.find((e) => e.type === 'tool_error' && e.name === 'wisp')?.text || '', /blocked by policy: 'wisp'.*can't ask you mid-run/);
  delete process.env.FAKE_MCP_POLICY;
  process.env.FAKE_SESSION_ERROR = 'You have exceeded your premium request allowance.';
  const results = (await run('copilot').done).filter((e) => e.type === 'result');
  assert.equal(results.length, 1);
  assert.equal(results[0].isError, true);
  assert.equal(results[0].text, 'You have exceeded your premium request allowance.');
});

// A harness announces an edit and writes at once: the snapshot can land between the truncate and
// the write and read an empty file. That isn't what the file held before.
test('a snapshot caught mid-write falls back to git for the before side', async () => {
  const { fileTracker } = await import('../server/adapters/common.js');
  const cwd = makeRepo();
  const files = fileTracker(cwd);
  const math = path.join(cwd, 'math.js');
  fs.writeFileSync(math, ''); // truncated, not written yet
  files.remember(math);
  fs.writeFileSync(math, 'export function add(a, b) {\n  return a + b;\n}\n');
  const edit = files.change(math);
  assert.equal(edit.op, 'write');
  assert.match(edit.edits[0].before, /a - b[\s\S]*\/\/ uncommitted/);

  const notes = path.join(cwd, 'notes.txt');
  fs.writeFileSync(notes, '');
  files.remember(notes);
  fs.writeFileSync(notes, 'new file\n');
  assert.equal(files.change(notes).op, 'create');
});
