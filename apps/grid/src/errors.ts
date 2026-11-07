// The grid's one error shape: a message for a person and the HTTP status it answers with. Pages show
// the message; the JSON API sends { error: message }. `full` and `waitlisted` say why a sign-up was
// turned away, so the sign-in page can offer the waitlist.

export interface GridError extends Error {
  status: number;
  full?: boolean;
  waitlisted?: boolean;
}

export const bad = (message: string, status = 400): GridError => Object.assign(new Error(message), { status });

/** The status an error answers with: its own, or 500 for anything that isn't a GridError. */
export const statusOf = (err: unknown): number => {
  const s = typeof err === 'object' && err !== null ? (err as { status?: unknown }).status : undefined;
  return typeof s === 'number' && s >= 400 && s < 600 ? s : 500;
};

export const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The node error code (ENOENT, EADDRINUSE…), or ''. */
export const codeOf = (err: unknown): string => {
  const c = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof c === 'string' ? c : '';
};
