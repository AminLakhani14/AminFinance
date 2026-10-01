/**
 * Corporate actions that need a decision, pulled out of the announcement feed.
 *
 * The News page already lists every PSX filing. That list is the wrong shape
 * for acting on: a bonus issue on a stock you hold is a dated obligation, and
 * it sits in the feed between two routine disclosures with nothing to
 * distinguish it. This classifies filings by what they *do to a position* and
 * keeps only the ones on symbols the user actually owns.
 *
 * Two reasons this matters beyond convenience:
 *
 * 1. **Book closure has a deadline.** Buy before the ex-date and the dividend
 *    is yours; buy after and it is not. A filing surfaced a week late is
 *    worthless.
 *
 * 2. **Bonus and right issues silently break cost basis.** A 10% bonus issue
 *    leaves the holder with more shares at a lower average cost, and nothing
 *    in the ledger knows that happened. Flagging it is what stops the P/L
 *    from quietly going wrong.
 *
 * Keyword matching over filing titles, deliberately. PSX announcement titles
 * are terse and formulaic, so a keyword table reads them well — and the cost
 * of a miss is a filing that stays in the ordinary feed, not a wrong number.
 */
import type { NewsArticle } from '@aminfinance/shared';

export type ActionKind =
  | 'dividend'
  | 'bonus-issue'
  | 'right-issue'
  | 'book-closure'
  | 'agm'
  | 'results'
  | 'other';

/** Whether the action changes the share count or the cost basis. */
export const ADJUSTS_COST_BASIS: ReadonlySet<ActionKind> = new Set<ActionKind>([
  'bonus-issue',
  'right-issue',
]);

export interface CorporateAction {
  id: string;
  symbol: string;
  kind: ActionKind;
  headline: string;
  publishedAt: number;
  url: string;
  /**
   * True when the filing implies the ledger needs a manual adjustment —
   * a bonus or right issue the user has to record themselves.
   */
  needsLedgerAdjustment: boolean;
  /** Why this was flagged, in one line, for the card. */
  note: string;
}

/**
 * Ordered most-specific-first: "bonus" must beat the generic "dividend" on a
 * title like "Bonus issue in lieu of dividend", and a plain results filing
 * must not be read as a book closure just because it mentions one.
 */
const PATTERNS: Array<{ kind: ActionKind; test: RegExp; note: string }> = [
  {
    kind: 'bonus-issue',
    test: /\bbonus\b/i,
    note: 'Bonus shares increase your quantity and lower your average cost — record it or the P/L will drift.',
  },
  {
    kind: 'right-issue',
    test: /\bright[s]?\s+(issue|shares)\b|\bletter of right\b/i,
    note: 'A right issue asks for money by a deadline and changes your cost basis if taken up.',
  },
  {
    kind: 'book-closure',
    test: /\bbook\s*clos/i,
    note: 'Own the stock before the ex-date to receive the payout.',
  },
  {
    kind: 'dividend',
    test: /\bdividend\b|\bpayout\b|\bcash\s+div/i,
    note: 'A cash dividend has been declared.',
  },
  {
    kind: 'agm',
    test: /\b(agm|egm|annual general|extraordinary general)\b/i,
    note: 'Shareholder meeting — voting matters may be on the agenda.',
  },
  {
    kind: 'results',
    test: /\b(financial results|quarterly|half[- ]year|annual accounts|profit|earnings)\b/i,
    note: 'Results filing — the numbers behind the position have moved.',
  },
];

export function classifyAction(headline: string): {
  kind: ActionKind;
  note: string;
} {
  for (const pattern of PATTERNS) {
    if (pattern.test.test(headline)) return { kind: pattern.kind, note: pattern.note };
  }
  return { kind: 'other', note: 'Filed with PSX.' };
}

/** How long a filing stays "actionable" before it is just history. */
const RECENT_DAYS = 45;

export interface ActionFilter {
  /** Symbols the user holds. Filings on anything else are dropped. */
  heldSymbols: Set<string>;
  /** Only filings that change a position or carry a deadline. */
  actionableOnly?: boolean;
  now?: number;
}

/**
 * Actionable filings on held symbols, newest first.
 *
 * Restricted to held symbols on purpose: an alert about a company the user
 * does not own is noise, and a list that is mostly noise trains them to
 * ignore the one that mattered.
 */
export function corporateActions(
  articles: NewsArticle[],
  filter: ActionFilter,
): CorporateAction[] {
  const { heldSymbols, actionableOnly = true, now = Date.now() } = filter;
  const cutoff = now - RECENT_DAYS * 86_400_000;

  const held = new Set([...heldSymbols].map((s) => s.toUpperCase()));
  const actions: CorporateAction[] = [];

  for (const article of articles) {
    if (article.publishedAt < cutoff) continue;

    // An article can be matched to several symbols; emit one row per held
    // symbol so the card can say which position it affects.
    for (const symbol of article.symbols) {
      if (!held.has(symbol.toUpperCase())) continue;

      const { kind, note } = classifyAction(article.headline);
      if (actionableOnly && kind === 'other') continue;
      if (actionableOnly && kind === 'results') continue;

      actions.push({
        id: `${article.id}:${symbol}`,
        symbol,
        kind,
        headline: article.headline,
        publishedAt: article.publishedAt,
        url: article.url,
        needsLedgerAdjustment: ADJUSTS_COST_BASIS.has(kind),
        note,
      });
    }
  }

  return actions.sort((a, b) => b.publishedAt - a.publishedAt);
}

export const ACTION_LABELS: Record<ActionKind, string> = {
  dividend: 'Dividend',
  'bonus-issue': 'Bonus issue',
  'right-issue': 'Right issue',
  'book-closure': 'Book closure',
  agm: 'Shareholder meeting',
  results: 'Results',
  other: 'Filing',
};
