/**
 * Settings for zakat, tax, and the economic rates.
 *
 * These three sit together because they share one property: the app cannot
 * derive any of them. The nisab basis and the treatment of shares are fiqh
 * positions, the tax rates change with each Finance Act, and there is no free
 * machine-readable feed for Pakistani CPI. Everything here is the user's to
 * state, and the copy is written to make the consequence of each choice
 * visible rather than burying it in a label.
 *
 * The nisab control carries the heaviest warning on purpose: silver is worth
 * roughly a sixth of gold as a threshold, so switching it can change whether
 * zakat is owed at all.
 */
import { Info } from 'lucide-react';
import type { EquityZakatTreatment, FilerStatus, NisabBasis } from '@aminfinance/shared';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { useAppDispatch, useAppSelector } from '@/app/hooks';
import {
  setRateSettings,
  setTaxSettings,
  setZakatSettings,
} from '@/features/settings/settingsSlice';
import { NISAB_GRAMS } from '@/lib/calc/zakat';
import { daysSinceRateUpdate } from '@/lib/calc/inflation';
import { cn } from '@/lib/utils';

const fieldClass =
  'w-full rounded-lg border border-border bg-surface-sunken px-3 py-2 text-sm text-text outline-none focus:border-accent';

export function PlanningSettingsCard({ className }: { className?: string }) {
  const dispatch = useAppDispatch();
  const { zakat, tax, rates } = useAppSelector((s) => s.settings);
  const rateAge = daysSinceRateUpdate(rates);

  return (
    <Card className={className}>
      <CardHeader
        title="Zakat, tax & rates"
        description="Figures the app cannot look up — yours to set and keep current"
      />
      <CardBody className="space-y-6">
        {/* ---- Zakat ------------------------------------------------- */}
        <section className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
            Zakat
          </h3>

          <label className="block">
            <span className="text-sm text-text">Nisab basis</span>
            <select
              value={zakat.nisabBasis}
              onChange={(e) =>
                dispatch(setZakatSettings({ nisabBasis: e.target.value as NisabBasis }))
              }
              className={cn(fieldClass, 'mt-1')}
            >
              <option value="silver">
                Silver — {NISAB_GRAMS.silver}g (lower threshold)
              </option>
              <option value="gold">Gold — {NISAB_GRAMS.gold}g (higher threshold)</option>
            </select>
            <span className="mt-1 block text-xs text-text-subtle">
              This decides whether zakat is owed at all. Silver's threshold is worth
              roughly a sixth of gold's, so wealth can exceed one and not the other.
              Scholars differ; silver is the more commonly recommended basis for
              mixed assets.
            </span>
          </label>

          <label className="block">
            <span className="text-sm text-text">Listed shares</span>
            <select
              value={zakat.equityTreatment}
              onChange={(e) =>
                dispatch(
                  setZakatSettings({
                    equityTreatment: e.target.value as EquityZakatTreatment,
                  }),
                )
              }
              className={cn(fieldClass, 'mt-1')}
            >
              <option value="market-value">Full market value</option>
              <option value="zakatable-portion">Zakatable portion only</option>
            </select>
            <span className="mt-1 block text-xs text-text-subtle">
              Full value is the simpler and more commonly applied view for shares
              held as an investment. The zakatable-portion view counts only the
              issuer's liquid assets — more precise, but the exchange does not
              publish the breakdown, so you supply the share below.
            </span>
          </label>

          {zakat.equityTreatment === 'zakatable-portion' ? (
            <label className="block">
              <span className="text-sm text-text">Zakatable share of equity value</span>
              <div className="mt-1 flex items-center gap-2">
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={zakat.equityZakatablePercent}
                  onChange={(e) =>
                    dispatch(
                      setZakatSettings({
                        equityZakatablePercent: Number(e.target.value),
                      }),
                    )
                  }
                  className={cn(fieldClass, 'nums')}
                />
                <span className="text-sm text-text-muted">%</span>
              </div>
            </label>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-sm text-text">Rate</span>
              <div className="mt-1 flex items-center gap-2">
                <input
                  type="number"
                  step="0.001"
                  value={zakat.ratePercent}
                  onChange={(e) =>
                    dispatch(setZakatSettings({ ratePercent: Number(e.target.value) }))
                  }
                  className={cn(fieldClass, 'nums')}
                />
                <span className="text-sm text-text-muted">%</span>
              </div>
              <span className="mt-1 block text-xs text-text-subtle">
                2.5% on a lunar year; 2.577% if you reckon on a solar one.
              </span>
            </label>

            <label className="block">
              <span className="text-sm text-text">Zakat date</span>
              <input
                type="text"
                inputMode="numeric"
                placeholder="MM-DD"
                value={zakat.anniversary ?? ''}
                onChange={(e) =>
                  dispatch(
                    setZakatSettings({ anniversary: e.target.value.trim() || null }),
                  )
                }
                className={cn(fieldClass, 'mt-1')}
              />
              <span className="mt-1 block text-xs text-text-subtle">
                The date your zakat year turns, so the card can count down. Stored as
                you enter it — the app does no Hijri conversion.
              </span>
            </label>
          </div>
        </section>

        {/* ---- Tax --------------------------------------------------- */}
        <section className="space-y-3 border-t border-border pt-5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
            Capital gains tax
          </h3>

          <label className="block">
            <span className="text-sm text-text">Filer status</span>
            <select
              value={tax.filerStatus}
              onChange={(e) =>
                dispatch(setTaxSettings({ filerStatus: e.target.value as FilerStatus }))
              }
              className={cn(fieldClass, 'mt-1')}
            >
              <option value="filer">Filer</option>
              <option value="non-filer">Non-filer</option>
            </select>
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <NumberField
              label="CGT — filer"
              value={tax.cgtPercentFiler}
              onChange={(v) => dispatch(setTaxSettings({ cgtPercentFiler: v }))}
            />
            <NumberField
              label="CGT — non-filer"
              value={tax.cgtPercentNonFiler}
              onChange={(v) => dispatch(setTaxSettings({ cgtPercentNonFiler: v }))}
            />
            <NumberField
              label="Dividend tax — filer"
              value={tax.dividendTaxPercentFiler}
              onChange={(v) => dispatch(setTaxSettings({ dividendTaxPercentFiler: v }))}
            />
            <NumberField
              label="Dividend tax — non-filer"
              value={tax.dividendTaxPercentNonFiler}
              onChange={(v) =>
                dispatch(setTaxSettings({ dividendTaxPercentNonFiler: v }))
              }
            />
          </div>

          <label className="block">
            <span className="text-sm text-text">Tax year starts</span>
            <select
              value={tax.taxYearStartMonth}
              onChange={(e) =>
                dispatch(setTaxSettings({ taxYearStartMonth: Number(e.target.value) }))
              }
              className={cn(fieldClass, 'mt-1')}
            >
              <option value={7}>July (Pakistan)</option>
              <option value={1}>January (calendar year)</option>
              <option value={4}>April</option>
            </select>
          </label>

          <p className="flex items-start gap-1.5 text-xs text-text-subtle">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            These rates ship as starting points, not current law. They change with
            each Finance Act — check them against the FBR's current schedule, since a
            stale rate here produces a confident wrong estimate.
          </p>
        </section>

        {/* ---- Rates ------------------------------------------------- */}
        <section className="space-y-3 border-t border-border pt-5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
            Inflation & benchmark
          </h3>

          <div className="grid gap-3 sm:grid-cols-2">
            <NumberField
              label="Inflation (CPI, year on year)"
              value={rates.inflationPercent}
              onChange={(v) => dispatch(setRateSettings({ inflationPercent: v }))}
            />
            <NumberField
              label="Savings rate"
              value={rates.savingsRatePercent}
              onChange={(v) => dispatch(setRateSettings({ savingsRatePercent: v }))}
            />
          </div>

          <label className="block">
            <span className="text-sm text-text">Savings product</span>
            <input
              value={rates.savingsRateLabel}
              onChange={(e) =>
                dispatch(setRateSettings({ savingsRateLabel: e.target.value }))
              }
              placeholder="Behbood certificate"
              className={cn(fieldClass, 'mt-1')}
            />
            <span className="mt-1 block text-xs text-text-subtle">
              What your portfolio is measured against — the alternative you would
              actually have used.
            </span>
          </label>

          <p className="flex items-start gap-1.5 text-xs text-text-subtle">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            No free, documented feed publishes these, so they are entered by hand and
            stamped with the date. {rateAge === null
              ? 'Never confirmed yet.'
              : `Last updated ${rateAge} day${rateAge === 1 ? '' : 's'} ago.`}{' '}
            CPI is published monthly.
          </p>
        </section>
      </CardBody>
    </Card>
  );
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block">
      <span className="text-sm text-text">{label}</span>
      <div className="mt-1 flex items-center gap-2">
        <input
          type="number"
          step="0.01"
          value={value}
          onChange={(e) => {
            const next = Number(e.target.value);
            // Guard NaN from an emptied field: writing it would persist a
            // rate that silently poisons every derived figure.
            if (Number.isFinite(next)) onChange(next);
          }}
          className={cn(fieldClass, 'nums')}
        />
        <span className="text-sm text-text-muted">%</span>
      </div>
    </label>
  );
}
