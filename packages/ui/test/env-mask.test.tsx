// .env masking on screen (content/env-mask.ts, v1 server/env-mask.js with v1 test/env-mask.test.js's cases) and the
// code / diff blocks' Reveal line (blocks/env-view.tsx).
import { expect, test } from 'vitest';
import { createSignal } from 'solid-js';
import { mount } from './helpers.tsx';
import { Answer, DOTS, envFileNamed, isEnvFile, maskBlock, maskDiffs, maskEdit, maskLine, maskText, namesEnvFile, readsEnvFile, type EnvReveal } from '../src/index.ts';


test('F-page-41: isEnvFile is .env and .env.*, not the templates (v1 cases)', () => {
  for (const f of ['.env', '.env.local', 'apps/web/.env.production', 'C:\\app\\.env.test', '/abs/.env.development.local']) expect(isEnvFile(f), f).toBe(true);
  for (const f of ['.env.example', '.env.sample', 'web/.env.local.example', '.ENV.SAMPLE', 'env', 'my.env', '.envrc', '.environment', 'src/env.js', '', undefined]) expect(isEnvFile(f), String(f)).toBe(false);
});

test('F-page-41: maskText takes the values and keeps keys, comments and blank lines (v1 cases)', () => {
  const text = '# db\nDATABASE_URL=postgres://me:pw@db/app\nexport TOKEN="ghp_x" # mine\nEMPTY=\nyaml_like: value\n\n  INDENTED = 3';
  expect(maskText(text)).toBe(`# db\nDATABASE_URL=${DOTS}\nexport TOKEN=${DOTS}\nEMPTY=\nyaml_like: ${DOTS}\n\n  INDENTED = ${DOTS}`);
  expect(maskLine('sk-live-bare-value')).toBe(DOTS); // a line with no key goes whole (an edit snippet)
  expect(maskLine('  # a comment')).toBe('  # a comment');
  expect(maskText(undefined)).toBeUndefined();
});

test('F-page-41: maskEdit keeps a changed value a line of the diff without showing either value (v1 case)', () => {
  const e = maskEdit({ before: 'A=1\nB=old\n', after: 'A=1\nB=new\nC=added\n' });
  expect(e.before).toBe(`A=${DOTS}\nB=${DOTS}\n`);
  expect(e.after).toBe(`A=${DOTS}\nB=${DOTS} (changed)\nC=${DOTS}\n`);
  expect(/old|new|added|=1/.test(String(e.before) + String(e.after))).toBe(false);
});

test('F-page-41: namesEnvFile finds a command that read a .env file, not a template (v1 cases)', () => {
  for (const c of ['cat .env', 'head -5 apps/web/.env.local', "Get-Content '.env'", 'grep KEY .env|sort', 'cat <.env.production']) expect(namesEnvFile(c), c).toBe(true);
  for (const c of ['cat .env.example', 'cp .env.sample .env.sample2.example', 'echo env', 'cat my.env', 'ls .envrc']) expect(namesEnvFile(c), c).toBe(false);
  expect(readsEnvFile({ label: 'Show the env', detail: 'cat .env' })).toBe(true);
  expect(readsEnvFile({ label: 'Read', file: 'app/.env.local' })).toBe(true);
  expect(readsEnvFile({ label: 'Run', detail: 'ls' })).toBe(false);
});

test('F-page-41: maskBlock masks a code or diff block about a .env file (snippet, unified diff), and nothing else (v1 maskBlock cases)', () => {
  expect(maskBlock({ type: 'diff', file: 'cfg/.env.local', before: 'K=a', after: 'K=b' })).toMatchObject({ before: `K=${DOTS}`, after: `K=${DOTS} (changed)` });
  expect(maskBlock({ type: 'code', file: '.env', code: 'K=v' })?.['code']).toBe(`K=${DOTS}`);
  expect(maskBlock({ type: 'diff', file: '.env' })).toBeUndefined(); // nothing of its own to show
  expect(maskBlock({ type: 'code', file: '.env.example', code: 'K=v' })).toBeUndefined();
  expect(maskBlock({ type: 'hero', file: '.env' })).toBeUndefined();
  const unified = 'diff --git a/.env b/.env\n--- a/.env\n+++ b/.env\n@@ -1,2 +1,2 @@\n # keys\n-API_KEY=sk-1\n+API_KEY=sk-2\ndiff --git a/a.ts b/a.ts\n+++ b/a.ts\n+const K=1';
  expect(maskDiffs(unified)).toBe(`diff --git a/.env b/.env\n--- a/.env\n+++ b/.env\n@@ -1,2 +1,2 @@\n # keys\n-API_KEY=${DOTS}\n+API_KEY=${DOTS}\ndiff --git a/a.ts b/a.ts\n+++ b/a.ts\n+const K=1`);
  expect(maskBlock({ type: 'diff', file: '.env', diff: '@@ -1 +1 @@\n-K=old\n+K=new' })?.['diff']).toBe(`@@ -1 +1 @@\n-K=${DOTS}\n+K=${DOTS}`);
});

test('F-page-41: maskDiffs reads the file from --no-prefix and diff -u headers, /dev/null sides, and masks a changed line that looks like a header', () => {
  const noPrefix = '--- .env\n+++ .env\n@@ -1 +1 @@\n-API_KEY=sk-live-1\n+API_KEY=sk-live-2';
  expect(maskDiffs(noPrefix)).not.toContain('sk-live');
  const dashU = '--- .env\t2026-01-01 10:00\n+++ .env\t2026-01-02 10:00\n@@ -1,2 +1,2 @@\n----BEGIN=x\n+---token=abc\n # c';
  expect(maskDiffs(dashU)).toBe(`--- .env\t2026-01-01 10:00\n+++ .env\t2026-01-02 10:00\n@@ -1,2 +1,2 @@\n-${DOTS}\n+${DOTS}\n # c`);
  expect(maskDiffs('--- a/.env\n+++ /dev/null\n@@ -1 +0,0 @@\n-K=gone')).toBe(`--- a/.env\n+++ /dev/null\n@@ -1 +0,0 @@\n-K=${DOTS}`);
  expect(maskDiffs('--- /dev/null\n+++ b/.env.local\n@@ -0,0 +1 @@\n+K=new')).toContain(`+K=${DOTS}`);
  const two = 'diff --git a/.env b/.env\n--- a/.env\n+++ b/.env\n@@ -1 +1 @@\n-K=1\n+K=2\ndiff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-const K=1\n+const K=2';
  expect(maskDiffs(two)).toContain('+const K=2');
  expect(maskDiffs(two)).not.toContain('+K=2');
  expect(maskBlock({ type: 'diff', file: '.env', diff: '-K=old\n+K=new' })?.['diff']).toBe(`-K=${DOTS}\n+K=${DOTS}`);
  expect(envFileNamed('cat config/prod.env.local .env')).toBe('.env');
  expect(envFileNamed('head -5 apps/web/.env.local')).toBe('.env.local');
});

/** A host's per-task reveal state, as the shell keeps it (env-reveal.ts). */
function host(on = true): EnvReveal & { readonly seen: string[] } {
  const [shown, setShown] = createSignal(new Set<string>());
  const seen: string[] = [];
  return {
    seen,
    on: () => on,
    shown: (id) => shown().has(id),
    set: (id, v) => {
      seen.push(`${id} ${v}`);
      const s = new Set(shown());
      if (v) s.add(id);
      else s.delete(id);
      setShown(s);
    },
  };
}

test('F-page-41: a code block about a .env file shows KEY=•••• under the line, Reveal shows it as it is and Hide masks it again, in place', () => {
  const env = host();
  const root = mount(() => <Answer blocks={[{ type: 'code', file: 'apps/web/.env.local', code: 'API_KEY=sk-live-1\n# note' }]} ctx={{ env }} />);
  const src = (): string => root.querySelector('[data-part="block.code.body"]')?.textContent ?? '';
  const bar = (): Element | null => root.querySelector('[data-part="block.code.envMask"]');
  const btn = (): HTMLButtonElement => root.querySelector('[data-part="block.code.envMask.reveal"]') as HTMLButtonElement;
  expect(src()).not.toContain('sk-live');
  expect(src()).toContain(`API_KEY=${DOTS}`);
  expect(bar()?.textContent).toBe('.env.local’s values are hiddenReveal');
  const was = bar();
  btn().click();
  expect(src()).toContain('API_KEY=sk-live-1');
  expect(btn().textContent).toBe('Hide');
  expect(btn().getAttribute('aria-pressed')).toBe('true');
  expect(bar()).toBe(was); // the same line, its words changed in place
  btn().click();
  expect(src()).not.toContain('sk-live');
  expect(env.seen).toEqual(['block:0 true', 'block:0 false']);
});

test('F-page-41: a diff block about a .env file is masked until Reveal; masking off or another file shows no line', () => {
  const env = host();
  const root = mount(() => <Answer blocks={[{ type: 'diff', file: '.env', before: 'K=old', after: 'K=new' }, { type: 'code', file: 'a.ts', code: 'K=1' }]} ctx={{ env }} />);
  const body = (): string => root.querySelector('[data-part="block.diff.body"]')?.textContent ?? '';
  expect(body()).not.toMatch(/old|new/);
  expect(root.querySelectorAll('[data-kit="env-mask"]').length).toBe(1);
  (root.querySelector('[data-part="block.diff.envMask.reveal"]') as HTMLButtonElement).click();
  expect(body()).toMatch(/K=old/);
  const off = mount(() => <Answer blocks={[{ type: 'code', file: '.env', code: 'K=v' }]} ctx={{ env: host(false) }} />);
  expect(off.querySelector('[data-kit="env-mask"]')).toBeNull();
  expect(off.textContent).toContain('K=v');
});

test('F-page-41: without a host (a share page) a .env block still masks, and its Reveal works by itself', () => {
  const root = mount(() => <Answer blocks={[{ type: 'code', file: '.env', code: 'K=secret' }]} />);
  expect(root.textContent).not.toContain('secret');
  (root.querySelector('[data-part="block.code.envMask.reveal"]') as HTMLButtonElement).click();
  expect(root.textContent).toContain('K=secret');
});

test('ADR-0050: a block the server masked stays masked when revealed until the host brings its value, then shows it', () => {
  const [raw, setRaw] = createSignal<Readonly<Record<string, unknown>> | undefined>(undefined);
  const base = host();
  const env: EnvReveal = { ...base, raw: () => raw() };
  const root = mount(() => <Answer blocks={[{ type: 'code', file: '.env', code: `API_KEY=${DOTS}`, masked: true }]} ctx={{ env }} />);
  const src = (): string => root.querySelector('[data-part="block.code.body"]')?.textContent ?? '';
  expect(root.querySelector('[data-part="block.code.envMask"]')).not.toBeNull(); // a server-masked block still has its line
  (root.querySelector('[data-part="block.code.envMask.reveal"]') as HTMLButtonElement).click();
  expect(src()).toContain(`API_KEY=${DOTS}`); // on its way: still masked, never the dots as "the value"
  setRaw({ type: 'code', file: '.env', code: 'API_KEY=sk-live-1' });
  expect(src()).toContain('API_KEY=sk-live-1');
});
