// Answer blocks: every type v1 draws, plus the unknown block and a block that throws.
import type { JSX } from 'solid-js';
import { Answer } from '../../src/index.ts';
import { Area, Specimen } from '../frame.tsx';
import { ContentBlocksGallery } from '../blocks/content.tsx';
import { RichBlocksGallery } from '../blocks/rich.tsx';
import { galleryCtx } from '../blocks/ctx.ts';

export function BlocksGallery(): JSX.Element {
  return (
    <Area id="blocks" title="Answer blocks">
      <ContentBlocksGallery />
      <RichBlocksGallery />
      <Specimen title="Unknown and fallback" note="A type this app doesn't know shows as its JSON; a plain-text answer says so.">
        <Answer fallback blocks={[{ type: 'hologram', depth: 3, caption: 'From a newer wisp' }, 'not an object']} ctx={galleryCtx} />
      </Specimen>
    </Area>
  );
}
