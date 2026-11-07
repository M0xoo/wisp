// The doc block (v1 test/doc-block.test.js, its pure parts): a markdown file the agent wrote. v1's
// "keepDocs snapshots the file into the block" and "reveal shows files in the project or named by a
// block" need the runner and the HTTP routes: they are ported with those.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SYSTEM_PROMPT } from '../src/blocks/prompt.ts';
import { blocksToMarkdown } from '../src/blocks/render.ts';

test('the agent is told about the doc block', () => {
  assert.match(SYSTEM_PROMPT, /"type":"doc","path"/);
});

test('the markdown export names the file and folds its text', () => {
  const out = blocksToMarkdown([{ type: 'doc', path: 'docs/plan.md', title: 'Plan', text: '# Plan\n\nBody' }]);
  assert.match(out, /docs\/plan\.md/);
  assert.match(out, /<details>/);
  assert.match(out, /Body/);
  assert.equal(blocksToMarkdown([{ type: 'doc', path: 'docs/x.md' }]), '📄 **`docs/x.md`**', 'no title, no text: just the path');
});
