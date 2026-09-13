/**
 * Sync state, and the two controls that act on it.
 *
 * Exists because the mirror is silent by design: a failed background push
 * only warns to the console, so without a surface here a user whose backup
 * stopped working would have no way to find out.
 */
import { useState } from 'react';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useAuth, signOut } from '@/lib/supabase/useAuth';
import { isSupabaseConfigured } from '@/lib/supabase/client';
import { syncAll } from '@/lib/supabase/sync';
import { mirrorStatus, clearMirrorFailures } from '@/lib/db/mirror';

export function CloudSyncCard() {
  const { user } = useAuth();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  // Read at render rather than subscribed to: the count only changes on a
  // background failure, and a re-render here is not worth a subscription.
  const status = mirrorStatus();

  if (!isSupabaseConfigured) {
    return (
      <Card>
        <CardHeader title="Cloud sync" />
        <CardBody>
          <p className="text-sm text-text-muted">
            Not configured. Set <code>VITE_SUPABASE_URL</code> and{' '}
            <code>VITE_SUPABASE_PUBLISHABLE_KEY</code> in <code>client/.env</code> to sync
            across devices. Your data stays on this device until then.
          </p>
        </CardBody>
      </Card>
    );
  }

  async function handleSync() {
    setBusy(true);
    setMessage(null);
    setFailed(false);
    try {
      const result = await syncAll();
      clearMirrorFailures();
      const pulled =
        result.pulled.transactions + result.pulled.budget + result.pulled.snapshots;
      const pushed =
        result.pushed.transactions + result.pushed.budget + result.pushed.snapshots;
      setMessage(`Synced. ${pulled} row(s) pulled, ${pushed} pushed.`);
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : 'Sync failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader title="Cloud sync" />
      <CardBody>
        <div className="space-y-3">
          <p className="text-sm text-text-muted">
            Signed in as <span className="text-text">{user?.email}</span>
          </p>

          {status.pendingFailures > 0 && (
            <p className="text-sm text-negative" role="alert">
              {status.pendingFailures} change(s) did not reach the cloud. They are safe on
              this device — sync to send them.
            </p>
          )}

          {message && (
            <p
              className={failed ? 'text-sm text-negative' : 'text-sm text-text-muted'}
              role="status"
            >
              {message}
            </p>
          )}

          <div className="flex gap-2">
            <Button onClick={handleSync} disabled={busy}>
              {busy ? 'Syncing…' : 'Sync now'}
            </Button>
            <Button variant="ghost" onClick={() => void signOut()} disabled={busy}>
              Sign out
            </Button>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}
