import { useMemo } from 'react';
import { TrendingUp, TrendingDown, Info } from 'lucide-react';
import type { AssetClass, Candle } from '@aminfinance/shared';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { StatTile } from '@/components/ui/StatTile';
import { Heatmap } from '@/components/charts/Heatmap';
import { DonutChart } from '@/components/charts/DonutChart';
import { PortfolioReviewCard } from '@/features/ai/PortfolioReviewCard';
import { usePortfolio } from '@/features/portfolio/usePortfolio';
import { useCandleSeries } from '@/features/portfolio/useCandleSeries';
import { useAppSelector } from '@/app/hooks';
import {
  toReturns,
  volatility,
  sharpeRatio,
  maxDrawdown,
  correlationMatrix,
} from '@/lib/calc/metrics';
import { formatPercent, formatCurrency } from '@/lib/format';

/** Allocation-ring buckets. Kept out of the component so it isn't rebuilt. */
const ASSET_CLASS_LABEL: Record<AssetClass, string> = {
  stock: 'PSX equities',
  crypto: 'Crypto',
  commodity: 'Precious metals',
};

export function Analytics() {
  const { holdings, summary, convert, displayCurrency, isEmpty } = usePortfolio();
  const riskFreeRate = useAppSelector((s) => s.settings.riskFreeRatePercent);

  const symbols = useMemo(() => holdings.map((h) => h.symbol), [holdings]);

  // One query per symbol, driven by a stable list. RTK Query dedupes and caches.
  const seriesBySymbol = useCandleSeries(symbols);

  const metrics = useMemo(() => {
    if (seriesBySymbol.size === 0) return null;

    // Weight each holding's returns by its allocation to approximate the
    // portfolio's own return series.
    const weights = new Map(
      holdings.map((h) => [h.symbol, h.allocationPercent / 100]),
    );

    const anySeries = [...seriesBySymbol.values()][0];
    if (!anySeries) return null;

    const portfolioReturns: number[] = [];
    const length = Math.min(
      ...[...seriesBySymbol.values()].map((s) => toReturns(s.map((c) => c.close)).length),
    );

    for (let i = 0; i < length; i++) {
      let weighted = 0;
      for (const [symbol, series] of seriesBySymbol) {
        const returns = toReturns(series.map((c) => c.close));
        const offset = returns.length - length;
        weighted += (returns[i + offset] ?? 0) * (weights.get(symbol) ?? 0);
      }
      portfolioReturns.push(weighted);
    }

    // Cumulative value path for drawdown.
    const path = portfolioReturns.reduce<number[]>(
      (acc, r) => [...acc, (acc[acc.length - 1] ?? 1) * (1 + r)],
      [1],
    );

    const hasCrypto = holdings.some((h) => h.assetClass === 'crypto');

    return {
      volatility: volatility(portfolioReturns, hasCrypto),
      sharpe: sharpeRatio(portfolioReturns, riskFreeRate, hasCrypto),
      drawdown: maxDrawdown(path),
      observations: portfolioReturns.length,
      correlation: correlationMatrix(seriesBySymbol),
    };
  }, [seriesBySymbol, holdings, riskFreeRate]);

  const best = useMemo(
    () => [...holdings].sort((a, b) => b.unrealizedPnlPercent - a.unrealizedPnlPercent)[0],
    [holdings],
  );
  const worst = useMemo(
    () => [...holdings].sort((a, b) => a.unrealizedPnlPercent - b.unrealizedPnlPercent)[0],
    [holdings],
  );

  const byClass = useMemo(() => {
    const totals = new Map<string, number>();
    for (const h of holdings) {
      const key = ASSET_CLASS_LABEL[h.assetClass] ?? 'PSX equities';
      totals.set(key, (totals.get(key) ?? 0) + convert(h.marketValue, h.currency));
    }
    return [...totals.entries()].map(([symbol, value]) => ({ symbol, value }));
  }, [holdings, convert]);

  if (isEmpty) {
    return (
      <div className="space-y-6">
        <Heading />
        <Card>
          <CardBody className="py-16 text-center text-sm text-text-muted">
            Add holdings to see risk and performance analytics.
          </CardBody>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Heading />

      <Card>
        <CardBody className="grid grid-cols-2 gap-6 lg:grid-cols-4">
          <StatTile
            label="Volatility (annualised)"
            value={metrics?.volatility !== null && metrics?.volatility !== undefined
              ? `${metrics.volatility.toFixed(1)}%`
              : '—'}
            hint={metrics?.volatility === null ? 'Needs 20+ days of history' : undefined}
          />
          <StatTile
            label="Sharpe ratio"
            value={metrics?.sharpe !== null && metrics?.sharpe !== undefined
              ? metrics.sharpe.toFixed(2)
              : '—'}
            hint={`vs ${riskFreeRate}% risk-free`}
          />
          <StatTile
            label="Max drawdown"
            value={metrics?.drawdown !== null && metrics?.drawdown !== undefined
              ? `${metrics.drawdown.toFixed(1)}%`
              : '—'}
            hint="Peak to trough"
          />
          <StatTile
            label="Realised P/L"
            value={formatCurrency(summary.totalRealizedPnl, displayCurrency, { compact: true })}
            hint="From closed positions"
          />
        </CardBody>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Best & worst" description="By unrealised P/L" />
          <CardBody className="space-y-4">
            {best ? (
              <PerformerRow
                icon={<TrendingUp className="size-4 text-positive" />}
                label="Best"
                symbol={best.symbol}
                percent={best.unrealizedPnlPercent}
              />
            ) : null}
            {worst && worst.symbol !== best?.symbol ? (
              <PerformerRow
                icon={<TrendingDown className="size-4 text-negative" />}
                label="Worst"
                symbol={worst.symbol}
                percent={worst.unrealizedPnlPercent}
              />
            ) : null}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Asset class" description="PSX equities vs crypto" />
          <CardBody>
            <DonutChart data={byClass} currency={displayCurrency} size={160} />
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Correlation"
          description="Daily returns. Holdings that move together diversify less."
        />
        <CardBody>
          {metrics?.correlation ? (
            <Heatmap
              symbols={metrics.correlation.symbols}
              values={metrics.correlation.values}
            />
          ) : (
            <p className="flex items-center gap-2 py-6 text-sm text-text-muted">
              <Info className="size-4" />
              Needs at least two holdings with 20+ days of overlapping history.
            </p>
          )}
        </CardBody>
      </Card>

      <PortfolioReviewCard holdings={holdings} currency={displayCurrency} />
    </div>
  );
}

function Heading() {
  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight text-text">Analytics</h1>
      <p className="mt-1 text-sm text-text-muted">
        Risk, performance, and diversification.
      </p>
    </div>
  );
}

function PerformerRow({
  icon,
  label,
  symbol,
  percent,
}: {
  icon: React.ReactNode;
  label: string;
  symbol: string;
  percent: number;
}) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        {icon}
        <div>
          <p className="text-xs text-text-muted">{label}</p>
          <p className="font-medium text-text">{symbol}</p>
        </div>
      </div>
      <span
        className={`nums text-sm font-medium ${percent >= 0 ? 'text-positive' : 'text-negative'}`}
      >
        {formatPercent(percent)}
      </span>
    </div>
  );
}

