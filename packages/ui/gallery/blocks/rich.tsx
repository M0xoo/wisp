// Gallery: the rich and interactive blocks (flow … app), every state.
import type { JSX } from 'solid-js';
import { Answer } from '../../src/index.ts';
import { Specimen } from '../frame.tsx';
import { galleryCtx } from './ctx.ts';

export function RichBlocksGallery(): JSX.Element {
  return (
    <Specimen title="Rich blocks" note="flow, chart, image, video, preview, map, doc, task, stuff, question, blocked, actions, next, app">
      <Answer blocks={[]} ctx={galleryCtx} />
    </Specimen>
  );
}
