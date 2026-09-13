/**
 * The Supabase connection.
 *
 * One client for the whole app: the SDK holds the auth session and a realtime
 * socket, and a second instance would race the first on token refresh.
 *
 * The publishable key ships in the bundle by design. Row-level security is
 * what guards the data — every policy matches `auth.uid()` against the row's
 * `user_id`, so this key on its own reads nothing.
 */
import { createClient } from '@supabase/supabase-js';
import type { Database } from './types';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

/**
 * Whether cloud sync is configured at all.
 *
 * Checked rather than assumed so a clone with no `.env` still runs on local
 * storage instead of crashing at import time on a missing key.
 */
export const isSupabaseConfigured = Boolean(url && key);

export const supabase = isSupabaseConfigured
  ? createClient<Database>(url, key, {
      auth: {
        // Survive a refresh: without this the session lives in memory and
        // every reload bounces the user back to the sign-in screen.
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;

/**
 * The client, or a thrown error if it was never configured.
 *
 * Call sites past the auth gate cannot proceed without a connection, and
 * threading `null` through every one of them buys nothing — by that point a
 * missing client is a deployment fault, not a state to handle.
 */
export function requireSupabase() {
  if (!supabase) {
    throw new Error(
      'Supabase is not configured. Set VITE_SUPABASE_URL and ' +
        'VITE_SUPABASE_PUBLISHABLE_KEY in client/.env',
    );
  }
  return supabase;
}
