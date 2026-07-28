/**
 * CSV import/export for transactions.
 *
 * Exists because most brokers — JS InvestPro among them — have no API, so the
 * only path from a real account into this app is a file. Export is the same
 * format, which makes the round trip a backup mechanism as well as an import.
 *
 * The parser is deliberately forgiving about column order, header casing, and
 * quoting, because a hand-edited spreadsheet is the normal input here.
 */
import type { Transaction, AssetClass, TransactionType } from '@aminfinance/shared';

export const CSV_HEADERS = [
  'symbol',
  'assetClass',
  'type',
  'quantity',
  'price',
  'fee',
  'currency',
  'date',
  'notes',
] as const;

export interface ParseResult {
  transactions: Transaction[];
  /** Row-level problems. Parsing continues so one bad line can't block the rest. */
  errors: Array<{ line: number; message: string }>;
}

/**
 * Split one CSV line, honouring quoted fields.
 *
 * Naive `split(',')` breaks on any note containing a comma, which is common.
 */
function splitLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      // Doubled quote inside a quoted field is a literal quote.
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current.trim());
  return fields;
}

function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[\s_-]/g, '');
}

/** Header aliases, so a broker export doesn't need renaming first. */
const HEADER_ALIASES: Record<string, string> = {
  symbol: 'symbol',
  ticker: 'symbol',
  scrip: 'symbol',
  assetclass: 'assetClass',
  class: 'assetClass',
  kind: 'assetClass',
  type: 'type',
  side: 'type',
  action: 'type',
  quantity: 'quantity',
  qty: 'quantity',
  shares: 'quantity',
  units: 'quantity',
  price: 'price',
  rate: 'price',
  avgprice: 'price',
  averagecost: 'price',
  avgcost: 'price',
  fee: 'fee',
  fees: 'fee',
  commission: 'fee',
  currency: 'currency',
  ccy: 'currency',
  date: 'date',
  timestamp: 'date',
  tradedate: 'date',
  notes: 'notes',
  note: 'notes',
  remarks: 'notes',
};

function parseNumber(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null;
  // Tolerate thousands separators and currency prefixes.
  const cleaned = raw.replace(/[,\s]/g, '').replace(/^[A-Za-z]{2,4}\s*/, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a date to **local** midnight.
 *
 * `Date.parse('2026-04-17')` treats a date-only ISO string as UTC, which is
 * wrong twice over: it disagrees with the manual-entry dialog (local midnight),
 * so the same date entered two ways produces two different timestamps and
 * defeats deduplication; and for anyone west of UTC it lands on the previous
 * calendar day, displaying a date the user never typed.
 */
function parseDate(raw: string | undefined): number | null {
  if (!raw) return null;

  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    return new Date(Number(y), Number(m) - 1, Number(d)).getTime();
  }

  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Stable YYYY-MM-DD for id generation, independent of timezone. */
function dateKey(timestamp: number): string {
  const d = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseCsv(text: string): ParseResult {
  const errors: ParseResult['errors'] = [];
  const transactions: Transaction[] = [];

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));

  if (lines.length < 2) {
    return {
      transactions: [],
      errors: [{ line: 0, message: 'File needs a header row and at least one transaction.' }],
    };
  }

  const rawHeaders = splitLine(lines[0] ?? '');
  const headers = rawHeaders.map((h) => HEADER_ALIASES[normalizeHeader(h)] ?? normalizeHeader(h));

  const required = ['symbol', 'quantity', 'price'];
  const missing = required.filter((r) => !headers.includes(r));
  if (missing.length > 0) {
    return {
      transactions: [],
      errors: [
        {
          line: 1,
          message: `Missing required column(s): ${missing.join(', ')}. Found: ${rawHeaders.join(', ')}`,
        },
      ],
    };
  }

  for (let i = 1; i < lines.length; i++) {
    const lineNumber = i + 1;
    const fields = splitLine(lines[i] ?? '');
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      row[header] = fields[index] ?? '';
    });

    const symbol = (row.symbol ?? '').toUpperCase();
    if (!symbol) {
      errors.push({ line: lineNumber, message: 'Missing symbol.' });
      continue;
    }

    const quantity = parseNumber(row.quantity);
    if (quantity === null || quantity <= 0) {
      errors.push({ line: lineNumber, message: `Invalid quantity "${row.quantity}".` });
      continue;
    }

    const price = parseNumber(row.price);
    if (price === null || price < 0) {
      errors.push({ line: lineNumber, message: `Invalid price "${row.price}".` });
      continue;
    }

    // Infer asset class from the ticker shape when the column is absent:
    // Binance pairs end in a known quote asset, PSX tickers don't.
    const declaredClass = (row.assetClass ?? '').toLowerCase();
    const assetClass: AssetClass =
      declaredClass === 'crypto' || declaredClass === 'coin'
        ? 'crypto'
        : declaredClass === 'stock' || declaredClass === 'equity'
          ? 'stock'
          : /(USDT|USDC|FDUSD|BUSD|BTC|ETH|BNB)$/.test(symbol) && symbol.length > 4
            ? 'crypto'
            : 'stock';

    const declaredType = (row.type ?? 'buy').toLowerCase();
    const type: TransactionType = declaredType.startsWith('s') ? 'sell' : 'buy';

    const currency =
      (row.currency ?? '').toUpperCase() || (assetClass === 'crypto' ? 'USDT' : 'PKR');

    const timestamp = parseDate(row.date) ?? Date.now();

    // Deterministic id from the row's content so re-importing is idempotent.
    // Keyed on the calendar date, not the raw epoch: a millisecond difference
    // from a timezone or parsing change must not read as a different trade.
    const identity = `csv-${symbol}-${type}-${quantity}-${price}-${dateKey(timestamp)}`;

    transactions.push({
      id: identity,
      symbol,
      assetClass,
      type,
      quantity,
      price,
      fee: parseNumber(row.fee) ?? 0,
      currency,
      timestamp,
      source: 'csv',
      externalId: identity,
      ...(row.notes ? { notes: row.notes } : {}),
    });
  }

  return { transactions, errors };
}

/** Serialize transactions back to the same format — export doubles as backup. */
export function toCsv(transactions: Transaction[]): string {
  const escape = (value: string): string =>
    /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

  const rows = transactions.map((tx) =>
    [
      tx.symbol,
      tx.assetClass,
      tx.type,
      String(tx.quantity),
      String(tx.price),
      String(tx.fee),
      tx.currency,
      new Date(tx.timestamp).toISOString().slice(0, 10),
      escape(tx.notes ?? ''),
    ].join(','),
  );

  return [CSV_HEADERS.join(','), ...rows].join('\n');
}

export function downloadCsv(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
