/**
 * User preferences. Small, synchronous, and read on almost every render —
 * this is the one slice that belongs in localStorage rather than IndexedDB.
 *
 * Note what is NOT here: API keys. Those live only in server/.env. The client
 * holds at most the shared secret, which is a gate on our own proxy, not a
 * credential for any upstream. See PROJECT_PLAN.md §1.2.
 */
import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { RateSettings, TaxSettings, ZakatSettings } from '@aminfinance/shared';
import { clearColorCache } from '@/lib/cssColor';
import { DEFAULT_ZAKAT_SETTINGS } from '@/lib/calc/zakat';
import { DEFAULT_TAX_SETTINGS } from '@/lib/calc/tax';
import { DEFAULT_RATE_SETTINGS } from '@/lib/calc/inflation';

export type Theme = 'light' | 'dark';

export interface SettingsState {
  theme: Theme;
  /** ISO 4217 code everything is converted to for display. */
  displayCurrency: string;
  /** Stock quote poll interval, ms. Crypto uses the WS stream regardless. */
  quoteRefreshMs: number;
  /** Annualized risk-free rate as a percent, used by the Sharpe calculation. */
  riskFreeRatePercent: number;
  /** Opt out of 3D scenes independently of the OS reduced-motion setting. */
  enable3D: boolean;
  /** Show absolute currency amounts, or hide them for screenshots. */
  privacyMode: boolean;
  /**
   * Zakat basis and equity treatment.
   *
   * Nested rather than flattened into this slice, because these are fiqh
   * positions rather than app preferences and the grouping is what makes that
   * legible at the call site — `settings.zakat.nisabBasis` reads as a
   * religious choice, `settings.nisabBasis` reads like a display toggle.
   */
  zakat: ZakatSettings;
  /** Filer status and the rates from the current Finance Act. */
  tax: TaxSettings;
  /** User-maintained CPI and savings-rate figures. */
  rates: RateSettings;
}

const STORAGE_KEY = 'aminfinance.settings';
const THEME_KEY = 'aminfinance.theme';

const defaults: SettingsState = {
  theme: 'dark',
  // PKR: the book is PSX-dominated, so totals belong in the home currency.
  // Binance values arrive in USDT and are converted for the combined total.
  displayCurrency: 'PKR',
  quoteRefreshMs: 60_000,
  riskFreeRatePercent: 4.5,
  enable3D: true,
  privacyMode: false,
  zakat: DEFAULT_ZAKAT_SETTINGS,
  tax: DEFAULT_TAX_SETTINGS,
  rates: DEFAULT_RATE_SETTINGS,
};

function loadInitialState(): SettingsState {
  if (typeof window === 'undefined') return defaults;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const stored: unknown = raw ? JSON.parse(raw) : {};
    // Spread over defaults so a settings key added in a later release doesn't
    // read as undefined for existing users.
    const partial = (stored ?? {}) as Partial<SettingsState>;
    // The nested groups need their own merge: a top-level spread would take a
    // stored `zakat` object wholesale, so a field added to ZakatSettings in a
    // later release would arrive as undefined for every existing user — and
    // an undefined nisab basis silently means "no zakat is ever due".
    const merged: SettingsState = {
      ...defaults,
      ...partial,
      zakat: { ...defaults.zakat, ...(partial.zakat ?? {}) },
      tax: { ...defaults.tax, ...(partial.tax ?? {}) },
      rates: { ...defaults.rates, ...(partial.rates ?? {}) },
    };
    // index.html already applied the theme class from its own key; keep the
    // two in sync so a manual localStorage edit can't desync them.
    const themeFromDom = document.documentElement.classList.contains('dark')
      ? 'dark'
      : 'light';
    return { ...merged, theme: themeFromDom };
  } catch {
    return defaults;
  }
}

function persist(state: SettingsState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    window.localStorage.setItem(THEME_KEY, state.theme);
    document.documentElement.classList.toggle('dark', state.theme === 'dark');
    // Resolved token values differ per theme, so canvas/WebGL consumers must
    // re-read them after a switch.
    clearColorCache();
  } catch {
    // Private-browsing or a full quota. Preferences degrade to session-only,
    // which is not worth interrupting the user over.
  }
}

const settingsSlice = createSlice({
  name: 'settings',
  initialState: loadInitialState(),
  reducers: {
    setTheme(state, action: PayloadAction<Theme>) {
      state.theme = action.payload;
      persist(state);
    },
    toggleTheme(state) {
      state.theme = state.theme === 'dark' ? 'light' : 'dark';
      persist(state);
    },
    setDisplayCurrency(state, action: PayloadAction<string>) {
      state.displayCurrency = action.payload;
      persist(state);
    },
    setQuoteRefreshMs(state, action: PayloadAction<number>) {
      state.quoteRefreshMs = action.payload;
      persist(state);
    },
    setRiskFreeRate(state, action: PayloadAction<number>) {
      state.riskFreeRatePercent = action.payload;
      persist(state);
    },
    setEnable3D(state, action: PayloadAction<boolean>) {
      state.enable3D = action.payload;
      persist(state);
    },
    togglePrivacyMode(state) {
      state.privacyMode = !state.privacyMode;
      persist(state);
    },
    setZakatSettings(state, action: PayloadAction<Partial<ZakatSettings>>) {
      state.zakat = { ...state.zakat, ...action.payload };
      persist(state);
    },
    setTaxSettings(state, action: PayloadAction<Partial<TaxSettings>>) {
      state.tax = { ...state.tax, ...action.payload };
      persist(state);
    },
    /**
     * Stamps `updatedAt` on every write rather than trusting the caller.
     *
     * The staleness warning is the only thing standing between a typed-once
     * CPI figure and every real-return number in the app quietly aging into
     * fiction, so the timestamp cannot be the form's responsibility.
     */
    setRateSettings(state, action: PayloadAction<Partial<RateSettings>>) {
      state.rates = { ...state.rates, ...action.payload, updatedAt: Date.now() };
      persist(state);
    },
  },
});

export const {
  setTheme,
  toggleTheme,
  setDisplayCurrency,
  setQuoteRefreshMs,
  setRiskFreeRate,
  setEnable3D,
  togglePrivacyMode,
  setZakatSettings,
  setTaxSettings,
  setRateSettings,
} = settingsSlice.actions;

export default settingsSlice.reducer;
