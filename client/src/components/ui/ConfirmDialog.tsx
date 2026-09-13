/**
 * Confirmation modal — the replacement for `window.confirm`.
 *
 * Native dialogs were wrong here for three reasons: they are chrome-styled and
 * ignore the app's theme entirely, they leak the origin ("localhost:5173 says")
 * into what should be product copy, and on some platforms they can be
 * suppressed by the browser, which would silently skip a destructive
 * confirmation rather than block it.
 *
 * Mirrors ImportDialog's structure so modals in this app behave consistently:
 * backdrop click and Escape both dismiss, focus is trapped while open, and the
 * surface stops click propagation so an inner click never dismisses.
 */
import { useEffect, useRef } from 'react';
import { TriangleAlert } from 'lucide-react';
import { Button } from './Button';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** Main body copy. Rendered as-is, so keep it a plain sentence. */
  message: string;
  /** Optional second line for consequences, e.g. "This cannot be undone." */
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Styles the confirm button as destructive and shows a warning icon. */
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  detail,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);

  // Escape closes, and Tab is trapped inside the dialog. Without the trap,
  // tabbing walks into the page behind the backdrop, where clicks are blocked
  // but keyboard focus is not — the modal would only *look* modal.
  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = surfaceRef.current?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable || focusable.length === 0) return;

      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;

      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onCancel]);

  // Focus the confirm button on open so the dialog is immediately keyboard
  // operable, matching what `window.confirm` did.
  useEffect(() => {
    if (open) confirmRef.current?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
      onClick={onCancel}
      role="presentation"
    >
      <div
        ref={surfaceRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-message"
        className="w-full max-w-md rounded-t-2xl border border-border bg-surface p-5 shadow-xl sm:rounded-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          {destructive ? (
            <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-negative/10">
              <TriangleAlert className="size-4 text-negative" />
            </span>
          ) : null}
          <div className="min-w-0">
            <h2 id="confirm-title" className="text-base font-semibold text-text">
              {title}
            </h2>
            <p id="confirm-message" className="mt-1.5 text-sm text-text-muted">
              {message}
            </p>
            {detail ? <p className="mt-2 text-xs text-text-subtle">{detail}</p> : null}
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button
            ref={confirmRef}
            variant={destructive ? 'danger' : 'primary'}
            size="sm"
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
