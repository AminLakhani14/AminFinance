/**
 * Provider configuration checklist.
 *
 * Shown on an empty dashboard and in Settings. PSX and Binance public data
 * need no keys, so a fresh install is already useful — this is about the
 * optional extras, not a wall of blockers.
 */
import { CheckCircle2, Circle, ExternalLink } from 'lucide-react';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { useGetHealthQuery } from '@/services/api';

const PROVIDER_INFO: Record<
  string,
  { label: string; envVar: string; url: string; note: string; optional: boolean }
> = {
  binanceAccount: {
    label: 'Binance account sync',
    envVar: 'BINANCE_API_KEY + BINANCE_API_SECRET',
    url: 'https://www.binance.com/en/my/settings/api-management',
    note: 'Auto-imports balances and trade history. Create with "Enable Reading" ONLY and an IP whitelist.',
    optional: true,
  },
  anthropic: {
    label: 'Claude (AI insights)',
    envVar: 'ANTHROPIC_API_KEY',
    url: 'https://console.anthropic.com',
    note: 'Per-asset analysis and portfolio review.',
    optional: true,
  },
  coingecko: {
    label: 'CoinGecko',
    envVar: 'COINGECKO_API_KEY',
    url: 'https://www.coingecko.com/en/developers/dashboard',
    note: 'Coin metadata and logos.',
    optional: true,
  },
  finnhub: {
    label: 'Finnhub',
    envVar: 'FINNHUB_API_KEY',
    url: 'https://finnhub.io/register',
    note: 'Only needed if you add US-listed tickers.',
    optional: true,
  },
  alphaVantage: {
    label: 'Alpha Vantage',
    envVar: 'ALPHAVANTAGE_API_KEY',
    url: 'https://www.alphavantage.co/support/#api-key',
    note: 'Only needed for US tickers. PSX data comes from PSX directly.',
    optional: true,
  },
  twelveData: {
    label: 'Twelve Data',
    envVar: 'TWELVEDATA_API_KEY',
    url: 'https://twelvedata.com/pricing',
    note: 'Only needed for US ticker history.',
    optional: true,
  },
};

export function SetupChecklist() {
  const { data } = useGetHealthQuery();
  if (!data) return null;

  return (
    <Card>
      <CardHeader
        title="Data providers"
        description="PSX and Binance market data need no key. Everything below is optional."
      />
      <CardBody className="divide-y divide-border p-0">
        <div className="flex items-start gap-3 px-5 py-3.5">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-positive" />
          <div>
            <span className="text-sm font-medium text-text">
              PSX &amp; Binance market data
            </span>
            <p className="mt-0.5 text-xs text-text-muted">
              Quotes, history, and fundamentals. No key required — already working.
            </p>
          </div>
        </div>

        {Object.entries(data.providers).map(([key, configured]) => {
          const info = PROVIDER_INFO[key];
          if (!info) return null;
          return (
            <div key={key} className="flex items-start gap-3 px-5 py-3.5">
              {configured ? (
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-positive" />
              ) : (
                <Circle className="mt-0.5 size-4 shrink-0 text-text-subtle" />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-text">{info.label}</span>
                  {!configured ? (
                    <a
                      href={info.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
                    >
                      Get key
                      <ExternalLink className="size-3" />
                    </a>
                  ) : null}
                </div>
                <p className="mt-0.5 text-xs text-text-muted">{info.note}</p>
                {!configured ? (
                  <code className="mt-1 inline-block rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] text-text-subtle">
                    {info.envVar}
                  </code>
                ) : null}
              </div>
            </div>
          );
        })}
      </CardBody>
    </Card>
  );
}
