// Watch's sealed document (src/side/watch-doc.ts, v1 watch-doc.js): the CSP first, the bridge, the agent's page last.
import { expect, test } from 'vitest';
import { appSandbox, runLine, shortUrl, watchDoc } from '../src/side/watch-doc.ts';

test('the CSP comes before the page, a doctype goes, and the state cannot close the script_v1_watch_doc', () => {
  const d = watchDoc('<!DOCTYPE html><h1>Hi</h1>', { vars: { '--ink': '#111' }, scheme: 'dark', state: { s: '</script><b>' } });
  expect(d.indexOf('Content-Security-Policy')).toBeLessThan(d.indexOf('<h1>Hi</h1>'));
  expect(d).toContain("connect-src 'none'");
  expect(d.match(/<!doctype/gi)?.length).toBe(1);
  expect(d).not.toContain('</script><b>');
  expect(d).toContain('color-scheme:dark');
  expect(d.endsWith('<h1>Hi</h1>')).toBe(true);
});

test('a running app keeps its own origin, never wisp’s; the run line quotes a folder with spaces_v1_watch_run', () => {
  expect(appSandbox('http://localhost:5173/', 'http://localhost:4040')).toContain('allow-same-origin');
  expect(appSandbox('http://localhost:4040/x', 'http://localhost:4040')).not.toContain('allow-same-origin');
  expect(runLine({ command: 'npm test', cwd: '/code/web' })).toBe('cd /code/web && npm test');
  expect(runLine({ command: 'make', cwd: "/my code/it's" })).toBe("cd '/my code/it'\\''s' && make");
  expect(shortUrl('http://localhost:5173/')).toBe('localhost:5173');
});
