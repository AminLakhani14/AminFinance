/**
 * Planning: the obligations and intentions side of the book.
 *
 * Everything on this page answers a question the Portfolio and Analytics
 * pages cannot, because each one needs data those pages deliberately exclude
 * — cash the portfolio has no way to price, debts it has never known about,
 * a zakat threshold set by the silver price, and a tax year that runs July to
 * June.
 *
 * Ordered by how often it is acted on rather than by theme: net worth and the
 * surplus are read constantly, zakat once a year but with a deadline, and the
 * tax report once a year with none.
 */
import { NetWorthCard } from '@/features/planning/NetWorthCard';
import { NetWorthHistoryCard } from '@/features/planning/NetWorthHistoryCard';
import { CashCard } from '@/features/planning/CashCard';
import { ZakatCard } from '@/features/planning/ZakatCard';
import { GoalsCard } from '@/features/planning/GoalsCard';
import { RealReturnCard } from '@/features/planning/RealReturnCard';
import { DividendCalendarCard } from '@/features/planning/DividendCalendarCard';
import { ActionAlertsCard } from '@/features/planning/ActionAlertsCard';
import { TaxReportCard } from '@/features/planning/TaxReportCard';

export function Planning() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-lg font-semibold tracking-tight text-text">Planning</h1>
        <p className="mt-1 text-sm text-text-muted">
          Net worth, zakat, goals, and tax — the numbers your positions alone cannot
          tell you.
        </p>
      </header>

      <NetWorthCard />

      <div className="grid gap-6 lg:grid-cols-2">
        <ZakatCard />
        <CashCard />
      </div>

      <NetWorthHistoryCard />

      <div className="grid gap-6 lg:grid-cols-2">
        <GoalsCard />
        <RealReturnCard />
      </div>

      <ActionAlertsCard />
      <DividendCalendarCard />
      <TaxReportCard />
    </div>
  );
}
