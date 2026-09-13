/**
 * Decides whether the app or the sign-in form renders.
 *
 * Also owns the first sync: signing in has to pull the cloud book into Dexie
 * *before* the views read it, or the user lands on an empty dashboard on a
 * new device and watches rows appear underneath them.
 *
 * When Supabase is unconfigured the gate is transparent. A clone with no
 * `.env` still runs, on local storage, exactly as it did before — which keeps
 * the cloud optional rather than required.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useAuth } from '@/lib/supabase/useAuth';
import { isSupabaseConfigured } from '@/lib/supabase/client';
import { syncAll } from '@/lib/supabase/sync';
import { clearMirrorFailures } from '@/lib/db/mirror';
import { SignInPanel } from './SignInPanel';

function FullScreenMessage({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-sunken">
      <p className="text-sm text-text-muted" role="status">
        {children}
      </p>
    </div>
  );
}

export function AuthGate({ children }: { children: ReactNode }) {
  const { user, isLoading } = useAuth();
  const [syncing, setSyncing] = useState(false);

  // Keyed by user id so a sign-out and sign-in as someone else syncs again,
  // while a token refresh — which re-runs this effect — does not.
  const syncedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!user || syncedFor.current === user.id) return;
    syncedFor.current = user.id;
    setSyncing(true);

    void syncAll()
      .then(clearMirrorFailures)
      .catch((error: unknown) => {
        // A failed sync is not a failed sign-in. The local book is intact and
        // usable; Settings offers a retry.
        console.warn('[sync] initial sync failed', error);
      })
      .finally(() => setSyncing(false));
  }, [user]);

  if (!isSupabaseConfigured) return <>{children}</>;
  if (isLoading) return <FullScreenMessage>Loading…</FullScreenMessage>;
  if (!user) return <SignInPanel />;
  if (syncing) return <FullScreenMessage>Syncing your data…</FullScreenMessage>;

  return <>{children}</>;
}
