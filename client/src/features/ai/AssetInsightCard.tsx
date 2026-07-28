/**
 * Per-asset AI analysis.
 *
 * Rendered from structured output (typed JSON), not parsed prose. Every card
 * shows the exact data snapshot the model saw, so a thin or stale insight is
 * visibly attributable to thin or stale inputs rather than looking authoritative.
 */
import { Sparkles, TrendingUp, TrendingDown, ShieldAlert, RefreshCw } from 'lucide-react';
import type { AssetInsight, Verdict, InsightPoint } from '@aminfinance/shared';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useAnalyzeAssetMutation } from '@/services/endpoints';
import { toApiError } from '@/services/api';
import { formatCurrency, formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';

interface AssetInsightCardProps {
  symbol: string;
  assetClass: 'stock' | 'crypto';
  position?: { quantity: number; averageCost: number } | undefined;
}

/**
 * Verdicts get status colours, which are reserved and never reused for series.
 * Each ships with a label, so the meaning never rests on colour alone.
 */
const VERDICT_STYLE: Record<Verdict, { label: string; className: string }> = {
  buy: { label: 'Buy', className: 'bg-positive/15 text-positive border-positive/30' },
  hold: { label: 'Hold', className: 'bg-surface-sunken text-text-muted border-border' },
  reduce: { label: 'Reduce', className: 'bg-warning/15 text-warning border-warning/30' },
  sell: { label: 'Sell', className: 'bg-negative/15 text-negative border-negative/30' },
};

export function AssetInsightCard({ symbol, assetClass, position }: AssetInsightCardProps) {
  const [analyze, { data, isLoading, error }] = useAnalyzeAssetMutation();
  const apiError = toApiError(error);
  const notConfigured = apiError?.code === 'provider_not_configured';

  function run(refresh = false) {
    void analyze({
      symbol,
      assetClass,
      ...(position ? { position } : {}),
      ...(refresh ? { refresh: true } : {}),
    });
  }

  return (
    <Card>
      <CardHeader
        title="AI analysis"
        description="Grounded in the data shown below — not live market access."
        action={
          data ? (
            <Button size="sm" variant="ghost" onClick={() => run(true)} disabled={isLoading}>
              <RefreshCw className={cn('size-4', isLoading && 'animate-spin')} />
            </Button>
          ) : null
        }
      />
      <CardBody>
        {notConfigured ? (
          <p className="text-sm text-text-muted">
            Set{' '}
            <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-xs">
              ANTHROPIC_API_KEY
            </code>{' '}
            in <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-xs">server/.env</code>{' '}
            to enable AI analysis.
          </p>
        ) : !data && !isLoading ? (
          <div className="flex flex-col items-start gap-3">
            <p className="text-sm text-text-muted">
              Generate an analysis of {symbol}
              {position ? ' against your actual cost basis' : ''}.
            </p>
            <Button variant="primary" size="sm" onClick={() => run()}>
              <Sparkles className="size-4" />
              Analyze
            </Button>
          </div>
        ) : isLoading ? (
          <div className="space-y-3" aria-busy="true">
            <div className="h-4 w-28 animate-pulse rounded bg-surface-raised" />
            <div className="h-16 animate-pulse rounded bg-surface-raised" />
            <p className="text-xs text-text-subtle">
              Thinking — this can take up to a minute.
            </p>
          </div>
        ) : error ? (
          <p className="text-sm text-negative">{apiError?.message ?? 'Analysis failed.'}</p>
        ) : data ? (
          <InsightBody insight={data} />
        ) : null}
      </CardBody>
    </Card>
  );
}

function InsightBody({ insight }: { insight: AssetInsight }) {
  const verdict = VERDICT_STYLE[insight.verdict];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            'rounded-full border px-2.5 py-1 text-xs font-semibold',
            verdict.className,
          )}
        >
          {verdict.label}
        </span>
        <span className="rounded-full border border-border px-2.5 py-1 text-xs text-text-muted">
          {insight.confidence} confidence
        </span>
        <span className="rounded-full border border-border px-2.5 py-1 text-xs text-text-muted">
          {insight.horizon} term
        </span>
      </div>

      <p className="text-sm leading-relaxed text-text">{insight.summary}</p>

      {insight.positionNote ? (
        <div className="rounded-lg border border-accent/30 bg-accent/5 px-3 py-2.5">
          <p className="text-xs font-medium text-accent">On your position</p>
          <p className="mt-1 text-sm text-text">{insight.positionNote}</p>
        </div>
      ) : null}

      <div className="grid gap-5 md:grid-cols-2">
        <PointList
          title="Bull case"
          icon={<TrendingUp className="size-3.5 text-positive" />}
          points={insight.bullCase}
        />
        <PointList
          title="Bear case"
          icon={<TrendingDown className="size-3.5 text-negative" />}
          points={insight.bearCase}
        />
      </div>

      {insight.risks.length > 0 ? (
        <PointList
          title="Key risks"
          icon={<ShieldAlert className="size-3.5 text-warning" />}
          points={insight.risks}
        />
      ) : null}

      {/* Provenance: what the model actually saw. */}
      <details className="rounded-lg border border-border bg-surface-sunken px-3 py-2">
        <summary className="cursor-pointer text-xs font-medium text-text-muted">
          Data this was based on
        </summary>
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
          <Row label="Price" value={formatCurrency(insight.basedOn.price, insight.basedOn.currency)} />
          <Row label="Change" value={`${insight.basedOn.changePercent.toFixed(2)}%`} />
          <Row
            label="Market cap"
            value={insight.basedOn.marketCap ? insight.basedOn.marketCap.toLocaleString() : '—'}
          />
          <Row label="P/E" value={insight.basedOn.peRatio?.toString() ?? '—'} />
          <Row
            label="Your cost"
            value={
              insight.basedOn.userCostBasis
                ? formatCurrency(insight.basedOn.userCostBasis, insight.basedOn.currency)
                : '—'
            }
          />
          <Row label="Headlines" value={String(insight.basedOn.headlines.length)} />
        </dl>
        <p className="mt-2 text-[11px] text-text-subtle">
          Generated {formatDate(insight.generatedAt)} · {insight.model}
        </p>
      </details>

      <p className="text-[11px] leading-relaxed text-text-subtle">
        Not financial advice. This is one input into your own decision, produced by a
        language model from the data above — it has no live market access and can be
        wrong.
      </p>
    </div>
  );
}

function PointList({
  title,
  icon,
  points,
}: {
  title: string;
  icon: React.ReactNode;
  points: InsightPoint[];
}) {
  if (points.length === 0) return null;
  return (
    <div>
      <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-text-muted">
        {icon}
        {title}
      </h3>
      <ul className="mt-2 space-y-2.5">
        {points.map((point) => (
          <li key={point.title}>
            <p className="text-sm font-medium text-text">{point.title}</p>
            <p className="mt-0.5 text-sm leading-relaxed text-text-muted">{point.detail}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-text-subtle">{label}</dt>
      <dd className="nums text-right text-text-muted">{value}</dd>
    </>
  );
}
