import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, Info } from 'lucide-react';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { usePortfolio } from '@/features/portfolio/usePortfolio';
import { useGetNewsQuery } from '@/services/endpoints';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';

const SENTIMENT_LABEL: Record<string, { label: string; className: string }> = {
  bullish: { label: 'Bullish', className: 'text-positive border-positive/30 bg-positive/10' },
  'somewhat-bullish': { label: 'Positive', className: 'text-positive border-positive/30 bg-positive/10' },
  neutral: { label: 'Neutral', className: 'text-text-muted border-border bg-surface-sunken' },
  'somewhat-bearish': { label: 'Negative', className: 'text-negative border-negative/30 bg-negative/10' },
  bearish: { label: 'Bearish', className: 'text-negative border-negative/30 bg-negative/10' },
};

export function News() {
  const { holdings, isEmpty } = usePortfolio();
  const [filter, setFilter] = useState<string | null>(null);

  const stockSymbols = useMemo(
    () => holdings.filter((h) => h.assetClass === 'stock').map((h) => h.symbol),
    [holdings],
  );

  const { data, isLoading } = useGetNewsQuery(stockSymbols, { skip: stockSymbols.length === 0 });

  const articles = useMemo(() => {
    const all = data?.articles ?? [];
    return filter ? all.filter((a) => a.symbols.includes(filter)) : all;
  }, [data, filter]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-text">News</h1>
        <p className="mt-1 text-sm text-text-muted">
          Corporate disclosures filed with PSX for the stocks you hold.
        </p>
      </div>

      {isEmpty ? (
        <Card>
          <CardBody className="py-16 text-center text-sm text-text-muted">
            Add holdings to see their announcements.
          </CardBody>
        </Card>
      ) : stockSymbols.length === 0 ? (
        <Card>
          <CardBody className="flex items-start gap-2 py-8 text-sm text-text-muted">
            <Info className="mt-0.5 size-4 shrink-0" />
            <span>
              You hold only crypto. There is no free crypto news provider configured, so
              this page covers PSX equities only.
            </span>
          </CardBody>
        </Card>
      ) : (
        <>
          {/* Filters sit in one row above the content. */}
          <div className="flex flex-wrap gap-1.5">
            <FilterChip active={filter === null} onClick={() => setFilter(null)}>
              All
            </FilterChip>
            {stockSymbols.map((symbol) => (
              <FilterChip
                key={symbol}
                active={filter === symbol}
                onClick={() => setFilter(symbol)}
              >
                {symbol}
              </FilterChip>
            ))}
          </div>

          <Card>
            <CardHeader
              title="Announcements"
              description={
                isLoading ? 'Loading…' : `${articles.length} filings`
              }
            />
            <CardBody className="p-0">
              {isLoading ? (
                <div className="space-y-3 p-5">
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="h-12 animate-pulse rounded bg-surface-raised" />
                  ))}
                </div>
              ) : articles.length === 0 ? (
                <p className="px-5 py-10 text-center text-sm text-text-muted">
                  No announcements found.
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {articles.map((article) => {
                    const sentiment = article.sentiment
                      ? SENTIMENT_LABEL[article.sentiment]
                      : null;
                    return (
                      <li key={article.id} className="px-5 py-3.5">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <p className="text-sm text-text">{article.headline}</p>
                            <div className="mt-1.5 flex flex-wrap items-center gap-2">
                              {article.symbols.map((s) => (
                                <Link
                                  key={s}
                                  to={`/asset/${encodeURIComponent(s)}`}
                                  className="text-xs font-medium text-accent hover:underline"
                                >
                                  {s}
                                </Link>
                              ))}
                              <span className="text-xs text-text-subtle">{article.source}</span>
                              {sentiment ? (
                                <span
                                  className={cn(
                                    'rounded-full border px-1.5 py-0.5 text-[10px] font-medium',
                                    sentiment.className,
                                  )}
                                  title="Keyword heuristic over the headline — a scanning hint, not analysis."
                                >
                                  {sentiment.label}
                                </span>
                              ) : null}
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <span className="text-xs text-text-subtle nums">
                              {formatDate(article.publishedAt)}
                            </span>
                            <a
                              href={article.url}
                              target="_blank"
                              rel="noreferrer noopener"
                              className="rounded-md p-1 text-text-muted hover:bg-surface-raised hover:text-text"
                              aria-label="Open on PSX"
                            >
                              <ExternalLink className="size-3.5" />
                            </a>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardBody>
          </Card>

          {data?.coverage ? (
            <p className="flex items-start gap-2 text-xs text-text-subtle">
              <Info className="mt-0.5 size-3.5 shrink-0" />
              {data.coverage.note}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
        active
          ? 'border-accent bg-accent/10 text-accent'
          : 'border-border text-text-muted hover:text-text',
      )}
    >
      {children}
    </button>
  );
}
