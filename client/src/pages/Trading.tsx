/**
 * Trading desk — buy and sell prices from today's charts.
 *
 * Two questions, answered separately:
 *
 *  1. "What do I do with what I own?" Every holding gets a plan — add, hold,
 *     take profit or sell, at which prices — and a hold period, so the page
 *     says outright which positions are long-term holds and which are trades.
 *  2. "What should I buy?" The server screens the most-traded PSX stocks and
 *     Binance coins on their daily charts and plans the best few setups among
 *     names not already owned.
 *
 * Both load on arrival and both are fast: the server's chart engine answers in
 * milliseconds from cache, a second or two cold. Each plan's AI review runs in
 * the background on the server, and the page polls — cheaply — while any are
 * still pending, filling them in as they land.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  Anchor,
  ArrowDownToLine,
  Ban,
  CalendarClock,
  LoaderCircle,
  LogOut,
  Plus,
  Radar,
  RefreshCw,
  Sparkles,
  Wallet,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { AssetClass, TradePlan, TradingDesk, TradingRequest } from '@aminfinance/shared';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { StatTile } from '@/components/ui/StatTile';
import { usePortfolio } from '@/features/portfolio/usePortfolio';
import { useIssuerLogos } from '@/features/market/useIssuerLogos';
import { useStreamedSymbols } from '@/features/market/useLivePrice';
import { TradePlanCard } from '@/features/trading/TradePlanCard';
import { useGetTradingDeskQuery, usePlanTradesMutation } from '@/services/endpoints';
import { toApiError } from '@/services/api';
import { formatDate, formatTime } from '@/lib/format';
import { cn } from '@/lib/utils';

/** How often to re-ask while AI reviews are landing. Each ask is milliseconds server-side. */
const POLL_MS = 2500;

type Filter = 'all' | AssetClass;

const FILTER_LABEL: Record<Filter, string> = {
  all: 'All',
  stock: 'Stocks',
  crypto: 'Crypto',
  commodity: 'Metals',
};

interface Group {
  key: string;
  title: string;
  blurb: string;
  Icon: LucideIcon;
  match: (plan: TradePlan) => boolean;
  /** Folded away by default — present for completeness, not for action. */
  collapsed?: boolean;
}

/**
 * Holdings, grouped by how long each deserves to be kept.
 *
 * An exit outranks its hold period — a long-term name the review says to sell
 * belongs under "sell", not hidden among the keepers — so it is matched first.
 */
const HOLDING_GROUPS: Group[] = [
  {
    key: 'exit',
    title: 'Sell — exit these',
    blurb: 'More risk in staying than reason to hold.',
    Icon: LogOut,
    match: (p) => p.signal === 'sell',
  },
  {
    key: 'long-term',
    title: 'Hold for the long term',
    blurb: 'Core holdings worth keeping for a year or more. A dip is a chance to add, not a reason to sell.',
    Icon: Anchor,
    match: (p) => p.signal !== 'sell' && p.holdPeriod === 'long-term',
  },
  {
    key: 'medium-term',
    title: 'Hold for a few months',
    blurb: 'Worth keeping while the current trend plays out. Review when price reaches a target.',
    Icon: CalendarClock,
    match: (p) => p.signal !== 'sell' && p.holdPeriod === 'medium-term',
  },
  {
    key: 'short-term',
    title: 'Trade it — short term',
    blurb: 'A trade, not an investment: sell at the targets, and respect the stop.',
    Icon: Zap,
    match: (p) => p.signal !== 'sell' && p.holdPeriod === 'short-term',
  },
];

const MARKET_GROUPS: Group[] = [
  {
    key: 'buy-now',
    title: 'Buy now',
    blurb: 'Price is inside the buy zone today.',
    Icon: Plus,
    match: (p) => p.signal === 'buy-now',
  },
  {
    key: 'buy-on-dip',
    title: 'Buy on a dip',
    blurb: 'Good setups, but only at the lower price. Set a price alert at the top of the buy zone.',
    Icon: ArrowDownToLine,
    match: (p) => p.signal === 'buy-on-dip',
  },
  {
    key: 'avoid',
    title: 'Not now',
    blurb: 'Passed the chart screen, but the setup is not worth the risk today.',
    Icon: Ban,
    match: (p) => p.signal === 'avoid',
    collapsed: true,
  },
];

/**
 * One section's desk: the polling query, plus the one-shot refresh.
 *
 * Polling switches itself on while any review is pending and off once all
 * have landed, so an idle page makes no requests at all.
 */
function useDesk(request: TradingRequest, skip: boolean) {
  const [poll, setPoll] = useState(0);
  const query = useGetTradingDeskQuery(request, {
    skip,
    pollingInterval: poll,
    skipPollingIfUnfocused: true,
  });
  const pending = query.data?.aiPending ?? 0;
  useEffect(() => setPoll(pending > 0 ? POLL_MS : 0), [pending]);

  const [refreshDesk, refreshState] = usePlanTradesMutation();
  const { refetch } = query;
  const refresh = () => {
    void refreshDesk({ ...request, refresh: true })
      .unwrap()
      .catch(() => undefined)
      .finally(() => {
        // The refresh restarted the reviews; the next read sees them pending
        // and polling picks up from there.
        void refetch();
      });
  };

  return {
    data: query.data,
    error: query.error ?? refreshState.error,
    isLoading: query.isLoading,
    isRefreshing: refreshState.isLoading,
    refresh,
    retry: () => void refetch(),
  };
}

export function Trading() {
  const { holdings, quotes, isEmpty, isLoading: portfolioLoading } = usePortfolio();
  const [filter, setFilter] = useState<Filter>('all');

  // Size and cost change the plan; price does not. The query keys on these
  // serialised values, so a price tick never re-requests.
  const book = useMemo<TradingRequest['holdings']>(
    () =>
      holdings.map((h) => ({
        symbol: h.symbol,
        assetClass: h.assetClass,
        quantity: h.quantity,
        averageCost: h.costBasisKnown ? h.averageCost : 0,
      })),
    [holdings],
  );

  const holdingsDesk = useDesk({ scope: 'holdings', holdings: book }, portfolioLoading || book.length === 0);
  // Waits for the book so the scan can leave out what is already owned,
  // rather than scanning once without it and again with it.
  const marketDesk = useDesk(
    { scope: 'market', holdings: book, assetClasses: ['stock', 'crypto'] },
    portfolioLoading,
  );

  const allPlans = useMemo(
    () => [...(holdingsDesk.data?.plans ?? []), ...(marketDesk.data?.plans ?? [])],
    [holdingsDesk.data, marketDesk.data],
  );

  // Keep crypto prices streaming while the page is open, so each card can
  // re-check its zone, targets and stop against the live price.
  useStreamedSymbols(allPlans);

  const logos = useIssuerLogos(
    useMemo(
      () => allPlans.filter((p) => p.assetClass === 'stock').map((p) => p.symbol),
      [allPlans],
    ),
  );

  const filters = useMemo<Filter[]>(() => {
    const present = new Set(allPlans.map((p) => p.assetClass));
    return ['all', 'stock', 'crypto', ...(present.has('commodity') ? (['commodity'] as const) : [])];
  }, [allPlans]);

  const visible = (plans: TradePlan[]) =>
    filter === 'all' ? plans : plans.filter((p) => p.assetClass === filter);

  const quotePrice = (symbol: string) => quotes.get(symbol)?.price ?? null;

  if (portfolioLoading) {
    return (
      <div className="space-y-3" aria-busy="true">
        <div className="h-7 w-44 animate-pulse rounded-md bg-surface-raised" />
        <div className="h-64 animate-pulse rounded-card bg-surface-raised" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-text">Trading desk</h1>
        <p className="mt-1 text-sm text-text-muted">
          Where to buy, where to sell and where to cut the loss — read from today's daily charts,
          reviewed by AI, for what you own and for the market's best setups.
        </p>
      </div>

      {/* One filter row, scoping both sections below it. */}
      <div role="radiogroup" aria-label="Show" className="inline-flex rounded-xl border border-border bg-surface p-1">
        {filters.map((f) => (
          <button
            key={f}
            role="radio"
            aria-checked={filter === f}
            onClick={() => setFilter(f)}
            className={cn(
              'rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
              filter === f ? 'bg-accent/15 text-accent' : 'text-text-muted hover:text-text',
            )}
          >
            {FILTER_LABEL[f]}
          </button>
        ))}
      </div>

      <Card>
        <CardHeader
          title={
            <span className="inline-flex items-center gap-2">
              <Wallet className="size-4 text-text-muted" />
              Your holdings
            </span>
          }
          description="What to do with each position, and which ones to keep for the long run."
          action={
            holdingsDesk.data ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={holdingsDesk.refresh}
                disabled={holdingsDesk.isRefreshing}
                title="Re-read the charts and ask the AI again"
              >
                <RefreshCw className={cn('size-4', holdingsDesk.isRefreshing && 'animate-spin')} />
                Regenerate
              </Button>
            ) : undefined
          }
        />
        <CardBody>
          {isEmpty ? (
            <p className="text-sm text-text-muted">
              Add holdings from{' '}
              <Link to="/portfolio" className="text-accent hover:underline">
                Portfolio
              </Link>{' '}
              and each one gets a plan here — add, hold, take profit or sell, and whether to keep it
              for the long term. The market scan below works in the meantime.
            </p>
          ) : (
            <DeskBody
              desk={holdingsDesk}
              loadingNote={`Pricing ${book.length} holding${book.length === 1 ? '' : 's'} and reading their charts…`}
              render={(desk) => (
                <>
                  <HoldPeriodTiles plans={visible(desk.plans)} />
                  <Groups
                    groups={HOLDING_GROUPS}
                    plans={visible(desk.plans)}
                    quotePrice={quotePrice}
                    logos={logos}
                    empty="None of your holdings are in this market."
                  />
                </>
              )}
            />
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title={
            <span className="inline-flex items-center gap-2">
              <Radar className="size-4 text-text-muted" />
              Market scan
            </span>
          }
          description="The 30 most-traded PSX stocks and 30 Binance coins you don't own, screened on their charts. The best setups get a full plan."
          action={
            marketDesk.data ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={marketDesk.refresh}
                disabled={marketDesk.isRefreshing}
                title="Screen the market again and ask the AI again"
              >
                <RefreshCw className={cn('size-4', marketDesk.isRefreshing && 'animate-spin')} />
                Rescan
              </Button>
            ) : undefined
          }
        />
        <CardBody>
          <DeskBody
            desk={marketDesk}
            loadingNote="Charting about 60 instruments and shortlisting the best setups…"
            render={(desk) => (
              <>
                {desk.screened.length > 0 ? (
                  <p className="text-[11px] text-text-subtle">
                    Screened{' '}
                    {desk.screened
                      .map(
                        (s) =>
                          `${s.universe} ${s.assetClass === 'stock' ? 'stocks' : 'coins'} → ${s.shortlisted} shortlisted`,
                      )
                      .join(' · ')}
                    . Looks for pullbacks in uptrends with room to run; liquid names only.
                  </p>
                ) : null}
                <Groups
                  groups={MARKET_GROUPS}
                  plans={visible(desk.plans)}
                  quotePrice={() => null}
                  logos={logos}
                  empty="The scan shortlisted nothing in this market."
                />
              </>
            )}
          />
        </CardBody>
      </Card>

      <p className="text-[11px] text-text-subtle">
        Levels come from daily charts and describe what has happened, not what will. A stop only
        protects you if you actually place it. This is one input into your own decision — not
        financial advice.
      </p>
    </div>
  );
}

/** Loading, error and result framing shared by both sections. */
function DeskBody({
  desk: state,
  loadingNote,
  render,
}: {
  desk: ReturnType<typeof useDesk>;
  loadingNote: string;
  render: (desk: TradingDesk) => ReactNode;
}) {
  const apiError = toApiError(state.error);

  if (state.isLoading && !state.data) {
    return (
      <div className="space-y-3" aria-busy="true">
        <div className="grid gap-3 lg:grid-cols-2">
          {[0, 1].map((i) => (
            <div key={i} className="h-80 animate-pulse rounded-xl bg-surface-raised" />
          ))}
        </div>
        <p className="text-xs text-text-subtle">{loadingNote}</p>
      </div>
    );
  }

  if (state.error && !state.data) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-negative">{apiError?.message ?? 'The trading desk request failed.'}</p>
        <Button size="sm" variant="secondary" onClick={state.retry}>
          <RefreshCw className="size-4" />
          Try again
        </Button>
      </div>
    );
  }

  const desk = state.data;
  if (!desk) return null;

  const reviewed = desk.plans.filter((p) => p.ai.status === 'ready').length;
  const reviewable = desk.plans.filter((p) => p.ai.status !== 'skipped').length;

  return (
    // A refresh keeps the current plans on screen, dimmed, rather than
    // flashing back to a skeleton.
    <div
      className={cn('space-y-5 transition-opacity', state.isRefreshing && 'opacity-60')}
      aria-busy={state.isRefreshing}
    >
      {state.error ? (
        <p className="text-xs text-negative">
          {apiError?.message ?? 'Refreshing failed.'} Showing the previous plan.
        </p>
      ) : null}

      <div className="space-y-2 rounded-lg border border-border bg-surface-sunken px-3 py-2.5">
        <p className="text-sm text-text">{desk.marketView}</p>
        {desk.pulse.length > 0 ? (
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-text-subtle">
            {desk.pulse.map((p) => (
              <span key={p.assetClass}>
                {p.assetClass === 'stock' ? 'PSX today' : 'Top 100 coins, 24h'}:{' '}
                <span className="nums text-positive">▲ {p.advancers}</span>{' '}
                <span className="nums text-negative">▼ {p.decliners}</span>
                {p.benchmark ? (
                  <>
                    {' '}
                    · {p.benchmark.symbol === 'KSE100' ? 'KSE-100' : p.benchmark.symbol.replace(/USDT$/, '')}{' '}
                    {p.benchmark.trend}
                    {p.benchmark.rsi14 !== null ? `, RSI ${Math.round(p.benchmark.rsi14)}` : ''}
                  </>
                ) : null}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      {/* Where the AI stands — progress while reviews land, or why there are none. */}
      {desk.model === null ? (
        <p className="text-xs text-text-subtle">
          Plans below come from the chart engine alone. Set{' '}
          <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px]">OPENAI_BASE_URL</code>{' '}
          and <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px]">OPENAI_MODEL</code>{' '}
          in server/.env to add an AI review of each.
        </p>
      ) : desk.aiPending > 0 ? (
        <p className="flex items-center gap-1.5 text-xs text-text-muted" role="status">
          <LoaderCircle className="size-3.5 animate-spin text-accent" aria-hidden />
          AI reviewing — {reviewed} of {reviewable} done. Plans are usable now; reviews fill in as they
          land.
        </p>
      ) : reviewable > 0 ? (
        <p className="flex items-center gap-1.5 text-xs text-text-subtle">
          <Sparkles className="size-3.5 text-accent" aria-hidden />
          {reviewed} of {reviewable} plans reviewed by {desk.model}.
        </p>
      ) : null}

      {render(desk)}

      {desk.skipped.length > 0 ? (
        <div className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2.5">
          <p className="flex items-center gap-1.5 text-xs font-medium text-warning">
            <AlertTriangle className="size-3.5" />
            Not planned
          </p>
          <ul className="mt-1 space-y-0.5">
            {desk.skipped.map((s) => (
              <li key={s.symbol} className="text-xs text-text-muted">
                <span className="font-medium text-text">{s.symbol}</span> — {s.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="text-[11px] text-text-subtle">
        Prices as of {formatDate(desk.generatedAt)} at {formatTime(desk.generatedAt)}
        {desk.model ? ` · AI review by ${desk.model}` : ''}
      </p>
    </div>
  );
}

/** The answer to "which of these do I just hold?", before the detail. */
function HoldPeriodTiles({ plans }: { plans: TradePlan[] }) {
  if (plans.length === 0) return null;
  const count = (key: string) =>
    plans.filter((p) => HOLDING_GROUPS.find((g) => g.key === key)?.match(p)).length;
  return (
    <div className="grid grid-cols-2 gap-4 rounded-lg border border-border/70 px-4 py-3 sm:grid-cols-4">
      <StatTile label="Long-term holds" value={`${count('long-term')} of ${plans.length}`} />
      <StatTile label="Hold for months" value={String(count('medium-term'))} />
      <StatTile label="Short-term trades" value={String(count('short-term'))} />
      <StatTile label="Sell" value={String(count('exit'))} />
    </div>
  );
}

function Groups({
  groups,
  plans,
  quotePrice,
  logos,
  empty,
}: {
  groups: Group[];
  plans: TradePlan[];
  quotePrice: (symbol: string) => number | null;
  logos: Map<string, string | null>;
  empty: string;
}) {
  if (plans.length === 0) return <p className="text-sm text-text-subtle">{empty}</p>;

  return (
    <div className="space-y-5">
      {groups.map((group) => {
        const members = plans.filter(group.match);
        if (members.length === 0) return null;

        const heading = (
          <span className="flex items-center gap-2">
            <group.Icon className="size-4 text-text-muted" aria-hidden />
            <span className="text-sm font-semibold text-text">{group.title}</span>
            <span className="nums text-xs text-text-subtle">{members.length}</span>
          </span>
        );
        const cards = (
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            {members.map((plan) => (
              <TradePlanCard
                key={plan.symbol}
                plan={plan}
                quotePrice={plan.held ? quotePrice(plan.symbol) : null}
                logoUrl={logos.get(plan.symbol)}
              />
            ))}
          </div>
        );

        return group.collapsed ? (
          <details key={group.key} className="group/section">
            <summary className="cursor-pointer list-none">
              {heading}
              <span className="mt-0.5 block text-xs text-text-muted">
                {group.blurb} <span className="text-text-subtle group-open/section:hidden">Show</span>
              </span>
            </summary>
            {cards}
          </details>
        ) : (
          <section key={group.key}>
            {heading}
            <p className="mt-0.5 text-xs text-text-muted">{group.blurb}</p>
            {cards}
          </section>
        );
      })}
    </div>
  );
}
