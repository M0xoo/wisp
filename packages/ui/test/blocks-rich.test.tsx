// The rich blocks that were stubs (v1 R.map, R.doc, preview-frame.js, R.graph, app-frame.js): each shows what v1 did.
import { expect, test } from 'vitest';
import { mount, part } from './helpers.tsx';
import { Answer, type BlockContext } from '../src/index.ts';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const click = (el: Element | null | undefined): void => void el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

test('map_doc_preview_graph_and_app_blocks_render_and_act_as_v1s_did', async () => {
  const said: string[] = [];
  const saved: unknown[] = [];
  const ctx: BlockContext = {
    latest: true,
    reply: (t) => void said.push(`reply:${t}`),
    draft: (t) => void said.push(`draft:${t}`),
    appState: { get: () => ({ n: 2 }), set: (_k, s) => void saved.push(s) },
  };
  const longDoc = `# Plan\n\n${Array.from({ length: 60 }, (_, i) => `Line ${i} of the plan.`).join('\n')}`;
  mount(() => (
    <Answer
      ctx={ctx}
      blocks={[
        { type: 'map', title: 'Coffee', route: true, places: [{ name: 'Blue Bottle', address: '66 Mint St, San Francisco' }, { name: 'Sightglass', lat: 37.77, lng: -122.41 }] },
        { type: 'map', places: [] },
        { type: 'doc', path: 'docs/plan.md', text: longDoc },
        { type: 'doc', path: 'docs/gone.md' },
        { type: 'preview', url: 'https://example.com/settings', device: 'mobile', title: 'Settings' },
        { type: 'preview', url: 'file:///etc/passwd' },
        {
          type: 'graph',
          title: 'Refresh sessions',
          state: 'open',
          into: 'main',
          commits: [
            { hash: 'd29f50', message: 'Add refresh tests', branch: 'feat/refresh' },
            { hash: '5be27d', message: 'Rotate keys', branch: 'main', conflict: true },
          ],
          conflicts: [{ file: 'src/auth.ts:42', commit: '5be27d', ours: 'refresh(token)', theirs: 'rotate(key)', resolution: 'Rotate first' }],
          action: { label: 'Resolve conflicts', reply: 'Merge main in and resolve the conflicts' },
        },
        { type: 'app', title: 'Counter', html: '<button onclick="wisp.save({n:1})">+</button>' },
      ]}
    />
  ));
  // map: numbered places, the first on the map, a pick moves the map, Route and Open in Google Maps
  const map = part('block.map');
  const frame = (): string => map?.querySelector('iframe')?.getAttribute('src') ?? '';
  expect(map?.textContent).toContain('2 places');
  expect(frame()).toContain('66%20Mint%20St');
  click(map?.querySelectorAll('[data-kit="rb-map-pick"]')[1]);
  expect(frame()).toContain('37.77');
  expect(map?.querySelector('[data-part="block.map.route"]')?.getAttribute('href')).toContain('google.com/maps/dir');
  expect(map?.querySelectorAll('[data-part="block.map.open"]').length).toBe(2);
  expect(part('block.map.none')?.textContent).toContain('has no address to show');

  // doc: title, length, the opening only with Read all; a file that wasn't there says so
  const docs = document.querySelectorAll('[data-part="block.doc"]');
  expect(docs[0]?.textContent).toContain('Plan');
  expect(docs[0]?.textContent).toContain('62 lines');
  expect(docs[0]?.textContent).toContain('Read all 62 lines');
  expect(docs[0]?.textContent).not.toContain('Line 59 of the plan');
  expect(docs[1]?.textContent).toContain('wasn’t there');

  // preview: the phone, sandboxed, Rotate swaps the size; a non-http url can't be shown
  const pv = part('block.preview');
  expect(pv?.querySelector('iframe')?.getAttribute('sandbox')).toContain('allow-scripts');
  expect(pv?.textContent).toContain('390 × 844');
  click(pv?.querySelector('[aria-label="Rotate"]'));
  expect(pv?.textContent).toContain('844 × 390');
  click(pv?.querySelector('[aria-label="Desktop"]'));
  expect(pv?.querySelector('[data-kit="rb-pv-device"]')?.getAttribute('data-device')).toBe('desktop');
  expect(part('block.preview.cant')?.textContent).toContain('Only http:// and https://');

  // graph: the merge target, the conflict numbered on its commit and listed, the action replies
  const g = part('block.graph');
  expect(g?.textContent).toContain('Merge into main');
  expect(g?.textContent).toContain('1 conflict');
  expect(g?.querySelector('[data-kit="rb-g-row"][data-tone="conflict"] [data-kit="rb-g-num"]')?.textContent).toBe('1');
  expect(g?.textContent).toContain('rotate(key)');
  click([...(g?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'Resolve conflicts'));
  expect(said.at(-1)).toBe('reply:Merge main in and resolve the conflicts');

  // app: sandboxed to scripts, its saved state handed back in the page
  await tick();
  const app = part('block.app')?.querySelector('iframe');
  expect(app?.getAttribute('sandbox')).toBe('allow-scripts');
  expect(app?.getAttribute('srcdoc') ?? '').toContain('{"n":2}');
});
