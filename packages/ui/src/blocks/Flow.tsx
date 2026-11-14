// The `flow` block (v1 web/js/blocks.js R.flow): nodes in layers joined by wires, chained in order
// when the agent gives no edges. The layout is pure (flow-layout.ts); this measures the stage with
// one ResizeObserver, reads every node's box in one pass, then writes the plan and the wires.
import { createMemo, createSignal, For, Index, onCleanup, onMount, Show, type JSX } from 'solid-js';
import { styleOf } from '../core/props.ts';
import { useBlocks, useBlockT } from './context.tsx';
import { FLOW_GAP, FLOW_ROW_GAP, flowGraph, flowPlan, flowWires, samePlan, type FlowGraph, type FlowNode, type FlowPad, type FlowPlan, type FlowRect, type FlowWire } from './flow-layout.ts';
import { opt } from './read.ts';
import { BlockTitle, InlineMd } from './rich-ui.tsx';
import { useFrame } from './rich-scope.ts';
import type { BlockProps } from './types.ts';

const NO_PAD: FlowPad = { top: 0, right: 0, bottom: 0 };
const samePad = (a: FlowPad, b: FlowPad): boolean => a.top === b.top && a.right === b.right && a.bottom === b.bottom;
const MAX_PASSES = 4; // plan, then padding, settle in two; the cap keeps a flapping width from looping

function Wires(props: { readonly wires: readonly FlowWire[]; readonly box: { w: number; h: number }; readonly moving: boolean }): JSX.Element {
  return (
    <svg data-kit="rb-flow-wires" aria-hidden="true" viewBox={`0 0 ${props.box.w} ${props.box.h}`}>
      <Index each={props.wires}>
        {(w, i) => (
          <>
            <path data-kit="rb-flow-wire" data-back={w().back ? '' : undefined} d={w().d} pathLength={w().back ? 100 : 1} style={styleOf({ '--k': i })} />
            <Show when={props.moving}>
              {/* Hidden until its motion begins: before that it sits at the stage's top-left corner. */}
              <circle r="3" data-kit="rb-flow-spark" data-back={w().back ? '' : undefined} visibility="hidden">
                <set {...SHOW_SPARK} begin={`${0.8 + i * 0.35}s`} />
                <animateMotion dur={w().back ? '3.2s' : '2.2s'} begin={`${0.8 + i * 0.35}s`} repeatCount="indefinite" path={w().d} />
              </circle>
            </Show>
            <Show when={w().label}>
              {(label) => (
                <text data-kit="rb-flow-label" x={w().lx} y={w().ly} text-anchor={w().anchor}>
                  {label()}
                </text>
              )}
            </Show>
          </>
        )}
      </Index>
    </svg>
  );
}

// Solid's SetSVGAttributes lacks attributeName (an upstream typing gap); a spread carries it.
const SHOW_SPARK = { attributeName: 'visibility', to: 'visible' } as const;

const reducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

interface FlowLayout {
  readonly plan: () => FlowPlan;
  readonly wires: () => readonly FlowWire[];
  readonly box: () => { w: number; h: number };
  readonly pad: () => FlowPad;
  readonly stage: (el: HTMLDivElement) => void;
  readonly node: (id: string, el: HTMLElement) => void;
}

/** Measures the stage with one ResizeObserver: reads the stage and every node first, then writes. */
function useFlowLayout(graph: () => FlowGraph): FlowLayout {
  const [plan, setPlan] = createSignal<FlowPlan>({ mode: 'row', perRow: Number.MAX_SAFE_INTEGER, cells: [] });
  const [wires, setWires] = createSignal<readonly FlowWire[]>([]);
  const [box, setBox] = createSignal({ w: 0, h: 0 });
  const [pad, setPad] = createSignal<FlowPad>(NO_PAD);
  const nodes = new Map<string, HTMLElement>();
  const frame = useFrame();
  let stage: HTMLDivElement | undefined;
  let passes = 0;
  const rectOf = (base: DOMRect) => (id: string): FlowRect | undefined => {
    const r = nodes.get(id)?.getBoundingClientRect();
    return r ? { l: r.left - base.left, t: r.top - base.top, r: r.right - base.left, b: r.bottom - base.top } : undefined;
  };
  // A write that moves the nodes (a new plan, new padding) measures again next frame.
  const measure = (): void => {
    const base = stage?.getBoundingClientRect();
    if (!base?.width) return;
    const g = graph();
    const next = flowPlan(g.cols.length, base.width, g.hasBack);
    if (!samePlan(next, plan()) && passes++ < MAX_PASSES) {
      setPlan(next);
      return frame(measure);
    }
    const out = flowWires(g.edges, rectOf(base), plan(), base.width, pad().top);
    setBox({ w: base.width, h: base.height });
    setWires(out.wires);
    if (!samePad(out.pad, pad()) && passes++ < MAX_PASSES) {
      setPad(out.pad);
      return frame(measure);
    }
    passes = 0;
  };
  onMount(() => {
    if (!stage || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      passes = 0;
      frame(measure);
    });
    ro.observe(stage);
    onCleanup(() => ro.disconnect());
  });
  return { plan, wires, box, pad, stage: (el) => (stage = el), node: (id, el) => nodes.set(id, el) };
}

function Node(props: { readonly node: FlowNode; readonly layer: number; readonly ref: (el: HTMLElement) => void }): JSX.Element {
  return (
    <div data-kit="rb-flow-node" data-part="block.flow.node" data-id={props.node.id} ref={props.ref} style={styleOf({ '--k': props.layer })}>
      <b data-kit="rb-flow-node-label">
        <InlineMd source={props.node.label} />
      </b>
      <Show when={props.node.note}>
        {(note) => (
          <span data-kit="rb-flow-node-note">
            <InlineMd source={note()} />
          </span>
        )}
      </Show>
    </div>
  );
}

export function FlowBlock(props: BlockProps): JSX.Element {
  const ctx = useBlocks();
  const t = useBlockT();
  const graph = createMemo(() => flowGraph(props.block));
  const lay = useFlowLayout(graph);
  const title = (): string | undefined => opt(props.block['title']);
  return (
    <div data-kit="rb-flow" data-card="" data-part="block.flow" role="figure" aria-label={title() ?? t('block.flow.label')}>
      <Show when={title()}>{(s) => <BlockTitle part="block.flow.title">{s()}</BlockTitle>}</Show>
      <div
        ref={lay.stage}
        data-kit="rb-flow-stage"
        data-part="block.flow.stage"
        style={styleOf({ '--k-pad-t': `${lay.pad().top}px`, '--k-pad-r': `${lay.pad().right}px`, '--k-pad-b': `${lay.pad().bottom}px` })}
      >
        <Wires wires={lay.wires()} box={lay.box()} moving={ctx.reveal !== false && !reducedMotion()} />
        <div
          data-kit="rb-flow-cols"
          data-mode={lay.plan().mode}
          style={styleOf({ '--k-per-row': lay.plan().mode === 'snake' ? lay.plan().perRow : undefined, '--k-flow-gap': `${FLOW_GAP}px`, '--k-flow-row-gap': `${FLOW_ROW_GAP}px` })}
        >
          <For each={graph().cols}>
            {(col, ci) => (
              <div data-kit="rb-flow-col" style={styleOf({ '--k-row': lay.plan().cells[ci()]?.row, '--k-col': lay.plan().cells[ci()]?.col })}>
                <For each={col}>{(n) => <Node node={n} layer={ci()} ref={(el) => lay.node(n.id, el)} />}</For>
              </div>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
