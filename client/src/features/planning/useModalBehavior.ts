/**
 * Escape-to-close and focus trapping for the planning dialogs.
 *
 * `ConfirmDialog` already does both, but its implementation is welded to its
 * own props. Rather than duplicate the logic in two more dialogs, this pulls
 * out the part they share.
 *
 * The trap is the load-bearing half. Without it, Tab walks focus into the page
 * behind the backdrop — where clicks are blocked but keyboard focus is not —
 * so the dialog would only *look* modal to anyone navigating by keyboard.
 */
import { useEffect, type RefObject } from 'react';

/** Everything focusable, in DOM order, excluding anything explicitly skipped. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useModalBehavior(
  surfaceRef: RefObject<HTMLElement | null>,
  onClose: () => void,
): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const surface = surfaceRef.current;
      if (!surface) return;

      const focusable = [...surface.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        // A hidden or collapsed control is in the DOM but not reachable, and
        // including it would send focus somewhere invisible.
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;

      // Wrap at both ends so focus cycles inside the dialog rather than
      // escaping to the document.
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [surfaceRef, onClose]);

  // Lock the page behind the dialog. Restores whatever was there rather than
  // assuming `visible`, so nesting or a page that sets its own overflow is
  // not clobbered.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);
}
