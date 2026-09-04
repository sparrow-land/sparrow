/**
 * The scenario's MTA: one SMTP conversation with the gateway, reported as JSON.
 *
 * `swaks` would be the obvious host tool here, but swaks cannot DKIM-SIGN, and
 * the spec's 150 entry turns on the difference between a signed message and an
 * unsigned one. nodemailer can sign, and it is already a dependency of
 * `apps/mail-gateway` — so the suite needs no extra host tool at all (see
 * SCENARIO_REQUIRES in run.sh).
 *
 * Config is entirely environmental; the result goes to stdout as one JSON
 * object, ALWAYS exit 0 — an SMTP refusal is an assertion in run.sh, not a
 * crash:
 *
 *   { "ok": true,  "response": "250 …", "messageId": "<…>" }
 *   { "ok": false, "code": 550, "response": "550 …" }
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// Resolve nodemailer the way the gateway itself would.
const require = createRequire(path.join(here, '../../apps/mail-gateway/index.cjs'));
const nodemailer = require('nodemailer');

const env = process.env;
const need = (name) => {
  const v = env[name];
  if (!v) throw new Error(`send-mail.mjs: ${name} is required`);
  return v;
};

const dkim =
  env.DKIM_PRIVATE_KEY && env.DKIM_DOMAIN && env.DKIM_SELECTOR
    ? {
        domainName: env.DKIM_DOMAIN,
        keySelector: env.DKIM_SELECTOR,
        privateKey: env.DKIM_PRIVATE_KEY,
      }
    : undefined;

const transport = nodemailer.createTransport({
  host: env.SMTP_HOST || '127.0.0.1',
  port: Number(need('SMTP_PORT')),
  secure: false,
  ignoreTLS: true,
  tls: { rejectUnauthorized: false },
  ...(dkim ? { dkim } : {}),
});

const message = {
  from: need('MAIL_FROM'),
  to: need('MAIL_TO'),
  subject: env.MAIL_SUBJECT ?? '',
  text: env.MAIL_TEXT ?? '',
  ...(env.MAIL_MESSAGE_ID ? { messageId: env.MAIL_MESSAGE_ID } : {}),
  ...(env.MAIL_IN_REPLY_TO ? { inReplyTo: env.MAIL_IN_REPLY_TO } : {}),
};

try {
  const info = await transport.sendMail(message);
  process.stdout.write(
    JSON.stringify({
      ok: true,
      code: 250,
      response: String(info.response ?? ''),
      messageId: String(info.messageId ?? ''),
      accepted: info.accepted ?? [],
      rejected: info.rejected ?? [],
    }) + '\n',
  );
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      ok: false,
      // nodemailer surfaces the SMTP reply code on the error; 0 when the failure
      // was not an SMTP reply at all (connection refused, timeout).
      code: Number(error?.responseCode ?? 0),
      response: String(error?.response ?? error?.message ?? ''),
      messageId: '',
    }) + '\n',
  );
}
process.exit(0);
