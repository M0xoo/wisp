import { expect, test } from 'vitest';
import { fileToKit, kitFileOk } from '../src/more/kit-logic.ts';
import { addOffer, dropOffer, ideas, kitGoal, kitRows, localRows, offerOf, offerPill, toggled, type Say } from '../src/more/kit-view.ts';
import type { KitFile } from '../src/more/types.ts';
import type { Offer } from '../src/types.ts';

const say: Say = (k, v) => (v ? `${k}(${Object.entries(v).map(([a, b]) => `${a}=${b}`).join(',')})` : k);
const kit: KitFile[] = [
  { id: 'k1', kind: 'rules', name: 'AGENTS.md', body: 'x'.repeat(1200), on: true },
  { id: 'k2', kind: 'skill', name: 'review-sync', description: 'Reviewing sync changes.', body: '1. Read', on: false },
];

test('the_kit_section_lists_each_file_with_what_it_is_for_and_its_switch_and_a_spells_kit_reads_but_does_not_change', () => {
  const rows = kitRows({ kit }, say);
  expect(rows.map((r) => [r.name, r.note, r.on])).toEqual([
    ['AGENTS.md', 'wisp.crew.more.kit.every(n=1.2k)', true],
    ['review-sync', 'Reviewing sync changes.', false],
  ]);
  expect(rows[1]?.title).toBe('wisp.crew.more.kit.editSkill');
  expect(kitRows({ kit, spell: { id: 's', key: 'k', name: 'Reviewers', def: {} } }, say)[0]?.title).toBe('wisp.crew.more.kit.fromSpell(name=Reviewers)');
  // the switch keeps the file (off: kept, not used)
  expect(toggled(kit, 'k2', true).map((k) => k.on)).toEqual([true, true]);
});

test('files_on_this_computer_come_with_their_text_and_the_ones_the_kit_has_are_marked_added', () => {
  const rows = localRows(kit, [
    { name: 'review-sync', description: 'Reviewing sync changes.', path: '/h/.claude/skills/review-sync', from: 'home', body: '1. Read' },
    { name: 'release-notes', description: '', path: '/h/.claude/skills/release-notes', from: 'home', body: '1. Log' },
    { name: 'AGENTS.md', description: "this project's instructions", path: '/w/AGENTS.md', from: 'project', body: '- tests' },
    { name: 'unreadable', description: '', path: '/x', from: 'home', body: '' },
  ]);
  expect(rows.map((r) => [r.draft.kind, r.draft.name, r.added])).toEqual([
    ['skill', 'review-sync', true],
    ['skill', 'release-notes', false],
    ['rules', 'AGENTS.md', false],
  ]);
  // a skill with no When gets one from its name; it keeps its folder for the files beside its SKILL.md
  expect(rows[1]?.draft).toMatchObject({ description: 'Use for release notes.', path: '/h/.claude/skills/release-notes' });
});

test('a_dropped_skill_md_is_a_skill_the_rest_are_instructions_and_only_md_or_txt_files_are_taken', () => {
  expect(fileToKit('SKILL.md', '---\nname: Lint Fix\ndescription: Fixing lint.\n---\n\n1. Run lint')).toEqual({ kind: 'skill', name: 'lint-fix', description: 'Fixing lint.', body: '1. Run lint' });
  expect(fileToKit('style.md', '  Use tabs.\n')).toEqual({ kind: 'rules', name: 'style.md', body: 'Use tabs.' });
  expect([kitFileOk('a.md', 10), kitFileOk('a.png', 10), kitFileOk('a.txt', 1e9)]).toEqual([true, false, false]);
});

test('generate_suggests_ideas_from_the_role_and_starts_with_the_first_when_nothing_is_typed', () => {
  expect(ideas({ role: 'Reviewer', kit }, say)).toEqual(['wisp.crew.more.gen.idea.best(role=Reviewer)', 'wisp.crew.more.gen.idea.conv', 'wisp.crew.more.gen.idea.skill', 'wisp.crew.more.gen.idea.improve']);
  expect(ideas({ role: '', kit: [] }, say)).toHaveLength(3);
  expect(kitGoal('  ', 'Be great')).toBe('Be great.');
  expect(kitGoal(' Learn CI ', 'Be great')).toBe('Learn CI');
});

test('an_offers_ticked_files_join_the_kit_replacing_the_same_name_and_settle_it_with_their_names', () => {
  const o: Offer = {
    id: 'o1',
    job: 'laptop:s1',
    at: 1,
    state: 'open',
    files: [
      { kind: 'rules', name: 'agents.md', body: 'new' },
      { kind: 'skill', name: 'flaky', description: 'Flaky tests.', body: '1. Rerun' },
      { kind: 'skill', name: 'review-sync', description: 'Reviewing sync changes.', body: '1. Read' },
    ],
  };
  expect(offerOf([o], 'laptop:s1')).toBe(o);
  expect(offerOf([o], 'laptop:s2')).toBeUndefined();
  // unticked: the second; added already through the editor: review-sync
  const plan = addOffer(kit, o, new Set([1]), new Set(['review-sync']), () => 'knew00001');
  if (plan === 'tooMany') throw new Error('fits');
  expect(plan.kit.find((k) => k.id === 'k1')?.body).toBe('new');
  expect(plan.kit).toHaveLength(2);
  expect(plan.offers).toEqual([{ id: 'o1', state: 'taken', names: ['review-sync', 'agents.md'] }]);
  // a kit at its cap refuses; Dismiss after adding some reads Done and keeps their names
  const full = Array.from({ length: 24 }, (_, i): KitFile => ({ id: `k${i}`, kind: 'rules', name: `f${i}.md`, body: 'x', on: true }));
  expect(addOffer(full, o, new Set(), new Set())).toBe('tooMany');
  expect(dropOffer(o, new Set())).toEqual([{ id: 'o1', state: 'dismissed', names: [] }]);
  expect(dropOffer(o, new Set(['flaky']))).toEqual([{ id: 'o1', state: 'taken', names: ['flaky'] }]);
  // pills: the same file as yours, one that replaces yours, one added
  expect(offerPill(kit, o.files[2] as never, false, say)).toBe('wisp.crew.more.offer.same');
  expect(offerPill(kit, o.files[0] as never, false, say)).toBe('wisp.crew.more.offer.replaces');
  expect(offerPill(kit, o.files[1] as never, true, say)).toBe('wisp.crew.more.local.added');
});
