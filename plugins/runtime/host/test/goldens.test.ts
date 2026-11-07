// Goldens of real answers (AGENTS.md: what an agent reads or writes is pinned). The agent writes the
// `wisp` block, so its parse and its markdown stand-in are a contract; so is the system prompt.
// UPDATE_GOLDENS=1 rewrites them: changing one is a deliberate act in the PR.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parsePresentation } from '../src/blocks/parse.ts';
import { blocksToMarkdown } from '../src/blocks/render.ts';
import { systemPrompt } from '../src/blocks/prompt.ts';

const dir = path.join(import.meta.dirname, 'goldens');
const update = process.env['UPDATE_GOLDENS'] === '1';

// v1 server/subagents.js SUBAGENT_ASK: a subagent has nobody to ask.
const SUBAGENT_ASK = `- You are a subagent: a lead agent delegated this task to you and will read your presentation.
  You cannot ask the user anything. Make the call yourself, note the assumption in a "callout"
  block, and finish. Don't commit unless the task says to.`;

function golden(name: string, actual: string): void {
  const file = path.join(dir, name);
  if (update || !fs.existsSync(file)) fs.writeFileSync(file, actual);
  assert.equal(actual, fs.readFileSync(file, 'utf8'), `${name} changed: run with UPDATE_GOLDENS=1 if that is meant`);
}

const inputs: string[] = JSON.parse(fs.readFileSync(path.join(dir, 'blocks-real.json'), 'utf8')) as string[];

test('real answers parse as pinned', () => {
  assert.ok(inputs.length >= 15);
  golden('blocks-real.parsed.json', `${JSON.stringify(inputs.map((t) => parsePresentation(t)), null, 2)}\n`);
});

test('real answers render to markdown as pinned', () => {
  const md = inputs.map((t, i) => `<!-- answer ${i} -->\n${blocksToMarkdown(parsePresentation(t).blocks)}`).join('\n\n');
  golden('blocks-real.md', `${md}\n`);
});

test('the system prompt is pinned, in its three main shapes', () => {
  golden('system-prompt.txt', systemPrompt());
  golden('system-prompt-plain.txt', systemPrompt({ blocks: false }));
  golden('system-prompt-subagent.txt', systemPrompt({ ask: SUBAGENT_ASK }));
});

test('every built-in block type the prompt documents appears in a golden answer', () => {
  const seen = new Set(inputs.flatMap((t) => parsePresentation(t).blocks.map((b) => b.type)));
  for (const type of ['hero', 'markdown', 'steps', 'stats', 'files', 'diff', 'tests', 'commits', 'graph', 'tree', 'code', 'compare', 'flow', 'chart', 'terminal', 'checklist', 'callout', 'image', 'video', 'preview', 'map', 'doc', 'task', 'stuff', 'question', 'blocked', 'actions', 'next', 'app']) {
    assert.ok(seen.has(type), type);
  }
});
