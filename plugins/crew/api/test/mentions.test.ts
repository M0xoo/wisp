// @mentions and SKILL.md front matter (v1 test/crew.test.js: "@mentions…" and the parseSkillMd half
// of "SKILL.md front matter…"), plus the tools' member lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crewMentions, handleOf, memberDetail, memberLine, parseSkillMd, plainCrew, skillMd, skillName } from '../src/index.ts';

test('@mentions: stored tokens and plain names, addressed (leading) or in passing', () => {
  const ada = { id: 'aaaaaaaa1', name: 'Ada' };
  const bo = { id: 'bbbbbbbb1', name: 'Bo Lee' };
  const crew = [ada, bo];
  let t = crewMentions('@[Ada](crew:aaaaaaaa1) check the deploy', crew);
  assert.deepEqual(t.lead, [ada]);
  assert.equal(t.rest, 'check the deploy');
  t = crewMentions('@ada, @Bo Lee: look at #12', crew);
  assert.deepEqual(t.lead, [ada, bo]);
  assert.equal(t.rest, 'look at #12');
  t = crewMentions('fix it, then have @bo-lee review it', crew);
  assert.deepEqual(t.lead, []);
  assert.deepEqual(t.all, [bo]);
  assert.equal(t.rest, 'fix it, then have @bo-lee review it');
  // Not a mention: inside a word, an email, or a longer name.
  assert.deepEqual(crewMentions('mail ada@x.com and @Adam', crew).all, []);
  assert.equal(handleOf('Bo Lee'), 'bo-lee');
  assert.equal(plainCrew('@[Ada](crew:aaaaaaaa1) hi'), '@Ada hi');
});

test('SKILL.md front matter: folded values, quotes, none at all; and the file a skill is written as', () => {
  assert.deepEqual(parseSkillMd('---\r\nname: pdf\r\ndescription: >\r\n  Fill PDF forms\r\n  and merge them.\r\n---\r\n\r\n# PDF\r\nSteps'), { name: 'pdf', description: 'Fill PDF forms and merge them.', body: '# PDF\nSteps' });
  assert.deepEqual(parseSkillMd('---\nname: "x"\ndescription: \'Quoted: yes\'\n---\nB'), { name: 'x', description: 'Quoted: yes', body: 'B' });
  assert.deepEqual(parseSkillMd('# Just text'), { name: '', description: '', body: '# Just text' });
  assert.equal(skillMd({ name: 'release-notes', description: 'Writing  release notes.', body: 'Steps' }), '---\nname: release-notes\ndescription: "Writing release notes."\n---\n\nSteps\n');
  assert.equal(skillName('Release Notes!'), 'release-notes');
});

test('a member as the tools read it: one line, or in full', () => {
  const m = { id: 'abc123', name: 'Quill', handle: 'quill', role: 'Docs writer', agent: 'claude', mode: 'auto', cwd: '/r', cron: '0 9 * * 1-5', paused: true, running: 1, queue: [1], brief: 'Keep the README current.', notebook: 'Docs live in docs/.', kit: [] };
  assert.equal(memberLine(m), '- **Quill** (@quill, id `abc123`) — Docs writer · claude · auto mode · in /r · checks in on `0 9 * * 1-5` · paused · 1 job running · 1 waiting\n  Brief: Keep the README current.');
  assert.match(memberDetail(m), /## Brief\n\nKeep the README current\.\n\n## Notebook\n\nDocs live in docs\/\.\n\n\(19 characters\)\n\n## Kit\n\nNo skills/);
});
