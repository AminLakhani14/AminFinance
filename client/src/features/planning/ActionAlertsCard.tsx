/**
 * Corporate filings that need a decision, on stocks you hold.
 *
 * The News page already lists every PSX announcement. This is the subset that
 * does something to a position — and the distinction is worth its own surface
 * because two of these carry consequences a passive feed cannot convey:
 *
 * - A **book closure** has a deadline. Buy before the ex-date and the payout
 *   is yours; buy after and it is not.
 * - A **bonus or right issue** silently breaks cost basis. The holder ends up
 *   with more shares at a lower average cost, and nothing in the ledger knows
 *   it happened until someone records it.
 */
import { useMemo } from 'react';
import { AlertTriangle, BellRing, ExternalLink } from 'lucide-react';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { usePortfolio } from '@/features/portfolio/usePortfolio';
import { useGetNewsQuery } from '@/services/endpoints';
import {
  ACTION_LABELS,
  corporateActions,
  type CorporateAction,
} from '@/lib/calc/corporateActions';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';

export function ActionAlertsCard({ className }: { className?: string }) {
  const { holdings } = usePortfolio();

  const symbols = useMemo(
    () => holdings.filter((h) => h.assetClass === 'stock').map((h) => h.symbol),
    [holdings],
  );

  const newsQuery = useGetNewsQuery(symbols, { skip: symbols.length === 0 });

  const actions = useMemo(() => {
    const articles = newsQuery.data?.articles ?? [];
    return corporateActions(articles, { heldSymbols: new Set(symbols) });
  }, [newsQuery.data, symbols]);

  // Ledger-affecting filings float to the top regardless of date: a bonus
  // issue from three weeks ago still has an unrecorded adjustment behind it,
  // whereas a dividend notice is only news.
  const ordered = useMemo(
    () =>
      [...actions].sort((a, b) => {
        if (a.needsLedgerAdjustment !== b.needsLedgerAdjustment) {
          return a.needsLedgerAdjustment ? -1 : 1;
        }
        return b.publishedAt - a.publishedAt;
      }),
    [actions],
  );

  if (symbols.length === 0) return null;

  return (
    <Card className={className}>
      <CardHeader
        title="Needs attention"
        description="Filings on your holdings that carry a deadline or change your cost basis"
      />
      <CardBody>
        {newsQuery.isLoading ? (
          <div className="h-16 animate-pulse rounded-lg bg-surface-sunken" />
        ) : ordered.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-4 text-center">
            <BellRing className="mx-auto size-5 text-text-subtle" aria-hidden />
            <p className="mt-2 text-sm text-text">Nothing outstanding</p>
            <p className="mt-1 text-xs text-text-muted">
              No dividend, bonus, or book-closure filings on your holdings in the
              last 45 days.
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {ordered.slice(0, 6).map((action) => (
              <ActionRow key={action.id} action={action} />
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

function ActionRow({ action }: { action: CorporateAction }) {
  return (
    <li
      className={cn(
        'rounded-lg border p-3',
        action.needsLedgerAdjustment
          ? 'border-negative/40 bg-negative/5'
          : 'border-border',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-text">{action.symbol}</span>
            <span className="rounded-full border border-border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-muted">
              {ACTION_LABELS[action.kind]}
            </span>
          </div>
          <p className="mt-1 line-clamp-2 text-xs text-text-muted">{action.headline}</p>
        </div>
        <a
          href={action.url}
          target="_blank"
          rel="noreferrer noopener"
          className="shrink-0 rounded p-1 text-text-subtle hover:bg-surface-raised hover:text-text"
          aria-label={`Open filing for ${action.symbol}`}
        >
          <ExternalLink className="size-3.5" aria-hidden />
        </a>
      </div>

      <p
        className={cn(
          'mt-1.5 flex items-start gap-1.5 text-xs',
          action.needsLedgerAdjustment ? 'text-text' : 'text-text-subtle',
        )}
      >
        {action.needsLedgerAdjustment ? (
          <AlertTriangle className="mt-0.5 size-3 shrink-0 text-negative" aria-hidden />
        ) : null}
        {action.note}
      </p>
      <p className="mt-1 text-[11px] text-text-subtle">{formatDate(action.publishedAt)}</p>
    </li>
  );
}
