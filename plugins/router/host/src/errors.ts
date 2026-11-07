// The one error shape this plugin throws: the kernel maps `{ code, message }` to the wire error, and
// the http edge to v1's status (invalid 400, not_found 404, unavailable 503).

export class PluginError extends Error {
  readonly code: 'invalid' | 'not_found' | 'unavailable' | 'forbidden';
  /** the HTTP status a v1 route answered this with, when it isn't the code's */
  readonly status?: number;
  constructor(code: PluginError['code'], message: string, status?: number) {
    super(message);
    this.name = 'PluginError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}
