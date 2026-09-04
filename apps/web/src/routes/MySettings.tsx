import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Check, Monitor, Moon, Sun, type LucideIcon } from 'lucide-react';
import {
  AVATAR_MAX_BYTES,
  AVATAR_CONTENT_TYPES,
  type MeOrg,
  type ThemePreference,
} from '@sparrow/common-types';
import { ApiError } from '@sparrow/client';
import { api, updateMe, uploadAvatar, deleteAvatar } from '../lib/client.js';
import { useAuth } from '../lib/auth.js';
import { useTheme } from '../lib/theme-provider.js';
import { readAvatarUrl } from '../lib/avatar.js';
import { Avatar } from '../components/Avatar.js';
import { orgPath } from '../lib/ids.js';
import { useDocumentTitle, pageTitle } from '../lib/title.js';

/**
 * My settings (`/me/settings`) — the personal account/membership surface. It
 * renders INSIDE the app shell (see `MeLayout` in App.tsx), so this page
 * contributes only its own content column, not any page chrome.
 *
 * User-specific settings only: the account (editable display name; read-only
 * email + provider) and the caller's org memberships (role + Leave). All copy is
 * written for a non-technical human — plain language, never route names.
 */
export function MySettings() {
  const auth = useAuth();
  useDocumentTitle(pageTitle('Your settings'));

  if (!auth.user) {
    return (
      <Frame>
        <Header
          title="Your settings"
          subtitle="Manage your account and the organizations you belong to."
        />
        <Notice title="Sign in to see your settings">
          You need to be signed in to manage your account.{' '}
          <Link
            to="/login?next=/me/settings"
            className="font-medium text-[var(--sparrow-accent)] underline-offset-2 hover:underline"
          >
            Sign in
          </Link>
          .
        </Notice>
      </Frame>
    );
  }

  return (
    <Frame>
      <Header
        title="Your settings"
        subtitle="Manage your account and the organizations you belong to."
      />
      <div className="flex flex-col gap-8">
        <AccountSection />
        <AppearanceSection />
        <AvatarSection />
        <OrganizationsSection />
      </div>
    </Frame>
  );
}

/* -------------------------------------------------------------------------- */
/* Account                                                                    */
/* -------------------------------------------------------------------------- */

/** Friendly names for the known sign-in providers; unknowns show verbatim. */
const PROVIDER_LABELS: Record<string, string> = {
  password: 'a password',
  google: 'Google',
};

function AccountSection() {
  const auth = useAuth();
  const user = auth.user!;
  const [name, setName] = useState(user.displayName);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();
  const dirty = trimmed.length > 0 && trimmed !== user.displayName;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!dirty || busy) return;
    const previous = user;
    setBusy(true);
    setSaved(false);
    setError(null);
    // Optimistic: update the local user immediately so the top-nav chip and
    // every "you" surface reflect the new name before the server answers.
    auth.updateUser({ ...previous, displayName: trimmed });
    try {
      const principal = await updateMe({ displayName: trimmed });
      // Trust the server's canonical value (it trims / normalizes). PATCH /me is
      // a human session, so the principal is always a human.
      const canonical = principal.type === 'human' ? principal.displayName : trimmed;
      auth.updateUser({ ...previous, displayName: canonical });
      setName(canonical);
      setSaved(true);
    } catch (err) {
      // Revert to the name we had before the optimistic write.
      auth.updateUser(previous);
      setName(previous.displayName);
      setError(err instanceof ApiError ? err.message : 'Couldn’t save your name. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const providerLabel = PROVIDER_LABELS[user.provider] ?? user.provider;

  return (
    <Section title="Account" description="Your name and how you sign in.">
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <div>
          <label htmlFor="display-name" className="block text-sm font-medium">
            Display name
          </label>
          <p className="mt-1 text-xs text-[var(--sparrow-muted)]">
            This is how you appear to everyone in your rooms.
          </p>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <input
              id="display-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setSaved(false);
                setError(null);
              }}
              autoComplete="name"
              className="min-h-[40px] flex-1 rounded-md border border-[var(--sparrow-border)] bg-[var(--sparrow-bg)] px-3 py-2.5 text-sm outline-none transition-colors placeholder:text-[var(--sparrow-faint)] focus:border-[var(--sparrow-accent)]"
            />
            <button
              type="submit"
              disabled={!dirty || busy}
              className="min-h-[40px] rounded-md bg-[var(--sparrow-accent)] px-4 py-2.5 text-sm font-semibold text-black transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
          {saved && !dirty && (
            <p className="mt-2 text-sm text-[var(--sparrow-good)]" role="status">
              <Check size={14} strokeWidth={2.5} aria-hidden="true" className="mr-1 inline align-[-2px]" />
              Saved
            </p>
          )}
          {error && (
            <p className="mt-2 text-sm text-[var(--sparrow-danger)]" role="alert">
              {error}
            </p>
          )}
        </div>

        <ReadOnlyRow label="Email" value={user.email} />
        <ReadOnlyRow label="Sign-in" value={`You’re signed in with ${providerLabel}.`} />
      </form>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* Appearance (theme)                                                         */
/* -------------------------------------------------------------------------- */

const THEME_OPTIONS: { value: ThemePreference; label: string; hint: string; icon: LucideIcon }[] = [
  { value: 'auto', label: 'Auto', hint: 'Match your device', icon: Monitor },
  { value: 'light', label: 'Light', hint: 'Always light', icon: Sun },
  { value: 'dark', label: 'Dark', hint: 'Always dark', icon: Moon },
];

function AppearanceSection() {
  const { theme, setTheme } = useTheme();

  return (
    <Section title="Appearance" description="Choose how sparrow looks on this and your other devices.">
      <fieldset>
        <legend className="sr-only">Theme</legend>
        <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-2">
          {THEME_OPTIONS.map((opt) => {
            const selected = theme === opt.value;
            const Icon = opt.icon;
            return (
              <button
                key={opt.value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setTheme(opt.value)}
                className={`flex min-h-[40px] flex-col items-center gap-1.5 rounded-lg border px-3 py-3 text-center transition-colors ${
                  selected
                    ? 'border-[var(--sparrow-accent)] bg-[var(--sparrow-accent-soft)] text-[var(--sparrow-text)]'
                    : 'border-[var(--sparrow-border)] bg-[var(--sparrow-bg)] text-[var(--sparrow-muted)] hover:border-[var(--sparrow-border-strong)] hover:text-[var(--sparrow-text)]'
                }`}
              >
                <Icon size={18} strokeWidth={1.75} aria-hidden="true" />
                <span className="text-sm font-medium">{opt.label}</span>
                <span className="text-xs text-[var(--sparrow-faint)]">{opt.hint}</span>
              </button>
            );
          })}
        </div>
      </fieldset>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* Avatar                                                                     */
/* -------------------------------------------------------------------------- */

const AVATAR_MAX_MB = Math.round(AVATAR_MAX_BYTES / (1024 * 1024));

function AvatarSection() {
  const auth = useAuth();
  const user = auth.user!;
  const inputRef = useRef<HTMLInputElement>(null);
  // `null` → show the server's current avatar; `{ url }` → a local override after
  // an upload (object URL) or removal (null). Kept local so the preview updates
  // instantly without a User-type field.
  const [override, setOverride] = useState<{ url: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const previewUrl = override ? override.url : readAvatarUrl(user);

  async function onPick(file: File) {
    setError(null);
    if (!(AVATAR_CONTENT_TYPES as readonly string[]).includes(file.type)) {
      setError('Please choose a PNG, JPEG, or WebP image.');
      return;
    }
    if (file.size > AVATAR_MAX_BYTES) {
      setError(`That image is larger than ${AVATAR_MAX_MB} MB. Please choose a smaller one.`);
      return;
    }
    setBusy(true);
    try {
      const returned = await uploadAvatar(file);
      // Prefer the server's canonical URL; otherwise preview the picked bytes so
      // the change is visible immediately.
      setOverride({ url: returned ?? URL.createObjectURL(file) });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Couldn’t upload that image. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function onRemove() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // The server returns the effective avatar after clearing (provider photo →
      // gravatar → null); reflect it so a fallback image still shows.
      const url = await deleteAvatar();
      setOverride({ url });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Couldn’t remove your photo. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Photo" description="A picture shown next to your name across your rooms.">
      <div className="flex flex-wrap items-center gap-4">
        <Avatar
          kind="human"
          id={user.id}
          displayName={user.displayName}
          avatarUrl={previewUrl}
          size={64}
        />
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <input
              ref={inputRef}
              type="file"
              accept={AVATAR_CONTENT_TYPES.join(',')}
              className="hidden"
              aria-label="Choose a photo"
              onChange={(e) => {
                const file = e.target.files?.[0];
                // Reset so re-picking the same file fires onChange again.
                e.target.value = '';
                if (file) void onPick(file);
              }}
            />
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={busy}
              className="min-h-[40px] rounded-md bg-[var(--sparrow-accent)] px-4 py-2 text-sm font-semibold text-black transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {busy ? 'Uploading…' : previewUrl ? 'Change photo' : 'Upload photo'}
            </button>
            {previewUrl && (
              <button
                type="button"
                onClick={() => void onRemove()}
                disabled={busy}
                className="min-h-[40px] rounded-md border border-[var(--sparrow-border-strong)] bg-[var(--sparrow-panel-2)] px-4 py-2 text-sm font-medium text-[var(--sparrow-text)] transition-colors hover:border-[var(--sparrow-danger)] hover:text-[var(--sparrow-danger)] disabled:opacity-50"
              >
                Remove
              </button>
            )}
          </div>
          <p className="text-xs text-[var(--sparrow-muted)]">
            PNG, JPEG, or WebP, up to {AVATAR_MAX_MB} MB. Without a photo, we show a generated one.
          </p>
          {error && (
            <p className="text-sm text-[var(--sparrow-danger)]" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
    </Section>
  );
}

function ReadOnlyRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="block text-sm font-medium">{label}</div>
      <p className="mt-1 text-sm text-[var(--sparrow-muted)]">{value}</p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Organizations                                                              */
/* -------------------------------------------------------------------------- */

const ROLE_LABELS: Record<MeOrg['role'], string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
};

function OrganizationsSection() {
  const auth = useAuth();

  return (
    <Section
      title="Organizations"
      description="The organizations you belong to, and your role in each."
    >
      {auth.orgs.length === 0 ? (
        <p className="text-sm text-[var(--sparrow-muted)]">You’re not in any organizations yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {auth.orgs.map((membership) => (
            <OrgRow key={membership.org.id} membership={membership} />
          ))}
        </ul>
      )}
    </Section>
  );
}

function OrgRow({ membership }: { membership: MeOrg }) {
  const auth = useAuth();
  const { org, role } = membership;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function leave() {
    if (busy || !auth.user) return;
    setBusy(true);
    setError(null);
    try {
      await api.removeOrgHuman(org.id, auth.user.id);
      await auth.refreshOrgs(); // drops this row
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Last owner, or still owns agents — the server explains; fall back to
        // the most common case so the user always sees a next step.
        setError(
          err.message ||
            'You’re the only owner — make someone else an owner first.',
        );
      } else {
        setError(
          err instanceof ApiError ? err.message : 'Couldn’t leave right now. Try again.',
        );
      }
      setBusy(false);
    }
  }

  return (
    <li className="rounded-xl border border-[var(--sparrow-border)] bg-[var(--sparrow-panel)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <Link
            to={orgPath(org.id)}
            className="text-sm font-semibold text-[var(--sparrow-text)] underline-offset-2 hover:underline"
          >
            {org.name}
          </Link>
          <p className="mt-0.5 text-xs text-[var(--sparrow-muted)]">{ROLE_LABELS[role]}</p>
        </div>
        <button
          type="button"
          onClick={() => void leave()}
          disabled={busy}
          className="min-h-[40px] rounded-md border border-[var(--sparrow-border-strong)] bg-[var(--sparrow-panel-2)] px-4 py-2 text-sm font-medium text-[var(--sparrow-text)] transition-colors hover:border-[var(--sparrow-danger)] hover:text-[var(--sparrow-danger)] disabled:opacity-50"
        >
          {busy ? 'Leaving…' : 'Leave'}
        </button>
      </div>
      {error && (
        <p className="mt-3 text-sm text-[var(--sparrow-danger)]" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/* Chrome                                                                      */
/* -------------------------------------------------------------------------- */

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6">{children}</div>
    </div>
  );
}

function Header({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-6">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-1.5 text-sm text-[var(--sparrow-muted)]">{subtitle}</p>
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="mt-0.5 text-xs text-[var(--sparrow-muted)]">{description}</p>
      </div>
      <div className="rounded-xl border border-[var(--sparrow-border)] bg-[var(--sparrow-panel)] p-5">
        {children}
      </div>
    </section>
  );
}

function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-[var(--sparrow-border)] bg-[var(--sparrow-panel)] p-5">
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-[var(--sparrow-muted)]">{children}</p>
    </div>
  );
}
