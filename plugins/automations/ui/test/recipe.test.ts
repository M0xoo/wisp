// Save as recipe… (src/recipe.ts, v1 automations.js recipeParams / saveAsRecipe).
import { expect, test } from 'vitest';
import { draftOf, parseDraft, recipeParams } from '../src/recipe.ts';

test('a prompt’s {fields} once each in order; the draft from a task and from view params_v1_save_as_recipe', () => {
  expect(recipeParams('Release {version}: bump {version}, tag {tag}; not { x } or {1x}')).toEqual(['version', 'tag']);
  expect(recipeParams('as written')).toEqual([]);
  expect(draftOf({ title: 'Ship the release', mode: 'edits', agent: 'codex' }, 'Prepare {version}')).toEqual({
    name: 'Ship the release',
    prompt: 'Prepare {version}',
    project: '',
    mode: 'edits',
    agent: 'codex',
    model: '',
    effort: '',
  });
  expect(parseDraft({ session: 'local:s1', name: 'X', prompt: '', mode: 7 })).toEqual({ name: 'X', prompt: '', project: '', mode: '', agent: '', model: '', effort: '', session: 'local:s1' });
});
