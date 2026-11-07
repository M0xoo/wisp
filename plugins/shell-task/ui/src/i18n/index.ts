// The plugin's catalogue (key → English): one JSON per area, so each area owns its own strings.
import cards from './en.cards.json' with { type: 'json' };
import head from './en.head.json' with { type: 'json' };
import plan from './en.plan.json' with { type: 'json' };
import side from './en.side.json' with { type: 'json' };
import transcript from './en.json' with { type: 'json' };
import { BLOCK_STRINGS } from '@wisp/ui';

export const CATALOGUE: Readonly<Record<string, string>> = { ...BLOCK_STRINGS, ...transcript, ...head, ...side, ...cards, ...plan };
