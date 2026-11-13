// A recipe from the launcher (v1 runRecipe, F-comp-37): the dialog asks each `{field}` of its prompt and steps once,
// in order, and takes the recipe's name and the launcher's project from its params.
import { expect, test } from 'vitest';
import { fieldsOf, parseRun } from '../src/recipe.ts';

test('the run dialog asks each field of the prompt and steps once_v1_run_recipe', () => {
  expect(fieldsOf({ prompt: 'Prepare release {version} for {app}', steps: ['tag {version}', 'tell {who}'] })).toEqual(['version', 'app', 'who']);
  expect(fieldsOf({ prompt: 'no fields' })).toEqual([]);
  expect(parseRun({ name: 'Prepare release', project: '/code/app' })).toEqual({ name: 'Prepare release', project: '/code/app' });
  expect(parseRun(null)).toEqual({ name: '', project: '' });
});
