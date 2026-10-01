/**
 * Pakistan macroeconomic indicators.
 *
 * Three sources, all keyless, each used where it is most current:
 *
 *   IMF SDMX (`imf.ts`) — MONTHLY CPI inflation and monthly goods trade.
 *     Preferred wherever it has the series, because it is current to the last
 *     month or two rather than the last calendar year.
 *   World Bank v2 API — annual only, and used only for what the IMF does not
 *     publish monthly for Pakistan: reserves, external debt, current account,
 *     GDP, unemployment.
 *   open.er-api.com — the live USD/PKR, via the same upstream `fx.ts` uses, so
 *     this tab and every converted portfolio total agree.
 *
 * ⚠️ Why reserves are still annual. The obvious monthly source is the IMF's
 * IRFCL dataflow, but Pakistan does not report into it (`PAK` returns an empty
 * dataset), and its NSDP summary page carries only CPI, WPI, trade and GDP.
 * SBP publishes weekly reserves but its API at easydata.sbp.org.pk requires a
 * registered key (401, not 404) and its public pages are now client-rendered
 * with no figures in the HTML. `SBP_API_KEY` in config gates that path. Until
 * one is set, reserves carry their true annual period rather than being passed
 * off as current — the tile says which month or year it is from, always.
 *
 * Fiscal-year convention: Pakistan's FY runs July–June, but both the IMF and
 * World Bank series here are calendar-period, so tiles say "2025" or
 * "Aug 2026", never "FY2024-25". Relabelling a calendar figure as a fiscal one
 * would be a real error in a finance app, not a cosmetic one.
 */
import type { EconomyIndicator, EconomySnapshot, IndicatorGroup } from '@aminfinance/shared';
import { httpGetJson } from '../lib/http.js';
import { AppError } from '../lib/errors.js';
import { acquire } from '../lib/rateLimit.js';
import { getRates } from './fx.js';
import * as imf from './imf.js';

const PROVIDER = 'WorldBank';
const WB_BASE = 'https://api.worldbank.org/v2';
const WB_SOURCE = 'World Bank';

/** How many annual observations back the sparkline. Ten years shows a cycle. */
const HISTORY_YEARS = 10;

/**
 * The World Bank response is `[metadata, observations]` — a two-element tuple,
 * not an object. `observations` is null (not an empty array) for a country with
 * no data for the indicator, which is why every access below is guarded.
 */
type WbResponse = [
  { page: number; pages: number; total: number } | null,
  WbObservation[] | null,
];

interface WbObservation {
  indicator: { id: string; value: string };
  countryiso3code: string;
  /** The year, as a string: "2025". */
  date: string;
  value: number | null;
}

interface SeriesSpec {
  id: string;
  /** World Bank indicator code. */
  indicator: string;
  label: string;
  group: IndicatorGroup;
  unit: EconomyIndicator['unit'];
  /**
   * False for metrics that are already rates. A percent change of a percent
   * ("inflation rose 14%") invites exactly the wrong reading, so those tiles
   * show the level and the previous level instead.
   */
  showChange: boolean;
  note?: string;
}

/**
 * The series, in the order they are requested. Ordering within a group is the
 * order the tiles appear, so this list is also the page's layout.
 */
const SERIES: SeriesSpec[] = [
  {
    id: 'reserves.total',
    indicator: 'FI.RES.TOTL.CD',
    label: 'Total reserves',
    group: 'external',
    unit: 'USD',
    showChange: true,
    note: 'Includes gold. Annual — SBP publishes a weekly figure that needs an API key.',
  },
  {
    id: 'debt.external',
    indicator: 'DT.DOD.DECT.CD',
    label: 'External debt',
    group: 'external',
    unit: 'USD',
    showChange: true,
  },
  {
    id: 'account.current',
    indicator: 'BN.CAB.XOKA.CD',
    label: 'Current account',
    group: 'external',
    unit: 'USD',
    showChange: false,
    note: 'Negative is a deficit.',
  },
  {
    id: 'fx.official',
    indicator: 'PA.NUS.FCRF',
    label: 'Official rate (avg)',
    group: 'prices',
    unit: 'PKR/USD',
    showChange: true,
    note: 'Period average — compare against the live interbank rate.',
  },
  {
    id: 'activity.gdp',
    indicator: 'NY.GDP.MKTP.CD',
    label: 'GDP',
    group: 'activity',
    unit: 'USD',
    showChange: true,
  },
  {
    id: 'activity.unemployment',
    indicator: 'SL.UEM.TOTL.ZS',
    label: 'Unemployment',
    group: 'activity',
    unit: '%',
    showChange: false,
    note: 'ILO modelled estimate.',
  },
];

/** Epoch ms for 31 December of a World Bank observation year. */
function yearEnd(year: number): number {
  return Date.UTC(year, 11, 31);
}

/**
 * Fetch one annual series and shape it into an indicator.
 *
 * `date` is requested as a range rather than using `mrnev=1` so the sparkline
 * and the change figure come out of the same response — the alternative is two
 * calls per series, which for nine series is nine avoidable round trips.
 */
async function fetchSeries(spec: SeriesSpec): Promise<EconomyIndicator> {
  const thisYear = new Date().getUTCFullYear();
  const from = thisYear - HISTORY_YEARS;
  const url =
    `${WB_BASE}/country/PAK/indicator/${spec.indicator}` +
    `?format=json&per_page=${HISTORY_YEARS + 2}&date=${from}:${thisYear}`;

  const raw = await httpGetJson<WbResponse>(url, { provider: PROVIDER, timeoutMs: 15_000 });

  // The World Bank reports its own errors inside a 200 response, as a
  // `message` array where the observations would be. Treat that as a failure
  // rather than letting it fall through as "no data".
  if (!Array.isArray(raw) || raw.length < 2) {
    throw AppError.providerError(PROVIDER, `Unexpected response shape for ${spec.indicator}.`);
  }

  const observations = (raw[1] ?? [])
    .filter((o): o is WbObservation & { value: number } => typeof o?.value === 'number')
    // Upstream returns newest-first; a sparkline reads left to right in time.
    .sort((a, b) => Number(a.date) - Number(b.date));

  if (observations.length === 0) {
    throw AppError.notFound(`World Bank has no ${spec.label} data for Pakistan.`);
  }

  const latest = observations[observations.length - 1] as WbObservation & { value: number };
  const previous = observations[observations.length - 2];

  // Guarded against a zero or negative prior value: the current account
  // legitimately crosses zero, and a percent change through zero is undefined
  // rather than merely large. `showChange` already excludes that series, but
  // the guard keeps the arithmetic honest if the list changes.
  const changePercent =
    spec.showChange && previous && typeof previous.value === 'number' && previous.value > 0
      ? ((latest.value - previous.value) / previous.value) * 100
      : null;

  return {
    id: spec.id,
    label: spec.label,
    group: spec.group,
    value: latest.value,
    unit: spec.unit,
    changePercent,
    changeBasis:
      changePercent === null ? null : `vs ${previous?.date ?? 'prior'}`,
    asOf: yearEnd(Number(latest.date)),
    periodLabel: latest.date,
    period: 'annual',
    source: WB_SOURCE,
    history: observations.map((o) => ({ periodLabel: o.date, value: o.value })),
    note: spec.note ?? null,
  };
}

/**
 * Monthly series, from the IMF.
 *
 * `MONTHLY_START` is deliberately a rolling window rather than a fixed date:
 * asking for everything since 2000 would return hundreds of observations to
 * render a 12-point sparkline.
 */
const MONTHLY_MONTHS = 24;

function monthlyStart(): string {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - MONTHLY_MONTHS, 1));
  return `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`;
}

interface MonthlySpec {
  id: string;
  label: string;
  group: IndicatorGroup;
  unit: EconomyIndicator['unit'];
  series: imf.ImfSeries;
  /**
   * The IMF's own year-on-year percent series for this indicator, where one
   * exists.
   *
   * Month-on-month is the wrong comparison for trade and was actively
   * misleading: Pakistan's imports are seasonal, so May against April read as
   * −18.6% while the same month a year earlier was +3.8%. Rather than
   * differencing two months here, this takes the figure the IMF publishes,
   * which is computed against the same month of the prior year.
   *
   * Null where the figure is already a rate — a percent change of an inflation
   * rate invites exactly the wrong reading.
   */
  changeSeries?: imf.ImfSeries;
  note?: string;
}

/**
 * Keys are positional and unforgiving: one slot per dimension, ISO-3 country,
 * and the exact dataflow version. See `imf.ts` for why an error here surfaces
 * as an empty dataset rather than a failure.
 *
 * CPI: COUNTRY.INDEX_TYPE.COICOP_1999.TYPE_OF_TRANSFORMATION.FREQUENCY
 * ITG: COUNTRY.INDICATOR.TYPE_OF_TRANSFORMATION.FREQUENCY
 */
const MONTHLY: MonthlySpec[] = [
  {
    id: 'prices.cpi',
    label: 'Inflation (CPI)',
    group: 'prices',
    unit: '%',
    series: { dataflow: 'IMF.STA,CPI,5.0.0', key: ['CPI', '_T', 'YOY_PCH_PA_PT'], scale: 0 },
    // Already a year-on-year rate; a change-on-the-change would be noise.
    note: 'Year on year, monthly.',
  },
  {
    id: 'trade.exports',
    label: 'Exports',
    group: 'trade',
    unit: 'PKR',
    // Pakistan reports goods trade to the IMF in rupees only; the USD
    // transformations exist in the dataflow but return nothing for PAK.
    series: { dataflow: 'IMF.STA,ITG,4.0.0', key: ['XG', 'FOB_XDC'], scale: 0 },
    changeSeries: { dataflow: 'IMF.STA,ITG,4.0.0', key: ['XG', 'FOB_YOY_PCH_PT'], scale: 0 },
    note: 'Goods, FOB, monthly.',
  },
  {
    id: 'trade.imports',
    label: 'Imports',
    group: 'trade',
    unit: 'PKR',
    series: { dataflow: 'IMF.STA,ITG,4.0.0', key: ['MG', 'CIF_XDC'], scale: 0 },
    changeSeries: { dataflow: 'IMF.STA,ITG,4.0.0', key: ['MG', 'CIF_YOY_PCH_PT'], scale: 0 },
    note: 'Goods, CIF, monthly.',
  },
];

/** Fetch one monthly series and shape it like any other indicator. */
async function fetchMonthly(spec: MonthlySpec): Promise<EconomyIndicator> {
  const observations = await imf.getMonthlySeries(spec.series, monthlyStart());

  const latest = observations[observations.length - 1] as imf.ImfObservation;

  // The year-on-year figure is fetched rather than derived, and is matched to
  // the level's own period: the two series can publish at different lags, and
  // pairing May's level with April's change would misattribute it. A failure
  // here costs the delta line, not the tile — the level is the point.
  let changePercent: number | null = null;
  if (spec.changeSeries) {
    try {
      const changes = await imf.getMonthlySeries(spec.changeSeries, monthlyStart());
      changePercent = changes.find((c) => c.period === latest.period)?.value ?? null;
    } catch {
      changePercent = null;
    }
  }

  return {
    id: spec.id,
    label: spec.label,
    group: spec.group,
    value: latest.value,
    unit: spec.unit,
    changePercent,
    // Stated explicitly because it is not the same basis as the annual tiles,
    // which compare against the prior observation.
    changeBasis: changePercent === null ? null : 'year on year',
    asOf: imf.periodToDate(latest.period),
    periodLabel: imf.periodLabel(latest.period),
    period: 'monthly',
    source: 'IMF',
    history: observations.map((o) => ({
      periodLabel: imf.periodLabel(o.period),
      value: o.value,
    })),
    note: spec.note ?? null,
  };
}

/**
 * The live interbank USD/PKR.
 *
 * Reuses `fx.getRates` rather than calling the upstream again, so this tile and
 * every converted portfolio total are the same number. A mismatch between the
 * two would be worse than the tile being absent.
 */
async function fetchLiveRate(): Promise<EconomyIndicator> {
  const rates = await getRates('USD');
  const pkr = rates.rates.PKR;
  if (typeof pkr !== 'number' || !Number.isFinite(pkr)) {
    throw AppError.providerError('FX', 'Exchange-rate provider did not quote PKR.');
  }

  return {
    id: 'fx.usdpkr',
    label: 'USD / PKR',
    group: 'prices',
    value: pkr,
    unit: 'PKR/USD',
    // One reading with nothing to compare against. A day-change would need
    // yesterday's snapshot, which this provider does not keep.
    changePercent: null,
    changeBasis: null,
    asOf: rates.timestamp,
    periodLabel: new Date(rates.timestamp).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    }),
    period: 'daily',
    source: 'open.er-api.com',
    history: [],
    note: 'Live rate — the same one used to convert your portfolio.',
  };
}

/**
 * Assemble the snapshot.
 *
 * Every series is settled independently: one indicator the World Bank has
 * retired must not blank the whole tab, so failures are reported per-id in
 * `errors` and the remaining tiles still render. The route caches the result,
 * so this fan-out of ten runs at most once per TTL.
 */
export async function getSnapshot(): Promise<EconomySnapshot> {
  try {
    await acquire('worldBank');
  } catch {
    throw AppError.rateLimited(PROVIDER, 30);
  }

  const settled = await Promise.allSettled([
    fetchLiveRate(),
    ...MONTHLY.map((spec) => fetchMonthly(spec)),
    ...SERIES.map((spec) => fetchSeries(spec)),
  ]);

  const ids = ['fx.usdpkr', ...MONTHLY.map((m) => m.id), ...SERIES.map((s) => s.id)];
  const indicators: EconomyIndicator[] = [];
  const errors: Record<string, string> = {};

  settled.forEach((result, i) => {
    const id = ids[i] as string;
    if (result.status === 'fulfilled') {
      indicators.push(result.value);
    } else {
      errors[id] =
        result.reason instanceof Error ? result.reason.message : 'Could not load this series.';
    }
  });

  // Nothing at all means both upstreams are unreachable. The cache layer will
  // serve a stale snapshot if it has one; an empty payload would render as a
  // tab full of dashes with no explanation.
  if (indicators.length === 0) {
    throw AppError.providerError(
      PROVIDER,
      `No economic data available. ${Object.values(errors)[0] ?? ''}`.trim(),
    );
  }

  // Most-recent first inside each group, so a monthly figure sits above the
  // annual one beside it rather than below by list order. The group itself is
  // ordered by the client.
  const freshness: Record<EconomyIndicator['period'], number> = {
    daily: 0,
    monthly: 1,
    annual: 2,
  };
  indicators.sort((a, b) => freshness[a.period] - freshness[b.period]);

  return {
    country: 'PK',
    indicators,
    asOf: Date.now(),
    ...(Object.keys(errors).length > 0 ? { errors } : {}),
  };
}
