import { useState } from 'react';
import { ShieldCheck, TriangleAlert } from 'lucide-react';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useAppDispatch, useAppSelector } from '@/app/hooks';
import {
  setDisplayCurrency,
  setQuoteRefreshMs,
  setRiskFreeRate,
  setEnable3D,
  setTheme,
} from '@/features/settings/settingsSlice';
import { clearAllData } from '@/lib/db';
import { CloudSyncCard } from '@/features/auth/CloudSyncCard';

import { SUPPORTED_CURRENCIES } from '@/lib/calc/currency';
import { SetupChecklist } from '@/features/settings/SetupChecklist';
import { useConfirm } from '@/components/ui/useConfirm';

const CURRENCIES = SUPPORTED_CURRENCIES;
const REFRESH_OPTIONS = [
  { label: '30 seconds', value: 30_000 },
  { label: '1 minute', value: 60_000 },
  { label: '5 minutes', value: 300_000 },
] as const;

export function Settings() {
  const dispatch = useAppDispatch();
  const settings = useAppSelector((s) => s.settings);
  const [cleared, setCleared] = useState(false);
  const { confirm, dialog } = useConfirm();

  async function handleClear() {
    const confirmed = await confirm({
      title: 'Clear all local data?',
      message:
        'Deletes every transaction and portfolio snapshot stored in this browser. ' +
        'Binance trades can be re-synced and stock positions re-entered, but anything ' +
        'entered manually is gone permanently.',
      detail: 'This cannot be undone. Export a CSV first if you want a backup.',
      confirmLabel: 'Clear data',
      destructive: true,
    });
    if (!confirmed) return;
    await clearAllData();
    setCleared(true);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-text">Settings</h1>
        <p className="mt-1 text-sm text-text-muted">
          Preferences are stored on this device only.
        </p>
      </div>

      <CloudSyncCard />

      <Card>
        <CardHeader title="Display" />
        <CardBody className="space-y-5">
          <Field label="Theme" hint="Applied before first paint to avoid a flash.">
            <Segmented
              options={[
                { label: 'Dark', value: 'dark' },
                { label: 'Light', value: 'light' },
              ]}
              value={settings.theme}
              onChange={(v) => dispatch(setTheme(v as 'dark' | 'light'))}
            />
          </Field>

          <Field
            label="Display currency"
            hint="Holdings are converted to this for all totals."
          >
            <Select
              value={settings.displayCurrency}
              onChange={(v) => dispatch(setDisplayCurrency(v))}
              options={CURRENCIES.map((c) => ({ label: c, value: c }))}
            />
          </Field>

          <Field
            label="3D visuals"
            hint="Loaded lazily. Disabled automatically under reduced-motion."
          >
            <Segmented
              options={[
                { label: 'On', value: 'on' },
                { label: 'Off', value: 'off' },
              ]}
              value={settings.enable3D ? 'on' : 'off'}
              onChange={(v) => dispatch(setEnable3D(v === 'on'))}
            />
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Data"
          description="Crypto prices stream over a WebSocket regardless of this setting."
        />
        <CardBody className="space-y-5">
          <Field
            label="Stock quote refresh"
            hint="Polling pauses while the tab is in the background."
          >
            <Select
              value={String(settings.quoteRefreshMs)}
              onChange={(v) => dispatch(setQuoteRefreshMs(Number(v)))}
              options={REFRESH_OPTIONS.map((o) => ({
                label: o.label,
                value: String(o.value),
              }))}
            />
          </Field>

          <Field
            label="Risk-free rate"
            hint="Annualized percent, used by the Sharpe ratio calculation."
          >
            <input
              type="number"
              step="0.1"
              min="0"
              max="25"
              value={settings.riskFreeRatePercent}
              onChange={(e) => dispatch(setRiskFreeRate(Number(e.target.value)))}
              className="h-9 w-24 rounded-lg border border-border bg-surface-raised px-3 text-sm text-text nums"
            />
          </Field>
        </CardBody>
      </Card>

      <SetupChecklist />

      <Card>
        <CardHeader
          title="API keys"
          action={<ShieldCheck className="size-4 text-positive" />}
        />
        <CardBody>
          <p className="text-sm text-text-muted">
            There are no API keys here by design. Every credential lives in{' '}
            <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-xs">
              server/.env
            </code>{' '}
            and is never sent to the browser — anything in frontend JavaScript is
            readable by any extension or script on the page.
          </p>
          <p className="mt-3 text-sm text-text-muted">
            Configure them there, restart the server, and the Dashboard checklist will
            update.
          </p>
        </CardBody>
      </Card>

      <Card className="border-negative/30">
        <CardHeader
          title="Danger zone"
          action={<TriangleAlert className="size-4 text-negative" />}
        />
        <CardBody className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-text">Clear all local data</p>
            <p className="mt-0.5 text-xs text-text-muted">
              Deletes every transaction and portfolio snapshot from this browser.
            </p>
          </div>
          {cleared ? (
            <span className="text-sm font-medium text-positive">Cleared</span>
          ) : (
            <Button variant="danger" size="sm" onClick={() => void handleClear()}>
              Clear data
            </Button>
          )}
        </CardBody>
      </Card>

      {dialog}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-text">{label}</p>
        {hint ? <p className="mt-0.5 text-xs text-text-muted">{hint}</p> : null}
      </div>
      {children}
    </div>
  );
}

function Segmented({
  options,
  value,
  onChange,
}: {
  options: ReadonlyArray<{ label: string; value: string }>;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border border-border bg-surface-sunken p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          onClick={() => onChange(option.value)}
          className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
            value === option.value
              ? 'bg-surface-raised text-text shadow-sm'
              : 'text-text-muted hover:text-text'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<{ label: string; value: string }>;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-9 rounded-lg border border-border bg-surface-raised px-3 text-sm text-text"
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
