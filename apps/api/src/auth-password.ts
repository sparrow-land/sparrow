/**
 * Built-in `password` auth provider (open core): email/password accounts.
 * v5: always registered — accounts are always on.
 */
import { LoginRequestSchema, SignupRequestSchema } from '@sparrow/common-types';
import type { AuthCtx, AuthProvider } from './auth.js';
import { hashPassword, verifyPassword } from './auth.js';
import { parse } from './validate.js';
import { unauthorized } from './errors.js';

export const passwordAuthProvider: AuthProvider = {
  id: 'password',
  label: 'Password',
  kind: 'credentials',

  register(app, ctx: AuthCtx): void {
    app.post('/api/v1/auth/signup', (request, reply) => {
      const body = parse(SignupRequestSchema, request.body);
      // Duplicate email -> 409 (signup must not silently log in).
      ctx.auth.assertEmailAvailable(body.email);
      // Policy (allowSignup / allowedEmailPatterns) enforced inside -> 403.
      const { user, token } = ctx.auth.loginOrCreateUser(
        {
          email: body.email,
          displayName: body.displayName,
          provider: 'password',
          passwordHash: hashPassword(body.password),
          // Honored only if this turns out to be the bootstrap signup.
          orgName: body.orgName,
        },
        reply,
      );
      return reply.code(201).send({ user, token });
    });

    app.post('/api/v1/auth/login', (request, reply) => {
      const body = parse(LoginRequestSchema, request.body);
      const row = ctx.auth.humanByEmail(body.email);
      // Wrong anything -> the same 401; never reveal which part failed.
      if (!row?.passwordHash || !verifyPassword(body.password, row.passwordHash)) {
        throw unauthorized('Invalid email or password');
      }
      const { user, token } = ctx.auth.loginOrCreateUser(
        { email: row.email, provider: row.provider },
        reply,
      );
      return reply.code(200).send({ user, token });
    });
  },
};
