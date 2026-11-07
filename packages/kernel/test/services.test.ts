// Plugin services (plan §6.11.1): by contract, every method a permission, plain data only, handles
// owned by the consumer's scope, service_gone + onLost when the provider goes, provider choice.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defineService, Kernel, scoped, type Disposable, type KernelOptions, type PluginContext } from '../src/index.ts';
import { def, manifest, rejection } from './helpers.ts';

interface Repo {
  status(): Promise<{ clean: boolean }>;
  worktreeAdd(branch: string): string;
  onChange(cb: (e: string) => void): Disposable;
  dispose(): void;
}
interface GitService {
  repo(path: string): Repo;
  version(): string;
  info(o: { path: string }): { path: string; tags: string[] };
  slow(): Promise<string>;
  weird(): unknown;
}
const gitService = defineService<GitService>(
  'git.service',
  1,
  { repo: 'git:repo', 'repo.worktreeAdd': 'git:worktree.add', version: 'git:read', info: 'git:read', slow: 'git:read', weird: 'git:read' },
  ['version', 'info'],
);

function gitImpl(log: string[]): GitService {
  return {
    repo: (path) => ({
      status: async () => ({ clean: true }),
      worktreeAdd: (b) => `${path}#${b}`,
      onChange: (cb) => {
        const t = setInterval(() => cb('changed'), 1);
        return { dispose: () => (log.push('unwatched'), clearInterval(t)) };
      },
      dispose: () => void log.push(`closed ${path}`),
    }),
    version: () => '2.44',
    info: (o) => ({ path: o.path, tags: ['v1'] }),
    slow: () => new Promise((r) => setTimeout(() => r('late'), 50)),
    weird: () => new Map(),
  };
}

async function world(consumerPerms: string[], o: KernelOptions = {}, req: string | { version: string; optional: true } = '^1'): Promise<{ k: Kernel; ctx: () => PluginContext; log: string[] }> {
  const k = new Kernel(o);
  const log: string[] = [];
  let c: PluginContext | undefined;
  k.register(manifest('wisp.git', { provides: { 'git.service': { version: '1.3.0' } } }), { def: def('wisp.git', (ctx) => ctx.provide(gitService, gitImpl(log))), builtin: true });
  k.register(manifest('wisp.worktrees', { requires: { 'git.service': req }, permissions: consumerPerms }), { def: def('wisp.worktrees', (ctx) => void (c = ctx)) });
  await k.start();
  return { k, ctx: () => c ?? assert.fail('no ctx'), log };
}

test('a service is used by contract, and every method checks the caller’s permission', async () => {
  const { ctx } = await world(['git:repo', 'git:read']);
  const git = ctx().use(gitService);
  assert.equal(git.version(), '2.44');
  const repo = git.repo('/w');
  assert.deepEqual(await repo.status(), { clean: true }, 'a handle method answers to its parent’s permission');
  assert.throws(() => repo.worktreeAdd('b'), (e: { code: string; message: string }) => e.code === 'forbidden' && /wisp\.worktrees may not call git\.service@1\.repo\.worktreeAdd: plugin:wisp\.worktrees may not git:worktree\.add/.test(e.message));
});

test('a missing permission is refused before the provider runs', async () => {
  const { ctx } = await world(['git:read']);
  assert.throws(() => ctx().use(gitService).repo('/w'), /may not git:repo/);
});

test('plain data only: arguments and results are copies; a Map is refused', async () => {
  const { ctx } = await world(['git:read']);
  const git = ctx().use(gitService);
  const arg = { path: '/w' };
  const out = git.info(arg);
  out.tags.push('mutated');
  assert.deepEqual(git.info(arg).tags, ['v1']);
  assert.throws(() => git.info(new Map() as never), /only plain data crosses a service boundary/);
  assert.throws(() => git.weird(), /isn't plain data, a Disposable or a handle/);
});

test('handles and subscriptions belong to the consumer: switching it off frees them', async () => {
  const { k, ctx, log } = await world(['git:repo', 'git:read']);
  const repo = ctx().use(gitService).repo('/w');
  let changes = 0;
  repo.onChange(() => changes++);
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(changes > 0);
  assert.equal(k.inspect('wisp.worktrees').handles, 1);
  await k.deactivate('wisp.worktrees');
  assert.deepEqual(log.sort(), ['closed /w', 'unwatched']);
  assert.equal(k.inspect('wisp.worktrees').handles, 0);
});

test('provider gone: service_gone on the next call, onLost once, and a required consumer goes off with the reason', async () => {
  const k = new Kernel();
  const log: string[] = [];
  let optionalCtx: PluginContext | undefined;
  k.register(manifest('wisp.git', { provides: { 'git.service': { version: '1.3.0' } } }), { def: def('wisp.git', (ctx) => ctx.provide(gitService, gitImpl(log))) });
  k.register(manifest('wisp.review', { requires: { 'git.service': { version: '^1', optional: true } }, permissions: ['git:read'] }), { def: def('wisp.review', (ctx) => void (optionalCtx = ctx)) });
  k.register(manifest('wisp.worktrees', { requires: { 'git.service': '^1' }, permissions: ['git:read'] }), { def: def('wisp.worktrees', (ctx) => void ctx.use(gitService)) });
  await k.start();
  const lost: string[] = [];
  const git = optionalCtx?.tryUse(gitService, { onLost: (why) => lost.push(why) });
  assert.equal(git?.version(), '2.44');
  const gone = await k.deactivate('wisp.git');
  assert.deepEqual(lost, ['wisp.git stopped providing git.service@1']);
  assert.throws(() => git?.version(), (e: { code: string }) => e.code === 'service_gone');
  assert.deepEqual(gone.map((g) => g.id), ['wisp.git', 'wisp.worktrees']);
  assert.equal(gone[1]?.reason, 'wisp.worktrees requires git.service, which is missing');
  assert.equal(k.status().find((s) => s.id === 'wisp.review')?.state, 'active', 'an optional consumer stays on');
  assert.equal(optionalCtx?.tryUse(gitService), undefined);
  assert.throws(() => optionalCtx?.use(gitService), /no plugin provides git\.service@1/);
});

test('use is only for what the manifest requires; provide only for what it declares; every method mapped', async () => {
  const k = new Kernel();
  const errs: string[] = [];
  const t = (fn: () => void): void => {
    try {
      fn();
    } catch (e) {
      errs.push((e as Error).message);
    }
  };
  k.register(manifest('wisp.rogue', { provides: { 'git.service': { version: '2.0.0' } } }), {
    def: def('wisp.rogue', (ctx) => {
      t(() => ctx.use(gitService));
      t(() => ctx.provide(gitService, gitImpl([])));
      t(() => ctx.provide(defineService('other.service', 1, {}), {}));
    }),
  });
  k.register(manifest('wisp.sloppy', { provides: { 'git.service': { version: '1.0.0' } } }), {
    def: def('wisp.sloppy', (ctx) => {
      t(() => ctx.provide(gitService, { ...gitImpl([]), secret: () => 1 }));
      t(() => ctx.provide(gitService, 'not an object' as never));
    }),
  });
  await k.start();
  assert.deepEqual(errs, [
    "wisp.rogue uses git.service but doesn't list it in requires",
    'wisp.rogue provides git.service@1, which its manifest doesn\'t declare (provides: {"git.service": {"version": "1.0.0"}})',
    'wisp.rogue provides other.service@1, which its manifest doesn\'t declare (provides: {"other.service": {"version": "1.0.0"}})',
    'wisp.sloppy provides git.service@1, whose method secret maps to no permission',
    'wisp.sloppy: a service is an object of methods',
  ]);
});

test('a provider version outside the consumer’s range is refused', async () => {
  const { ctx } = await world(['git:read'], {}, { version: '^1.5', optional: true });
  assert.equal(ctx().tryUse(gitService), undefined);
  assert.throws(() => ctx().use(gitService), /wisp\.worktrees needs git\.service \^1\.5, and wisp\.git provides 1\.3\.0/);
});

test('two providers: an override (non built-in) wins, then the user’s choice', async () => {
  const k = new Kernel();
  let c: PluginContext | undefined;
  const impl = (v: string): GitService => ({ ...gitImpl([]), version: () => v });
  k.register(manifest('wisp.git', { provides: { 'git.service': { version: '1.3.0' } } }), { def: def('wisp.git', (ctx) => ctx.provide(gitService, impl('git'))), builtin: true });
  k.register(manifest('acme.jj', { provides: { 'git.service': { version: '1.0.0' } } }), { def: def('acme.jj', (ctx) => ctx.provide(gitService, impl('jj'))) });
  k.register(manifest('wisp.worktrees', { requires: { 'git.service': '^1' }, permissions: ['git:read'] }), { def: def('wisp.worktrees', (ctx) => void (c = ctx)), builtin: true });
  await k.start();
  assert.equal(c?.use(gitService).version(), 'jj');
  await k.chooseProvider('git.service', 'wisp.git');
  assert.equal(c?.use(gitService).version(), 'git');
  assert.deepEqual(k.services.providers('git.service', 1), ['wisp.git', 'acme.jj']);
});

test('service calls have a time budget (5 s by default)', async () => {
  const { ctx } = await world(['git:read'], { serviceTimeoutMs: 10 });
  const e = await rejection(ctx().use(gitService).slow());
  assert.equal(e.code, 'timeout');
  assert.match(e.message, /git\.service@1\.slow didn't answer within 10 ms/);
});

test('inside an interceptor only read-only methods are allowed', async () => {
  const k = new Kernel();
  const seen: string[] = [];
  k.register(manifest('wisp.git', { provides: { 'git.service': { version: '1.3.0' } } }), { def: def('wisp.git', (ctx) => ctx.provide(gitService, gitImpl([]))) });
  k.register(manifest('wisp.host', { contributes: { commands: [{ id: 'host.go', title: 'Go' }] } }), { def: def('wisp.host', (ctx) => ctx.command({ id: 'host.go', run: (a, call) => call.runHook('before:go', a) })) });
  k.register(manifest('wisp.guard', { requires: { 'git.service': '^1' }, permissions: ['git:read', 'git:repo'] }), {
    def: def('wisp.guard', (ctx) => {
      const git = ctx.use(gitService);
      ctx.intercept({
        hook: 'before:go',
        run: () => {
          seen.push(git.version());
          try {
            git.repo('/w');
          } catch (e) {
            seen.push((e as Error).message);
          }
          return { kind: 'continue' };
        },
      });
    }),
  });
  await k.start();
  await k.run('host.go', {}, { set: 'user:full' });
  assert.deepEqual(seen, ['2.44', 'git.service@1.repo writes, and an interceptor may only read']);
});

test('kernel services: by name, overridable, and checked when their methods map to permissions', async () => {
  const spawned: string[] = [];
  const proc = { spawn: (bin: string) => (spawned.push(bin), 'pid') };
  const k = new Kernel({ services: { proc, clock: { now: () => 5 } }, servicePermissions: { proc: { spawn: 'proc:spawn{bin:$0}' } } });
  let c: PluginContext | undefined;
  k.register(manifest('wisp.claude', { permissions: ['proc:spawn{bin:claude}'] }), { def: def('wisp.claude', (ctx) => void (c = ctx)) });
  k.register(manifest('wisp.free', { permissions: ['proc:spawn'] }), { def: def('wisp.free', (ctx) => void ctx.service<typeof proc>('proc').spawn('x')) });
  await k.start();
  assert.equal(c?.service<{ now(): number }>('clock').now(), 5, 'unmapped services are passed as they are');
  // the scope comes from the call: claude may spawn claude, not codex
  assert.equal(c?.service<typeof proc>('proc').spawn('claude'), 'pid');
  assert.throws(() => c?.service<typeof proc>('proc').spawn('codex'), /plugin:wisp\.claude may not proc:spawn\{bin:codex\}/);
  assert.deepEqual(spawned, ['x', 'claude']);
  assert.throws(() => c?.service('fs'), /no kernel service fs/);
});

test('permission scopes from call arguments', () => {
  assert.equal(scoped('proc:spawn{bin:$0}', ['claude']), 'proc:spawn{bin:claude}');
  assert.equal(scoped('fs:read{path:$1.cwd,n:$0}', [3, { cwd: '/w' }]), 'fs:read{path:/w,n:3}');
  assert.equal(scoped('fs:read{path:$0.x.y}', [{ x: {} }]), 'fs:read{path:?}');
  assert.equal(scoped('a:b{v:$0}', ['x,y}']), 'a:b{v:x_y_}');
  assert.equal(scoped('a:b{v:$0}', ['']), 'a:b{v:?}');
  assert.equal(scoped('git:push', []), 'git:push');
});
