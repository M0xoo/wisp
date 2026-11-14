// Gallery: the content blocks (hero … terminal), every state. Fixtures are v1-shaped answers.
import type { JSX } from 'solid-js';
import { Answer } from '../../src/index.ts';
import { Specimen } from '../frame.tsx';
import { galleryCtx } from './ctx.ts';

export function ContentBlocksGallery(): JSX.Element {
  return (
    <Specimen title="Content blocks" note="hero, markdown, steps, stats, files, tree, diff, code, compare, tests, commits, graph, checklist, callout, terminal">
      <Answer blocks={[{ type: 'code', language: 'ts', file: 'src/auth/limiter.ts', line: 10, code: 'export const limit = 5;\nexport const windowMs = 60_000;\n', highlight: [1] }]} ctx={galleryCtx} />
    </Specimen>
  );
}
