import { expect, test } from 'vitest';
import { bundleText, shareNotes, shareWhat } from '../src/share.ts';
import type { Member } from '../src/types.ts';

const m = (id: string, x: Partial<Member> = {}): Member => ({ id, name: id.toUpperCase(), kit: [], notebook: '', team: [], ...x }) as Member;

test('share_offers_the_kit_when_there_is_one_never_ticks_the_notebook_and_names_one_members_crew_delegates', () => {
  const ada = m('ada', { kit: [{ id: 'k1', kind: 'rules', name: 'AGENTS.md', body: 'x', on: true }], notebook: 'CI is flaky on mac', team: [{ name: 'Bob', agent: 'claude', model: '', effort: '', crew: 'bob' }, { name: 'helper', agent: 'codex', model: '', effort: '' }] });
  const bob = m('bob');
  const w = shareWhat([ada], [ada, bob]);
  expect(w).toEqual({ kits: 1, noted: true, mates: ['BOB'], start: { kit: true, notebook: false, team: false } });
  // nothing to share: the kit box starts off; the whole crew has no delegates option
  expect(shareWhat([bob], [ada, bob]).start.kit).toBe(false);
  expect(shareWhat([ada, bob], [ada, bob]).mates).toEqual([]);
});

test('the_delegates_note_is_left_out_when_the_option_says_it_and_a_bundle_is_saved_pretty', () => {
  const notes = ['Ada delegates to Bob, who stays here.', 'Their notebook goes along.'];
  expect(shareNotes(notes, ['Bob'])).toEqual(['Their notebook goes along.']);
  expect(shareNotes(notes, [])).toEqual(notes);
  expect(bundleText({ wispCrew: 1 })).toBe('{\n  "wispCrew": 1\n}\n');
});
