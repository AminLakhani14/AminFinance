import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import type { CandleInterval } from '@aminfinance/shared';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { StatTile } from '@/components/ui/StatTile';
import { CandlestickChart } from '@/components/charts/CandlestickChart';
import { AssetInsightCard } from '@/features/ai/AssetInsightCard';
import { usePortfolio } from '@/features/portfolio/usePortfolio';
import {
  useGetCandlesQuery,
  useGetFundamentalsQuery,
  useGetNewsQuery,
} from '@/services/endpoints';
import { formatCurrency, formatPercent, formatQuantity, formatDate, compactNumber } from '@/lib/format';
import { cn } from '@/lib/utils';

const RANGES: Array<{ label: string; interval: CandleInterval; limit: number }> = [
  { label: '1M', interval: '1d', limit: 22 },
  { label: '3M', interval: '1d', limit: 66 },
  { label: '6M', interval: '1d', limit: 130 },
  { label: '1Y', interval: '1d', limit: 250 },
  { label: 'All', interval: '1w', limit: 400 },
];

export function AssetDetail() {
  const { symbol = '' } = useParams<{ symbol: string }>();
  const [rangeIndex, setRangeIndex] = useState(2);
  const range = RANGES[rangeIndex] ?? RANGES[2]!;

  const { holdings, quotes, convert, displayCurrency } = usePortfolio();
  const holding = holdings.find((h) => h.symbol === symbol);
  const quote = quotes.get(symbol);
  const assetClass = holding?.assetClass ?? (quote?.assetClass ?? 'stock');

  const candles = useGetCandlesQuery({
    symbol,
    interval: range.interval,
    limit: range.limit,
  });
  const fundamentals = useGetFundamentalsQuery(symbol);
  // Only PSX issuers have company announcements to show.
  const news = useGetNewsQuery([symbol], { skip: assetClass !== 'stock' });

  return (
    <div className="space-y-6">
      <div>
        <Link
          to="/portfolio"
          className="inline-flex items-center gap-1.5 text-sm text-text-muted transition-colors hover:text-text"
        >
          <ArrowLeft className="size-4" />
          Portfolio
        </Link>
        <div className="mt-2 flex flex-wrap items-baseline gap-3">
          <h1 className="text-xl font-semibold tracking-tight text-text">{symbol}</h1>
          {fundamentals.data?.name && fundamentals.data.name !== symbol ? (
            <span className="text-sm text-text-muted">{fundamentals.data.name}</span>
          ) : null}
          {fundamentals.data?.sector ? (
            <span className="rounded-full border border-border px-2 py-0.5 text-[11px] uppercase tracking-wide text-text-subtle">
              {fundamentals.data.sector}
            </span>
          ) : null}
        </div>
      </div>

      <Card>
        <CardBody className="grid grid-cols-2 gap-6 lg:grid-cols-4">
          <StatTile
            label="Price"
            value={quote ? formatCurrency(quote.price, quote.currency) : '—'}
            delta={quote?.changePercent ?? null}
          />
          <StatTile
            label="Market cap"
            value={
              fundamentals.data?.marketCap
                ? `${fundamentals.data.currency} ${compactNumber(fundamentals.data.marketCap)}`
                : '—'
            }
          />
          <StatTile label="P/E (TTM)" value={fundamentals.data?.peRatio?.toFixed(2) ?? '—'} />
          <StatTile
            label="52-week range"
            value={
              fundamentals.data?.weekLow52 && fundamentals.data?.weekHigh52
                ? `${fundamentals.data.weekLow52} – ${fundamentals.data.weekHigh52}`
                : '—'
            }
          />
        </CardBody>
      </Card>

      {holding ? (
        <Card>
          <CardHeader title="Your position" />
          <CardBody className="grid grid-cols-2 gap-6 lg:grid-cols-4">
            <StatTile label="Quantity" value={formatQuantity(holding.quantity)} />
            <StatTile
              label="Average cost"
              value={formatCurrency(holding.averageCost, holding.currency)}
            />
            <StatTile
              label="Market value"
              value={formatCurrency(convert(holding.marketValue, holding.currency), displayCurrency)}
            />
            <StatTile
              label="Unrealised P/L"
              value={formatCurrency(convert(holding.unrealizedPnl, holding.currency), displayCurrency)}
              delta={holding.unrealizedPnlPercent}
            />
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          title="Price history"
          action={
            <div className="inline-flex rounded-lg border border-border bg-surface-sunken p-0.5">
              {RANGES.map((r, i) => (
                <button
                  key={r.label}
                  onClick={() => setRangeIndex(i)}
                  className={cn(
                    'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                    i === rangeIndex
                      ? 'bg-surface-raised text-text shadow-sm'
                      : 'text-text-muted hover:text-text',
                  )}
                >
                  {r.label}
                </button>
              ))}
            </div>
          }
        />
        <CardBody>
          {candles.isLoading ? (
            <div className="h-80 animate-pulse rounded bg-surface-raised" />
          ) : (
            <CandlestickChart
              candles={candles.data?.candles ?? []}
              note={
                assetClass === 'stock'
                  ? 'PSX daily data reports open, close, and volume — the high/low shown is the open–close range, not intraday extremes.'
                  : undefined
              }
            />
          )}
        </CardBody>
      </Card>

      <AssetInsightCard
        symbol={symbol}
        assetClass={assetClass}
        position={
          holding ? { quantity: holding.quantity, averageCost: holding.averageCost } : undefined
        }
      />

      {assetClass === 'stock' ? (
        <Card>
          <CardHeader title="Announcements" description="Filed with PSX" />
          <CardBody className="p-0">
            {news.data && news.data.articles.length > 0 ? (
              <ul className="divide-y divide-border">
                {news.data.articles.slice(0, 12).map((article) => (
                  <li key={article.id} className="px-5 py-3">
                    <div className="flex items-start justify-between gap-4">
                      <p className="text-sm text-text">{article.headline}</p>
                      <span className="shrink-0 text-xs text-text-subtle nums">
                        {formatDate(article.publishedAt)}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-text-subtle">{article.source}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-5 py-8 text-center text-sm text-text-muted">
                No announcements available.
              </p>
            )}
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
