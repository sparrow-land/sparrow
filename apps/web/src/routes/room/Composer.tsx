import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { File as FileIcon, Paperclip, X } from 'lucide-react';
import type { SuggestedReply } from '@sparrow/common-types';
import { MicButton, type HandsFreeWiring } from './MicButton.js';
import { formatBytes, isImageAttachment, type PendingAttachment } from '../../lib/attachments.js';

/** Pull `File`s out of a paste/drop DataTransfer (files list, else file items). */
function filesFromDataTransfer(dt: DataTransfer | null | undefined): File[] {
  if (!dt) return [];
  const out: File[] = [];
  if (dt.files && dt.files.length > 0) {
    for (let i = 0; i < dt.files.length; i += 1) {
      const f = dt.files.item ? dt.files.item(i) : dt.files[i];
      if (f) out.push(f);
    }
  } else if (dt.items && dt.items.length > 0) {
    for (let i = 0; i < dt.items.length; i += 1) {
      const it = dt.items[i];
      if (it && it.kind === 'file') {
        const f = it.getAsFile();
        if (f) out.push(f);
      }
    }
  }
  return out;
}

/** Whether a drag carries files (so we only highlight/accept file drags). */
function dragHasFiles(dt: DataTransfer | null | undefined): boolean {
  if (!dt) return false;
  if (dt.files && dt.files.length > 0) return true;
  if (dt.items) {
    for (let i = 0; i < dt.items.length; i += 1) {
      if (dt.items[i]?.kind === 'file') return true;
    }
  }
  const types = dt.types as unknown as string[] | undefined;
  return Array.isArray(types) ? types.includes('Files') : false;
}

/**
 * Autosize bounds for the composer textarea. The minimum keeps the resting
 * ~2-line height; the maximum (~10 lines) is where it stops growing and starts
 * scrolling internally. In px so it works without reading computed styles.
 */
export const COMPOSER_MIN_HEIGHT_PX = 56;
export const COMPOSER_MAX_HEIGHT_PX = 240;

/**
 * Pure autosize clamp: given the textarea's natural content height
 * (`scrollHeight`), return the height to apply and whether to scroll
 * internally. Clamped to [min, max]; overflow becomes scrollable only once the
 * content exceeds the max.
 */
export function nextComposerHeight(scrollHeight: number): {
  height: number;
  overflowY: 'auto' | 'hidden';
} {
  const clamped = Math.min(
    Math.max(scrollHeight, COMPOSER_MIN_HEIGHT_PX),
    COMPOSER_MAX_HEIGHT_PX,
  );
  return { height: clamped, overflowY: scrollHeight > COMPOSER_MAX_HEIGHT_PX ? 'auto' : 'hidden' };
}

/** A structured reply echo attached to a chip-sent message. */
export interface ReplyEcho {
  inReplyTo: string;
  replyValue: string;
}

type NavLike = { platform?: string; userAgent?: string };

/** Whether we're on a Mac (⌘) vs. a Ctrl-based platform. Testable via an injected nav. */
export function isMac(nav: NavLike = navigator): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(`${nav.platform ?? ''} ${nav.userAgent ?? ''}`);
}

/** The composer-hotkey modifier label for the current platform. */
export function modKeyLabel(nav: NavLike = navigator): string {
  return isMac(nav) ? '⌘' : 'Ctrl';
}

/**
 * The conversation composer: the suggested-reply chips (v6), the textarea, an
 * inline send-error line, and the send row. Presentation + input handling only —
 * the actual `POST /message` lives in the Room view and arrives via `onSend`.
 *
 * `onSend()` with no args sends the current draft (Enter, or the Send button); a
 * chip passes its label as `body` plus the structured `reply` echo, leaving the
 * draft untouched. Chips render only while `suggestions` is set AND the composer
 * is enabled.
 */
export function Composer({
  value,
  onChange,
  onSend,
  onDraft,
  onOpenDrafts,
  draftCount,
  canCompose,
  sending,
  sendError,
  placeholder,
  suggestions,
  handsFree,
  attachments = [],
  onAddFiles,
  onRemoveAttachment,
  attachmentError = null,
  autoFocus = false,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: (body?: string, reply?: ReplyEcho) => void;
  /** Enqueue the current composer text as a draft (Cmd/Ctrl+Enter, Draft button). */
  onDraft: () => void;
  /** Open the drafts list (Cmd/Ctrl+Shift+Enter, or the count link). */
  onOpenDrafts: () => void;
  draftCount: number;
  canCompose: boolean;
  sending: boolean;
  sendError: string | null;
  placeholder: string;
  suggestions: { messageId: string; options: SuggestedReply[] } | null;
  /**
   * Everything hands-free mode needs (voice v2). Present iff the room can host a
   * spoken turn; the composer forwards it opaquely to the mic and is otherwise
   * uninvolved — a voice turn never touches the draft or the staged files.
   */
  handsFree?: HandsFreeWiring;
  /** Files staged on the composer, awaiting send (rendered as removable chips). */
  attachments?: PendingAttachment[];
  /** Stage picked/pasted/dropped files (limit-checking lives in the owner). */
  onAddFiles?: (files: File[]) => void;
  /** Remove a staged attachment by its local id. */
  onRemoveAttachment?: (id: string) => void;
  /** Inline error from a rejected staging attempt (oversize / too many / too big). */
  attachmentError?: string | null;
  /**
   * Put the caret here as soon as the composer is usable — opening a
   * conversation should leave you ready to type, not three Tab stops away.
   * Opt-in: only the room view asks for it, and it yields to any element the
   * user has already focused (and to coarse-pointer devices, where stealing
   * focus pops the on-screen keyboard over the conversation).
   */
  autoFocus?: boolean;
}) {
  const canDraft = canCompose && !sending && value.trim().length > 0;
  // A send is allowed with text OR at least one staged attachment (empty-body
  // attachment-only sends are valid on the wire).
  const canSend = canCompose && !sending && (value.trim().length > 0 || attachments.length > 0);

  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const stageFrom = useCallback(
    (dt: DataTransfer | null | undefined): boolean => {
      const files = filesFromDataTransfer(dt);
      if (files.length > 0) onAddFiles?.(files);
      return files.length > 0;
    },
    [onAddFiles],
  );

  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    // Only intercept when the clipboard carries files (e.g. a screenshot). A plain
    // text paste has no files and falls through to the textarea untouched.
    if (stageFrom(e.clipboardData)) e.preventDefault();
  }

  function onDragOver(e: React.DragEvent) {
    if (!dragHasFiles(e.dataTransfer)) return;
    e.preventDefault();
    setDragging(true);
  }
  function onDragLeave() {
    setDragging(false);
  }
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    stageFrom(e.dataTransfer);
  }

  function onPickFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files ? Array.from(e.target.files) : [];
    if (files.length > 0) onAddFiles?.(files);
    // Reset so picking the same file again still fires a change.
    e.target.value = '';
  }

  // Auto-grow the textarea to fit its content: reset to `auto` to get the true
  // content height, then clamp between the resting min and the ~10-line max.
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const resize = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const prevHeight = ta.style.height;
    ta.style.height = 'auto';
    const scrollHeight = ta.scrollHeight;
    // A `scrollHeight` of 0 means the box isn't laid out yet — on a client-side
    // room switch the composer remounts before width/fonts settle. Restore and
    // wait for a later ResizeObserver/rAF pass rather than locking in a bogus
    // small height with hidden overflow (the "truncated composer" bug).
    if (scrollHeight <= 0) {
      ta.style.height = prevHeight;
      return;
    }
    const { height, overflowY } = nextComposerHeight(scrollHeight);
    ta.style.height = `${height}px`;
    ta.style.overflowY = overflowY;
  }, []);

  // Re-measure on every value change so the composer grows while typing and
  // shrinks back after send/clear.
  useLayoutEffect(() => {
    resize();
  }, [value, resize]);

  // Robust re-measure independent of `value`. Because Room is keyed by roomId,
  // switching rooms REMOUNTS the composer with the same (usually empty) draft —
  // so the value-keyed pass above may run before layout/fonts settle and never
  // fire again. A post-paint rAF fixes the first frame; a ResizeObserver catches
  // every later box change (font load, width/reflow) so the height is never
  // stuck truncated.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const raf = requestAnimationFrame(() => resize());
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => resize());
      ro.observe(ta);
    }
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  }, [resize]);

  // FOCUS REPAIR after the send-cycle disable (prod bug, 2026-09-02): the
  // textarea is disabled while a send is in flight, and real browsers BLUR a
  // focused element the moment it becomes disabled (jsdom doesn't — which is
  // why tests alone missed this). Without repair, every Enter-to-send dumps
  // focus onto <body>, and the Escape → clawback hotkey (scope 'composer':
  // live only while focus is inside the composer) goes dead in exactly its
  // "hit Enter, regret it, hit Escape" moment. A native blur listener marks
  // blurs whose cause is the disable itself (`disabled` is already true when
  // the browser fires them); when the textarea re-enables, focus is restored —
  // but only if nothing else took focus meanwhile, so a modal or a
  // deliberately-focused control is never robbed.
  const disabled = !canCompose || sending;
  const refocusOnEnableRef = useRef(false);
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const onBlur = () => {
      if (ta.disabled) refocusOnEnableRef.current = true;
    };
    ta.addEventListener('blur', onBlur);
    return () => ta.removeEventListener('blur', onBlur);
  }, []);
  useEffect(() => {
    if (disabled || !refocusOnEnableRef.current) return;
    refocusOnEnableRef.current = false;
    const active = document.activeElement;
    if (!active || active === document.body) textareaRef.current?.focus();
  }, [disabled]);

  // OPEN-TO-TYPE (issue #47): a conversation that opens with focus still in the
  // sidebar costs three Tab presses before the first keystroke. Fires once per
  // mount — Room is keyed by roomId, so switching conversations remounts this —
  // and only when the composer is actually usable (`self` has loaded, the room
  // isn't archived). Two guards keep it from being rude: it never takes focus
  // away from something the user already put it in, and it stays out of the way
  // on touch devices, where focusing a textarea throws up the keyboard and eats
  // half the conversation.
  const didAutoFocusRef = useRef(false);
  useEffect(() => {
    if (!autoFocus || disabled || didAutoFocusRef.current) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    if (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches) {
      return;
    }
    didAutoFocusRef.current = true;
    textareaRef.current?.focus();
  }, [autoFocus, disabled]);

  function onComposeKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== 'Enter') return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.shiftKey) {
      e.preventDefault();
      onOpenDrafts();
      return;
    }
    if (mod) {
      e.preventDefault();
      if (canDraft) onDraft();
      return;
    }
    if (!e.shiftKey) {
      e.preventDefault();
      onSend();
    }
    // Shift+Enter falls through → newline.
  }

  return (
    <>
      {suggestions && canCompose && (
        <div
          className="flex flex-wrap gap-2 border-t border-[var(--sparrow-border)] px-3 pt-3"
          aria-label="Suggested replies"
        >
          {suggestions.options.map((opt, i) => (
            <button
              key={`${opt.value}-${i}`}
              type="button"
              disabled={sending}
              onClick={() =>
                onSend(opt.label, { inReplyTo: suggestions.messageId, replyValue: opt.value })
              }
              className="inline-flex min-h-[40px] items-center rounded-full border border-[var(--sparrow-border)] bg-[var(--sparrow-panel)] px-4 py-2 text-sm transition-colors hover:border-[var(--sparrow-accent)] hover:text-[var(--sparrow-accent)] disabled:opacity-50"
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}

      <div
        data-testid="composer-dropzone"
        data-dragging={dragging}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={`border-t px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] ${
          dragging ? 'border-[var(--sparrow-accent)] bg-[var(--sparrow-accent-soft)]' : 'border-[var(--sparrow-border)]'
        }`}
      >
        {attachments.length > 0 && (
          <ul className="mb-2 flex flex-wrap gap-2" aria-label="Attachments">
            {attachments.map((a) => (
              <AttachmentChip key={a.id} att={a} onRemove={() => onRemoveAttachment?.(a.id)} />
            ))}
          </ul>
        )}
        <textarea
          ref={textareaRef}
          id="compose"
          name="compose"
          // Opts this textarea into the 'composer' hotkey scope (lib/hotkeys):
          // composer-scoped bindings (Escape → clawback) fire only while focus
          // is here.
          data-hotkey-scope="composer"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onComposeKey}
          onPaste={onPaste}
          rows={2}
          disabled={disabled}
          placeholder={placeholder}
          className="block w-full max-w-full resize-none rounded border border-[var(--sparrow-border)] bg-[var(--sparrow-bg)] px-3 py-2 text-sm outline-none focus:border-[var(--sparrow-accent)] disabled:opacity-50"
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={onPickFiles}
          className="hidden"
          aria-hidden="true"
          tabIndex={-1}
        />
        {attachmentError && (
          <p role="alert" className="mt-1 text-xs text-[var(--sparrow-danger)]">
            {attachmentError}
          </p>
        )}
        {sendError && (
          <p role="alert" className="mt-1 text-xs text-[var(--sparrow-danger)]">
            Couldn’t send: {sendError}
          </p>
        )}
        <div className="mt-1 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {/* Decorative hotkey hint — the hotkeys work regardless. Hidden on
                narrow (phone) widths where it only crowds the controls. */}
            <span aria-hidden="true" className="hidden truncate text-xs text-[var(--sparrow-muted)] sm:inline">
              Enter to send · Shift+Enter for newline · {modKeyLabel()}+Enter to draft · Esc pulls
              back your last message
            </span>
            {draftCount > 0 && (
              <button
                type="button"
                onClick={onOpenDrafts}
                className="shrink-0 text-xs font-medium text-[var(--sparrow-accent)] transition-colors hover:underline"
              >
                Drafts ({draftCount})
              </button>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={!canCompose || sending}
              aria-label="Attach files"
              title="Attach files"
              className="rounded border border-[var(--sparrow-border-strong)] p-1.5 text-[var(--sparrow-muted)] transition-colors hover:border-[var(--sparrow-accent)] hover:text-[var(--sparrow-accent)] disabled:opacity-50"
            >
              <Paperclip size={16} aria-hidden="true" />
            </button>
            {handsFree && (
              <MicButton handsFree={handsFree} disabled={!canCompose || sending} />
            )}
            <button
              type="button"
              onClick={onDraft}
              disabled={!canDraft}
              title={`Queue as a draft (${modKeyLabel()}+Enter)`}
              className="rounded border border-[var(--sparrow-border-strong)] px-3 py-1.5 text-sm font-medium text-[var(--sparrow-muted)] transition-colors hover:border-[var(--sparrow-accent)] hover:text-[var(--sparrow-accent)] disabled:opacity-50"
            >
              Draft
            </button>
            <button
              onClick={() => onSend()}
              disabled={!canSend}
              className="rounded bg-[var(--sparrow-accent)] px-4 py-1.5 text-sm font-medium text-black disabled:opacity-50"
            >
              {sending ? 'Sending…' : 'Send'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * A single staged-attachment chip above the composer: an image thumbnail (via a
 * per-chip object URL, revoked on removal/unmount) or a file glyph, the truncated
 * filename + size, and a remove ×.
 */
function AttachmentChip({ att, onRemove }: { att: PendingAttachment; onRemove: () => void }) {
  const isImage = isImageAttachment(att.contentType, att.filename);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!isImage) return;
    const objectUrl = URL.createObjectURL(att.file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [att.file, isImage]);

  return (
    <li className="inline-flex min-w-0 max-w-[12rem] items-center gap-2 rounded-md border border-[var(--sparrow-border)] bg-[var(--sparrow-panel-2)] py-1 pl-1 pr-1.5 text-xs">
      {isImage && url ? (
        <img src={url} alt={att.filename} className="h-8 w-8 shrink-0 rounded object-cover" />
      ) : (
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-[var(--sparrow-panel)] text-[var(--sparrow-muted)]">
          <FileIcon size={16} aria-hidden="true" />
        </span>
      )}
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="min-w-0 truncate">{att.filename}</span>
        <span className="text-[var(--sparrow-muted)]">{formatBytes(att.size)}</span>
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${att.filename}`}
        className="ml-auto shrink-0 rounded p-0.5 text-[var(--sparrow-muted)] transition-colors hover:text-[var(--sparrow-text)]"
      >
        <X size={14} aria-hidden="true" />
      </button>
    </li>
  );
}
