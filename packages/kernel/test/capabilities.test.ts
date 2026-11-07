import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowed, APIKEY, BOX, CapabilityRegistry, cappedRefusal, cappedSet, covers, crewSet, explain, formatPermission, glob, paneSet, parsePermission, permissionProblem, pluginSet, PREVIEW, sessionSet, USER_FULL } from '../src/index.ts';
import { manifest } from './helpers.ts';

test('the permission grammar: ns:action{k:v,…}', () => {
  for (const ok of ['*', 'git:push', 'git:worktree.add', 'proc:spawn{bin:claude}', 'topic:read{topic:session:*}', 'fs:write{scope:workspace,mode:rw}', 'git:*', '*:read', 'net:none'])
    assert.equal(permissionProblem(ok), undefined, ok);
  const bad: [string, RegExp][] = [
    ['push', /no ':'/],
    ['Git:push', /namespace/],
    ['git:', /action/],
    ['git:pu sh', /action/],
    ['proc:spawn{bin:claude', /must end/],
    ['proc:spawn{}', /empty scope/],
    ['proc:spawn{bin}', /not k:v/],
    ['proc:spawn{bin:}', /no value/],
    ['proc:spawn{bin:a,bin:b}', /twice/],
    ['proc:spawn{Bin:a}', /not k:v/],
  ];
  for (const [s, re] of bad) assert.match(permissionProblem(s) ?? '', re, s);
  assert.equal(parsePermission('nope'), undefined);
  assert.deepEqual(parsePermission('topic:read{topic:session:*}'), { ns: 'topic', action: 'read', scope: { topic: 'session:*' } });
  for (const s of ['*', 'git:push', 'proc:spawn{bin:claude,arg:x}']) assert.equal(formatPermission(parsePermission(s) ?? assert.fail()), s);
});

test('scope matching: a wider grant covers a narrower request, never the reverse', () => {
  const t: [string, string, boolean][] = [
    ['proc:spawn{bin:*}', 'proc:spawn{bin:claude}', true],
    ['proc:spawn{bin:claude}', 'proc:spawn{bin:*}', false],
    ['proc:spawn{bin:claude}', 'proc:spawn{bin:codex}', false],
    ['proc:spawn', 'proc:spawn{bin:claude}', true],
    ['proc:spawn{bin:claude}', 'proc:spawn', false],
    ['proc:spawn{bin:claude}', 'proc:spawn{bin:claude,cwd:/x}', true],
    ['secrets:read{key:claude.*}', 'secrets:read{key:claude.token}', true],
    ['secrets:read{key:claude.*}', 'secrets:read{key:codex.token}', false],
    ['git:*', 'git:worktree.add', true],
    ['git:worktree.*', 'git:worktree.add', true],
    ['git:worktree.*', 'git:push', false],
    ['*', 'anything:at{all:1}', true],
    ['*:read', 'stuff:read', true],
    ['topic:read{topic:session:*}', 'topic:read{topic:session:42}', true],
    ['topic:read{topic:session:*}', 'topic:read{topic:list}', false],
    ['git:push', 'nope', false],
  ];
  for (const [g, r, want] of t) assert.equal(covers(g, r), want, `${g} covers ${r}`);
  assert.ok(glob('a*c', 'abbbc'));
  assert.ok(!glob('a.c', 'abc')); // a dot is literal
});

test('default deny, and a deny beats an allow with its reason', () => {
  assert.ok(allowed(USER_FULL, 'runtime:start'));
  assert.deepEqual(explain(paneSet('x'), 'stuff:read'), { ok: false, why: 'pane:x may not stuff:read' });
  assert.ok(allowed(paneSet('x', ['stuff:read']), 'stuff:read'));
  assert.deepEqual(explain(USER_FULL, 'bad'), { ok: false, why: '"bad" is not a permission' });
  const d = explain(BOX, 'machines:add');
  assert.equal(d.ok, false);
  assert.ok(allowed(BOX, 'runtime:start'));
  assert.ok(!allowed(BOX, 'proc:spawn{sandbox:none}'));
  assert.ok(allowed(BOX, 'proc:spawn{sandbox:gvisor}'));
  assert.ok(allowed(APIKEY, 'runtime:start'));
  assert.ok(!allowed(APIKEY, 'apikeys:create'));
  assert.ok(!allowed(APIKEY, 'secrets:read'));
  assert.ok(allowed(PREVIEW, 'topic:read{topic:list}'));
  assert.ok(!allowed(PREVIEW, 'runtime:start'));
});

test('agent:capped is v1 capped.js: same refusals, word for word', () => {
  const capped = cappedSet();
  assert.equal(capped.id, 'agent:capped');
  const why = (p: string): string => {
    const d = explain(capped, p);
    return d.ok ? '' : d.why;
  };
  assert.equal(why('machines:run'), cappedRefusal('run anything on another machine or in a sandbox'));
  assert.equal(why('connectors:read'), cappedRefusal("read or change the user's connectors"));
  assert.equal(why('runtime:start{project:other}'), cappedRefusal('start a task in another project'));
  assert.equal(why('stuff:publish'), cappedRefusal('put anything on a public link, or take one down'));
  assert.equal(why('crew:write'), cappedRefusal('change the user’s crew'));
  assert.match(cappedRefusal('x'), /^Refused: this task was started from a channel with a mode cap, so it can't x\. Say so in your report; the user can do it in wisp\.$/);
  // what a capped task may still do
  assert.ok(allowed(capped, 'runtime:start{project:own,mode:edits}'));
  assert.ok(allowed(capped, 'session:read{project:own}'));
  assert.ok(allowed(capped, 'stuff:save{project:own,from:inside}'));
  // nothing above its cap
  assert.match(why('runtime:start{project:own,mode:auto}'), /Full auto, above this task’s Edits/);
  const plan = cappedSet('plan');
  assert.equal(plan.id, 'agent:capped:plan');
  assert.ok(!allowed(plan, 'runtime:start{mode:edits}'));
});

test('agent:session is narrowed per mode; crew members cannot rewrite the crew', () => {
  assert.ok(allowed(sessionSet('auto'), 'runtime:start{mode:auto}'));
  assert.ok(!allowed(sessionSet('edits'), 'runtime:start{mode:auto}'));
  assert.ok(allowed(sessionSet('edits'), 'runtime:start{mode:edits}'));
  assert.ok(!allowed(sessionSet('plan'), 'session:mode{to:edits}'));
  assert.ok(!allowed(sessionSet('auto'), 'plugins:install'));
  const c = crewSet('reviewer');
  assert.equal(c.id, 'crew:reviewer');
  assert.ok(!allowed(c, 'crew:write'));
  assert.ok(allowed(c, 'crew:read'));
});

test('a plugin speaks for its manifest permissions plus its own commands', () => {
  const s = pluginSet(manifest('wisp.claude', { permissions: ['proc:spawn{bin:claude}'] }));
  assert.ok(allowed(s, 'claude:login'));
  assert.ok(allowed(s, 'proc:spawn{bin:claude}'));
  assert.ok(!allowed(s, 'proc:spawn{bin:codex}'));
  assert.ok(!allowed(s, 'runtime:start'));
});

test('the registry knows every set, and makes the parametrised families', () => {
  const r = new CapabilityRegistry();
  for (const id of ['user:full', 'agent:session', 'agent:session:plan', 'agent:capped', 'agent:capped:plan', 'box', 'apikey', 'preview']) assert.ok(r.get(id), id);
  assert.equal(r.get('crew:ana')?.id, 'crew:ana');
  assert.equal(r.get('pane:p1')?.id, 'pane:p1');
  assert.equal(r.get('agent:session:auto')?.id, 'agent:session:auto');
  assert.equal(r.get('agent:session:0190-abc')?.id, 'agent:session');
  assert.equal(r.get('agent:capped:auto')?.id, 'agent:capped:auto');
  assert.equal(r.get('nobody'), undefined);
  assert.equal(r.get('crew:'), undefined);
  r.define(paneSet('p1', ['stuff:read']));
  assert.ok(allowed(r.get('pane:p1') ?? assert.fail(), 'stuff:read'));
  assert.ok(r.ids().includes('pane:p1'));
});
