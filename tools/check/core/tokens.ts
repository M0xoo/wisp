// The px values the design tokens allow (packages/tokens/tokens/*.json). The kit's CSS may use a px
// value only if it is on this scale (plan §5: "a stylelint rule fails CI on any px value outside the
// token scale, even inside the kit").

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from './workspace.ts';

export const TOKENS_DIR = 'packages/tokens/tokens';
/** Files whose bare numbers are lengths in px (space.json: { "2": 8 }). */
const LENGTH_FILE = /space|size|radius|border|width|breakpoint|gap|inset|shadow/i;
const PX = /^(-?\d*\.?\d+)px$/;

function collect(v: unknown, numbersArePx: boolean, out: Set<number>): void {
  if (typeof v === 'string') {
    for (const part of v.split(/\s+/)) {
      const m = PX.exec(part);
      if (m?.[1]) out.add(Math.abs(Number(m[1])));
    }
  } else if (typeof v === 'number') {
    if (numbersArePx) out.add(Math.abs(v));
  } else if (Array.isArray(v)) {
    for (const x of v) collect(x, numbersArePx, out);
  } else if (isRecord(v)) {
    // DTCG dimension: { "$value": { "value": 4, "unit": "px" } }
    if (typeof v['value'] === 'number' && v['unit'] === 'px') out.add(Math.abs(v['value']));
    for (const [k, x] of Object.entries(v)) if (k !== '$description' && k !== 'description') collect(x, numbersArePx, out);
  }
}

/** undefined when the token files don't exist yet. */
export function pxScale(root: string): Set<number> | undefined {
  const dir = join(root, TOKENS_DIR);
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  if (!files.length) return undefined;
  const out = new Set<number>([0]);
  for (const f of files) collect(JSON.parse(readFileSync(join(dir, f), 'utf8')), LENGTH_FILE.test(f), out);
  return out;
}
