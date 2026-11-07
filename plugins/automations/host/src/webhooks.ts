// Outbound webhooks (v1 server/services/webhooks.js): POST { event, session, markdown, at } to each
// URL in the `webhooks` setting (Slack bridges, CI, notifiers), through the net service. Events:
// session.finished (a turn ended) and session.waiting (the agent asks you something). Fire and forget.
// The markdown is the small part of v1 render.js sessionToMarkdown a notifier needs: the report.

import type { Json, Log, NetService } from '@wisp/kernel';
import type { Presentation, Turn } from '@wisp-plugin/runtime-api';
import { isObj } from './util.ts';

export const WEBHOOK_EVENTS: readonly string[] = ['session.finished', 'session.waiting'];
const TIMEOUT_MS = 10_000;

export interface Webhook {
  url: string;
  events?: string[];
}

/** A webhook list from the setting: a URL string or { url, events }. The error names the first bad one. */
export function normalizeWebhooks(list: unknown): { hooks: Webhook[] } | { error: string } {
  const hooks = Array.isArray(list) ? (list as unknown[]) : [];
  const url = (h: unknown): string => String(isObj(h) ? h['url'] : h);
  const wrong = hooks.find((h) => !/^https?:\/\/\S+$/.test(url(h)));
  if (wrong !== undefined) return { error: `Not an http(s) URL: ${url(wrong)}` };
  return {
    hooks: hooks.map((h) => {
      const events = isObj(h) && Array.isArray(h['events']) ? h['events'].map(String) : undefined;
      return { url: url(h), ...(events && { events }) };
    }),
  };
}

const STATUS: Readonly<Record<string, string>> = { done: '✅ Done', partial: '🟡 Partly done', blocked: '⛔ Blocked', info: 'ℹ️ Report' };
const s = (v: unknown): string => (v == null ? '' : String(v));
const items = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isObj) : []);
const fence = (text: string, lang = ''): string => {
  const ticks = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return `${ticks}${lang}\n${text.replace(/\n$/, '')}\n${ticks}`;
};

const BLOCKS: Readonly<Record<string, (b: Record<string, unknown>) => string>> = {
  hero: (b) => `## ${s(b['title']) || 'Done'}\n\n**${STATUS[s(b['status'])] ?? STATUS['done']}**${b['summary'] ? ` — ${s(b['summary'])}` : ''}`,
  markdown: (b) => s(b['text']),
  steps: (b) => `${b['title'] ? `**${s(b['title'])}**\n\n` : ''}${items(b['items']).map((x, i) => `${i + 1}. ${x['status'] === 'failed' ? '❌' : x['status'] === 'skipped' ? '⏭️' : '✔︎'} **${s(x['title'])}**${x['detail'] ? ` — ${s(x['detail'])}` : ''}`).join('\n')}`,
  stats: (b) => items(b['items']).map((x) => `- **${s(x['label'])}:** ${s(x['value'])}${s(x['unit'])}${x['delta'] ? ` (${s(x['delta'])})` : ''}`).join('\n'),
  code: (b) => `${b['caption'] ? `${s(b['caption'])}\n\n` : ''}${fence(s(b['code']), s(b['language']))}`,
};

/** The last turn's report as markdown; its answer text when it has no blocks. */
export function turnMarkdown(turn: Turn | undefined, question = ''): string {
  const out: string[] = [];
  const blocks: Presentation['blocks'] = turn?.presentation?.blocks ?? [];
  if (turn?.status === 'running') out.push('_Working…_');
  else if (blocks.length) out.push(blocks.map((b) => (BLOCKS[b.type] ?? ((x: Record<string, unknown>) => fence(JSON.stringify(x, null, 2), 'json')))(b)).filter(Boolean).join('\n\n'));
  else if (turn?.text) out.push(turn.text);
  if (question) out.push(`**❓ The agent is waiting for your answer:** ${question}`);
  return out.join('\n\n');
}

export interface SendArgs {
  hooks: readonly Webhook[];
  event: string;
  session: Json;
  markdown: string;
  at: number;
  version: string;
}

/** Posts to every hook that wants the event; a failure is logged, never thrown. */
export function send(net: NetService, log: Log, a: SendArgs): void {
  const want = a.hooks.filter((h) => !h.events?.length || h.events.includes(a.event));
  if (!want.length) return;
  const body = JSON.stringify({ event: a.event, session: a.session, markdown: a.markdown, at: a.at });
  for (const h of want) {
    net
      .fetch(h.url, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': `wisp/${a.version}` }, body, timeoutMs: TIMEOUT_MS })
      .then((r) => void r.body?.cancel())
      .catch((err: unknown) => log.warn(`webhook ${h.url} failed`, { error: String(err) }));
  }
}
