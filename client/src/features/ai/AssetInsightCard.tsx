/**
 * Per-asset AI analysis.
 *
 * Rendered from structured output (typed JSON), not parsed prose. Every card
 * shows the exact data snapshot the model saw, so a thin or stale insight is
 * visibly attributable to thin or stale inputs rather than looking authoritative.
 */
import {
  Sparkles,
  TrendingUp,
  TrendingDown,
  ShieldAlert,
  RefreshCw,
  Activity,
  Target,
} from 'lucide-react';
import type {
  AssetClass,
  AssetInsight,
  Verdict,
  InsightPoint,
  TechnicalSnapshot,
  TradeLevels,
} from '@aminfinance/shared';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useAnalyzeAssetMutation } from '@/services/endpoints';
import { toApiError } from '@/services/api';
import { formatCurrency, formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';

interface AssetInsightCardProps {
  symbol: string;
  assetClass: AssetClass;
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
              OPENAI_BASE_URL
            </code>{' '}
            and{' '}
            <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-xs">
              OPENAI_MODEL
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

      {insight.chartRead ? (
        <div>
          <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-text-muted">
            <Activity className="size-3.5" />
            Chart read
          </h3>
          <p className="mt-1.5 text-sm leading-relaxed text-text">{insight.chartRead}</p>
          {insight.basedOn.technicals ? (
            <TechnicalGrid
              technicals={insight.basedOn.technicals}
              currency={insight.basedOn.currency}
            />
          ) : null}
        </div>
      ) : null}

      {insight.levels ? (
        <LevelsPanel levels={insight.levels} currency={insight.basedOn.currency} />
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

/**
 * The indicator readings behind the chart read.
 *
 * Shown alongside the model's prose so a claim like "overbought" can be checked
 * against the RSI it came from — the same auditability principle as `basedOn`.
 */
function TechnicalGrid({
  technicals,
  currency,
}: {
  technicals: TechnicalSnapshot;
  currency: string;
}) {
  const t = technicals;
  const fmt = (v: number | null, digits = 2): string =>
    v === null ? '—' : v.toLocaleString(undefined, { maximumFractionDigits: digits });

  const cells: Array<[string, string]> = [
    ['Trend', t.trend],
    ['RSI(14)', fmt(t.rsi14, 1)],
    ['SMA 20 / 50', `${fmt(t.sma20)} / ${fmt(t.sma50)}`],
    ['SMA 200', fmt(t.sma200)],
    ['ATR(14)', t.atrPercent !== null ? `${fmt(t.atrPercent, 1)}% of price` : '—'],
    ['52w range', `${fmt(t.low52w)} – ${fmt(t.high52w)}`],
    ['Support / resistance', `${fmt(t.support)} / ${fmt(t.resistance)}`],
    ['7 / 30 / 90d', `${fmt(t.changePercent7d, 1)}% / ${fmt(t.changePercent30d, 1)}% / ${fmt(t.changePercent90d, 1)}%`],
  ];

  return (
    <div className="mt-3">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-4">
        {cells.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="truncate text-[11px] text-text-subtle">{label}</dt>
            <dd className="nums truncate text-xs text-text-muted">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-[11px] text-text-subtle">
        From {t.bars} daily bars, in {currency}.
        {t.bars < 50 ? ' Thin history — longer averages are unavailable.' : ''}
      </p>
    </div>
  );
}

/**
 * Proposed entry, targets and stop.
 *
 * Deliberately styled as data rather than as a call to action: these are one
 * model's levels off one chart, and the rationale sits directly underneath so
 * they are never read as a bare instruction.
 */
function LevelsPanel({ levels, currency }: { levels: TradeLevels; currency: string }) {
  const has =
    levels.entryZone !== null || levels.targets.length > 0 || levels.stopLoss !== null;
  if (!has) return null;

  return (
    <div className="rounded-lg border border-border bg-surface-sunken px-3 py-2.5">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-text-muted">
        <Target className="size-3.5" />
        Suggested levels
      </h3>

      <div className="mt-2 flex flex-wrap gap-x-6 gap-y-2">
        {levels.entryZone ? (
          <div>
            <p className="text-[11px] text-text-subtle">Entry zone</p>
            <p className="nums text-sm text-text">
              {formatCurrency(levels.entryZone[0], currency)} –{' '}
              {formatCurrency(levels.entryZone[1], currency)}
            </p>
          </div>
        ) : null}
        {levels.targets.length > 0 ? (
          <div>
            <p className="text-[11px] text-text-subtle">Targets</p>
            <p className="nums text-sm text-positive">
              {levels.targets.map((t) => formatCurrency(t, currency)).join(' · ')}
            </p>
          </div>
        ) : null}
        {levels.stopLoss !== null ? (
          <div>
            <p className="text-[11px] text-text-subtle">Stop-loss</p>
            <p className="nums text-sm text-negative">
              {formatCurrency(levels.stopLoss, currency)}
            </p>
          </div>
        ) : null}
      </div>

      <p className="mt-2 text-xs text-text-muted">{levels.rationale}</p>
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
