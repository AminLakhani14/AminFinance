/**
 * Pakistan Stock Exchange.
 *
 * Two sources, split by what each can still serve:
 *
 *  - Prices, candles, the market listing and the symbol check come from
 *    TradingView (see `tradingview.ts`). The PSX Data Portal's JSON endpoints
 *    — /timeseries/eod, /timeseries/int, /market-watch, /symbols and
 *    /company/payouts — started answering 404/403 in September 2026, for the
 *    exchange's own website as much as for us.
 *  - Issuer facts still come from the Data Portal's company pages
 *    (dps.psx.com.pk/company/{SYM}), which render server-side and still work:
 *    fundamentals, announcements, and the issuer website behind each logo.
 *
 * ⚠️ Neither is a documented public API, so everything here is parsed
 * defensively: HTML selectors live in one table, shapes are validated before
 * they reach the cache, and a parse failure degrades to a partial result.
 */
import type {
  Quote,
  Candle,
  CandleSeries,
  CandleInterval,
  Fundamentals,
  DividendInfo,
  DividendEvent,
  MarketRow,
} from '@aminfinance/shared';
import { httpGetText } from '../lib/http.js';
import { AppError } from '../lib/errors.js';
import { acquire, retryAfterSeconds } from '../lib/rateLimit.js';
import * as tradingview from './tradingview.js';

const BASE = 'https://dps.psx.com.pk';
const PROVIDER = 'PSX';

/** PSX quotes in PKR; symbols are uppercase and unsuffixed. */
const CURRENCY = 'PKR';

async function gate(): Promise<void> {
  try {
    await acquire('psx');
  } catch {
    throw AppError.rateLimited(PROVIDER, retryAfterSeconds('psx'));
  }
}

export function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

/** Current quote. */
export async function getQuote(rawSymbol: string): Promise<Quote> {
  return tradingview.getQuote(normalizeSymbol(rawSymbol));
}

/**
 * Quotes for many symbols in one request — the whole book's PSX side costs a
 * single upstream call. Unknown symbols are returned in `missing`.
 */
export async function getQuotes(symbols: string[]): Promise<{ quotes: Quote[]; missing: string[] }> {
  return tradingview.getQuotes(symbols.map(normalizeSymbol));
}

/** OHLCV series, oldest bar first, with real session highs and lows. */
export async function getCandles(
  rawSymbol: string,
  interval: CandleInterval,
  limit = 400,
): Promise<CandleSeries> {
  const symbol = normalizeSymbol(rawSymbol);
  const candles = await tradingview.getCandles(symbol, interval, limit);
  return { symbol, assetClass: 'stock', interval, candles };
}

/**
 * Histories for many symbols over one connection. Each entry is the candles
 * or that symbol's own error, so one bad ticker never fails the batch.
 */
export async function getCandlesBatch(
  symbols: string[],
  interval: CandleInterval,
  limit: number,
): Promise<Map<string, Candle[] | Error>> {
  return tradingview.getCandlesBatch(symbols.map(normalizeSymbol), interval, limit);
}

// ---------------------------------------------------------------------------
// Company page scraping
// ---------------------------------------------------------------------------

/**
 * All HTML coupling lives here. When PSX changes their markup this table is
 * the only thing that needs editing.
 */
const STATS_PATTERN =
  /<div class="stats_label">([\s\S]*?)<\/div>\s*<div class="stats_value">([\s\S]*?)<\/div>/g;

/**
 * The issuer's own website, from the company profile's WEBSITE block.
 *
 * PSX publishes no company logos, but it does publish this — and an issuer's
 * domain is enough to fetch its favicon, which is in practice its logo. That
 * makes a real mark derivable for most of the ~500 listings instead of only
 * the few dozen anyone would hand-maintain a table for.
 */
const WEBSITE_PATTERN = /WEBSITE<\/div>\s*<p>\s*<a[^>]*href="([^"]+)"/i;

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').trim();
}

function parseNumber(raw: string | undefined): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/,/g, '').replace(/[^\d.\-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * A logo URL for the issuer, derived from the website it lists with PSX.
 *
 * The exchange hosts no company logos, so this goes via the issuer's own
 * domain and a favicon service. That is a real mark for most listings rather
 * than the few dozen a hand-kept table would ever cover, and it stays correct
 * as companies are listed and renamed without anyone editing a mapping.
 *
 * Returns null rather than guessing when there is no usable website — the
 * client renders a generated monogram in that case, and a guessed domain would
 * risk putting some other company's logo on a holding.
 */
function issuerLogoUrl(html: string): string | null {
  const href = WEBSITE_PATTERN.exec(html)?.[1]?.trim();
  if (!href) return null;

  let host: string;
  try {
    // Listed values are inconsistent about the scheme; assume http when absent
    // so the URL parses. Only the host is used, so the scheme never matters.
    host = new URL(/^https?:\/\//i.test(href) ? href : `http://${href}`).hostname;
  } catch {
    return null;
  }

  host = host.replace(/^www\./i, '').toLowerCase();
  // A bare label with no dot is not a domain, and PSX's own host would yield
  // the exchange's logo on every row.
  if (!host.includes('.') || host.endsWith('psx.com.pk')) return null;

  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
}

/** First value for a label, matched case-insensitively on a prefix. */
function pick(stats: Array<[string, string]>, labelPrefix: string): string | undefined {
  const needle = labelPrefix.toLowerCase();
  return stats.find(([label]) => label.toLowerCase().startsWith(needle))?.[1];
}

export async function getFundamentals(rawSymbol: string): Promise<Fundamentals> {
  const symbol = normalizeSymbol(rawSymbol);
  await gate();
  const html = await httpGetText(`${BASE}/company/${symbol}`, {
    provider: PROVIDER,
    timeoutMs: 20_000,
  });

  const flat = html.replace(/\n/g, '');
  const stats: Array<[string, string]> = [];
  for (const match of flat.matchAll(STATS_PATTERN)) {
    stats.push([stripTags(match[1] ?? ''), stripTags(match[2] ?? '')]);
  }

  if (stats.length === 0) {
    throw AppError.providerError(
      PROVIDER,
      `Could not parse the PSX company page for ${symbol} — the page markup may have changed.`,
    );
  }

  // Tag-agnostic and tolerant of nested markup: PSX renders the name in a
  // <div class="quote__name"> and wraps the sector text in a <span>.
  const name =
    stripTags(flat.match(/class="quote__name"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? '') || symbol;
  const sector =
    stripTags(flat.match(/class="quote__sector"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? '') || null;

  // "Market Cap (000's)" — the figure is in thousands of PKR.
  const marketCapThousands = parseNumber(pick(stats, 'market cap'));
  const marketCap = marketCapThousands !== null ? marketCapThousands * 1000 : null;

  // 52-week range renders as "425.00 — 685.00".
  const range52 = pick(stats, '52-week');
  const rangeParts = range52?.split(/[—–-]/).map((p) => parseNumber(p)) ?? [];

  return {
    symbol,
    assetClass: 'stock',
    name,
    currency: CURRENCY,
    marketCap,
    peRatio: parseNumber(pick(stats, 'p/e ratio')),
    epsTtm: parseNumber(pick(stats, 'eps')),
    dividendYield: parseNumber(pick(stats, 'dividend yield')),
    beta: null,
    sector,
    industry: null,
    exchange: 'PSX',
    description: null,
    logoUrl: issuerLogoUrl(html),
    weekHigh52: rangeParts[1] ?? null,
    weekLow52: rangeParts[0] ?? null,
    circulatingSupply: null,
  };
}

/**
 * Dividends.
 *
 * The company page renders its payouts section client-side, so the HTML we get
 * from `/company/{SYM}` has an empty shell. The table behind it comes from a
 * separate POST the page's own script makes:
 *
 *   POST /company/payouts   (form-encoded `symbol=LUCK`)  → an HTML <table>
 *
 * Undocumented like the rest of this portal, so it is parsed defensively: a
 * shape change yields fewer events, never a throw.
 *
 * PSX quotes cash dividends as a percentage of the PKR 10 par value, not of
 * the share price — "250%" is PKR 25 per share, on a share trading near 440.
 * Reading that as a yield would overstate the payout by roughly fifty times,
 * so the conversion to a per-share amount happens here, once, rather than in
 * each caller.
 */

/** Par value of a PSX ordinary share. Dividend percentages are quoted on this. */
const PAR_VALUE = 10;

export async function getDividends(rawSymbol: string): Promise<DividendInfo> {
  const symbol = normalizeSymbol(rawSymbol);
  await gate();

  let html: string;
  try {
    html = await httpGetText(`${BASE}/company/payouts`, {
      provider: PROVIDER,
      timeoutMs: 20_000,
      method: 'POST',
      body: `symbol=${encodeURIComponent(symbol)}`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-requested-with': 'XMLHttpRequest',
      },
    });
  } catch {
    // The payouts table has answered 403 since the Data Portal change; the
    // scanner's dividend fields are the fallback.
    return dividendsFromSnapshot(symbol);
  }

  const events = parsePayouts(html);
  if (events.length === 0) return dividendsFromSnapshot(symbol);

  // Rows are announcements, and an announcement dated in the future is one
  // whose book closure has not happened yet. That is the "next" payout.
  const now = Date.now();
  const upcoming = events.filter((e) => Date.parse(e.exDate) > now);
  const past = events.filter((e) => Date.parse(e.exDate) <= now);

  // Trailing twelve months, summed per share. Only past events count — an
  // announced-but-unpaid dividend is not yet income.
  const yearAgo = now - 365 * 24 * 60 * 60 * 1000;
  const trailing = past.filter((e) => Date.parse(e.exDate) >= yearAgo);

  return {
    symbol,
    assetClass: 'stock',
    // Soonest first among the upcoming ones; `events` is newest-first overall.
    next: upcoming.length > 0 ? upcoming[upcoming.length - 1]! : null,
    history: past,
    trailingAnnualAmount:
      trailing.length > 0 ? trailing.reduce((sum, e) => sum + e.amount, 0) : null,
  };
}

/**
 * Dividends from TradingView's snapshot: the last payout, the next announced
 * one, and the last fiscal year's total per share as the trailing figure.
 *
 * A history of one is thinner than the payout table was, but it is real, and
 * a fetch failure here still degrades to "none on record" — a dividend panel
 * must never fail the asset page around it.
 */
async function dividendsFromSnapshot(symbol: string): Promise<DividendInfo> {
  const empty: DividendInfo = { symbol, assetClass: 'stock', next: null, history: [], trailingAnnualAmount: null };
  let snapshot: tradingview.DividendSnapshot;
  try {
    snapshot = await tradingview.getDividendSnapshot(symbol);
  } catch {
    return empty;
  }

  const event = (e: { exDate: string; amount: number }): DividendEvent => ({
    exDate: e.exDate,
    paymentDate: null,
    recordDate: null,
    declarationDate: null,
    amount: e.amount,
    currency: CURRENCY,
    period: null,
  });
  const today = new Date().toISOString().slice(0, 10);

  return {
    ...empty,
    next: snapshot.upcoming && snapshot.upcoming.exDate >= today ? event(snapshot.upcoming) : null,
    history: snapshot.recent ? [event(snapshot.recent)] : [],
    trailingAnnualAmount: snapshot.fiscalYearAmount,
  };
}

/**
 * Parse the payouts fragment into cash-dividend events.
 *
 * Columns are: announcement date, the financial period, the payout detail, and
 * the book-closure range. The detail cell carries both the size and the kind:
 *
 *   " 250%(F) (D) "      → final cash dividend, 250% of par
 *   " 85%(i) (D) "       → first interim
 *   " 80(ii) (D) "       → already per-share, no percent sign
 *
 * Only rows marked `(D)` are cash dividends. Bonus and right issues appear in
 * the same table and are deliberately skipped: they are not income, and
 * summing them into a trailing figure would invent a payout that never landed.
 */
function parsePayouts(html: string): DividendEvent[] {
  const events: DividendEvent[] = [];
  const body = /<tbody[^>]*>([\s\S]*?)<\/tbody>/.exec(html)?.[1] ?? '';

  for (const row of body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const cells = [...(row[1] ?? '').matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) =>
      stripTags(c[1] ?? ''),
    );
    if (cells.length < 4) continue;

    const [announced, period, detail, closure] = cells as [string, string, string, string];
    if (!/\(D\)/i.test(detail)) continue;

    const amount = parsePayoutAmount(detail);
    if (amount === null || amount <= 0) continue;

    // The ex-date is what an investor acts on, and the book-closure start is
    // the closest PSX publishes to one. Announcement date is the fallback.
    const exDate = parsePsxDate(closure.split('-')[0]?.trim()) ?? parseLongDate(announced);
    if (!exDate) continue;

    events.push({
      exDate,
      paymentDate: null,
      recordDate: parsePsxDate(closure.split('-')[1]?.trim()) ?? null,
      declarationDate: parseLongDate(announced),
      amount,
      currency: CURRENCY,
      // The period the payout relates to, e.g. "30/06/2026(YR)" — kept as
      // PSX writes it so the UI can show which result it was declared against.
      period: period || null,
    });
  }

  // Newest first, matching the DividendInfo contract.
  return events.sort((a, b) => Date.parse(b.exDate) - Date.parse(a.exDate));
}

/**
 * Per-share amount from a payout detail cell.
 *
 * The figure is always a percentage of par value, even on the occasional row
 * where PSX drops the sign — MEBL's " 80(ii) (D) " sits among six siblings
 * that all read "70%", and reading it as PKR 80 per share rather than PKR 8
 * would inflate one payout tenfold and the trailing total with it.
 *
 * Treating a bare number as already-per-share was the tempting reading, but no
 * issuer surveyed actually publishes one that way, so the branch only ever
 * fired on typos. A percentage is assumed unconditionally.
 */
function parsePayoutAmount(detail: string): number | null {
  const match = /(\d+(?:\.\d+)?)/.exec(detail);
  if (!match) return null;
  const percentOfPar = Number(match[1]);
  if (!Number.isFinite(percentOfPar)) return null;
  return (percentOfPar / 100) * PAR_VALUE;
}

/** "18/09/2026" → "2026-09-18". */
function parsePsxDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw.trim());
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/** "August 10, 2026 4:15 PM" → "2026-08-10". */
function parseLongDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const ms = Date.parse(raw.replace(/\s+\d{1,2}:\d{2}\s*(AM|PM)$/i, ''));
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Company announcements — PSX's equivalent of news.
 *
 * The announcements tables are server-rendered, so unlike the payouts section
 * they need no second request: financial results, board meetings, and
 * corporate actions all arrive with the company page. It is the only
 * PSX-native news source available.
 */
export async function getAnnouncements(rawSymbol: string): Promise<
  Array<{ date: string; title: string; category: string }>
> {
  const symbol = normalizeSymbol(rawSymbol);
  await gate();
  const html = await httpGetText(`${BASE}/company/${symbol}`, {
    provider: PROVIDER,
    timeoutMs: 20_000,
  });
  const flat = html.replace(/\n/g, '');

  const items: Array<{ date: string; title: string; category: string }> = [];

  // Each tab panel is one category; rows are <td>date</td><td>title</td>.
  const panelPattern = /<div class="tabs__panel" data-name="([^"]+)">([\s\S]*?)<\/table>/g;
  for (const panel of flat.matchAll(panelPattern)) {
    const category = panel[1] ?? 'Other';
    const rowPattern = /<tr><td>([^<]+)<\/td><td>([\s\S]*?)<\/td>/g;
    for (const row of (panel[2] ?? '').matchAll(rowPattern)) {
      const date = stripTags(row[1] ?? '');
      const title = stripTags(row[2] ?? '');
      if (date && title) items.push({ date, title, category });
    }
  }

  return items;
}

/** Cheap existence check used when adding a holding. */
export async function symbolExists(rawSymbol: string): Promise<boolean> {
  try {
    await tradingview.getQuote(normalizeSymbol(rawSymbol));
    return true;
  } catch {
    return false;
  }
}

/** Whole-market snapshot: every PSX equity, fund and receipt, most-traded first. */
export async function getMarketWatch(): Promise<MarketRow[]> {
  return tradingview.getMarketListing();
}
