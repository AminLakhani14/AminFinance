/**
 * AI suggestions — each asset class ranked against itself.
 *
 * The per-asset insight on the detail page answers "what about this one?".
 * That question asked seven times gives seven independent verdicts that cannot
 * be ordered — typically all "moderate conviction", with nothing to say where
 * the next rupee should go. Ranking is comparative, so it happens in one
 * request per class with every asset of that class in front of the model.
 *
 * Three calls rather than one. A single global ranking is cheaper and lets the
 * model reason across currencies, but it numbers the whole set 1..N, so the
 * stocks section reads "1, 4, 5" and the coins "2, 6" — ranks that only make
 * sense against rows the reader cannot see. Splitting the call gives each
 * section its own 1..N and its own commentary, at the cost of three waits and
 * no cross-class comparison.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  Landmark,
  Bitcoin,
  Gem,
} from 'lucide-react';
import type {
  AssetClass,
  Opportunity,
  OpportunitySet,
  MarketRow,
  OpportunitiesRequest,
} from '@aminfinance/shared';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { OpportunityChart } from '@/features/ai/OpportunityChart';
import { DividendPanel } from '@/features/ai/DividendPanel';
import { AssetSearchPanel } from '@/features/ai/AssetSearchPanel';
import { InstrumentLogo } from '@/components/ui/InstrumentLogo';
import { useIssuerLogos } from '@/features/market/useIssuerLogos';
import { usePortfolio } from '@/features/portfolio/usePortfolio';
import { useSurplus } from '@/features/planning/useSurplus';
import { useRankOpportunitiesMutation, useGetMarketListingQuery } from '@/services/endpoints';
import { toApiError } from '@/services/api';
import { formatCurrency, formatDate, formatQuantity } from '@/lib/format';
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
 * When to act. Kept visually quieter than the action badge — pacing modifies
 * the call, it is not the call itself.
 */
const PACING: Record<'now' | 'staged' | 'on-dip', { label: string; className: string }> = {
  now: { label: 'buy it now', className: 'border-border text-text-muted bg-surface' },
  staged: { label: 'buy a bit at a time', className: 'border-border text-text-muted bg-surface' },
  'on-dip': {
    label: 'wait until it gets cheaper',
    className: 'border-warning/30 text-warning bg-warning/10',
  },
};

/** The three sections, in the order they are shown. */
const SECTIONS: Array<{
  assetClass: AssetClass;
  title: string;
  blurb: string;
  Icon: typeof Landmark;
}> = [
  {
    assetClass: 'stock',
    title: 'Stocks',
    blurb: 'PSX equities — ranked on price, trend, valuation and payouts.',
    Icon: Landmark,
  },
  {
    assetClass: 'crypto',
    title: 'Coins',
    blurb: 'Binance pairs — ranked on price and trend; no issuer accounts exist.',
    Icon: Bitcoin,
  },
  {
    assetClass: 'commodity',
    title: 'Commodities',
    blurb: 'Spot metals — ranked on price and trend against the dollar.',
    Icon: Gem,
  },
];

/**
 * Compositions this session has already asked about, keyed by asset class.
 *
 * Module-level so it survives unmounting: React Router tears the page down on
 * navigation, and a component-scoped ref would forget, re-firing the requests
 * every time the user came back. Paired with the mutations' `fixedCacheKey`s,
 * which keep the *results* across mounts, revisiting an unchanged book renders
 * instantly with no network calls at all.
 */
const lastRequestedKey: Partial<Record<AssetClass, string>> = {};

export function Suggestions() {
  const { holdings, summary, convert, displayCurrency, isEmpty, isLoading: portfolioLoading } =
    usePortfolio();
  // Dependable, not the median: committing the median overcommits half the
  // time, and a suggested purchase that needs the grocery money is worse than
  // a smaller one.
  const { dependable: dependableSurplus } = useSurplus();
  const [candidateInput, setCandidateInput] = useState('');

  /**
   * Candidate discovery.
   *
   * Ranking can only compare what it is given, so with an empty candidate box
   * the "what should I buy?" answer is limited to assets already owned. These
   * listings supply the rest of the market; `skip` keeps them off the wire
   * until the user actually asks, since each is a large response.
   */
  const [discovering, setDiscovering] = useState(false);
  const stockUniverse = useGetMarketListingQuery({ assetClass: 'stock' }, { skip: !discovering });
  const cryptoUniverse = useGetMarketListingQuery(
    { assetClass: 'crypto', quote: 'USDT' },
    { skip: !discovering },
  );

  const candidates = useMemo(
    () =>
      candidateInput
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    [candidateInput],
  );

  /**
   * Pick candidates worth ranking from the full market.
   *
   * Liquidity first, then momentum. Sorting purely by percentage gain surfaces
   * illiquid microcaps that moved on a handful of shares — the classic way a
   * "top movers" list becomes a list of things nobody can actually trade. So
   * the universe is cut to the most-traded names first, and only then ordered
   * by momentum.
   *
   * Anything already held is excluded: those are ranked anyway, and repeating
   * them would spend the candidate budget on assets the model already sees.
   */
  const discovered = useMemo(() => {
    if (!discovering) return [];
    const owned = new Set(holdings.map((h) => h.symbol.toUpperCase()));

    const pick = (rows: MarketRow[] | undefined, liquid: number, take: number) =>
      [...(rows ?? [])]
        .filter((r) => !owned.has(r.symbol.toUpperCase()) && (r.volume ?? 0) > 0)
        .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))
        .slice(0, liquid)
        .sort((a, b) => b.changePercent - a.changePercent)
        .slice(0, take)
        .map((r) => r.symbol);

    // Weighted toward PSX: it is where the bulk of this book sits, and crypto
    // candidates are far more correlated with each other than PSX names are.
    //
    // The classes now rank in parallel rather than in one call, so each class's
    // wait is set by its own asset count, not the total. That makes a slightly
    // wider stock shortlist affordable than when everything shared one request.
    return [...pick(stockUniverse.data?.rows, 60, 4), ...pick(cryptoUniverse.data?.rows, 80, 2)];
  }, [discovering, holdings, stockUniverse.data, cryptoUniverse.data]);

  const universeLoading = discovering && (stockUniverse.isLoading || cryptoUniverse.isLoading);

  // Once the listings land, write the picks into the candidate list and stop
  // discovering. The sections watch `candidates` and re-rank themselves, so
  // resolving it here — in one place, above all three — is what keeps them
  // from racing each other over a shared flag.
  useEffect(() => {
    if (!discovering || universeLoading || discovered.length === 0) return;
    setCandidateInput(discovered.join(', '));
    setDiscovering(false);
  }, [discovering, universeLoading, discovered]);

  /** The request body shared by all three calls, minus the class filter. */
  const baseRequest = useCallback(
    (extra: string[]): Omit<OpportunitiesRequest, 'assetClass'> => ({
      holdings: holdings.map((h) => ({
        symbol: h.symbol,
        assetClass: h.assetClass,
        quantity: h.quantity,
        averageCost: h.averageCost,
        allocationPercent: h.allocationPercent,
      })),
      ...(extra.length > 0 ? { candidates: extra } : {}),
      currency: displayCurrency,
      // Lets the server turn percentage-of-book sizing into real units. FX is
      // derived from the same converter the holdings table uses, so a suggested
      // quantity and the position it refers to agree on the rate.
      bookValue: summary.totalValue,
      // What the budget says can actually be committed each month, so sizing
      // is a plan rather than a weighting. Omitted entirely when there is too
      // little budget history for a rate — a zero would read as "no money"
      // rather than "not known".
      ...(dependableSurplus !== null ? { investableSurplus: dependableSurplus } : {}),
      fxToDisplay: Object.fromEntries(
        [...new Set(holdings.map((h) => h.currency))].map((code) => [code, convert(1, code)]),
      ),
    }),
    [holdings, displayCurrency, summary.totalValue, convert, dependableSurplus],
  );

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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-text">AI suggestions</h1>
        <p className="mt-1 text-sm text-text-muted">
          Stocks, coins and commodities each ranked against their own kind, from live prices and
          daily-chart indicators.
        </p>
      </div>

      {/* Search stands apart from the ranked sections, and above them: it
          answers a different question ("what about this one?") and works
          whether or not the book has anything in it. */}
      <Card>
        <CardHeader
          title="Ask about any instrument"
          description="Search a PSX ticker, a Binance pair or a spot metal for a full AI analysis — held or not."
        />
        <CardBody>
          <AssetSearchPanel />
        </CardBody>
      </Card>

      {isEmpty ? (
        <Card>
          <CardHeader title="Ranked opportunities" description="Ranking needs something to rank." />
          <CardBody>
            <p className="text-sm text-text-muted">
              Add holdings from{' '}
              <Link to="/portfolio" className="text-accent hover:underline">
                Portfolio
              </Link>
              , or import a CSV, and this page will rank them by asset class. The search above works
              in the meantime.
            </p>
          </CardBody>
        </Card>
      ) : (
        <Card>
          <CardHeader
            title="Ranked opportunities"
            description={`${holdings.length} holding${holdings.length === 1 ? '' : 's'}, one model call per asset class.`}
          />
          <CardBody className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="primary"
                size="md"
                onClick={() => setDiscovering(true)}
                disabled={universeLoading}
              >
                <Sparkles className={cn('size-4', universeLoading && 'animate-pulse')} />
                {universeLoading ? 'Scanning the market…' : 'Find me something to buy'}
              </Button>
            </div>

            <p className="text-[11px] text-text-subtle">
              Scans the most-traded PSX and Binance names you do not already hold, then ranks them
              against your book — price, momentum, valuation, payouts, and how much to buy.
            </p>
          </CardBody>
        </Card>
      )}

      {!isEmpty
        ? SECTIONS.map((section) => (
            <ClassSection
              key={section.assetClass}
              section={section}
              holdings={holdings}
              bookKey={bookKey}
              candidates={candidates}
              baseRequest={baseRequest}
            />
          ))
        : null}
    </div>
  );
}

type Holding = ReturnType<typeof usePortfolio>['holdings'][number];

/**
 * One asset class, ranked on its own.
 *
 * Each section owns its request, its cache entry and its loading state, so a
 * slow or failing class degrades alone: stocks can render while coins are
 * still thinking, and a crypto provider outage does not blank the equities.
 */
function ClassSection({
  section,
  holdings,
  bookKey,
  candidates,
  baseRequest,
}: {
  section: (typeof SECTIONS)[number];
  holdings: Holding[];
  bookKey: string;
  candidates: string[];
  baseRequest: (extra: string[]) => Omit<OpportunitiesRequest, 'assetClass'>;
}) {
  const { assetClass, title, blurb, Icon } = section;
  const [rank, { data, isLoading, error }] = useRankOpportunitiesMutation({
    // Per class, so the three results coexist in the cache and each survives
    // navigation independently.
    fixedCacheKey: `ai-opportunities-${assetClass}`,
  });

  const held = useMemo(
    () => holdings.filter((h) => h.assetClass === assetClass),
    [holdings, assetClass],
  );

  const run = useCallback(
    (refresh: boolean, extra: string[]) => {
      void rank({
        ...baseRequest(extra),
        assetClass,
        ...(refresh ? { refresh: true } : {}),
      });
    },
    [rank, baseRequest, assetClass],
  );

  // Held in a ref so the effect below can call the latest `run` without
  // listing it as a dependency — it is redefined whenever the book changes,
  // which would otherwise re-fire it.
  const runRef = useRef(run);
  runRef.current = run;

  /**
   * What this section has been asked for.
   *
   * Book composition and candidate list both change the answer, so both are in
   * the key. Discovery is not a separate trigger: the parent resolves its scan
   * into `candidates`, which lands here as an ordinary change and re-requests
   * through the same path as any other. One code path rather than two is what
   * keeps three sections from racing each other over a shared flag.
   */
  const requestKey = useMemo(
    () => (bookKey ? `${assetClass}:${bookKey}:${[...candidates].sort().join(',')}` : ''),
    [assetClass, bookKey, candidates],
  );

  // Run once the book is loaded, without waiting for a click. The server caches
  // a ranking for 24h against this same composition, so an automatic request is
  // usually a cache hit rather than a model call.
  //
  // Classes with nothing to rank are skipped entirely: the server rejects such
  // a request, and an empty section is the honest rendering anyway.
  const hasCandidates = candidates.length > 0;
  useEffect(() => {
    if (!requestKey) return;
    if (held.length === 0 && !hasCandidates) return;
    if (lastRequestedKey[assetClass] === requestKey) return;
    lastRequestedKey[assetClass] = requestKey;
    runRef.current(false, candidates);
  }, [requestKey, held.length, hasCandidates, assetClass, candidates]);

  const apiError = toApiError(error);
  const notConfigured = apiError?.code === 'provider_not_configured';

  // Nothing held and nothing found for this class — render the heading with an
  // honest note rather than a permanently empty card.
  const nothingToRank = held.length === 0 && !data && !isLoading;

  return (
    <Card>
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            <Icon className="size-4 text-text-muted" />
            {title}
          </span>
        }
        description={blurb}
        action={
          data ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => run(true, candidates)}
              disabled={isLoading}
            >
              <RefreshCw className={cn('size-4', isLoading && 'animate-spin')} />
              Regenerate
            </Button>
          ) : undefined
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
            in server/.env to enable this.
          </p>
        ) : nothingToRank ? (
          <p className="text-sm text-text-subtle">
            You hold no {title.toLowerCase()}. Use “Find me something to buy” above, or search a
            symbol, to get a read on this class.
          </p>
        ) : isLoading ? (
          <div className="space-y-2" aria-busy="true">
            {Array.from({ length: Math.max(held.length, 2) }, (_, i) => (
              <div key={i} className="h-16 animate-pulse rounded-lg bg-surface-raised" />
            ))}
            {/* Honest, and scaled to this class alone: the three sections run
                in parallel, so each one's wait is set by its own asset count
                rather than the total. */}
            <p className="text-xs text-text-subtle">
              Pricing {held.length + candidates.length} {title.toLowerCase()}, computing indicators,
              then one ranking call.
            </p>
          </div>
        ) : error ? (
          <div className="space-y-2">
            <p className="text-sm text-negative">
              {apiError?.message ?? `Ranking ${title.toLowerCase()} failed.`}
            </p>
            <Button size="sm" variant="secondary" onClick={() => run(false, candidates)}>
              <RefreshCw className="size-4" />
              Try again
            </Button>
          </div>
        ) : data ? (
          <Results data={data} />
        ) : (
          <p className="text-sm text-text-subtle">Preparing the ranking…</p>
        )}
      </CardBody>
    </Card>
  );
}

// No currency prop: each row is labelled in its own asset's quote currency.
function Results({ data }: { data: OpportunitySet }) {
  // Rank order is preserved inside each group — this splits the list, it does
  // not reorder it.
  const newIdeas = data.opportunities.filter((o) => !o.held);
  const owned = data.opportunities.filter((o) => o.held);

  // Issuer logos for the equities in this section. A no-op for the coins and
  // metals sections, which ask for nothing.
  const logoSymbols = useMemo(
    () =>
      data.opportunities.filter((o) => o.assetClass === 'stock').map((o) => o.symbol),
    [data.opportunities],
  );
  const logos = useIssuerLogos(logoSymbols);

  return (
    <div className="space-y-4">
      <p className="rounded-lg border border-border bg-surface-sunken px-3 py-2.5 text-sm text-text">
        {data.marketNote}
      </p>

      {/* New ideas first, and in their own section.
          Ranked together, a handful of candidates sink among the holdings —
          the book is bigger, so it wins on count — and the question "what
          should I buy that I don't own?" gets answered last. Splitting keeps
          the ranking intact (the numbers are unchanged) while putting the
          unowned names where they can actually be seen. */}
      {newIdeas.length > 0 ? (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
            New ideas — not in your portfolio
          </h3>
          <ol className="space-y-2">
            {newIdeas.map((o) => (
              <OpportunityRow key={o.symbol} opportunity={o} logoUrl={logos.get(o.symbol)} />
            ))}
          </ol>
        </section>
      ) : null}

      {owned.length > 0 ? (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
            {newIdeas.length > 0 ? 'What you already own' : 'Ranked holdings'}
          </h3>
          <ol className="space-y-2">
            {owned.map((o) => (
              <OpportunityRow key={o.symbol} opportunity={o} logoUrl={logos.get(o.symbol)} />
            ))}
          </ol>
        </section>
      ) : null}

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

function OpportunityRow({
  opportunity,
  logoUrl,
}: {
  opportunity: Opportunity;
  logoUrl: string | null | undefined;
}) {
  const action = ACTION[opportunity.action];
  const { Icon } = action;
  // The asset's own quote currency — a Binance pair is USDT even when the book
  // is reported in PKR, and labelling its stop "PKR" would be plainly wrong.
  const currency = opportunity.currency;
  const changePercent = opportunity.priceContext?.changePercent ?? null;

  return (
    <li className="rounded-lg border border-border bg-surface px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="nums w-6 shrink-0 text-sm font-semibold text-text-subtle">
          {opportunity.rank}
        </span>

        <InstrumentLogo
          symbol={opportunity.symbol}
          assetClass={opportunity.assetClass}
          currency={currency}
          logoUrl={logoUrl}
        />

        <div className="min-w-0">
          <Link
            to={`/asset/${encodeURIComponent(opportunity.symbol)}`}
            className="text-sm font-medium text-text hover:text-accent"
          >
            {opportunity.symbol}
          </Link>
          {/* The current price, right where the call is made. Reading a target
              or a stop means nothing without knowing what it is measured
              against, and making the reader look it up elsewhere is the gap
              this closes. */}
          <div className="flex items-baseline gap-1.5">
            <span className="nums text-[11px] text-text-muted">
              {formatCurrency(opportunity.price, currency)}
            </span>
            {changePercent !== null ? (
              <span
                className={cn(
                  'nums text-[11px]',
                  changePercent >= 0 ? 'text-positive' : 'text-negative',
                )}
              >
                {changePercent >= 0 ? '+' : ''}
                {changePercent.toFixed(2)}%
              </span>
            ) : null}
          </div>
        </div>

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
        {/* Plain version leads. The technical note stays available underneath,
            because it is the auditable part, but it should not be the first
            thing a non-specialist has to parse. */}
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="text-sm text-text">{opportunity.plainEnglish || opportunity.rationale}</p>
          {opportunity.plainEnglish ? (
            <details className="group">
              <summary className="cursor-pointer list-none text-[11px] text-text-subtle hover:text-text-muted">
                <span className="group-open:hidden">Show the technical reading</span>
                <span className="hidden group-open:inline">Hide the technical reading</span>
              </summary>
              <p className="mt-1 text-xs text-text-muted">{opportunity.rationale}</p>
            </details>
          ) : null}
        </div>
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

      {opportunity.profile || opportunity.priceContext ? (
        <div className="mt-2 ml-9 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-text-subtle">
          {opportunity.profile?.name ? (
            <span className="text-text-muted">{opportunity.profile.name}</span>
          ) : null}
          {opportunity.profile?.sector ? <span>{opportunity.profile.sector}</span> : null}
          {opportunity.profile?.marketCap ? (
            <span>
              mkt cap{' '}
              <span className="nums text-text-muted">
                {formatCurrency(opportunity.profile.marketCap, currency, { compact: true })}
              </span>
            </span>
          ) : null}
          {opportunity.profile?.peRatio ? (
            <span>
              P/E{' '}
              <span className="nums text-text-muted">{opportunity.profile.peRatio.toFixed(2)}</span>
            </span>
          ) : null}
          {opportunity.profile?.epsTtm ? (
            <span>
              EPS{' '}
              <span className="nums text-text-muted">{opportunity.profile.epsTtm.toFixed(2)}</span>
            </span>
          ) : null}
          {opportunity.priceContext?.weekLow52 && opportunity.priceContext.weekHigh52 ? (
            <span>
              52w{' '}
              <span className="nums text-text-muted">
                {formatCurrency(opportunity.priceContext.weekLow52, currency)} –{' '}
                {formatCurrency(opportunity.priceContext.weekHigh52, currency)}
              </span>
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Payouts, parsed from the exchange's own payouts table. Only equities
          have them, and only issuers that actually pay render anything. */}
      {opportunity.profile?.dividends ? (
        <div className="mt-2 ml-9">
          <DividendPanel dividends={opportunity.profile.dividends} currency={currency} />
        </div>
      ) : null}

      {opportunity.sizing ? (
        <div className="mt-2 ml-9 rounded-lg border border-border/70 bg-surface-sunken px-3 py-2">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span
              className={cn(
                'nums text-sm font-semibold',
                opportunity.sizing.deltaPercentOfBook >= 0 ? 'text-positive' : 'text-warning',
              )}
            >
              {opportunity.sizing.deltaPercentOfBook >= 0 ? 'Add' : 'Trim'}{' '}
              {formatQuantity(Math.abs(opportunity.sizing.units))} {opportunity.symbol}
            </span>
            <span className="nums text-xs text-text-muted">
              ≈ {formatCurrency(opportunity.sizing.amount, currency)}
            </span>
            <span className="text-[11px] text-text-subtle">
              {Math.abs(opportunity.sizing.deltaPercentOfBook).toFixed(1)}% of your portfolio
              {opportunity.sizing.deltaPercentOfBook >= 0 ? ', taking it to ' : ', leaving '}
              {opportunity.sizing.targetAllocationPercent.toFixed(1)}% of the total
            </span>
            <span
              className={cn(
                'rounded-full border px-2 py-0.5 text-[11px] font-medium',
                PACING[opportunity.sizing.pacing].className,
              )}
            >
              {PACING[opportunity.sizing.pacing].label}
            </span>
          </div>
          <p className="mt-1 text-[11px] text-text-subtle">{opportunity.sizing.rationale}</p>
        </div>
      ) : null}

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
                {opportunity.levels.targets.map((t) => formatCurrency(t, currency)).join(' · ')}
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
