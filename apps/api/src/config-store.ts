import { eq } from 'drizzle-orm';
import type {
  ConfigDescriptor,
  ConfigEntry,
  ConfigSource,
} from '@sparrow/common-types';
import type { DB } from './db/index.js';
import { config as configTable } from './db/schema.js';
import { badRequest } from './errors.js';

/** Value used in place of a secret config value on the wire. */
export const SECRET_MASK = '•••';

/** Core (v3) config descriptors per SPEC. */
export const CORE_DESCRIPTORS: ConfigDescriptor[] = [
  {
    key: 'auth.allowSignup',
    type: 'boolean',
    label: 'Allow new sign-ups',
    description: 'Let new people create an account.',
    default: true,
    envVar: 'AUTH_ALLOW_SIGNUP',
  },
  {
    key: 'auth.allowedEmailPatterns',
    type: 'string[]',
    label: 'Approved email domains',
    description:
      'Only emails matching these patterns can create accounts (for example *@yourcompany.com). Leave empty to allow everyone.',
    default: [],
    envVar: 'AUTH_ALLOWED_EMAIL_PATTERNS',
  },
  {
    key: 'auth.bootstrapFirstOrg',
    type: 'boolean',
    label: 'Found a workspace for the first sign-up',
    description:
      'When on, the very first person to sign in becomes the owner of a new workspace. Turn this off on managed multi-workspace instances where workspaces are provisioned centrally, so a first sign-in leaves the person free to redeem a pending invite instead of founding an accidental workspace.',
    default: true,
    envVar: 'BOOTSTRAP_FIRST_ORG',
  },
  {
    key: 'orgs.openCreation',
    type: 'boolean',
    label: 'Workspace creation',
    description: 'Let signed-in people create additional workspaces (orgs).',
    default: true,
    envVar: 'OPEN_ORG_CREATION',
  },
  {
    key: 'workspace.directoryUrl',
    type: 'string',
    label: 'Workspace directory URL',
    description:
      'URL of a workspace directory service. When set, the leftnav org header becomes a workspace switcher that lists the signed-in person’s workspaces (fetched browser-side, with credentials). Leave empty on a plain self-hosted instance to show a static org label instead.',
    default: '',
    envVar: 'WORKSPACE_DIRECTORY_URL',
  },
  {
    key: 'workspace.createUrl',
    type: 'string',
    label: 'Create-workspace URL',
    description:
      'URL the workspace switcher’s "Create a workspace" action navigates to. Only shown when set (and only alongside a workspace directory URL).',
    default: '',
    envVar: 'WORKSPACE_CREATE_URL',
  },
  {
    key: 'email.webhookUrl',
    type: 'string',
    label: 'Email webhook URL',
    description:
      'HTTPS endpoint that delivers outbound email. When set, the server POSTs each message as JSON to this URL — point it at the mail gateway, a relay, or a serverless function wrapping your mail provider. This is also the second half of the email medium’s on/off test: with EMAIL_PROVIDER=webhook and no URL here, no provider registers and the medium stays off (invites still return a shareable link).',
    default: '',
    envVar: 'EMAIL_WEBHOOK_URL',
  },
  {
    key: 'email.webhookToken',
    type: 'string',
    label: 'Email webhook token',
    description:
      'Bearer token sent to the email webhook as `Authorization: Bearer <token>`, so your endpoint can authenticate the server. Leave empty if the endpoint needs no token.',
    default: '',
    envVar: 'EMAIL_WEBHOOK_TOKEN',
    secret: true,
  },
  {
    key: 'avatars.gravatar',
    type: 'boolean',
    label: 'Gravatar fallback avatars',
    description:
      'When someone has no uploaded avatar and no photo from their sign-in provider, fall back to their Gravatar (a hash of their email address is sent to gravatar.com to fetch it). Off by default; only their generated avatar is shown.',
    default: false,
    envVar: 'GRAVATAR_AVATARS',
  },
  {
    key: 'llm.openAiApiKey',
    type: 'string',
    label: 'OpenAI API key',
    description:
      'With LLM_PROVIDER=openai, setting a key registers the OpenAI email judge — the model an org may delegate "should this message through?" to. Leave empty to run without a judge: a workspace whose email policy says `judge` then parks those messages for a human instead.',
    default: '',
    envVar: 'OPENAI_API_KEY',
    secret: true,
  },
  {
    key: 'llm.anthropicApiKey',
    type: 'string',
    label: 'Anthropic API key',
    description:
      'With LLM_PROVIDER=anthropic, setting a key registers the Anthropic email judge — the model an org may delegate "should this message through?" to. Leave empty to run without a judge: a workspace whose email policy says `judge` then parks those messages for a human instead.',
    default: '',
    envVar: 'ANTHROPIC_API_KEY',
    secret: true,
  },
  {
    key: 'voice.elevenLabsApiKey',
    type: 'string',
    label: 'ElevenLabs API key',
    description:
      'Setting a key registers ElevenLabs speech-to-text and text-to-speech; leave empty to disable voice.',
    default: '',
    envVar: 'ELEVENLABS_API_KEY',
    secret: true,
  },
  {
    key: 'voice.ttsVoiceId',
    type: 'string',
    label: 'Voice',
    description: 'ElevenLabs voice id used for spoken messages. Empty uses the vendor default voice.',
    default: '',
  },
  {
    key: 'voice.ttsModelId',
    type: 'string',
    label: 'Text-to-speech model',
    description: 'ElevenLabs TTS model id.',
    default: 'eleven_flash_v2_5',
  },
  {
    key: 'voice.sttModelId',
    type: 'string',
    label: 'Speech-to-text model',
    description: 'ElevenLabs STT model id.',
    default: 'scribe_v2',
  },
];

/**
 * Parse one env var into the descriptor's type.
 *
 * - `boolean`: only the literal `false` is false; every other non-empty value is true.
 * - `string`: verbatim.
 * - `string[]`: a **comma-separated list**, each item trimmed, empty items dropped
 *   (`"*@acme.com, *@sub.acme.com"` → `['*@acme.com', '*@sub.acme.com']`). There is
 *   no escape for a comma inside an item — no `string[]` descriptor takes one.
 */
function parseEnvValue(descriptor: ConfigDescriptor, raw: string): unknown {
  switch (descriptor.type) {
    case 'boolean':
      return raw !== 'false';
    case 'string':
      return raw;
    case 'string[]':
      return raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
  }
}

function typeMatches(descriptor: ConfigDescriptor, value: unknown): boolean {
  switch (descriptor.type) {
    case 'boolean':
      return typeof value === 'boolean';
    case 'string':
      return typeof value === 'string';
    case 'string[]':
      return Array.isArray(value) && value.every((v) => typeof v === 'string');
  }
}

/**
 * Runtime instance configuration: a descriptor registry (core + provider
 * settings) resolved against the `config` DB table with env fallback.
 * Resolution order: db value -> `envVar` (if set in the provided env
 * snapshot) -> descriptor default. Reads are live (per-request), so
 * `PUT /config` takes effect without a restart.
 */
export class ConfigStore {
  private registry = new Map<string, ConfigDescriptor>();

  constructor(
    private db: DB,
    private envValues: Record<string, string | undefined> = {},
  ) {
    this.register(CORE_DESCRIPTORS);
  }

  /** Merge descriptors into the registry (later registrations win on key). */
  register(descriptors: ConfigDescriptor[]): void {
    for (const d of descriptors) this.registry.set(d.key, d);
  }

  descriptor(key: string): ConfigDescriptor | undefined {
    return this.registry.get(key);
  }

  /** Resolve a key to its effective value + source. Throws on unknown keys. */
  resolve(key: string): { value: unknown; source: ConfigSource } {
    const descriptor = this.registry.get(key);
    if (!descriptor) throw badRequest(`Unknown config key: ${key}`);

    const row = this.db
      .select()
      .from(configTable)
      .where(eq(configTable.key, key))
      .get();
    if (row) {
      try {
        return { value: JSON.parse(row.value), source: 'db' };
      } catch {
        /* corrupt row: fall through to env/default */
      }
    }
    if (descriptor.envVar !== undefined) {
      const raw = this.envValues[descriptor.envVar];
      // A DEFINED-BUT-EMPTY env var is not configuration. `compose.yaml` forwards
      // keys as `${VAR:-}`, which defines every one of them even when the operator
      // set nothing — so `''` must read as unset and fall through to the default,
      // or an untouched instance reports `source: 'env'` (and, for a secret, a
      // mask) for a key that was never configured.
      if (raw !== undefined && raw !== '') {
        return { value: parseEnvValue(descriptor, raw), source: 'env' };
      }
    }
    return { value: descriptor.default, source: 'default' };
  }

  /** Effective (unmasked) value — for server-side use. */
  get(key: string): unknown {
    return this.resolve(key).value;
  }

  getBoolean(key: string): boolean {
    return this.get(key) === true;
  }

  getStringArray(key: string): string[] {
    const v = this.get(key);
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
  }

  /** All entries for the wire (`GET /config`); secret values are masked. */
  entries(): ConfigEntry[] {
    return [...this.registry.values()].map((descriptor) => {
      const { value, source } = this.resolve(descriptor.key);
      // Only a secret that actually HOLDS something is masked; an empty one is
      // reported as empty, so the wire never implies a key is configured when it
      // is not (the mask is the UI's "a secret lives here" signal).
      const masked = descriptor.secret && value !== '';
      return {
        descriptor,
        value: masked ? SECRET_MASK : value,
        source,
      };
    });
  }

  /**
   * Validate + upsert a `{ key: value }` map (`PUT /config`). Unknown keys
   * and type mismatches are `bad_request`; nothing is written on failure.
   */
  put(values: Record<string, unknown>): ConfigEntry[] {
    const now = new Date().toISOString();
    const writes: { key: string; value: string }[] = [];
    for (const [key, value] of Object.entries(values)) {
      const descriptor = this.registry.get(key);
      if (!descriptor) throw badRequest(`Unknown config key: ${key}`);
      if (!typeMatches(descriptor, value)) {
        throw badRequest(`Invalid value type for ${key}: expected ${descriptor.type}`);
      }
      writes.push({ key, value: JSON.stringify(value) });
    }
    for (const w of writes) {
      this.db
        .insert(configTable)
        .values({ key: w.key, value: w.value, updatedAt: now })
        .onConflictDoUpdate({
          target: configTable.key,
          set: { value: w.value, updatedAt: now },
        })
        .run();
    }
    return this.entries();
  }
}
