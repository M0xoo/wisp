// The blocks' own copy, in English. The kit has no copy of its own (README), so a host passes `t`
// in its BlockContext to translate these; keys are namespaced `block.*` so a host can register them
// in its catalogue as they are. Each half of the blocks keeps its strings in its own file.
import { fill } from '../core/i18n.tsx';
import { CONTENT_STRINGS } from './strings-content.ts';
import { RICH_STRINGS } from './strings-rich.ts';

export const BLOCK_STRINGS = {
  'block.unknown': 'Update the app to see this',
  'block.unknownType': 'Unknown block · {type}',
  'block.failed': 'This block couldn’t be shown',
  'block.fallback': 'The agent answered in plain text instead of a wisp presentation.',
  'block.copy': 'Copy',
  'block.copied': 'Copied',
  'block.showAll': 'Show all',
  'block.showLess': 'Show less',
  'block.open': 'Open',
  ...CONTENT_STRINGS,
  ...RICH_STRINGS,
} as const;

export type BlockString = keyof typeof BLOCK_STRINGS;
export type BlockTranslate = (key: BlockString, vars?: Readonly<Record<string, string | number>>) => string;

export const blockEnglish: BlockTranslate = (key, vars) => fill(BLOCK_STRINGS[key], vars);
