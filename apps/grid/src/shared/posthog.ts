// Copy of v1 server/telemetry.js postBatch/posthogKey; when the telemetry plugin's api publishes
// them, import from there. The grid's own usage stats (telemetry.ts) and the sign-in page's
// analytics (pages/) go to wisp's PostHog project over its plain HTTP API: no SDK, no dependency.

import fs from 'node:fs';

// PostHog project API key: write-only, safe to ship in the client.
const KEY = process.env['WISP_POSTHOG_KEY'] ?? 'phc_wowwZkbP8e4zYuwT67JtX6oxdPwkMWL5kKnrUmYYXhcD';
const HOST = (process.env['WISP_POSTHOG_HOST'] || 'https://us.i.posthog.com').replace(/\/$/, '');
const TIMEOUT_MS = 3000;

export const posthogKey = (): string => KEY;

export interface PosthogEvent {
  event: string;
  timestamp: string;
  properties: Record<string, unknown>;
}

/** PostHog's batch endpoint; true once it has them. */
export async function postBatch(batch: PosthogEvent[]): Promise<boolean> {
  if (!KEY) return false;
  try {
    const res = await fetch(`${HOST}/batch/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: KEY, batch }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function versionOf(file: URL): string | null {
  try {
    const j: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    const v = typeof j === 'object' && j !== null ? (j as { version?: unknown }).version : undefined;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

// The version a grid reports is the published package's (apps/server: wisp-agents), which is what
// its boxes run; the grid's own package.json when it's deployed without it. Read once, at import.
export const VERSION: string = versionOf(new URL('../../../server/package.json', import.meta.url)) ?? versionOf(new URL('../../package.json', import.meta.url)) ?? '0.0.0';
