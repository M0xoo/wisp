// The one error shape that crosses the wire (AGENTS.md: `{code, message, retry}`). The codes are the
// kernel's WispErrorCode values; the store only ever raises these four.

export type StoreErrorCode = 'invalid' | 'not_found' | 'conflict' | 'internal';

export class StoreError extends Error {
  readonly code: StoreErrorCode;
  readonly retry: boolean;

  constructor(code: StoreErrorCode, message: string, retry = false) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    this.retry = retry;
  }

  toWire(): { code: StoreErrorCode; message: string; retry: boolean } {
    return { code: this.code, message: this.message, retry: this.retry };
  }
}

export const invalid = (message: string): StoreError => new StoreError('invalid', message);
