/**
 * Email + password sign-in, with sign-up on the same form.
 *
 * One panel rather than two routes: the app has a single account per user and
 * no onboarding flow, so a mode toggle carries the whole difference and a
 * second page would only add a navigation step.
 */
import { useState, type FormEvent } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { signIn, signUp } from '@/lib/supabase/useAuth';

type Mode = 'signin' | 'signup';

export function SignInPanel() {
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);

    try {
      if (mode === 'signup') {
        await signUp(email, password);
        // With email confirmation enabled there is no session yet, so say so
        // rather than leaving the user on a form that looks like it failed.
        setNotice('Account created. Check your email if confirmation is on, then sign in.');
        setMode('signin');
      } else {
        await signIn(email, password);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-sunken p-4">
      <Card className="w-full max-w-sm p-6">
        <h1 className="text-lg font-semibold text-text">
          {mode === 'signin' ? 'Sign in' : 'Create an account'}
        </h1>
        <p className="mt-1 text-sm text-text-muted">
          Your portfolio and budget sync across devices once you sign in.
        </p>

        <form onSubmit={handleSubmit} className="mt-5 space-y-3">
          <label className="block">
            <span className="text-xs font-medium text-text-muted">Email</span>
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 h-9 w-full rounded-xl border border-border bg-surface-raised px-3 text-sm text-text outline-none focus:border-accent"
            />
          </label>

          <label className="block">
            <span className="text-xs font-medium text-text-muted">Password</span>
            <input
              type="password"
              required
              minLength={6}
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 h-9 w-full rounded-xl border border-border bg-surface-raised px-3 text-sm text-text outline-none focus:border-accent"
            />
          </label>

          {error && (
            <p role="alert" className="text-sm text-negative">
              {error}
            </p>
          )}
          {notice && (
            <p role="status" className="text-sm text-text-muted">
              {notice}
            </p>
          )}

          <Button type="submit" variant="primary" className="w-full" disabled={busy}>
            {busy ? 'Working…' : mode === 'signin' ? 'Sign in' : 'Sign up'}
          </Button>
        </form>

        <button
          type="button"
          onClick={() => {
            setMode(mode === 'signin' ? 'signup' : 'signin');
            setError(null);
            setNotice(null);
          }}
          className="mt-4 w-full text-center text-xs text-text-muted hover:text-text"
        >
          {mode === 'signin'
            ? "Don't have an account? Sign up"
            : 'Already have an account? Sign in'}
        </button>
      </Card>
    </div>
  );
}
