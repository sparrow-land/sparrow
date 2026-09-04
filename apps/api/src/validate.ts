import type { z } from 'zod';
import { badRequest } from './errors.js';

/** Parse `data` with a zod schema, mapping failures to a bad_request ApiError. */
export function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first?.path.join('.');
    const message = first
      ? `${path ? `${path}: ` : ''}${first.message}`
      : 'Invalid request';
    throw badRequest(message);
  }
  return result.data;
}
