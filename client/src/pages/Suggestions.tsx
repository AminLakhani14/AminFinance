/**
 * AI suggestions — the whole book ranked against itself in one call.
 *
 * The per-asset insight on the detail page answers "what about this one?".
 * That question asked seven times gives seven independent verdicts that cannot
 * be ordered — typically all "moderate conviction", with nothing to say where
 * the next rupee should go. Ranking is comparative, so it happens in a single
 * request with every asset in front of the model at once.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Sparkles,
  RefreshCw,
  ArrowUpRight,
  ArrowDownRight,
  Minus,
  Plus,
  AlertTriangle,
  Target,
} from 'lucide-react';
import type { Opportunity, OpportunitySet } from '@aminfinance/shared';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { OpportunityChart } from '@/features/ai/OpportunityChart';
import { usePortfolio } from '@/features/portfolio/usePortfolio';
import { useRankOpportunitiesMutation } from '@/services/endpoints';
import { toApiError } from '@/services/api';
import { formatCurrency, formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Actions carry the reserved status colours. `accumulate` and `buy` share
 * green because both put money in; the distinction is in the label, not the
 * colour, so the row still scans at a glance.
 */
const ACTION: Record<
  Opportunity['action'],
  { label: string; className: string; Icon: typeof ArrowUpRight }
> = {
  buy: { label: 'Buy', className: 'text-positive border-positive/30 bg-positive/10', Icon: Plus },
  accumulate: {
    label: 'Accumulate',
    className: 'text-positive border-positive/30 bg-positive/10',
    Icon: ArrowUpRight,
  },
  hold: { label: 'Hold', className: 'text-text-muted border-border bg-surface-sunken', Icon: Minus },
  reduce: {
    label: 'Reduce',
    className: 'text-warning border-warning/30 bg-warning/10',
    Icon: ArrowDownRight,
  },
  sell: {
    label: 'Sell',
    className: 'text-negative border-negative/30 bg-negative/10',
    Icon: ArrowDownRight,
  },
};

/**
 * The composition this session has already asked about.
 *
 * Module-level so it survives unmounting: React Router tears the page down on
 * navigation, and a component-scoped ref would forget, re-firing the request
 * every time the user came back. Paired with the mutation's `fixedCacheKey`,
 * which keeps the *result* across mounts, revisiting an unchanged book renders
 * instantly with no network call at all.
 */
let lastRequestedKey: string | null = null;

export function Suggestions() {
  const { holdings, displayCurrency, isEmpty, isLoading: portfolioLoading } = usePortfolio();
  const [rank, { data, isLoading, error }] = useRankOpportunitiesMutation({
    // Shared across mounts so a result already fetched is still on screen when
    // the user navigates back to this page.
    fixedCacheKey: 'ai-opportunities',
  });
  const [candidateInput, setCandidateInput] = useState('');

  const apiError = toApiError(error);
  const notConfigured = apiError?.code === 'provider_not_configured';

  const candidates = useMemo(
    () =>
      candidateInput
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    [candidateInput],
  );

  function run(refresh = false) {
    void rank({
      holdings: holdings.map((h) => ({
        symbol: h.symbol,
        assetClass: h.assetClass,
        quantity: h.quantity,
        averageCost: h.averageCost,
        allocationPercent: h.allocationPercent,
      })),
      ...(candidates.length > 0 ? { candidates } : {}),
      currency: displayCurrency,
      ...(refresh ? { refresh: true } : {}),
    });
  }

  /**
   * Identity of the book as the ranking sees it. Quantity and cost are in here
   * because they change the answer; market price is not, or every tick would
   * invalidate the ranking and re-request it.
   */
  const bookKey = useMemo(() => {
    if (holdings.length === 0) return '';
    const rows = holdings
      .map((h) => `${h.symbol}:${h.quantity}:${h.averageCost}`)
      .sort()
      .join('|');
    return `${displayCurrency}@${rows}`;
  }, [holdings, displayCurrency]);

  // Run once the book is loaded, without waiting for a click. The server caches
  // a ranking for 24h against this same composition, so an automatic request is
  // usually a cache hit rather than a model call.
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    if (!bookKey || portfolioLoading) return;
    if (lastRequestedKey === bookKey) return;
    lastRequestedKey = bookKey;
    runRef.current(false);
  }, [bookKey, portfolioLoading]);

  // A failed attempt must not poison the page: clear the marker so coming back
  // retries rather than showing the same stale error forever.
  useEffect(() => {
    if (error) lastRequestedKey = null;
  }, [error]);

  // Wait for the book before deciding it is empty — otherwise the first paint
  // shows "add holdings" to someone who has plenty.
  if (portfolioLoading) {
    return (
      <div className="space-y-3" aria-busy="true">
        <div className="h-7 w-44 animate-pulse rounded-md bg-surface-raised" />
        <div className="h-64 animate-pulse rounded-card bg-surface-raised" />
      </div>
    );
  }

  if (isEmpty) {
    return (
      <Card>
        <CardHeader title="AI suggestions" description="Ranking needs something to rank." />
        <CardBody>
          <p className="text-sm text-text-muted">
            Add holdings from{' '}
            <Link to="/portfolio" className="text-accent hover:underline">
              Portfolio
            </Link>
            , or import a CSV, and this page will rank them against each other.
          </p>
        </CardBody>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-text">AI suggestions</h1>
        <p className="mt-1 text-sm text-text-muted">
          Every holding ranked against the others, from live prices and daily-chart indicators.
        </p>
      </div>

      <Card>
        <CardHeader
          title="Ranked opportunities"
          description={`${holdings.length} holding${holdings.length === 1 ? '' : 's'}, one model call.`}
          action={
            data ? (
              <Button size="sm" variant="ghost" onClick={() => run(true)} disabled={isLoading}>
                <RefreshCw className={cn('size-4', isLoading && 'animate-spin')} />
                Regenerate
              </Button>
            ) : undefined
          }
        />
        <CardBody className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="min-w-0 flex-1">
              <span className="text-xs text-text-muted">
                Also consider (optional, comma-separated)
              </span>
              <input
                value={candidateInput}
                onChange={(e) => setCandidateInput(e.target.value)}
                placeholder="ENGRO, ETHUSDT, XAUUSD"
                className={cn(
                  'mt-1 h-9 w-full rounded-lg border border-border bg-surface-sunken px-3',
                  'text-sm text-text placeholder:text-text-subtle',
                  'focus:border-border-strong focus:outline-none',
                )}
              />
            </label>
            <Button
              variant={candidates.length > 0 ? 'primary' : 'secondary'}
              size="md"
              onClick={() => run()}
              disabled={isLoading}
            >
              <Sparkles className="size-4" />
              {candidates.length > 0 ? `Include ${candidates.length}` : 'Re-rank'}
            </Button>
          </div>

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
          ) : isLoading ? (
            <div className="space-y-2" aria-busy="true">
              {holdings.map((h) => (
                <div key={h.symbol} className="h-16 animate-pulse rounded-lg bg-surface-raised" />
              ))}
              <p className="text-xs text-text-subtle">
                Pricing every asset, computing indicators, then one ranking call. Usually 15–30
                seconds.
              </p>
            </div>
          ) : error ? (
            <div className="space-y-2">
              <p className="text-sm text-negative">{apiError?.message ?? 'Ranking failed.'}</p>
              <Button size="sm" variant="secondary" onClick={() => run()}>
                <RefreshCw className="size-4" />
                Try again
              </Button>
            </div>
          ) : data ? (
            <Results data={data} />
          ) : (
            // Only reached in the gap before the automatic request starts.
            <p className="text-sm text-text-subtle">Preparing the ranking…</p>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

// No currency prop: each row is labelled in its own asset's quote currency.
function Results({ data }: { data: OpportunitySet }) {
  return (
    <div className="space-y-4">
      <p className="rounded-lg border border-border bg-surface-sunken px-3 py-2.5 text-sm text-text">
        {data.marketNote}
      </p>

      <ol className="space-y-2">
        {data.opportunities.map((o) => (
          <OpportunityRow key={o.symbol} opportunity={o} />
        ))}
      </ol>

      {data.skipped.length > 0 ? (
        <div className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2.5">
          <p className="flex items-center gap-1.5 text-xs font-medium text-warning">
            <AlertTriangle className="size-3.5" />
            Not ranked
          </p>
          <ul className="mt-1 space-y-0.5">
            {data.skipped.map((s) => (
              <li key={s.symbol} className="text-xs text-text-muted">
                <span className="font-medium text-text">{s.symbol}</span> — {s.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="text-[11px] text-text-subtle">
        Generated {formatDate(data.generatedAt)} · {data.model} · Indicators describe what has
        happened, not what happens next. Not financial advice.
      </p>
    </div>
  );
}

function OpportunityRow({ opportunity }: { opportunity: Opportunity }) {
  const action = ACTION[opportunity.action];
  const { Icon } = action;
  // The asset's own quote currency — a Binance pair is USDT even when the book
  // is reported in PKR, and labelling its stop "PKR" would be plainly wrong.
  const currency = opportunity.currency;

  return (
    <li className="rounded-lg border border-border bg-surface px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="nums w-6 shrink-0 text-sm font-semibold text-text-subtle">
          {opportunity.rank}
        </span>

        <Link
          to={`/asset/${encodeURIComponent(opportunity.symbol)}`}
          className="text-sm font-medium text-text hover:text-accent"
        >
          {opportunity.symbol}
        </Link>

        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
            action.className,
          )}
        >
          <Icon className="size-3" />
          {action.label}
        </span>

        {!opportunity.held ? (
          <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-text-subtle">
            not held
          </span>
        ) : null}

        <span className="ml-auto text-[11px] text-text-subtle">
          {opportunity.conviction} conviction · {opportunity.horizon} term
        </span>
      </div>

      <div className="mt-1.5 flex flex-col gap-3 pl-9 sm:flex-row sm:items-start sm:justify-between">
        <p className="min-w-0 flex-1 text-sm text-text-muted">{opportunity.rationale}</p>
        {/* Defensive: a ranking cached before `series` existed has none, and a
            missing chart must degrade to no chart rather than a thrown read. */}
        {(opportunity.series?.length ?? 0) > 1 ? (
          <div className="shrink-0">
            <OpportunityChart
              series={opportunity.series}
              levels={opportunity.levels}
              price={opportunity.price}
              symbol={opportunity.symbol}
            />
          </div>
        ) : null}
      </div>

      {opportunity.levels &&
      (opportunity.levels.entryZone ||
        opportunity.levels.targets.length > 0 ||
        opportunity.levels.stopLoss !== null) ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 pl-9 text-[11px]">
          <Target className="size-3 text-text-subtle" />
          {opportunity.levels.entryZone ? (
            <span className="text-text-subtle">
              entry{' '}
              <span className="nums text-text-muted">
                {formatCurrency(opportunity.levels.entryZone[0], currency)} –{' '}
                {formatCurrency(opportunity.levels.entryZone[1], currency)}
              </span>
            </span>
          ) : null}
          {opportunity.levels.targets.length > 0 ? (
            <span className="text-text-subtle">
              target{' '}
              <span className="nums text-positive">
                {opportunity.levels.targets
                  .map((t) => formatCurrency(t, currency))
                  .join(' · ')}
              </span>
            </span>
          ) : null}
          {opportunity.levels.stopLoss !== null ? (
            <span className="text-text-subtle">
              stop{' '}
              <span className="nums text-negative">
                {formatCurrency(opportunity.levels.stopLoss, currency)}
              </span>
            </span>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
