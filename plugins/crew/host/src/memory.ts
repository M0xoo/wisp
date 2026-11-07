// What a job hands back (v1 server/crew.js takeCrewBlock, applyMemory, logEntry, reportText and the
// quiet/forLater rule of #turnDone): the hidden `crew` block that ends a job's answer, its effect on
// the member's notebook and wake-up, and the line wisp logs per job. Pure.
import { KIT_BODY_MAX, plainCrew, QUIET_JOBS } from '@wisp-plugin/crew-api';
import type { CrewExt, LogEntry, Member } from '@wisp-plugin/crew-api';
import type { Presentation, Turn } from '@wisp-plugin/runtime-api';
import { clampNotebook } from './members.ts';
import { WAKE_MIN } from './note.ts';
import { isObj, str, truncate } from './ports.ts';

const WAKE_MAX = 7 * 24 * 60;
const OFFER_FILES = 12;
// The parts of a job's report kept for the log, a lead and an @mention's answer.
const KEEP: ReadonlySet<string> = new Set(['hero', 'markdown', 'steps', 'stats', 'files', 'tests', 'commits', 'checklist', 'callout', 'question', 'next']);

export interface CrewData {
  remember: string[];
  notebook?: string;
  wakeIn?: number;
  quiet?: true;
  forLater?: true;
  kit?: { kind: string; name: string; description: string; body: string }[];
  followUps?: { task: string; text: string }[];
}

type Block = Presentation['blocks'][number];

/** A presentation as the parser hands it, with the top-level fields v1 kept on it. */
export interface Answer {
  blocks: Block[];
  topic?: string;
  notes?: string;
}

function readBlock(b: Block, out: CrewData, p: Answer): void {
  const rem = b['remember'];
  if (Array.isArray(rem)) out.remember.push(...rem.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.replace(/\s+/g, ' ').trim().slice(0, 300)));
  else if (typeof rem === 'string' && rem.trim()) out.remember.push(rem.trim().slice(0, 300));
  if (typeof b['notebook'] === 'string') out.notebook = b['notebook'];
  if (Number(b['wakeIn']) > 0) out.wakeIn = Number(b['wakeIn']);
  if (b['quiet'] === true) out.quiet = true;
  // A quick answer has no hero: the crew block names its task.
  const topic = b['topic'];
  if (typeof topic === 'string' && topic.trim() && !p.topic) p.topic = topic.trim().slice(0, 200);
  if (b['forLater'] === true) out.forLater = true;
  const kit = b['kit'];
  if (Array.isArray(kit)) for (const k of kit) if (isObj(k)) (out.kit ??= []).push({ kind: str(k['kind']), name: str(k['name']).trim().slice(0, 64), description: str(k['description']).slice(0, 1024), body: str(k['body']).slice(0, KIT_BODY_MAX) });
  for (const f of [b['followUp']].flat()) if (isObj(f) && typeof f['text'] === 'string' && f['text'].trim()) (out.followUps ??= []).push({ task: str(f['task']).slice(0, 60), text: f['text'].trim().slice(0, 4000) });
}

/**
 * Takes the `crew` blocks out of an answer: what they say, merged. The answer keeps the rest; only a
 * crew block: a quick answer's text (its notes) is the report, else a hero says "Nothing new".
 * Mutates `p` as v1 did; callers hand it a copy of what they don't own.
 */
export function takeCrewBlock(p: Answer | null | undefined): CrewData | null {
  const blocks = p?.blocks ?? [];
  const mine = blocks.filter((b) => b?.type === 'crew');
  if (!p || !mine.length) return null;
  p.blocks = blocks.filter((b) => b?.type !== 'crew');
  const out: CrewData = { remember: [] };
  for (const b of mine) readBlock(b, out, p);
  out.remember = out.remember.slice(0, 12);
  if (out.followUps) out.followUps = out.followUps.slice(0, 3);
  if (out.kit) out.kit = out.kit.slice(0, OFFER_FILES);
  if (!p.blocks.length && p.notes) {
    p.blocks = [{ type: 'markdown', text: p.notes }];
    delete p.notes;
  }
  if (!p.blocks.length) p.blocks = [{ type: 'hero', title: 'Nothing new', summary: '', status: 'info' }];
  return out;
}

/** What changes on the member: its notebook and its next wake-up. */
export function applyMemory(m: Pick<Member, 'notebook' | 'wakeAt'>, data: CrewData | null | undefined, now = Date.now()): void {
  if (!data) return;
  if (typeof data.notebook === 'string') m.notebook = clampNotebook(data.notebook);
  if (data.remember.length) m.notebook = clampNotebook([m.notebook, ...data.remember.map((x) => `- ${x}`)].filter(Boolean).join('\n'));
  if (data.wakeIn) m.wakeAt = now + Math.min(WAKE_MAX, Math.max(WAKE_MIN, Math.round(data.wakeIn))) * 60_000;
}

/**
 * How a job's turn lands (runtime.outcome): a check-in (or a watch's job) that found nothing is filed
 * quietly, one worth reading but not urgent goes to For later, and a delegation's answer goes to its
 * lead (the job is filed under Done). Only where nobody waits on the answer: such a job's first turn.
 */
export function outcomeOf(crew: Pick<CrewExt, 'job'>, turn: Pick<Turn, 'status' | 'idx' | 'presentation'>): { quiet: boolean; filed: boolean; later: boolean } | null {
  if (turn.status !== 'done') return null;
  const data = takeCrewBlock(turn.presentation ? structuredClone({ blocks: turn.presentation.blocks }) : null);
  const nobodyWaits = QUIET_JOBS.has(crew.job) && turn.idx === 0;
  const later = !!data?.forLater && nobodyWaits;
  return { quiet: !!data?.quiet && nobodyWaits && !later, filed: crew.job === 'delegated', later };
}

const heroOf = (turn: Pick<Turn, 'presentation'>): Block | undefined => turn.presentation?.blocks.find((b) => b?.type === 'hero');

/** One line in the member's log for a finished job. */
export function logEntry(sessionId: string, crew: Pick<CrewExt, 'job' | 'from'>, turn: Pick<Turn, 'status' | 'endedAt' | 'prompt' | 'presentation'>, o: { quiet?: boolean; forLater?: boolean; now?: number } = {}): LogEntry {
  const hero = heroOf(turn);
  const status = turn.status === 'done' ? str(hero?.['status']) || 'done' : turn.status === 'stopped' ? 'partial' : 'blocked';
  const fallback = turn.status === 'error' ? 'Failed' : turn.status === 'stopped' ? 'Stopped' : 'Finished';
  return {
    at: turn.endedAt ?? o.now ?? Date.now(),
    job: crew.job || 'task',
    title: truncate(str(hero?.['title']) || fallback, 80),
    summary: truncate(str(hero?.['summary']).replace(/\s+/g, ' '), 160),
    prompt: truncate(plainCrew(turn.prompt).replace(/\s+/g, ' ').trim(), 200),
    ...(crew.from?.title && { from: crew.from }),
    status,
    ...(o.quiet && { quiet: true }),
    ...(o.forLater && { forLater: true }),
    sessionId,
  };
}

function blockText(b: Block): string {
  const s = (k: string): string => str(b[k]);
  const items = (k: string): string[] => (Array.isArray(b[k]) ? (b[k] as unknown[]).map((x) => (isObj(x) ? str(x['text'] ?? x['title'] ?? x['label'] ?? x['path'] ?? x['name']) : str(x))) : []);
  switch (b.type) {
    case 'hero':
      return `### ${s('title')}${s('summary') ? `\n\n${s('summary')}` : ''}`;
    case 'markdown':
      return s('text');
    case 'callout':
      return `> ${s('text') || s('title')}`;
    case 'question':
      return `**${s('question')}**`;
    default: {
      const list = [...items('items'), ...items('steps'), ...items('files'), ...items('commits')].filter(Boolean);
      return [s('title'), ...list.map((x) => `- ${x}`)].filter(Boolean).join('\n');
    }
  }
}

/** A job's report as markdown, for an @mention's answer (the kept parts; the runtime renders the rest). */
export const reportText = (turn: Pick<Turn, 'presentation' | 'text'>): string => {
  const blocks = (turn.presentation?.blocks ?? []).filter((b) => KEEP.has(b?.type));
  const md = blocks.length ? blocks.map(blockText).filter(Boolean).join('\n\n') : str(turn.text);
  return truncate(md.trim(), 6000);
};
