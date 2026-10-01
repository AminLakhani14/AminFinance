/**
 * The debt a budget sheet row pays down, if any.
 *
 * Lives in `features/planning` rather than `features/budget` because the
 * relationship is owned by the debt: a `Liability` names the sheet row it is
 * paid from, and the row knows nothing about it. That direction matters —
 * a sheet row must stay usable by someone with no debts recorded, so the
 * budget side reads this and renders nothing when it comes back null.
 */
import { useLiveQuery } from 'dexie-react-hooks';
import type { DebtRepayment, Liability } from '@aminfinance/shared';
import { db } from '@/lib/db';
import { debtProgress, type DebtProgress } from '@/lib/calc/debt';

export interface LinkedDebt {
  liability: Liability;
  progress: DebtProgress;
  /** This month's recorded repayment, when there is one. */
  thisMonth: DebtRepayment | null;
}

export function useLinkedDebt(itemId: string, month: string): LinkedDebt | null {
  const liability = useLiveQuery(
    (): Promise<Liability | undefined> =>
      db.liabilities.filter((l) => l.linkedItemId === itemId).first(),
    [itemId],
  );

  const repayments = useLiveQuery(
    (): Promise<DebtRepayment[]> =>
      liability
        ? db.debtRepayments.where('liabilityId').equals(liability.id).toArray()
        : Promise.resolve([]),
    [liability?.id],
  );

  if (!liability || repayments === undefined) return null;

  return {
    liability,
    progress: debtProgress(liability, repayments),
    thisMonth: repayments.find((r) => r.month === month) ?? null,
  };
}
