/**
 * Export menu: Excel and PDF, for this month or a whole year.
 *
 * Every generator is behind a dynamic import. ExcelJS and jsPDF together are
 * well over a megabyte, and the page's budget is 250kb — so the cost is only
 * paid by someone who actually exports, on the click that needs it.
 */
import { useEffect, useRef, useState } from 'react';
import { Download, FileSpreadsheet, FileText, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { availableYears } from './reportData';
import { cn } from '@/lib/utils';

interface ExportMenuProps {
  /** `YYYY-MM` currently on screen. */
  month: string;
  monthLabel: string;
  currency: string;
}

type Job = 'month-xlsx' | 'month-pdf' | 'year-xlsx' | 'year-pdf' | null;

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  // Revoking immediately can cancel the download in some browsers; a tick is
  // enough for the navigation to have started.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ExportMenu({ month, monthLabel, currency }: ExportMenuProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<Job>(null);
  const [error, setError] = useState<string | null>(null);
  const [years, setYears] = useState<number[]>([]);
  const [year, setYear] = useState(() => Number(month.slice(0, 4)));
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    void availableYears().then((list) => {
      setYears(list);
      // Default to the year being viewed when it has data, else the newest.
      const viewing = Number(month.slice(0, 4));
      setYear(list.includes(viewing) ? viewing : (list[0] ?? viewing));
    });
  }, [open, month]);

  // Close on outside click and on Escape — a menu that traps focus is a bug.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  async function run(job: Exclude<Job, null>) {
    setBusy(job);
    setError(null);
    try {
      // Data first, then the renderer — both dynamic, so nothing loads until
      // this click.
      const { buildMonthReport, buildYearReport } = await import('./reportData');

      if (job === 'month-xlsx' || job === 'month-pdf') {
        const report = await buildMonthReport(month, currency);
        const slug = monthLabel.replace(/\s+/g, '-').toLowerCase();
        if (job === 'month-xlsx') {
          const { exportMonthToExcel } = await import('./exportExcel');
          saveBlob(await exportMonthToExcel(report), `expenses-${slug}.xlsx`);
        } else {
          const { exportMonthToPdf } = await import('./exportPdf');
          saveBlob(await exportMonthToPdf(report), `expenses-${slug}.pdf`);
        }
      } else {
        const report = await buildYearReport(year, currency);
        if (job === 'year-xlsx') {
          const { exportYearToExcel } = await import('./exportExcel');
          saveBlob(await exportYearToExcel(report), `expenses-${year}.xlsx`);
        } else {
          const { exportYearToPdf } = await import('./exportPdf');
          saveBlob(await exportYearToPdf(report), `expenses-${year}.pdf`);
        }
      }
      setOpen(false);
    } catch (err) {
      // Surfaced rather than swallowed: a silent no-op on an export button is
      // indistinguishable from a broken download.
      setError(err instanceof Error ? err.message : 'Export failed.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="relative" ref={wrapRef}>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="export-trigger"
      >
        <Download className="size-4" />
        Export
      </Button>

      {open ? (
        <div
          role="menu"
          className={cn(
            'absolute right-0 z-40 mt-2 w-64 overflow-hidden rounded-xl border border-border',
            'bg-surface shadow-2xl backdrop-blur-xl',
          )}
        >
          <p className="border-b border-border px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-text-subtle">
            {monthLabel}
          </p>

          <MenuItem
            icon={<FileSpreadsheet className="size-4 text-positive" />}
            label="Excel workbook"
            hint="Cards laid out as on screen"
            busy={busy === 'month-xlsx'}
            disabled={busy !== null}
            onClick={() => run('month-xlsx')}
          />
          <MenuItem
            icon={<FileText className="size-4 text-negative" />}
            label="PDF report"
            hint="Printable monthly summary"
            busy={busy === 'month-pdf'}
            disabled={busy !== null}
            onClick={() => run('month-pdf')}
          />

          <div className="flex items-center justify-between gap-2 border-y border-border bg-surface-raised/40 px-3 py-2">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-text-subtle">
              Full year
            </span>
            <select
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
              aria-label="Year to export"
              className="h-6 rounded-md border border-border bg-surface-raised px-1.5 text-xs text-text"
            >
              {(years.length > 0 ? years : [year]).map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </div>

          <MenuItem
            icon={<FileSpreadsheet className="size-4 text-positive" />}
            label={`Excel workbook · ${year}`}
            hint="Month-by-month plus totals"
            busy={busy === 'year-xlsx'}
            disabled={busy !== null}
            onClick={() => run('year-xlsx')}
          />
          <MenuItem
            icon={<FileText className="size-4 text-negative" />}
            label={`PDF report · ${year}`}
            hint="Annual summary with chart"
            busy={busy === 'year-pdf'}
            disabled={busy !== null}
            onClick={() => run('year-pdf')}
          />

          {error ? (
            <p className="border-t border-border bg-negative/10 px-3 py-2 text-xs text-negative">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

interface MenuItemProps {
  icon: React.ReactNode;
  label: string;
  hint: string;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}

function MenuItem({ icon, label, hint, busy, disabled, onClick }: MenuItemProps) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors',
        'hover:bg-surface-raised disabled:opacity-50',
      )}
    >
      <span className="shrink-0">
        {busy ? <Loader2 className="size-4 animate-spin text-accent" /> : icon}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-text">{label}</span>
        <span className="block truncate text-xs text-text-subtle">
          {busy ? 'Preparing…' : hint}
        </span>
      </span>
    </button>
  );
}
