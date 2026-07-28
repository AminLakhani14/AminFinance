import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, WifiOff } from 'lucide-react';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { StatTile } from '@/components/ui/StatTile';
import { DonutChart } from '@/components/charts/DonutChart';
import { AreaChart, type AreaPoint } from '@/components/charts/AreaChart';
import { HoldingsTable } from '@/features/portfolio/HoldingsTable';
import { usePortfolio } from '@/features/portfolio/usePortfolio';
import { useSparklines } from '@/features/portfolio/useCandleSeries';
import { useGetHealthQuery, toApiError } from '@/services/api';
import { useGetCandlesQuery } from '@/services/endpoints';
import { formatCurrency, formatPercent } from '@/lib/format';
import { SetupChecklist } from '@/features/settings/SetupChecklist';
import { HeroVisual } from '@/components/three/HeroVisual';

export function Dashboard() {
  const { holdings, summary, convert, displayCurrency, isEmpty, isLoading } = usePortfolio();
  const health = useGetHealthQuery(undefined, { pollingInterval: 30_000 });
  const sparklines = useSparklines(holdings.map((h) => h.symbol));

  const allocation = useMemo(
    () =>
      holdings.map((h) => ({
        symbol: h.symbol,
        value: convert(h.marketValue, h.currency),
      })),
    [holdings, convert],
  );

  if (health.isError) {
    return (
      <div className="space-y-6">
        <PageHeading />
        <Card>
          <CardBody className="flex flex-col items-center gap-3 py-16 text-center">
            <WifiOff className="size-6 text-negative" />
            <p className="text-sm font-medium text-text">
              {toApiError(health.error)?.message ?? 'Cannot reach the server.'}
            </p>
            <p className="max-w-sm text-sm text-text-muted">
              Every price comes through the local proxy. Start it with{' '}
              <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-xs">
                npm run dev
              </code>
              .
            </p>
          </CardBody>
        </Card>
      </div>
    );
  }

  if (isEmpty && !isLoading) {
    return (
      <div className="space-y-6">
        <PageHeading />
        <Card>
          <CardBody className="flex flex-col items-center gap-4 py-14 text-center">
            <div>
              <h2 className="text-base font-semibold text-text">No holdings yet</h2>
              <p className="mt-1 max-w-sm text-sm text-text-muted">
                Add a PSX or crypto transaction, or import your Binance trade history,
                and everything else fills in.
              </p>
            </div>
            <Link
              to="/portfolio"
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-fg transition-colors hover:bg-accent-hover"
            >
              Go to portfolio
              <ArrowRight className="size-4" />
            </Link>
          </CardBody>
        </Card>
        <SetupChecklist />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeading />

      <Card className="relative overflow-hidden">
        {/* Atmosphere only — the stat tiles below are the accessible reading. */}
        <div className="pointer-events-none absolute inset-x-0 top-0">
          <HeroVisual changePercent={summary.dayChangePercent} />
        </div>
        <CardBody className="relative grid grid-cols-2 gap-6 lg:grid-cols-4">
          <StatTile
            label="Total value"
            value={formatCurrency(summary.totalValue, displayCurrency, { compact: true })}
            delta={summary.dayChangePercent}
            deltaLabel={`${formatPercent(summary.dayChangePercent)} today`}
          />
          <StatTile
            label="Invested"
            value={formatCurrency(summary.totalCostBasis, displayCurrency, { compact: true })}
            hint={`${summary.holdingsCount} holding${summary.holdingsCount === 1 ? '' : 's'}`}
          />
          <StatTile
            label="Unrealised P/L"
            value={formatCurrency(summary.totalUnrealizedPnl, displayCurrency, { compact: true })}
            delta={summary.totalUnrealizedPnlPercent}
          />
          <StatTile
            label="Today"
            value={formatCurrency(summary.dayChange, displayCurrency, { compact: true })}
            delta={summary.dayChangePercent}
          />
        </CardBody>
      </Card>

      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader
            title="Portfolio value"
            description="Reconstructed from current holdings and their price history."
          />
          <CardBody>
            <PortfolioHistory
              holdings={holdings}
              convert={convert}
              displayCurrency={displayCurrency}
              costBasis={summary.totalCostBasis}
            />
          </CardBody>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader title="Allocation" description="Share of total market value" />
          <CardBody>
            <DonutChart data={allocation} currency={displayCurrency} />
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader title="Holdings" description={`${holdings.length} open positions`} />
        <CardBody className="p-0">
          <HoldingsTable
            holdings={holdings}
            sparklines={sparklines}
            convert={convert}
            displayCurrency={displayCurrency}
          />
        </CardBody>
      </Card>
    </div>
  );
}

function PageHeading() {
  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight text-text">Dashboard</h1>
      <p className="mt-1 text-sm text-text-muted">
        Your combined PSX and crypto position.
      </p>
    </div>
  );
}

/**
 * Value history.
 *
 * Built from the largest holding's price series with quantities held constant,
 * so it shows how the *current* book would have moved — not actual past
 * performance, since we don't have per-day historical positions. The caption
 * says so; presenting it as realised history would be a lie.
 */
function PortfolioHistory({
  holdings,
  convert,
  displayCurrency,
  costBasis,
}: {
  holdings: Array<{ symbol: string; quantity: number; currency: string; marketValue: number }>;
  convert: (amount: number, currency: string) => number;
  displayCurrency: string;
  costBasis: number;
}) {
  const anchor = holdings[0];
  const { data } = useGetCandlesQuery(
    { symbol: anchor?.symbol ?? '', interval: '1d', limit: 180 },
    { skip: !anchor },
  );

  const points = useMemo((): AreaPoint[] => {
    if (!data || !anchor) return [];
    // Scale the anchor's series by the whole book's value so the shape is the
    // portfolio's, anchored to today's real total.
    const latest = data.candles[data.candles.length - 1]?.close ?? 1;
    const totalToday = holdings.reduce((sum, h) => sum + convert(h.marketValue, h.currency), 0);
    return data.candles.map((c) => ({
      timestamp: c.time * 1000,
      value: (c.close / latest) * totalToday,
    }));
  }, [data, anchor, holdings, convert]);

  return (
    <AreaChart
      data={points}
      currency={displayCurrency}
      baseline={costBasis > 0 ? costBasis : null}
    />
  );
}
