/**
 * Whole-portfolio AI review — concentration, diversification, rebalancing.
 */
import { Sparkles, AlertTriangle, ArrowUpRight, ArrowDownRight, Minus } from 'lucide-react';
import type { PortfolioReview } from '@aminfinance/shared';
import type { HoldingWithFlags } from '@/lib/calc/costBasis';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useReviewPortfolioMutation } from '@/services/endpoints';
import { toApiError } from '@/services/api';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';

export function PortfolioReviewCard({
  holdings,
  currency,
}: {
  holdings: HoldingWithFlags[];
  currency: string;
}) {
  const [review, { data, isLoading, error }] = useReviewPortfolioMutation();
  const apiError = toApiError(error);
  const notConfigured = apiError?.code === 'provider_not_configured';

  function run(refresh = false) {
    void review({
      holdings: holdings.map((h) => ({
        symbol: h.symbol,
        assetClass: h.assetClass,
        quantity: h.quantity,
        averageCost: h.averageCost,
        allocationPercent: h.allocationPercent,
      })),
      currency,
      ...(refresh ? { refresh: true } : {}),
    });
  }

  if (holdings.length === 0) return null;

  return (
    <Card>
      <CardHeader
        title="Portfolio review"
        description="Concentration, diversification, and rebalancing."
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
            in server/.env to enable this.
          </p>
        ) : !data && !isLoading ? (
          <Button variant="primary" size="sm" onClick={() => run()}>
            <Sparkles className="size-4" />
            Review my portfolio
          </Button>
        ) : isLoading ? (
          <div className="space-y-3" aria-busy="true">
            <div className="h-4 w-40 animate-pulse rounded bg-surface-raised" />
            <div className="h-20 animate-pulse rounded bg-surface-raised" />
          </div>
        ) : error ? (
          <p className="text-sm text-negative">{apiError?.message ?? 'Review failed.'}</p>
        ) : data ? (
          <ReviewBody review={data} onRefresh={() => run(true)} />
        ) : null}
      </CardBody>
    </Card>
  );
}

function ReviewBody({ review, onRefresh }: { review: PortfolioReview; onRefresh: () => void }) {
  return (
    <div className="space-y-5">
      <p className="text-sm leading-relaxed text-text">{review.summary}</p>

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
          Diversification
        </h3>
        <p className="mt-1.5 text-sm text-text">{review.diversification.assessment}</p>
        {review.diversification.gaps.length > 0 ? (
          <ul className="mt-2 space-y-1">
            {review.diversification.gaps.map((gap) => (
              <li key={gap} className="flex gap-2 text-sm text-text-muted">
                <span className="mt-1.5 size-1 shrink-0 rounded-full bg-text-subtle" aria-hidden />
                {gap}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {review.concentrationFlags.length > 0 ? (
        <div>
          <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-text-muted">
            <AlertTriangle className="size-3.5 text-warning" />
            Concentration
          </h3>
          <ul className="mt-2 space-y-2">
            {review.concentrationFlags.map((flag) => (
              <li key={flag.symbol} className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-text">{flag.symbol}</span>
                  <span className="nums text-sm text-warning">
                    {flag.allocationPercent.toFixed(1)}%
                  </span>
                </div>
                <p className="mt-1 text-sm text-text-muted">{flag.note}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {review.rebalancing.length > 0 ? (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
            Rebalancing
          </h3>
          <ul className="mt-2 space-y-2">
            {review.rebalancing.map((item) => {
              const Icon =
                item.action === 'increase'
                  ? ArrowUpRight
                  : item.action === 'decrease'
                    ? ArrowDownRight
                    : Minus;
              return (
                <li key={item.symbol} className="flex gap-3">
                  <Icon
                    className={cn(
                      'mt-0.5 size-4 shrink-0',
                      item.action === 'increase'
                        ? 'text-positive'
                        : item.action === 'decrease'
                          ? 'text-negative'
                          : 'text-text-subtle',
                    )}
                  />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-text">
                      {item.symbol}{' '}
                      <span className="font-normal text-text-muted">
                        — {item.action}
                        {item.targetPercent !== null ? ` to ~${item.targetPercent}%` : ''}
                      </span>
                    </p>
                    <p className="mt-0.5 text-sm text-text-muted">{item.rationale}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      <div className="flex items-center justify-between border-t border-border pt-3">
        <p className="text-[11px] text-text-subtle">
          Generated {formatDate(review.generatedAt)} · {review.model} · Not financial advice.
        </p>
        <Button size="sm" variant="ghost" onClick={onRefresh}>
          Regenerate
        </Button>
      </div>
    </div>
  );
}
