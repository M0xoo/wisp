// The BlockContext a host gives an answer, read by every block below it.
import { createContext, useContext, type JSX } from 'solid-js';
import { blockEnglish, type BlockTranslate } from './strings.ts';
import type { BlockContext } from './types.ts';

const Ctx = createContext<BlockContext>({});

export function BlockHost(props: { readonly ctx: BlockContext; readonly children?: JSX.Element }): JSX.Element {
  return <Ctx.Provider value={props.ctx}>{props.children}</Ctx.Provider>;
}

export function useBlocks(): BlockContext {
  return useContext(Ctx);
}

/** The blocks' translator: the host's, or English. */
export function useBlockT(): BlockTranslate {
  const ctx = useContext(Ctx);
  return (key, vars) => (ctx.t ?? blockEnglish)(key, vars);
}
