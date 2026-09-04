import { useState } from 'react';
import { Check, Copy, WifiOff } from 'lucide-react';

/**
 * The copy-pasteable instruction a human sends TO their agent to bring it online.
 * Kept as ONE exported constant so the notice, its tests, and any future
 * alignment with the CLI (`sparrow watch` / `sparrow inbox`) all share a single source
 * of truth. Adjust wording here only.
 */
export const AGENT_WAKE_INSTRUCTIONS =
  "You're enrolled on sparrow. Start listening now: run `sparrow watch` and keep it " +
  'running, handle each message as it arrives, and check `sparrow inbox` for anything ' +
  'you missed.';

/**
 * Ephemeral, client-side ONLY system notice shown in a DM with an AI agent that
 * is enrolled but not currently online (not tailing its message loop). It is not
 * a persisted message — it renders purely from live presence and vanishes the
 * moment the agent comes online. It explains the situation and offers a copyable
 * instruction block the human can paste to their agent to wake it.
 */
export function AgentOfflineNotice({ agentName }: { agentName: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(AGENT_WAKE_INSTRUCTIONS);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard denied/unavailable — the text is still on screen to copy by hand.
    }
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="mx-auto w-full max-w-[80%] rounded-lg border border-dashed border-[var(--sparrow-border-strong)] bg-[var(--sparrow-panel-2)] px-3 py-2.5 text-xs text-[var(--sparrow-muted)]"
    >
      <div className="flex items-start gap-2">
        <WifiOff size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--sparrow-faint)]" />
        <div className="min-w-0 flex-1">
          <p>
            <span className="font-medium text-[var(--sparrow-text)]">{agentName} isn&rsquo;t listening yet.</span>{' '}
            It&rsquo;s enrolled, but it needs to run its message loop to come online.
          </p>
          <div className="mt-2 flex items-stretch gap-2">
            <code className="mono min-w-0 flex-1 whitespace-pre-wrap break-words rounded border border-[var(--sparrow-border)] bg-[var(--sparrow-panel)] px-2 py-1.5 text-[11px] leading-relaxed text-[var(--sparrow-text)]">
              {AGENT_WAKE_INSTRUCTIONS}
            </code>
            <button
              type="button"
              onClick={() => void copy()}
              aria-label={copied ? 'Instructions copied' : 'Copy instructions for your agent'}
              className="inline-flex shrink-0 items-center gap-1 self-start rounded-md border border-[var(--sparrow-border-strong)] px-2 py-1 font-medium text-[var(--sparrow-muted)] transition-colors hover:border-[var(--sparrow-accent)] hover:text-[var(--sparrow-accent)]"
            >
              {copied ? (
                <>
                  <Check size={13} aria-hidden="true" /> Copied
                </>
              ) : (
                <>
                  <Copy size={13} aria-hidden="true" /> Copy
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
