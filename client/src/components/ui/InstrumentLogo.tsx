/**
 * A logo for every instrument, with fallbacks that never leave a hole.
 *
 * Real marks come from two sources, both plain <img> URLs with no key and no
 * API budget: coincap for crypto, keyed on the base asset so every quote pair
 * of the same coin shares one icon, and — for PSX equities — the issuer's own
 * favicon, at a domain the server reads off the company page.
 *
 * Equity logos arrive as a `logoUrl` prop rather than being derived here. The
 * exchange publishes no logos and no website in its bulk listing, so the
 * domain has to be looked up per issuer; `useIssuerLogos` does that for the
 * rows on screen and hands the result down.
 *
 * Coverage is partial by nature — a new listing, an issuer with no website, a
 * site with no favicon — so the monogram is not an error state but the
 * designed floor: a deterministic colour from the symbol's hash, stable across
 * reloads, which reads as intentional rather than as a broken image.
 *
 * Remote sources are tried in order and each failure advances to the next, so a
 * dead CDN degrades to the monogram instead of rendering a broken-image glyph.
 */
import { useMemo, useState, type CSSProperties } from 'react';
import type { AssetClass } from '@aminfinance/shared';
import { cn } from '@/lib/utils';

interface InstrumentLogoProps {
  symbol: string;
  assetClass: AssetClass;
  currency?: string;
  /**
   * Resolved logo URL for an equity, from `useIssuerLogos`.
   *
   * Undefined means "not looked up yet" and null means "looked up, none
   * exists" — the first renders a monogram that may still be replaced, the
   * second one that is final. Both look the same; the distinction matters only
   * in that neither flickers a broken image.
   */
  logoUrl?: string | null | undefined;
  className?: string;
}

/** Spot metals are their element, so the periodic symbol is the truest mark. */
const METALS: Record<string, { mark: string; color: string }> = {
  XAUUSD: { mark: 'Au', color: '#d9a928' },
  XAGUSD: { mark: 'Ag', color: '#aeb9c8' },
  XPTUSD: { mark: 'Pt', color: '#8fc4d4' },
  XPDUSD: { mark: 'Pd', color: '#c8a9e8' },
};

/**
 * Binance quote suffixes, longest first.
 *
 * The row's own `currency` is preferred when it matches, but holdings and
 * favorites can carry a pair whose currency was recorded differently, so the
 * suffix is stripped by table as a second pass. Longest-first matters: USDT
 * must win over a bare match that would leave a stray "T" on the base.
 */
const QUOTE_SUFFIXES = ['FDUSD', 'USDT', 'USDC', 'BUSD', 'TUSD', 'BNB', 'BTC', 'ETH', 'TRY', 'EUR'];

export function InstrumentLogo({
  symbol,
  assetClass,
  currency = 'USDT',
  logoUrl,
  className,
}: InstrumentLogoProps) {
  const normalized = symbol.toUpperCase();

  // Each failing source advances this index; the monogram is past the end.
  const [sourceIndex, setSourceIndex] = useState(0);

  const sources = useMemo(
    () => logoSources(normalized, assetClass, currency, logoUrl),
    [normalized, assetClass, currency, logoUrl],
  );

  // A changed symbol reuses this component instance in a virtualised table, so
  // the cursor is keyed to the sources it was counting against rather than
  // reset in an effect — otherwise row N+1 inherits row N's exhausted state.
  const [sourcesSeen, setSourcesSeen] = useState(sources);
  if (sourcesSeen !== sources) {
    setSourcesSeen(sources);
    setSourceIndex(0);
  }

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

  const source = sources[sourceIndex];

  if (source) {
    return (
      <span
        className={cn('instrument-logo overflow-hidden', className)}
        style={{ '--logo-hue': hashHue(normalized) } as CSSProperties}
        title={normalized}
        aria-hidden="true"
      >
        <img
          // Keyed so React swaps the element rather than reusing the failed one,
          // which would keep the broken state and never fire onLoad.
          key={source}
          src={source}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          className="size-full scale-[0.82] object-contain"
          onError={() => setSourceIndex((i) => i + 1)}
        />
      </span>
    );
  }

  return (
    <span
      className={cn('instrument-logo text-[9px] font-bold uppercase tracking-[-0.04em]', className)}
      style={{ '--logo-hue': hashHue(normalized) } as CSSProperties}
      title={normalized}
      aria-hidden="true"
    >
      {monogram(normalized, assetClass, currency)}
    </span>
  );
}

/** Remote logo URLs to try, best first. Empty means monogram straight away. */
function logoSources(
  symbol: string,
  assetClass: AssetClass,
  currency: string,
  logoUrl: string | null | undefined,
): string[] {
  if (assetClass === 'crypto') {
    const base = baseAsset(symbol, currency).toLowerCase();
    if (!base) return [];
    return [`https://assets.coincap.io/assets/icons/${base}@2x.png`];
  }

  // Equities carry no derivable URL — the issuer's domain is known only to the
  // server, which read it off the company page. No prop means no logo yet.
  return logoUrl ? [logoUrl] : [];
}

/** The traded asset, with any Binance quote suffix removed. */
function baseAsset(symbol: string, currency: string): string {
  const quote = currency.toUpperCase();
  if (quote && symbol.endsWith(quote) && symbol.length > quote.length) {
    return symbol.slice(0, -quote.length);
  }
  for (const suffix of QUOTE_SUFFIXES) {
    if (symbol.endsWith(suffix) && symbol.length > suffix.length) {
      return symbol.slice(0, -suffix.length);
    }
  }
  return symbol;
}

/** Up to two letters standing in for the instrument when no logo exists. */
function monogram(symbol: string, assetClass: AssetClass, currency: string): string {
  const base = assetClass === 'crypto' ? baseAsset(symbol, currency) : symbol;
  // Leading digits belong to the ticker, not the name — "1INCH" reads as "IN".
  return base.replace(/^\d+/, '').slice(0, 2) || base.slice(0, 2);
}

function hashHue(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) hash = value.charCodeAt(i) + ((hash << 5) - hash);
  return Math.abs(hash) % 360;
}
