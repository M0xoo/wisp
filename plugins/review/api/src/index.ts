// @wisp-plugin/review-api: the contract of wisp.review. Review by another harness (setting
// review.mode, v1 defaults.review, off by default): when a task's own PR is open and its head is new,
// a harness other than the one that wrote it reads the diff against the base and lists what it would
// fix, and the project's tests run again on that head. Separate from wisp.ship so it can be switched
// off or replaced: it only listens to ship's PR events and reads through git.service.
//
// Per-task data: `ext['wisp.review']` = { review: Review } (v1 session.review).

import type { Json } from '@wisp/kernel';

export const PLUGIN = 'wisp.review';

export const HARNESSES = ['claude', 'codex', 'antigravity', 'copilot', 'opencode', 'cursor', 'grok'] as const;
export const REVIEW_VALUES = ['off', 'other', ...HARNESSES] as const;

export interface Finding {
  severity: 'high' | 'medium' | 'low';
  file?: string;
  line?: number;
  text: string;
  constraint?: number;
  rule?: string;
}

export interface Coverage {
  files: number;
  seen: number;
  chars: number;
  seenChars: number;
  cut: string[];
  missing: string[];
  more?: number;
}

export interface Review {
  status: 'running' | 'done' | 'failed' | 'held';
  head: string;
  by?: { agent: string; model: string };
  summary?: string;
  findings: Finding[];
  tests?: { verdict: string; command: string; passed: number; failed: number };
  constraints?: string[];
  coverage?: Coverage;
  why?: string;
  at: number;
}

export interface ReviewExt {
  review?: Review;
}

export function reviewOf(s: { ext?: Record<string, Json> } | null | undefined): ReviewExt {
  const v = s?.ext?.[PLUGIN];
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as unknown as ReviewExt) : {};
}

export const COMMANDS = {
  /** { id, force? } → { review } | refusal (v1 POST /sessions/:id/review) */
  start: 'review.start',
} as const;
