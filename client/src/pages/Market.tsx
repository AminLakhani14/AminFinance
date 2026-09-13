/**
 * Whole-market browser: every PSX issuer, every USDT pair, every spot metal.
 *
 * One upstream call per class backs this — PSX's market-watch page and
 * Binance's unparameterised 24h ticker — so browsing ~500 stocks costs the same
 * as browsing one. That is the only reason this screen is practical; quoting
 * them individually would be ~500 requests.
 *
 * Rows are capped for rendering rather than paginated. A screener's job is to
 * let you sort and search your way to the handful you care about, and 500 live
 * DOM rows cost more than they inform — the count line always says how many
 * matched, so the cap is never silent.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Search,
  ArrowUpDown,
  TrendingUp,
  TrendingDown,
  Star,
  BriefcaseBusiness,
} from 'lucide-react';
import type { AssetClass, MarketRow } from '@aminfinance/shared';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { InstrumentLogo } from '@/components/ui/InstrumentLogo';
import { useGetMarketListingQuery } from '@/services/endpoints';
import { toApiError } from '@/services/api';
import { useStreamedSymbols, useLiveTick } from '@/features/market/useLivePrice';
import { favoriteKey, useFavorites } from '@/features/market/useFavorites';
import { useIssuerLogos } from '@/features/market/useIssuerLogos';
import { usePortfolio } from '@/features/portfolio/usePortfolio';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';

type ViewKey = AssetClass | 'holdings' | 'favorites';

const TABS: Array<{ key: ViewKey; label: string }> = [
  { key: 'favorites', label: 'Favorites' },
  { key: 'holdings', label: 'Holdings' },
  { key: 'stock', label: 'PSX' },
  { key: 'crypto', label: 'Crypto' },
  { key: 'commodity', label: 'Metals' },
];

type SortKey = 'symbol' | 'price' | 'changePercent' | 'volume';

/** Rendered at once. Beyond this, search or sort rather than scroll. */
const ROW_CAP = 150;

/**
 * Live subscriptions opened from this page.
 *
 * The server caps a client at 50 symbols, and the ticker tape already spends
 * some of that on the portfolio. Streaming the top of the visible list keeps
 * the page feeling live where the eye actually is, without starving the tape.
 */
const LIVE_ROWS = 25;

export function Market() {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('changePercent');
  const [descending, setDescending] = useState(true);
  const { holdings } = usePortfolio();
  const { favorites, toggleFavorite } = useFavorites();
  // Favorites lead the tab strip, but landing on an empty list says nothing.
  // They come from localStorage synchronously, so the opening tab can be
  // decided on the first render; holdings arrive async and cannot be.
  const [tab, setTab] = useState<ViewKey>(() =>
    favorites.size > 0 ? 'favorites' : 'stock',
  );

  const stockQuery = useGetMarketListingQuery(
    { assetClass: 'stock' },
    { skip: tab !== 'stock' && tab !== 'favorites' },
  );
  const cryptoQuery = useGetMarketListingQuery(
    { assetClass: 'crypto' },
    { skip: tab !== 'crypto' && tab !== 'favorites' },
  );
  const metalQuery = useGetMarketListingQuery(
    { assetClass: 'commodity' },
    { skip: tab !== 'commodity' && tab !== 'favorites' },
  );

  const activeQuery =
    tab === 'stock' ? stockQuery : tab === 'crypto' ? cryptoQuery : metalQuery;

  const rows = useMemo((): MarketRow[] => {
    if (tab === 'holdings') {
      return holdings.map((holding) => ({
        symbol: holding.symbol,
        assetClass: holding.assetClass,
        price: holding.currentPrice,
        change: holding.dayChange / Math.max(holding.quantity, Number.EPSILON),
        changePercent: holding.dayChangePercent,
        volume: null,
        currency: holding.currency,
      }));
    }
    if (tab === 'favorites') {
      return [
        ...(stockQuery.data?.rows ?? []),
        ...(cryptoQuery.data?.rows ?? []),
        ...(metalQuery.data?.rows ?? []),
      ].filter((row) => favorites.has(favoriteKey(row)));
    }
    return activeQuery.data?.rows ?? [];
  }, [
    tab,
    holdings,
    favorites,
    activeQuery.data,
    stockQuery.data,
    cryptoQuery.data,
    metalQuery.data,
  ]);

  const isFetching =
    tab === 'favorites'
      ? stockQuery.isFetching || cryptoQuery.isFetching || metalQuery.isFetching
      : tab === 'holdings'
        ? false
        : activeQuery.isFetching;
  const error =
    tab === 'favorites'
      ? stockQuery.error ?? cryptoQuery.error ?? metalQuery.error
      : tab === 'holdings'
        ? undefined
        : activeQuery.error;
  const apiError = toApiError(error);

  const filtered = useMemo(() => {
    const needle = query.trim().toUpperCase();
    // Names are on screen now, so searching one has to work — "NESTLE" and
    // "Nestle Pakistan" should both find the row.
    const matched = needle
      ? rows.filter(
          (r) => r.symbol.includes(needle) || (r.name?.toUpperCase().includes(needle) ?? false),
        )
      : rows;

    const sorted = [...matched].sort((a, b) => {
      if (sort === 'symbol') return a.symbol.localeCompare(b.symbol);
      const av = sort === 'volume' ? (a.volume ?? 0) : a[sort];
      const bv = sort === 'volume' ? (b.volume ?? 0) : b[sort];
      return av - bv;
    });

    return descending ? sorted.reverse() : sorted;
  }, [rows, query, sort, descending]);

  const visible = filtered.slice(0, ROW_CAP);

  // Only crypto streams; PSX has no public streaming endpoint.
  const streamed = useMemo(
    () =>
      visible
        .slice(0, LIVE_ROWS)
        .map((r) => ({ symbol: r.symbol, assetClass: r.assetClass })),
    [visible],
  );
  useStreamedSymbols(streamed);

  // Issuer logos for the equities on screen. PSX's bulk listing carries no
  // websites, so these are looked up separately — for the visible rows only,
  // never the whole 500-row market.
  const logoSymbols = useMemo(
    () => visible.filter((r) => r.assetClass === 'stock').map((r) => r.symbol),
    [visible],
  );
  const logos = useIssuerLogos(logoSymbols);

  function toggleSort(key: SortKey) {
    if (key === sort) {
      setDescending((d) => !d);
    } else {
      setSort(key);
      setDescending(key !== 'symbol');
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-text">Market</h1>
        <p className="mt-1 text-sm text-text-muted">
          Every listed instrument, priced. Click any symbol for its chart and AI analysis.
        </p>
      </div>

      <Card>
        <CardHeader
          title={TABS.find((t) => t.key === tab)?.label ?? 'Market'}
          description={
            tab === 'holdings'
              ? `${filtered.length} of ${holdings.length} open positions`
              : tab === 'favorites'
                ? isFetching
                  ? 'Loading your saved instruments…'
                  : `${filtered.length} saved instrument${filtered.length === 1 ? '' : 's'}`
                : activeQuery.data
                  ? `${filtered.length} of ${activeQuery.data.rows.length} instruments · as of ${formatDate(activeQuery.data.asOf)}`
                  : 'Loading…'
          }
        />
        <CardBody className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex flex-wrap gap-1 rounded-xl border border-border/70 bg-surface-sunken/70 p-1">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-all',
                    t.key === 'stock' && 'ml-1 border-l border-border pl-3.5',
                    tab === t.key
                      ? 'bg-surface text-text shadow-sm ring-1 ring-inset ring-accent/20'
                      : 'text-text-muted hover:text-text',
                  )}
                >
                  {t.key === 'holdings' ? <BriefcaseBusiness className="size-3.5" /> : null}
                  {t.key === 'favorites' ? <Star className="size-3.5" /> : null}
                  {t.label}
                  {t.key === 'holdings' ? (
                    <span className="nums rounded-full bg-accent/10 px-1.5 text-[10px] text-accent">
                      {holdings.length}
                    </span>
                  ) : null}
                  {t.key === 'favorites' ? (
                    <span className="nums rounded-full bg-warning/10 px-1.5 text-[10px] text-warning">
                      {favorites.size}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>

            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-subtle" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter by symbol or name…"
                className={cn(
                  'h-9 w-full rounded-lg border border-border bg-surface-sunken pl-9 pr-3',
                  'text-sm text-text placeholder:text-text-subtle',
                  'focus:border-border-strong focus:outline-none',
                )}
              />
            </div>
          </div>

          {error && tab !== 'favorites' ? (
            <p className="text-sm text-negative">{apiError?.message ?? 'Could not load the market.'}</p>
          ) : isFetching && rows.length === 0 ? (
            <div className="space-y-1.5" aria-busy="true">
              {Array.from({ length: 10 }, (_, i) => (
                <div key={i} className="h-9 animate-pulse rounded bg-surface-raised" />
              ))}
            </div>
          ) : visible.length === 0 ? (
            <p className="text-sm text-text-muted">
              {query
                ? `Nothing matches “${query}”.`
                : tab === 'favorites'
                  ? 'No favorites yet. Select the star beside any instrument to save it here.'
                  : tab === 'holdings'
                    ? 'No open holdings yet. Add a transaction from the Portfolio page.'
                    : 'No instruments available — this class may need an API key. See Settings.'}
            </p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[680px] text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-text-muted">
                      <SortHeader label="Symbol" className="w-[44%]" active={sort === 'symbol'} onClick={() => toggleSort('symbol')} />
                      {tab === 'stock' ? (
                        <th className="px-3 py-2 font-medium">Sector</th>
                      ) : tab === 'holdings' || tab === 'favorites' ? (
                        <th className="px-3 py-2 font-medium">Type</th>
                      ) : null}
                      <SortHeader label="Price" align="right" active={sort === 'price'} onClick={() => toggleSort('price')} />
                      <SortHeader label="Change" align="right" active={sort === 'changePercent'} onClick={() => toggleSort('changePercent')} />
                      <SortHeader label="Volume" align="right" active={sort === 'volume'} onClick={() => toggleSort('volume')} />
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((row) => (
                      <Row
                        key={`${row.assetClass}:${row.symbol}`}
                        row={row}
                        detailColumn={
                          tab === 'stock'
                            ? 'sector'
                            : tab === 'holdings' || tab === 'favorites'
                              ? 'type'
                              : 'none'
                        }
                        logoUrl={logos.get(row.symbol)}
                        favorite={favorites.has(favoriteKey(row))}
                        onToggleFavorite={() => toggleFavorite(row)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>

              {filtered.length > ROW_CAP ? (
                <p className="text-xs text-text-subtle">
                  Showing the first {ROW_CAP} of {filtered.length}. Search or re-sort to narrow.
                </p>
              ) : null}
            </>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function SortHeader({
  label,
  active,
  align = 'left',
  className,
  onClick,
}: {
  label: string;
  active: boolean;
  align?: 'left' | 'right';
  className?: string;
  onClick: () => void;
}) {
  return (
    <th className={cn('px-3 py-2 font-medium', align === 'right' && 'text-right', className)}>
      <button
        onClick={onClick}
        className={cn(
          'inline-flex items-center gap-1 hover:text-text',
          active && 'text-text',
        )}
      >
        {label}
        <ArrowUpDown className={cn('size-3', active ? 'opacity-100' : 'opacity-40')} />
      </button>
    </th>
  );
}

function Row({
  row,
  detailColumn,
  logoUrl,
  favorite,
  onToggleFavorite,
}: {
  row: MarketRow;
  detailColumn: 'sector' | 'type' | 'none';
  logoUrl: string | null | undefined;
  favorite: boolean;
  onToggleFavorite: () => void;
}) {
  const tick = useLiveTick(row.symbol);
  const price = tick?.price ?? row.price;
  const changePercent = tick?.changePercent ?? row.changePercent;
  const up = changePercent >= 0;

  return (
    <tr className="group/row border-b border-border/50 transition-colors last:border-0 hover:bg-surface-raised/50">
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={onToggleFavorite}
            aria-pressed={favorite}
            aria-label={`${favorite ? 'Remove' : 'Add'} ${row.symbol} ${favorite ? 'from' : 'to'} favorites`}
            title={favorite ? 'Remove from favorites' : 'Add to favorites'}
            className={cn(
              'grid size-7 shrink-0 place-items-center rounded-lg transition-all hover:bg-warning/10 hover:text-warning',
              favorite
                ? 'text-warning'
                : 'text-text-subtle opacity-65 group-hover/row:opacity-100',
            )}
          >
            <Star className={cn('size-4', favorite && 'fill-current')} />
          </button>
          <InstrumentLogo
            symbol={row.symbol}
            assetClass={row.assetClass}
            currency={row.currency}
            logoUrl={logoUrl}
          />
          <div className="min-w-0 flex-1">
            <Link
              to={`/asset/${encodeURIComponent(row.symbol)}`}
              className="block font-semibold text-text transition-colors hover:text-accent"
            >
              {row.symbol}
            </Link>
            {/* The issuer name is what identifies a row PSX-side; the quote
                currency is a poor substitute and only stands in for crypto
                and metals, which publish no name. */}
            <span
              className="block truncate text-[11px] text-text-subtle"
              title={row.name ?? undefined}
            >
              {row.name ?? (
                <span className="text-[10px] uppercase tracking-wider">{row.currency}</span>
              )}
            </span>
          </div>
        </div>
      </td>
      {detailColumn === 'sector' ? (
        <td className="px-3 py-2 text-xs text-text-subtle">{row.sector ?? '—'}</td>
      ) : detailColumn === 'type' ? (
        <td className="px-3 py-2 text-xs capitalize text-text-subtle">{row.assetClass}</td>
      ) : null}
      <td className="nums px-3 py-2 text-right text-text">
        {price.toLocaleString(undefined, { maximumFractionDigits: 6 })}
      </td>
      <td className={cn('nums px-3 py-2 text-right', up ? 'text-positive' : 'text-negative')}>
        <span className="inline-flex items-center gap-1">
          {up ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
          {changePercent.toFixed(2)}%
        </span>
      </td>
      <td className="nums px-3 py-2 text-right text-xs text-text-subtle">
        {row.volume === null ? '—' : compact(row.volume)}
      </td>
    </tr>
  );
}

/** Volumes run to nine figures; full digits would dominate the row. */
function compact(value: number): string {
  return Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(
    value,
  );
}
