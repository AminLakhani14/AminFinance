/**
 * The fill-in sheet, as a grid of themed cards.
 *
 * One card per area of life — Salary, Home & bills, Personal care,
 * Subscriptions — each holding its own line items with an amount box. The
 * split is what makes the sheet scannable: you find "shampoo" by going to the
 * card you were already thinking about, instead of reading forty rows.
 *
 * Each card carries its own running total in the header, so the arithmetic
 * people actually do ("what did bills cost me this month?") is answered in
 * place rather than only in the chart below.
 *
 * Writes are debounced and go through `setBudgetItemAmount`, which upserts on
 * `[month, itemId]`. That is what lets a box behave like a form field: the
 * first keystroke creates the row, later ones update it, and clearing it
 * deletes the row rather than storing a zero.
 */
import { useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  House,
  Landmark,
  Repeat,
  ShoppingBag,
  ShoppingCart,
  Sparkles,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import type { BudgetEntry } from '@aminfinance/shared';
import { setBudgetItemAmount } from '@/lib/db';
import { itemGroups, type BudgetGroup, type BudgetItem } from '@/lib/calc/budgetItems';
import { Card } from '@/components/ui/Card';
import { formatCurrency } from '@/lib/format';
import { cn } from '@/lib/utils';

interface BudgetSheetProps {
  month: string;
  currency: string;
  /** Existing entries for this month, keyed by item id. */
  amounts: Map<string, BudgetEntry>;
  privacyMode: boolean;
}

/** Debounce for persistence — long enough to not write on every keystroke. */
const SAVE_DELAY_MS = 400;

/**
 * Icons are named in the catalog and resolved here.
 *
 * Keeping the component out of the data file means the catalog stays a plain
 * list of facts — importable by non-React code, and diffable without JSX.
 */
const ICONS: Record<string, LucideIcon> = {
  Wallet,
  House,
  ShoppingCart,
  Sparkles,
  Repeat,
  Users,
  Landmark,
  ShoppingBag,
};

export function BudgetSheet({ month, currency, amounts, privacyMode }: BudgetSheetProps) {
  const groups = itemGroups();

  return (
    // A real grid, not CSS columns. Columns flow top-to-bottom, which puts the
    // second card *under* the first instead of beside it — so "Home & bills"
    // landed below "Living & food" and the priority order read wrong. A grid
    // keeps left-to-right reading order; `items-start` stops a short card from
    // stretching to match a tall neighbour.
    <div className="grid items-start gap-5 md:grid-cols-2 xl:grid-cols-3">
      {groups.map(({ group, items }) => (
        <GroupCard
          key={group.id}
          group={group}
          items={items}
          month={month}
          currency={currency}
          amounts={amounts}
          privacyMode={privacyMode}
        />
      ))}
    </div>
  );
}

interface GroupCardProps {
  group: BudgetGroup;
  items: BudgetItem[];
  month: string;
  currency: string;
  amounts: Map<string, BudgetEntry>;
  privacyMode: boolean;
}

function GroupCard({
  group,
  items,
  month,
  currency,
  amounts,
  privacyMode,
}: GroupCardProps) {
  const [showAll, setShowAll] = useState(false);
  const Icon = ICONS[group.icon] ?? Wallet;

  // Deductions subtract. On the Salary card that makes the header figure
  // take-home rather than gross, which is the number people actually plan
  // against — and it matches the Income tile exactly.
  const gross = items
    .filter((i) => i.kind !== 'deduction')
    .reduce((sum, item) => sum + (amounts.get(item.id)?.amount ?? 0), 0);
  const withheld = items
    .filter((i) => i.kind === 'deduction')
    .reduce((sum, item) => sum + (amounts.get(item.id)?.amount ?? 0), 0);
  const total = Math.max(0, gross - withheld);

  const filledCount = items.filter((i) => (amounts.get(i.id)?.amount ?? 0) > 0).length;

  const hidden = items.filter((i) => !i.common);
  // A card with something already filled in below the fold must not hide it,
  // or a carried-forward amount would silently vanish from view.
  const hasHiddenValue = hidden.some((i) => (amounts.get(i.id)?.amount ?? 0) > 0);
  const expanded = showAll || hasHiddenValue;
  const visible = expanded ? items : items.filter((i) => i.common);

  return (
    <Card>
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <span
          className="flex size-9 shrink-0 items-center justify-center rounded-xl"
          style={{
            // Tinted from the card's own accent rather than a fixed grey, so
            // the eight cards are told apart at a glance.
            background: `color-mix(in oklab, ${group.accent} 16%, transparent)`,
            color: group.accent,
          }}
          aria-hidden
        >
          <Icon className="size-[18px]" strokeWidth={1.9} />
        </span>

        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold tracking-tight text-text">
            {group.label}
          </h3>
          <p className="truncate text-xs text-text-subtle">
            {filledCount > 0
              ? `${filledCount} of ${items.length} filled in`
              : group.hint}
          </p>
        </div>

        {/* The card's own subtotal. Reserves no space when zero — an empty
            card should look empty, not like it holds a meaningful nil. */}
        {total > 0 ? (
          <span
            className={cn('shrink-0 nums text-sm font-semibold', privacyMode && 'blur-[5px]')}
            style={{ color: group.accent }}
          >
            {formatCurrency(total, currency, { decimals: 0 })}
          </span>
        ) : null}
      </div>

      <div className="px-4 py-2">
        <ul>
          {visible.map((item) => (
            <SheetRow
              key={item.id}
              item={item}
              month={month}
              currency={currency}
              entry={amounts.get(item.id)}
              privacyMode={privacyMode}
              accent={group.accent}
            />
          ))}
        </ul>

        {/* Only shown once something is actually withheld: the arithmetic is
            worth spelling out precisely because the header shows take-home,
            not the gross figure the user typed. */}
        {withheld > 0 ? (
          <dl className="mt-2 space-y-1 border-t border-border pt-2 text-xs">
            <div className="flex justify-between gap-3">
              <dt className="text-text-muted">Gross</dt>
              <dd className={cn('nums text-text-muted', privacyMode && 'blur-[5px]')}>
                {formatCurrency(gross, currency, { decimals: 0 })}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-text-muted">Deducted</dt>
              <dd className={cn('nums text-negative', privacyMode && 'blur-[5px]')}>
                −{formatCurrency(withheld, currency, { decimals: 0 })}
              </dd>
            </div>
            <div className="flex justify-between gap-3 border-t border-border/60 pt-1">
              <dt className="font-medium text-text">Take-home</dt>
              <dd
                className={cn('nums font-semibold', privacyMode && 'blur-[5px]')}
                style={{ color: group.accent }}
              >
                {formatCurrency(total, currency, { decimals: 0 })}
              </dd>
            </div>
          </dl>
        ) : null}

        {hidden.length > 0 && !hasHiddenValue ? (
          <button
            onClick={() => setShowAll((v) => !v)}
            className="mt-1 flex w-full items-center justify-center gap-1 rounded-lg py-1.5 text-xs font-medium text-text-subtle transition-colors hover:bg-surface-raised hover:text-text"
          >
            <ChevronDown
              className={cn('size-3.5 transition-transform', showAll && 'rotate-180')}
            />
            {showAll ? 'Fewer' : `${hidden.length} more`}
          </button>
        ) : null}
      </div>
    </Card>
  );
}

interface SheetRowProps {
  item: BudgetItem;
  month: string;
  currency: string;
  entry: BudgetEntry | undefined;
  privacyMode: boolean;
  accent: string;
}

function SheetRow({
  item,
  month,
  currency,
  entry,
  privacyMode,
  accent,
}: SheetRowProps) {
  const stored = entry?.amount;
  const [value, setValue] = useState(() => (stored ? String(stored) : ''));
  const [saved, setSaved] = useState(false);

  // Track what we last wrote, so the effect below can tell an external change
  // (month switch, carry-forward, undo) from the echo of our own save.
  const lastWritten = useRef<number | undefined>(stored);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focused = useRef(false);

  useEffect(() => {
    if (stored === lastWritten.current) return;
    lastWritten.current = stored;
    // Never yank the value out from under someone mid-type.
    if (focused.current) return;
    setValue(stored ? String(stored) : '');
  }, [stored]);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  function commit(raw: string) {
    const amount = raw.trim() === '' ? 0 : Number(raw);
    if (!Number.isFinite(amount) || amount < 0) return;

    lastWritten.current = amount > 0 ? amount : undefined;
    void setBudgetItemAmount({
      month,
      itemId: item.id,
      kind: item.kind,
      category: item.category,
      amount,
      currency,
    }).then(() => {
      setSaved(true);
      setTimeout(() => setSaved(false), 1200);
    });
  }

  function handleChange(raw: string) {
    setValue(raw);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => commit(raw), SAVE_DELAY_MS);
  }

  function handleBlur() {
    focused.current = false;
    if (timer.current) clearTimeout(timer.current);
    commit(value);
  }

  const filled = value.trim() !== '' && Number(value) > 0;
  const isDeduction = item.kind === 'deduction';
  // A withheld row sits among income rows, so it must not borrow their accent
  // — colour and a minus sign both say "this comes off the total".
  const rowAccent = isDeduction ? 'var(--negative)' : accent;

  return (
    <li className="group/row flex items-center gap-2 border-b border-border/40 py-1 last:border-0">
      {/* A filled row gets a small accent bar, so a glance down the card shows
          what is done without reading any numbers. */}
      <span
        className="h-5 w-0.5 shrink-0 rounded-full transition-colors"
        style={{ background: filled ? rowAccent : 'transparent' }}
        aria-hidden
      />

      <label
        htmlFor={`item-${item.id}`}
        className={cn(
          'min-w-0 flex-1 cursor-pointer truncate text-[13px] transition-colors',
          filled ? 'text-text' : 'text-text-muted group-hover/row:text-text',
        )}
      >
        {isDeduction ? <span aria-hidden>− </span> : null}
        {item.label}
      </label>

      {/* Saved tick reserves its slot whether or not it is showing, so a row
          does not shift sideways the moment it persists. */}
      <span className="w-3.5 shrink-0" aria-hidden>
        {saved ? <Check className="size-3.5 text-positive" /> : null}
      </span>

      <div className="relative w-[7.5rem] shrink-0">
        <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[10px] font-medium text-text-subtle">
          {currency}
        </span>
        <input
          id={`item-${item.id}`}
          type="number"
          inputMode="decimal"
          step="any"
          min="0"
          value={value}
          onFocus={() => {
            focused.current = true;
          }}
          onChange={(e) => handleChange(e.target.value)}
          onBlur={handleBlur}
          placeholder="—"
          aria-label={`${item.label} amount in ${currency}`}
          className={cn(
            'h-8 w-full rounded-lg border bg-surface-raised/70 pl-8 pr-2 text-right text-[13px] nums',
            'transition-colors focus:outline-none focus:ring-1',
            filled
              ? 'border-border-strong text-text'
              : 'border-border/70 text-text-muted hover:border-border-strong',
            // Amounts are sensitive; blur them rather than hiding the field,
            // so the layout and the ability to type both survive.
            privacyMode && filled && 'blur-[5px] focus:blur-none',
          )}
          style={
            filled
              ? ({
                  '--tw-ring-color': rowAccent,
                  borderColor: `color-mix(in oklab, ${rowAccent} 45%, transparent)`,
                } as React.CSSProperties)
              : ({ '--tw-ring-color': rowAccent } as React.CSSProperties)
          }
        />
      </div>
    </li>
  );
}
