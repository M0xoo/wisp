// The one error shape ({code, message, retry}), with the HTTP status v1's routes answered. The edge
// turns any thrown `{code, message}` into a WireError; the compat routes answer v1's `{error}`.

const CODES: Readonly<Record<number, string>> = { 400: 'invalid', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 503: 'unavailable' };

export class PluginsError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retry: boolean;
  /** every problem a spell or manifest has, when that is why it was refused */
  readonly problems: readonly string[] | undefined;
  constructor(message: string, status = 400, problems?: readonly string[]) {
    super(message);
    this.name = 'PluginsError';
    this.status = status;
    this.code = CODES[status] ?? 'internal';
    this.retry = status === 503;
    this.problems = problems;
  }
}

export const bad = (message: string, status = 400, problems?: readonly string[]): PluginsError => new PluginsError(message, status, problems);

/** The status to answer for anything thrown: ours keep theirs, a kernel `{code}` maps back, the rest is 500. */
export function statusOf(e: unknown): number {
  if (e instanceof PluginsError) return e.status;
  const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
  const byCode: Record<string, number> = { invalid: 400, forbidden: 403, not_found: 404, conflict: 409, unavailable: 503, service_gone: 503, plugin_off: 503 };
  return typeof code === 'string' ? (byCode[code] ?? 500) : 500;
}

export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
