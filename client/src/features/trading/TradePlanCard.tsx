/**
 * One asset's trade plan: what to do, at which prices, and for how long.
 *
 * The plan was made against the price at generation time, but the market has
 * moved since. So the card re-reads the plan against the latest price it can
 * get — a streamed tick for crypto, the portfolio's polled quote for a held
 * stock — and says plainly whether price is in the buy zone *now*, has reached
 * a target, or has broken the stop. The levels themselves never change
 * client-side; only where price sits against them does.
 */
import { Link } from 'react-router-dom';
import {
  Anchor,
  ArrowDownRight,
  ArrowDownToLine,
  Ban,
  CalendarClock,
  CircleCheck,
  Cpu,
  HandCoins,
  Hourglass,
  LoaderCircle,
  Minus,
  Plus,
  ShieldAlert,
  Sparkles,
  Target,
  TriangleAlert,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { zoneStatusOf, type HoldPeriod, type TradePlan, type TradeSignal } from '@aminfinance/shared';
import { InstrumentLogo } from '@/components/ui/InstrumentLogo';
import { useLiveTick } from '@/features/market/useLivePrice';
import { useAppSelector } from '@/app/hooks';
import { formatCurrency, formatPercent, formatQuantity } from '@/lib/format';
import { cn } from '@/lib/utils';
import { TradeChart } from './TradeChart';

type Tone = 'positive' | 'negative' | 'warning' | 'accent' | 'muted';

const TONE_CLASS: Record<Tone, string> = {
  positive: 'text-positive border-positive/30 bg-positive/10',
  negative: 'text-negative border-negative/30 bg-negative/10',
  warning: 'text-warning border-warning/30 bg-warning/10',
  accent: 'text-accent border-accent/30 bg-accent/10',
  muted: 'text-text-muted border-border bg-surface-sunken',
};

/** Status colours carry meaning here, so every badge also carries an icon and a word. */
export const SIGNAL: Record<TradeSignal, { label: string; tone: Tone; Icon: LucideIcon }> = {
  'buy-now': { label: 'Buy now', tone: 'positive', Icon: Plus },
  'buy-on-dip': { label: 'Buy on a dip', tone: 'accent', Icon: ArrowDownToLine },
  avoid: { label: 'Avoid', tone: 'muted', Icon: Ban },
  add: { label: 'Add more', tone: 'positive', Icon: Plus },
  hold: { label: 'Hold', tone: 'muted', Icon: Minus },
  'take-profit': { label: 'Take profit', tone: 'warning', Icon: HandCoins },
  sell: { label: 'Sell', tone: 'negative', Icon: ArrowDownRight },
};

export const HOLD_PERIOD: Record<HoldPeriod, { label: string; Icon: LucideIcon }> = {
  'long-term': { label: 'Long-term hold', Icon: Anchor },
  'medium-term': { label: 'Hold for months', Icon: CalendarClock },
  'short-term': { label: 'Short-term trade', Icon: Zap },
};

interface LiveStatus {
  label: string;
  tone: Tone;
  Icon: LucideIcon;
}

/**
 * Where the latest price sits against the plan, in priority order: a broken
 * stop outranks everything, because it means the plan no longer applies.
 */
function liveStatus(plan: TradePlan, now: number): LiveStatus | null {
  if (plan.stopLoss !== null && now <= plan.stopLoss) {
    return { label: 'Stop level hit — this plan no longer holds', tone: 'negative', Icon: ShieldAlert };
  }
  const firstTarget = plan.sellTargets[0];
  if (firstTarget !== undefined && now >= firstTarget) {
    return plan.held
      ? { label: 'First sell target reached', tone: 'positive', Icon: Target }
      : { label: 'Already at the first target — the move has happened', tone: 'muted', Icon: Target };
  }
  if (plan.signal === 'avoid' || plan.signal === 'sell') return null;

  const zone = zoneStatusOf(now, plan.buyZone);
  if (zone === 'in-zone') {
    return {
      label: plan.held ? 'In the add zone now' : 'In the buy zone now',
      tone: 'positive',
      Icon: CircleCheck,
    };
  }
  if (zone === 'above' && plan.buyZone) {
    const gap = ((now - plan.buyZone[1]) / now) * 100;
    return {
      label: `${gap.toFixed(1)}% above the ${plan.held ? 'add' : 'buy'} zone — wait for it`,
      tone: 'muted',
      Icon: Hourglass,
    };
  }
  if (zone === 'below') {
    return { label: 'Below the buy zone — check the stop before buying', tone: 'warning', Icon: TriangleAlert };
  }
  return null;
}

function Badge({ tone, Icon, children }: { tone: Tone; Icon: LucideIcon; children: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium',
        TONE_CLASS[tone],
      )}
    >
      <Icon className="size-3" aria-hidden />
      {children}
    </span>
  );
}

/** One cell of the ticket. The colour bar matches the chart's line for that level. */
function TicketCell({ label, color, value }: { label: string; color: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-border/70 bg-surface-sunken px-2.5 py-2">
      <dt className="flex items-center gap-1.5 text-[11px] text-text-subtle">
        <span className="h-0.5 w-2.5 rounded-full" style={{ background: color }} aria-hidden />
        {label}
      </dt>
      <dd className="nums mt-0.5 break-words text-sm font-medium text-text">{value}</dd>
    </div>
  );
}

export function TradePlanCard({
  plan,
  quotePrice,
  logoUrl,
}: {
  plan: TradePlan;
  /** The portfolio's polled quote, when the asset is held. */
  quotePrice: number | null;
  logoUrl: string | null | undefined;
}) {
  const privacyMode = useAppSelector((s) => s.settings.privacyMode);
  // Only crypto streams; for anything else the hook simply stays null.
  const tick = useLiveTick(plan.symbol);
  const now = (plan.assetClass === 'crypto' ? tick?.price : undefined) ?? quotePrice ?? plan.price;
  const isLive = now !== plan.price;

  const signal = SIGNAL[plan.signal];
  const period = HOLD_PERIOD[plan.holdPeriod];
  const status = liveStatus(plan, now);
  const currency = plan.currency;
  const money = (v: number) => formatCurrency(v, currency);

  // A held position is measured from where it stands now, re-read against the
  // latest price — plain arithmetic on levels the server already sanitised.
  // A position not yet open is measured from its entry, which no tick moves,
  // so the server's figures stand.
  const nextTarget = plan.sellTargets.find((t) => t > now) ?? null;
  const upside = plan.held
    ? nextTarget !== null
      ? ((nextTarget - now) / now) * 100
      : null
    : plan.metrics.upsidePercent;
  const downside = plan.held
    ? plan.stopLoss !== null
      ? ((plan.stopLoss - now) / now) * 100
      : null
    : plan.metrics.downsidePercent;
  const fromLabel = plan.held || !plan.buyZone ? 'now' : 'buy';
  const hasLevels = plan.buyZone !== null || plan.sellTargets.length > 0 || plan.stopLoss !== null;
  const pnl =
    plan.position && plan.position.averageCost > 0
      ? ((now - plan.position.averageCost) / plan.position.averageCost) * 100
      : null;

  const hide = (text: string) => (privacyMode ? '••••' : text);

  return (
    <article className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-surface p-4">
      <header className="flex items-start gap-3">
        <InstrumentLogo
          symbol={plan.symbol}
          assetClass={plan.assetClass}
          currency={currency}
          logoUrl={logoUrl}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <Link
              to={`/asset/${encodeURIComponent(plan.symbol)}`}
              className="text-sm font-semibold text-text hover:text-accent"
            >
              {plan.symbol}
            </Link>
            {plan.name && plan.name !== plan.symbol ? (
              <span className="truncate text-xs text-text-subtle">{plan.name}</span>
            ) : null}
          </div>
          <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2">
            <span className="nums text-sm text-text">{money(now)}</span>
            <span
              className={cn(
                'nums text-[11px]',
                plan.changePercent >= 0 ? 'text-positive' : 'text-negative',
              )}
            >
              {formatPercent(plan.changePercent)}
            </span>
            {isLive ? <span className="text-[11px] text-text-subtle">live</span> : null}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Badge tone={signal.tone} Icon={signal.Icon}>
            {signal.label}
          </Badge>
          {/* "Avoid" next to "Short-term trade" reads as a contradiction; a
              hold period only means something for a position worth taking. */}
          {plan.signal !== 'avoid' ? (
            <Badge tone={plan.holdPeriod === 'long-term' ? 'accent' : 'muted'} Icon={period.Icon}>
              {period.label}
            </Badge>
          ) : null}
        </div>
      </header>

      {plan.position ? (
        <p className="text-xs text-text-muted">
          You hold{' '}
          <span className="nums text-text">{hide(formatQuantity(plan.position.quantity))}</span>
          {plan.position.averageCost > 0 ? (
            <>
              {' '}
              at <span className="nums text-text">{hide(money(plan.position.averageCost))}</span> ·{' '}
              <span className={cn('nums', pnl !== null && pnl >= 0 ? 'text-positive' : 'text-negative')}>
                {pnl !== null ? formatPercent(pnl) : '—'}
              </span>
            </>
          ) : (
            <> · purchase price unknown</>
          )}
        </p>
      ) : null}

      {plan.series.length > 1 ? (
        <TradeChart
          series={plan.series}
          buyZone={plan.buyZone}
          sellTargets={plan.sellTargets}
          stopLoss={plan.stopLoss}
          price={now}
          currency={currency}
          symbol={plan.symbol}
          held={plan.held}
        />
      ) : (
        <p className="rounded-lg bg-surface-sunken px-3 py-6 text-center text-xs text-text-subtle">
          No chart history for this instrument.
        </p>
      )}

      {/* An "avoid" with no levels at all gets no ticket: three empty cells
          say nothing the badge has not already said. */}
      {hasLevels ? (
        <PlanTicket
          plan={plan}
          money={money}
          upside={upside}
          downside={downside}
          fromLabel={fromLabel}
        />
      ) : (
        <p className="text-right text-[11px] text-text-subtle">{plan.confidence} confidence</p>
      )}

      {status ? (
        <p
          className={cn(
            'flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium',
            TONE_CLASS[status.tone],
          )}
        >
          <status.Icon className="size-3.5 shrink-0" aria-hidden />
          {status.label}
        </p>
      ) : null}

      <div className="space-y-1">
        <ReviewSource plan={plan} />
        <p className="text-sm text-text">{plan.summary}</p>
      </div>

      <div className="rounded-lg border border-border/70 bg-surface-sunken px-3 py-2">
        <p className="flex items-center gap-1.5 text-[11px] font-medium text-text-muted">
          <Anchor className="size-3" aria-hidden />
          Long-term view
        </p>
        <p className="mt-0.5 text-xs text-text-muted">{plan.longTermView}</p>
      </div>

      {plan.tags.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="Chart facts">
          {plan.tags.map((tag) => (
            <li
              key={tag}
              className="rounded-full border border-border px-2 py-0.5 text-[11px] text-text-subtle"
            >
              {tag}
            </li>
          ))}
        </ul>
      ) : null}

      <details className="group">
        <summary className="cursor-pointer list-none text-[11px] text-text-subtle hover:text-text-muted">
          <span className="group-open:hidden">Show the reasoning behind these levels</span>
          <span className="hidden group-open:inline">Hide the reasoning</span>
        </summary>
        <div className="mt-2 space-y-2 text-xs text-text-muted">
          <p>{plan.technicalNote}</p>
          <p>
            <span className="font-medium text-text">What would prove it wrong: </span>
            {plan.invalidation}
          </p>
        </div>
      </details>
    </article>
  );
}

/**
 * Whose words the card is showing, and how far the AI review has got.
 *
 * The text below changes when a review lands, and so can the signal; saying
 * so — and saying what the engine had called it, when the review overrode
 * that — keeps a changed card from looking like a glitch.
 */
function ReviewSource({ plan }: { plan: TradePlan }) {
  const { ai } = plan;
  if (ai.status === 'ready') {
    return (
      <p className="flex flex-wrap items-center gap-1.5 text-[11px] text-text-subtle">
        <Sparkles className="size-3 text-accent" aria-hidden />
        AI review
        {ai.engineSignal ? (
          <span className="text-warning">
            · changed the chart engine's “{SIGNAL[ai.engineSignal].label}” to “{SIGNAL[plan.signal].label}”
          </span>
        ) : null}
      </p>
    );
  }
  if (ai.status === 'pending') {
    // A regenerate keeps the previous review on screen until the new one lands.
    return (
      <p className="flex items-center gap-1.5 text-[11px] text-text-subtle" role="status">
        <LoaderCircle className="size-3 animate-spin text-accent" aria-hidden />
        {ai.generatedAt !== null ? 'AI review — refreshing' : 'Chart engine — AI review on its way'}
      </p>
    );
  }
  if (ai.status === 'failed') {
    return (
      <p className="flex items-center gap-1.5 text-[11px] text-text-subtle" title={ai.error ?? undefined}>
        <Cpu className="size-3" aria-hidden />
        Chart engine — the AI review could not be completed
      </p>
    );
  }
  return (
    <p className="flex items-center gap-1.5 text-[11px] text-text-subtle">
      <Cpu className="size-3" aria-hidden />
      Chart engine
    </p>
  );
}

/** The figure without its currency, for the second number in a range. */
function shortAmount(value: number): string {
  const digits = Math.abs(value) < 1 && value !== 0 ? 4 : 2;
  return value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Buy, sell and stop as text — the table twin of the chart — and what they imply. */
function PlanTicket({
  plan,
  money,
  upside,
  downside,
  fromLabel,
}: {
  plan: TradePlan;
  money: (value: number) => string;
  upside: number | null;
  downside: number | null;
  fromLabel: string;
}) {
  return (
    <>
      <dl className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <TicketCell
          label={plan.held ? 'Add between' : 'Buy between'}
          color="var(--accent)"
          value={
            plan.buyZone
              ? `${money(plan.buyZone[0])} – ${shortAmount(plan.buyZone[1])}`
              : plan.held
                ? "Don't add now"
                : '—'
          }
        />
        <TicketCell
          label={plan.sellTargets.length > 1 ? 'Sell at (in steps)' : 'Sell at'}
          color="var(--positive)"
          value={
            plan.sellTargets.length > 0
              ? plan.sellTargets.map((t, i) => (i === 0 ? money(t) : shortAmount(t))).join(' · ')
              : '—'
          }
        />
        <TicketCell
          label="Stop loss"
          color="var(--negative)"
          value={plan.stopLoss !== null ? money(plan.stopLoss) : '—'}
        />
      </dl>
  
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-text-subtle">
        <span>
          {fromLabel} → target{' '}
          <span className="nums text-text-muted">{upside !== null ? formatPercent(upside, 1) : '—'}</span>
        </span>
        <span>
          {fromLabel} → stop{' '}
          <span className="nums text-text-muted">{downside !== null ? formatPercent(downside, 1) : '—'}</span>
        </span>
        {/* An entry metric — meaningless on a hold or an exit, so absent there. */}
        {plan.signal === 'buy-now' || plan.signal === 'buy-on-dip' || plan.signal === 'add' ? (
          <span title="How far the first target sits above the entry, for every unit of distance down to the stop. Above 1.5 is worth taking.">
            reward : risk{' '}
            <span
              className={cn(
                'nums',
                plan.metrics.rewardRisk === null
                  ? 'text-text-muted'
                  : plan.metrics.rewardRisk >= 1.5
                    ? 'text-positive'
                    : 'text-warning',
              )}
            >
              {plan.metrics.rewardRisk !== null ? `${plan.metrics.rewardRisk.toFixed(1)}×` : '—'}
            </span>
          </span>
        ) : null}
        <span className="ml-auto">{plan.confidence} confidence</span>
      </div>
    </>
  );
}
