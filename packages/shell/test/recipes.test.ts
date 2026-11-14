// New task's Recipes row (v1 renderLaunchRecipes, F-comp-37): the picked project's recipes and the ones tied to none;
// the rest counted as elsewhere.
import { expect, test } from 'vitest';
import { recipesAt } from '../src/frame/recipes.ts';

test('the recipes row lists the picked projects recipes and counts the rest_v1_launch_recipes', () => {
  const all = [
    { name: 'Prepare release {version}', prompt: 'Release {version}' },
    { name: 'Fix lint', prompt: 'fix lint', project: '/code/app' },
    { name: 'Docs', prompt: 'docs', project: '/code/site' },
  ];
  expect(recipesAt(all, '/code/app').list.map((r) => r.name)).toEqual(['Prepare release {version}', 'Fix lint']);
  expect(recipesAt(all, '/code/app').elsewhere).toBe(1);
  expect(recipesAt(all, undefined)).toEqual({ list: [all[0]], elsewhere: 2 });
  expect(recipesAt([], '/x')).toEqual({ list: [], elsewhere: 0 });
});
