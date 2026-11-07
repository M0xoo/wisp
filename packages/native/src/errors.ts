// Errors cross every boundary as one shape: {code, message, retry} (AGENTS.md).

import type { ErrorCode } from './protocol.ts';

export class NativeError extends Error {
  readonly code: ErrorCode;
  readonly retry: boolean;
  constructor(code: ErrorCode, message: string, retry = false) {
    super(message);
    this.name = 'NativeError';
    this.code = code;
    this.retry = retry;
  }
  toJSON(): { code: ErrorCode; message: string; retry: boolean } {
    return { code: this.code, message: this.message, retry: this.retry };
  }
}
