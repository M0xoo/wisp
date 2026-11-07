// Block type → component: every type v1 draws (web/js/blocks.js R, server/protocol.js).
// A host's `renderers` win over these (BlockContext), and a type in neither is UnknownBlock.
import type { BlockRenderer } from './types.ts';
import { HeroBlock } from './Hero.tsx';
import { MarkdownBlock } from './Markdown.tsx';
import { StepsBlock } from './Steps.tsx';
import { StatsBlock } from './Stats.tsx';
import { FilesBlock } from './Files.tsx';
import { TreeBlock } from './Tree.tsx';
import { DiffBlock } from './Diff.tsx';
import { CodeBlock } from './Code.tsx';
import { CompareBlock } from './Compare.tsx';
import { TestsBlock } from './Tests.tsx';
import { CommitsBlock } from './Commits.tsx';
import { GraphBlock } from './Graph.tsx';
import { ChecklistBlock } from './Checklist.tsx';
import { CalloutBlock } from './Callout.tsx';
import { TerminalBlock } from './Terminal.tsx';
import { FlowBlock } from './Flow.tsx';
import { ChartBlock } from './Chart.tsx';
import { ImageBlock } from './Image.tsx';
import { VideoBlock } from './Video.tsx';
import { PreviewBlock } from './Preview.tsx';
import { MapBlock } from './Map.tsx';
import { DocBlock } from './Doc.tsx';
import { TaskBlock } from './Task.tsx';
import { StuffBlock } from './Stuff.tsx';
import { QuestionBlock } from './Question.tsx';
import { BlockedBlock } from './Blocked.tsx';
import { ActionsBlock } from './Actions.tsx';
import { NextBlock } from './Next.tsx';
import { AppBlock } from './App.tsx';

export const BLOCKS: Readonly<Record<string, BlockRenderer>> = {
  hero: HeroBlock,
  markdown: MarkdownBlock,
  steps: StepsBlock,
  stats: StatsBlock,
  files: FilesBlock,
  tree: TreeBlock,
  diff: DiffBlock,
  code: CodeBlock,
  compare: CompareBlock,
  tests: TestsBlock,
  commits: CommitsBlock,
  graph: GraphBlock,
  checklist: ChecklistBlock,
  callout: CalloutBlock,
  terminal: TerminalBlock,
  flow: FlowBlock,
  chart: ChartBlock,
  image: ImageBlock,
  video: VideoBlock,
  preview: PreviewBlock,
  map: MapBlock,
  doc: DocBlock,
  task: TaskBlock,
  stuff: StuffBlock,
  question: QuestionBlock,
  blocked: BlockedBlock,
  actions: ActionsBlock,
  next: NextBlock,
  app: AppBlock,
};

/** Every type the kit draws, for `welcome`'s blocks list and the gallery. */
export const BLOCK_TYPES: readonly string[] = Object.keys(BLOCKS);
