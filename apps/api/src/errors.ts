import type { ErrorCode } from '@sparrow/common-types';

/** HTTP status for each SPEC error code. */
const STATUS_BY_CODE: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  gone: 410,
  rate_limited: 429,
  payload_too_large: 413,
  client_upgrade_required: 426,
  internal: 500,
};

/** An error carrying a SPEC error code; the error handler renders the envelope. */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;

  constructor(code: ErrorCode, message: string, statusCode?: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.statusCode = statusCode ?? STATUS_BY_CODE[code];
  }
}

export const badRequest = (m = 'Bad request') => new ApiError('bad_request', m);
export const unauthorized = (m = 'Unauthorized') => new ApiError('unauthorized', m);
export const forbidden = (m = 'Forbidden') => new ApiError('forbidden', m);
export const notFound = (m = 'Not found') => new ApiError('not_found', m);
export const conflict = (m = 'Conflict') => new ApiError('conflict', m);
export const gone = (m = 'Gone') => new ApiError('gone', m);
export const rateLimited = (m = 'Rate limit exceeded') => new ApiError('rate_limited', m);
export const payloadTooLarge = (m = 'Payload too large') =>
  new ApiError('payload_too_large', m);
export const internal = (m = 'Internal server error') => new ApiError('internal', m);
/**
 * A `502` upstream failure rendered with the `internal` SPEC code (there is no
 * dedicated `bad_gateway` code). Used to map opaque voice-vendor failures
 * without leaking the vendor's response body.
 */
export const badGateway = (m = 'Bad gateway') => new ApiError('internal', m, 502);
