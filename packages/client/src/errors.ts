import type { ErrorCode } from '@sparrow/common-types';

/**
 * Typed error thrown for any non-2xx API response (or a malformed one).
 * `code` is the machine error code from the API error envelope
 * (falls back to `internal` when the body is not a valid error envelope).
 */
export class ApiError extends Error {
  readonly code: ErrorCode | string;
  readonly status: number;

  constructor(params: { code: ErrorCode | string; status: number; message: string }) {
    super(params.message);
    this.name = 'ApiError';
    this.code = params.code;
    this.status = params.status;
    // Restore prototype chain for instanceof across transpilation targets.
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}
