/**
 * The current session, as React state.
 *
 * Supabase keeps the session in localStorage and refreshes the token on a
 * timer, so the source of truth lives in the SDK — this hook only mirrors it.
 * `onAuthStateChange` fires on sign-in, sign-out, and every silent refresh,
 * which is what keeps a token rotation from logging the UI out.
 */
import { useEffect, useState } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase, isSupabaseConfigured } from './client';

export interface AuthState {
  session: Session | null;
  user: User | null;
  /** True until the stored session has been read; guards a sign-in flash. */
  isLoading: boolean;
}

export function useAuth(): AuthState {
  const [session, setSession] = useState<Session | null>(null);
  // Nothing to restore when the project is unconfigured, so start resolved
  // rather than hanging on a loading screen that will never end.
  const [isLoading, setIsLoading] = useState(isSupabaseConfigured);

  useEffect(() => {
    if (!supabase) return;

    // Reading the stored session is async. Without this first pass the app
    // would render signed-out for a frame on every reload.
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setIsLoading(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      setIsLoading(false);
    });

    return () => sub.subscription.unsubscribe();
  }, []);

  return { session, user: session?.user ?? null, isLoading };
}

/**
 * The signed-in user's id, for stamping `user_id` on writes.
 *
 * Throws rather than returning null: every write path runs behind the auth
 * gate, so no user here means the gate was bypassed — a bug, not a state the
 * caller should paper over with a fallback id.
 */
export async function requireUserId(): Promise<string> {
  if (!supabase) throw new Error('Supabase is not configured.');
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new Error('Not signed in.');
  return data.user.id;
}

export async function signIn(email: string, password: string) {
  if (!supabase) throw new Error('Supabase is not configured.');
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

export async function signUp(email: string, password: string) {
  if (!supabase) throw new Error('Supabase is not configured.');
  const { error } = await supabase.auth.signUp({ email, password });
  if (error) throw error;
}

export async function signOut() {
  if (!supabase) throw new Error('Supabase is not configured.');
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}
