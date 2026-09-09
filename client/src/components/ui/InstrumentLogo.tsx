import { useState, type CSSProperties } from 'react';
import type { AssetClass } from '@aminfinance/shared';
import { cn } from '@/lib/utils';

interface InstrumentLogoProps {
  symbol: string;
  assetClass: AssetClass;
  currency?: string;
  className?: string;
}

const METALS: Record<string, { mark: string; color: string }> = {
  XAUUSD: { mark: 'Au', color: '#d9a928' },
  XAGUSD: { mark: 'Ag', color: '#aeb9c8' },
  XPTUSD: { mark: 'Pt', color: '#8fc4d4' },
  XPDUSD: { mark: 'Pd', color: '#c8a9e8' },
};

/** A logo for every instrument, with deterministic fallbacks that never break. */
export function InstrumentLogo({
  symbol,
  assetClass,
  currency = 'USDT',
  className,
}: InstrumentLogoProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const normalized = symbol.toUpperCase();

  if (assetClass === 'commodity') {
    const metal = METALS[normalized] ?? { mark: normalized.slice(0, 2), color: '#b7c5d8' };
    return (
      <span
        className={cn('instrument-logo font-mono text-[10px] font-bold', className)}
        style={{ '--logo-color': metal.color } as CSSProperties}
        title={normalized}
        aria-hidden="true"
      >
        {metal.mark}
      </span>
    );
  }

  const baseSymbol =
    assetClass === 'crypto' && normalized.endsWith(currency.toUpperCase())
      ? normalized.slice(0, -currency.length)
      : normalized;
  const initials = baseSymbol.replace(/^\d+/, '').slice(0, 2) || baseSymbol.slice(0, 2);
  const hue = hashHue(normalized);

  if (assetClass === 'crypto' && !imageFailed) {
    return (
      <span className={cn('instrument-logo overflow-hidden', className)} aria-hidden="true">
        <img
          src={`https://assets.coincap.io/assets/icons/${baseSymbol.toLowerCase()}@2x.png`}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          className="size-full object-cover"
          onError={() => setImageFailed(true)}
        />
      </span>
    );
  }

  return (
    <span
      className={cn('instrument-logo text-[9px] font-bold uppercase tracking-[-0.04em]', className)}
      style={{ '--logo-hue': hue } as CSSProperties}
      title={normalized}
      aria-hidden="true"
    >
      {initials}
    </span>
  );
}

function hashHue(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) hash = value.charCodeAt(i) + ((hash << 5) - hash);
  return Math.abs(hash) % 360;
}
