import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';
import { agentToolAppliesWhen, agentToolHostName } from '../utils/agentToolSetting';

/**
 * One-time offer to turn on the `plannotator` agent tool on Pi and OpenCode 2,
 * where it is off by default. Plain on purpose: one headline, what the tool
 * lets the agent do, what it costs, and two buttons. Same shell as the other
 * first-run announcements (portal, z-[100], hand-rolled Escape + Tab wrap +
 * focus restore, backdrop dismiss, capture-phase keydown that swallows
 * Mod+Enter so a keystroke aimed here cannot approve a plan or post a review
 * behind it).
 *
 * Unlike those, it collects a decision, so it never dismisses itself while a
 * save is in flight, and it reports the outcome in place: a failed save shows
 * the server's reason and keeps both buttons; a successful one says when the
 * tool arrives and offers Done.
 *
 * LAST in each app's first-run dialog chain; the Apps gate rendering through
 * agentToolAnnouncementEligible and useFirstRunAnnouncementWindow.
 */

export type AgentToolOfferHost = 'pi' | 'opencode';

interface AgentToolAnnouncementDialogProps {
  readonly isOpen: boolean;
  /** The session's host; names the agent and when the change applies. */
  readonly host: AgentToolOfferHost;
  /**
   * "Turn it on": writes the setting (POST /api/config `{ agentTool: true }`).
   * Rejects with an Error whose message is shown. The App marks the offer
   * seen when it resolves.
   */
  readonly onTurnOn: () => Promise<void>;
  /** "Not now", Escape, the backdrop and Done: marks the offer seen and closes it. */
  readonly onDismiss: () => void;
}

type SaveState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'saved' }
  | { readonly kind: 'failed'; readonly message: string };

const SECONDARY_BUTTON_CLASS =
  'inline-flex min-h-9 items-center gap-2 rounded-lg border border-border bg-surface-0/40 px-3 text-sm font-medium text-foreground outline-none transition-colors motion-reduce:transition-none hover:bg-surface-1/70 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:cursor-not-allowed disabled:opacity-50';

const PRIMARY_BUTTON_CLASS =
  'min-h-9 rounded-lg bg-primary px-5 text-sm font-medium text-primary-foreground outline-none transition-opacity motion-reduce:transition-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:cursor-not-allowed disabled:opacity-50';

export function AgentToolAnnouncementDialog({
  isOpen,
  host,
  onTurnOn,
  onDismiss,
}: AgentToolAnnouncementDialogProps) {
  const notNowRef = useRef<HTMLButtonElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onDismissRef = useRef(onDismiss);
  const [save, setSave] = useState<SaveState>({ kind: 'idle' });
  const saveRef = useRef(save);
  saveRef.current = save;
  const mountedRef = useRef(true);
  const agent = agentToolHostName(host);

  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Never closed mid-save: the outcome has to be shown.
  const dismiss = useCallback(() => {
    if (saveRef.current.kind === 'saving') return;
    onDismissRef.current();
  }, []);

  const turnOn = useCallback(async () => {
    if (saveRef.current.kind === 'saving' || saveRef.current.kind === 'saved') return;
    setSave({ kind: 'saving' });
    try {
      await onTurnOn();
      if (mountedRef.current) setSave({ kind: 'saved' });
    } catch (error) {
      if (!mountedRef.current) return;
      setSave({
        kind: 'failed',
        message: error instanceof Error && error.message ? error.message : 'Could not save the setting.',
      });
    }
  }, [onTurnOn]);

  // Focus follows the outcome: Done once saved.
  useEffect(() => {
    if (save.kind === 'saved') doneRef.current?.focus();
  }, [save.kind]);

  useEffect(() => {
    if (!isOpen) return;

    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    // "Not now" takes focus, so a stray Enter or Space never changes a setting.
    notNowRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        dismiss();
        return;
      }
      // Both apps submit their decision on Mod+Enter from a window-level
      // handler; swallowing it here on the capture phase keeps a keystroke
      // aimed at this dialog from approving a plan or posting a review.
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.key !== 'Tab') return;

      const dialog = document.querySelector<HTMLElement>('[data-agent-tool-announcement-dialog]');
      const focusable = Array.from(
        dialog?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')
          ?? [],
      ).filter((element) => element.getAttribute('tabindex') !== '-1');
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, [isOpen, dismiss]);

  if (!isOpen) return null;

  const saving = save.kind === 'saving';
  const capabilities = [
    'Open a review on its own: a file, several files together, a code review of its changes, or its last message.',
    'Keep working while you review. Your decision comes back as a message.',
    `Ask this session works from those reviews: Ask AI questions go to ${agent}.`,
    'List and close the reviews it opened.',
  ];

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-background/90 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) dismiss();
      }}
    >
      <div
        data-agent-tool-announcement-dialog
        data-agent-tool-host={host}
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-tool-announcement-title"
        aria-describedby="agent-tool-announcement-description"
        className="flex max-h-[calc(100dvh-2rem)] w-full max-w-lg min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
      >
        <div className="min-h-0 overflow-y-auto px-5 py-5 sm:px-7 sm:py-6">
          <h2
            id="agent-tool-announcement-title"
            className="text-balance text-xl font-semibold tracking-tight sm:text-2xl"
          >
            Let {agent} open reviews itself
          </h2>
          <p
            id="agent-tool-announcement-description"
            className="mt-1 text-pretty text-sm leading-relaxed text-muted-foreground"
          >
            Plannotator can give {agent} a <span className="font-mono text-foreground">plannotator</span> tool.
            {save.kind === 'saved' ? '' : 'It is off for now. '}With it on, {agent} can:
          </p>

          <ul className="mt-4 space-y-2.5" data-agent-tool-capabilities>
            {capabilities.map((line) => (
              <li key={line} className="flex gap-2.5 text-sm leading-relaxed text-foreground">
                <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
                <span className="text-pretty">{line}</span>
              </li>
            ))}
          </ul>

          <p className="mt-4 text-pretty text-sm leading-relaxed text-muted-foreground" data-agent-tool-cost>
            Your <span className="font-mono">/plannotator-*</span> commands work either way. The tool adds
            about 780 tokens to every request, and you can turn it off again in Settings.
          </p>

          <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-3">
            {save.kind === 'saved' ? (
              <p
                role="status"
                data-agent-tool-status="saved"
                className="inline-flex min-w-0 items-center gap-2 text-sm text-foreground"
              >
                <span className="size-2 shrink-0 rounded-full bg-success" aria-hidden="true" />
                Turned on. It applies from {agentToolAppliesWhen(host)}.
              </p>
            ) : save.kind === 'failed' ? (
              <p
                role="alert"
                data-agent-tool-status="failed"
                className="inline-flex min-w-0 items-center gap-2 text-sm text-destructive"
              >
                <span className="size-2 shrink-0 rounded-full bg-destructive" aria-hidden="true" />
                {save.message}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                Applies from {agentToolAppliesWhen(host)}.
              </p>
            )}

            <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
              {save.kind === 'saved' ? (
                <button
                  ref={doneRef}
                  type="button"
                  onClick={() => onDismissRef.current()}
                  className={PRIMARY_BUTTON_CLASS}
                >
                  Done
                </button>
              ) : (
                <>
                  <button
                    ref={notNowRef}
                    type="button"
                    onClick={dismiss}
                    disabled={saving}
                    data-agent-tool-not-now
                    className={SECONDARY_BUTTON_CLASS}
                  >
                    Not now
                  </button>
                  <button
                    type="button"
                    onClick={() => void turnOn()}
                    disabled={saving}
                    aria-busy={saving}
                    data-agent-tool-turn-on
                    className={PRIMARY_BUTTON_CLASS}
                  >
                    {saving ? 'Turning on…' : save.kind === 'failed' ? 'Try again' : 'Turn it on'}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
