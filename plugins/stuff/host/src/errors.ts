// v1's bad(msg, status): an error the edge answers as `{error}` with that status. It is wire-like
// (`code`, `message`), so the kernel's toKernelError keeps its code when a command throws it.

const CODE: Readonly<Record<number, string>> = { 400: 'invalid', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 413: 'invalid', 501: 'unavailable', 503: 'unavailable' };

export class StuffError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'StuffError';
    this.status = status;
    this.code = CODE[status] ?? 'internal';
  }
}

export const bad = (message: string, status = 400): StuffError => new StuffError(message, status);

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** node's error code (ENOENT, EBUSY…), or '' */
export const errno = (e: unknown): string => (typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'string' ? (e as { code: string }).code : '');
