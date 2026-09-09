import { cn } from '@/lib/utils';

/* ---------------------------------------------------------------------------
   Brand mark

   The "A" doubles as a price line: up to a peak, back down, with the peak
   marked in the same green the app uses for gains. Inlined as JSX rather than
   an <img src="/logo.svg"> so it paints with the first render — a network fetch
   for a 40px mark in the sidebar would flash empty on every cold load.

   The standalone files in client/public are the same geometry, for use outside
   React (favicon, README, anywhere an SVG URL is needed).
   --------------------------------------------------------------------------- */

interface LogoMarkProps {
  className?: string;
  /** Drop the tile and draw in `currentColor` — for tight or single-colour spots. */
  mono?: boolean;
}

// Gradient ids must be unique per document or the first one on the page wins
// for every instance. A module counter is enough; the mark is never rendered
// during SSR, so hydration mismatch isn't a concern.
let gradientSeq = 0;

export function LogoMark({ className, mono = false }: LogoMarkProps) {
  if (mono) {
    return (
      <svg
        viewBox="0 0 48 48"
        className={cn('size-8', className)}
        aria-hidden="true"
        focusable="false"
      >
        <g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
          <rect x="1.6" y="1.6" width="44.8" height="44.8" rx="11" strokeWidth="3.2" />
          <path d="M13 34.5 L24 14 L35 34.5" strokeWidth="3.6" />
          <path d="M18 27.5 H30" strokeWidth="3" />
        </g>
        <circle cx="24" cy="14" r="3.2" fill="currentColor" />
      </svg>
    );
  }

  const gradientId = `af-logo-${(gradientSeq += 1)}`;

  return (
    <svg
      viewBox="0 0 48 48"
      className={cn('size-8', className)}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4A93EC" />
          <stop offset="1" stopColor="#12469A" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="12" fill={`url(#${gradientId})`} />
      <path
        d="M11 36 L24 12 L37 36"
        fill="none"
        stroke="#fff"
        strokeWidth="4.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M17 28 H31" fill="none" stroke="#fff" strokeWidth="3.4" strokeLinecap="round" />
      <circle cx="24" cy="12" r="3.7" fill="#3DDC9A" />
    </svg>
  );
}

interface LogoProps {
  className?: string;
  /** Hide the "Portfolio tracker" line — for headers with no room for it. */
  compact?: boolean;
}

/** Mark plus wordmark, as used in the sidebar. */
export function Logo({ className, compact = false }: LogoProps) {
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <LogoMark className="size-9 shrink-0" />
      <div className="min-w-0">
        <span className="block text-base font-semibold tracking-tight text-text">
          Amin<span className="text-accent">Finance</span>
        </span>
        {compact ? null : (
          <span className="mt-0.5 block text-[11px] text-text-subtle">Portfolio tracker</span>
        )}
      </div>
    </div>
  );
}
