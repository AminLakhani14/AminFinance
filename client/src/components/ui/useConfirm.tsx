/**
 * Promise-based confirmation, so a modal reads like `window.confirm` did.
 *
 * `window.confirm` blocks and returns a boolean, which lets a handler stay a
 * single linear function. A React modal cannot block, so without this hook
 * every call site has to be split into "open the dialog", "stash what was
 * being acted on", and "do the work in a separate callback" — three pieces of
 * state per confirmation, duplicated at each site.
 *
 * Instead this resolves a promise when the user answers:
 *
 *   if (await confirm({ title: 'Delete?', message: '...' })) await remove(id);
 *
 * Render `dialog` once in the component; it is null while nothing is pending.
 */
import { useCallback, useRef, useState } from 'react';
import { ConfirmDialog, type ConfirmDialogProps } from './ConfirmDialog';

type ConfirmOptions = Omit<ConfirmDialogProps, 'open' | 'onConfirm' | 'onCancel'>;

export function useConfirm(): {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  dialog: React.ReactNode;
} {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolveRef = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback((next: ConfirmOptions): Promise<boolean> => {
    // A second confirm while one is pending would strand the first promise
    // forever, leaving its caller suspended. Resolve it as declined.
    resolveRef.current?.(false);
    setOptions(next);
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
    });
  }, []);

  const settle = useCallback((result: boolean) => {
    resolveRef.current?.(result);
    resolveRef.current = null;
    setOptions(null);
  }, []);

  const dialog = options ? (
    <ConfirmDialog
      {...options}
      open
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  ) : null;

  return { confirm, dialog };
}
