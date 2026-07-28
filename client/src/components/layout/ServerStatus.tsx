/**
 * Live server-connection indicator.
 *
 * The client is useless without the proxy — every quote, candle, and insight
 * comes through it — so connection state is surfaced permanently in the shell
 * rather than as a transient toast. When the server is down the user should be
 * able to tell at a glance that stale numbers are stale.
 */
import { CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import { useGetHealthQuery, toApiError } from '@/services/api';
import { cn } from '@/lib/utils';

export function ServerStatus() {
  const { data, isLoading, isError, error } = useGetHealthQuery(undefined, {
    // Cheap probe, unauthenticated — polling it is how the UI notices a
    // restarted or crashed server without waiting for a user action to fail.
    pollingInterval: 30_000,
  });

  if (isLoading) {
    return (
      <Indicator tone="muted" icon={<Loader2 className="size-3.5 animate-spin" />}>
        Connecting
      </Indicator>
    );
  }

  if (isError || !data) {
    const apiError = toApiError(error);
    return (
      <Indicator
        tone="negative"
        icon={<AlertCircle className="size-3.5" />}
        title={apiError?.message ?? 'Server unreachable'}
      >
        Offline
      </Indicator>
    );
  }

  const configured = Object.values(data.providers).filter(Boolean).length;
  const total = Object.keys(data.providers).length;
  const allReady = configured === total;

  return (
    <Indicator
      tone={allReady ? 'positive' : 'warning'}
      icon={<CheckCircle2 className="size-3.5" />}
      title={
        allReady
          ? 'All providers configured'
          : `${total - configured} provider(s) missing keys — see Settings`
      }
    >
      {allReady ? 'Connected' : `${configured}/${total} providers`}
    </Indicator>
  );
}

function Indicator({
  tone,
  icon,
  title,
  children,
}: {
  tone: 'positive' | 'negative' | 'warning' | 'muted';
  icon: React.ReactNode;
  title?: string;
  children: React.ReactNode;
}) {
  const tones = {
    positive: 'text-positive',
    negative: 'text-negative',
    warning: 'text-warning',
    muted: 'text-text-muted',
  } as const;

  return (
    <div
      title={title}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border border-border',
        'bg-surface px-2.5 py-1 text-xs font-medium',
        tones[tone],
      )}
    >
      {icon}
      <span>{children}</span>
    </div>
  );
}
