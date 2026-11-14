// What Auto will run (app/AutoPop.tsx, v1 auto-preview.js openPop): its rows, keys and closing.
import { expect, test } from 'vitest';
import { mount } from './helpers.tsx';
import { AutoPop, type AutoPopRow } from '../src/app/AutoPop.tsx';

const row = (key: string, title: string): AutoPopRow => ({ key, title, sub: 'Codex', chance: '88%', usd: '~$0.34' });

test('the first row has the focus, arrows go round, Escape closes, a row runs that pick_v1_auto_pop', () => {
  const said: string[] = [];
  const anchor = document.createElement('button');
  document.body.append(anchor);
  mount(() => (
    <AutoPop
      anchor={() => anchor}
      label="What Auto will run"
      head={{ title: 'Claude Code', sub: 'Claude Code · Balanced' }}
      why="Your usual pick"
      facts={[{ strong: '83%', text: 'likely to work' }, { text: '~$0.11' }]}
      suggest={{ heading: 'Worth a try', row: row('opus', 'Try Opus · High') }}
      others={{ heading: 'Or run', rows: [row('codex', 'Codex · High')] }}
      never="Never pick Claude Code’s default model for feature tasks"
      how="How Auto picks"
      onPick={(k) => said.push(`pick ${k}`)}
      onNever={() => said.push('never')}
      onHow={() => said.push('how')}
      onClose={() => said.push('close')}
    />
  ));
  const pop = document.querySelector('[data-auto-pop]') as HTMLElement;
  const buttons = [...pop.querySelectorAll('button')];
  expect(buttons.map((b) => b.getAttribute('data-part'))).toEqual(['autoPreview.suggest', 'autoPreview.alternatives', 'autoPreview.never', 'autoPreview.how']);
  expect(document.activeElement).toBe(buttons[0]);
  expect(pop.querySelector('[data-kit="ap-facts"]')?.textContent).toBe('83% likely to work~$0.11');
  pop.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  expect(document.activeElement).toBe(buttons[3]); // round to the last
  buttons[1]?.click();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(said).toEqual(['pick codex', 'close']);
});

test('nothing Auto may use can run: it says so and why, and offers only How Auto picks_v1_auto_pop_nothing', () => {
  mount(() => (
    <AutoPop
      anchor={() => null}
      label="What Auto will run"
      head={{ nothing: 'Nothing to run', why: 'Auto is still looking' }}
      how="How Auto picks"
      onPick={() => {}}
      onNever={() => {}}
      onHow={() => {}}
      onClose={() => {}}
    />
  ));
  const pops = document.querySelectorAll('[data-auto-pop]');
  const pop = pops[pops.length - 1] as HTMLElement;
  expect(pop.querySelector('[data-kit="ap-title"]')?.textContent).toBe('Nothing to runAuto is still looking');
  expect([...pop.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['How Auto picks']);
});
