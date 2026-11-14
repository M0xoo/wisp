// A face's card beside the crew rail (app/RailCard.tsx, v1 crew.js and crew-jobs.js).
import { expect, test } from 'vitest';
import { createSignal } from 'solid-js';
import { mount } from './helpers.tsx';
import { RailCardBody, headingForCard, stepRow, type RailCardRow } from '../src/app/RailCard.tsx';

test('the pointer heading for the card keeps it; going along the rail switches faces; keys step through its rows_v1_crew_card', () => {
  expect(headingForCard(12, 30)).toBe(true); // out and a little down: toward the card
  expect(headingForCard(2, 12)).toBe(true);
  expect(headingForCard(1, 0)).toBe(false); // barely moved out
  expect(headingForCard(4, 40)).toBe(false); // mostly along the rail: to another face
  expect(headingForCard(-6, 0)).toBe(false);
  expect(stepRow('ArrowDown', 0, 3)).toBe(1);
  expect(stepRow('ArrowDown', 2, 3)).toBe(2);
  expect(stepRow('ArrowUp', 0, 3)).toBe(0);
  expect(stepRow('End', 0, 3)).toBe(2);
  expect(stepRow('Home', 2, 3)).toBe(0);
  expect(stepRow('x', 1, 3)).toBeNull();
});

test('a job changing while the card is up repaints its row in place, never rebuilding it_v1_paint_card', () => {
  const row = (side: string, mark: RailCardRow['mark'] = 'live'): RailCardRow => ({ id: 'j1', title: 'Review the fix', mark, side });
  const [rows, setRows] = createSignal<readonly RailCardRow[]>([row('Working')]);
  const opened: string[] = [];
  const host = mount(() => <RailCardBody name="Ada" role="Reviewer" line={{ text: 'Lending a hand', tone: 'live' }} headTitle="Open Ada’s thread" rows={rows()} none="Nothing going on" onHead={() => opened.push('thread')} onRow={(id) => opened.push(id)} />);
  const el = host.querySelector('[data-kit="cl-row"]');
  expect(el?.textContent).toContain('Working');
  setRows([row('5m', 'unread')]);
  expect(host.querySelector('[data-kit="cl-row"]')).toBe(el); // the same button
  expect(el?.textContent).toContain('5m');
  expect(el?.querySelector('[data-kit="cl-mark"]')?.getAttribute('data-m')).toBe('unread');
  (el as HTMLButtonElement).click();
  (host.querySelector('[data-kit="cl-head"]') as HTMLButtonElement).click();
  expect(opened).toEqual(['j1', 'thread']);
  setRows([]);
  expect(host.querySelector('[data-kit="cl-none"]')?.textContent).toBe('Nothing going on');
});
